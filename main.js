const { core, standaloneWindow, event, mpv, file, utils, console: log, menu } = iina;

let uiReady = false;

let allSubTracks = [];
let trackId = null;

let cues = [];
let rows = [];

let lastStateKey = "";
let timeTicker = null;
let loop = { enabled: false, start: 0, end: 0 };

let windowLoaded = false;

function ensureWindowLoaded() {
  if (windowLoaded) return;
  standaloneWindow.setProperty({ title: "Subtitle Navigator", resizable: true });
  standaloneWindow.loadFile("ui/window.html");
  standaloneWindow.setFrame(900, 720);
  windowLoaded = true;
}

const STATS_FILE_PATH = "/Users/johnshao/.iina-subtitle-navigator-stats.json";
let db = { currentUser: "Default User", usersList: ["Default User"], users: { "Default User": { watched: {}, loops: {} } } };

async function loadStats() {
  try {
    const raw = await execStdout("/bin/bash", ["-lc", `cat ${shQuote(STATS_FILE_PATH)}`]);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.users) db = parsed;
    }
  } catch(_) {}
}

async function saveStats() {
  try {
    const tmp = "@tmp/iina-stats-tmp.json";
    file.write(tmp, JSON.stringify(db));
    const realTmp = utils.resolvePath(tmp);
    await execStdout("/bin/bash", ["-lc", `cp ${shQuote(realTmp)} ${shQuote(STATS_FILE_PATH)}`]);
  } catch(_) {}
}

function openWindow() {
  ensureWindowLoaded();
  loadStats();
  try { standaloneWindow.open(); } catch (e) { log.error(e?.stack || e); }
}

// Plugin menu item: reopen window after user closes it.
try {
  menu.addItem(menu.item("Show Subtitle Navigator", () => openWindow(), { keyBinding: "cmd+shift+s" }));
} catch (e) { /* menu may be unavailable in some contexts */ }

// Open once on plugin load.
openWindow();
function fmtErr(e) {
  try { return (e && e.message) ? e.message : String(e); }
  catch { return String(e); }
}

function shQuote(path) {
  return `'${String(path).replace(/'/g, `'\\''`)}'`;
}

function post(name, data) {
  if (uiReady) standaloneWindow.postMessage(name, data);
}

function stripCurly(text) {
  return String(text || "").replace(/\{[^}]*\}/g, "").trim();
}

async function execStdout(cmd, args) {
  const res = await utils.exec(cmd, args);
  if (typeof res === "string") return res;
  if (res && typeof res.stdout === "string") return res.stdout;
  if (res && typeof res.output === "string") return res.output;
  return "";
}

function hasSuffix(path) {
  return typeof path === "string" && /\.[A-Za-z0-9]+$/.test(path);
}

function getTrackListRaw() {
  const tracks = mpv.getNative("track-list") || [];
  return tracks
    .filter(t => t.type === "sub")
    .map(t => ({
      id: t.id,
      title: t.title || "",
      lang: t.lang || "",
      externalFilename: t["external-filename"] || "",
      selected: (t.selected === true || t.selected === "yes"),
      ffIndex: t["ff-index"]
    }));
}

async function buildTrackList() {
  const raw = getTrackListRaw();
  const out = [];
  for (const t of raw) {
    const p = t.externalFilename;
    if (p) {
      if (hasSuffix(p)) out.push({ ...t, path: p, isEmbedded: false });
    } else {
      out.push({ ...t, path: "", isEmbedded: true });
    }
  }
  return out;
}

async function readSubtitleTextById(id, fallbackPath) {
  // Prefer IINA's pseudo folder reader to avoid utils.exec stdout truncation.
  // @sub/:id points to the subtitle file of the current playing media.
  try {
    const txt = file.read(`@sub/${id}`);
    if (txt && typeof txt === "string") return String(txt).replace(/^\uFEFF/, "");
  } catch (_) {}
  // Fallback: read via shell (may truncate on some builds)
  if (fallbackPath) return await readTextFromPath(fallbackPath);
  throw new Error("Failed to read subtitle");
}

async function readTextFromPath(path) {

  const out = await execStdout("/bin/bash", ["-lc", `cat ${shQuote(path)}`]);
  if (!out) throw new Error(`Failed to read subtitle: ${path}`);
  return String(out).replace(/^\uFEFF/, "");
}

function parseTimeToSeconds(ts) {
  const s = String(ts).trim();
  const m = s.match(/^(\d+):(\d{1,2}):(\d{1,2})([.,](\d{1,3}))?$/);
  if (!m) return NaN;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  const se = Number(m[3]);
  const ms = m[5] ? Number(m[5].padEnd(3, "0")) : 0;
  if (![h, mi, se, ms].every(Number.isFinite)) return NaN;
  return h * 3600 + mi * 60 + se + ms / 1000;
}

function parseSubtitle(content) {
  if (content.includes("[Events]") && content.includes("Dialogue:")) {
    return parseASS(content);
  }
  return parseSRT(content);
}

function parseASS(content) {
  const lines = String(content).replace(/\r/g, "").split("\n");
  const out = [];
  let inEvents = false;
  let format = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "[Events]") {
      inEvents = true;
      continue;
    }
    if (inEvents && line.startsWith("Format:")) {
      format = line.substring(7).split(",").map(s => s.trim());
      continue;
    }
    if (inEvents && line.startsWith("Dialogue:")) {
      let textPart = line.substring(9).trim();
      const parts = [];
      let cur = 0;
      for (let j = 0; j < format.length - 1; j++) {
        const nextComma = textPart.indexOf(",", cur);
        if (nextComma < 0) break;
        parts.push(textPart.substring(cur, nextComma).trim());
        cur = nextComma + 1;
      }
      parts.push(textPart.substring(cur).trim());

      const startIdx = format.indexOf("Start");
      const endIdx = format.indexOf("End");
      const textIdx = format.indexOf("Text");

      if (parts.length === format.length && startIdx >= 0 && endIdx >= 0 && textIdx >= 0) {
        const start = parseTimeToSeconds(parts[startIdx]);
        const end = parseTimeToSeconds(parts[endIdx]);
        let text = parts[textIdx].replace(/\{[^}]*\}/g, "").replace(/\\N/gi, "\n").trim();
        if (Number.isFinite(start) && Number.isFinite(end) && end > start && text) {
          out.push({ start, end, text });
        }
      }
    }
  }
  out.sort((a,b)=>a.start-b.start);
  return out;
}

function parseSRT(content) {
  const lines = String(content).replace(/\r/g, "").split("\n");
  const out = [];
  let i = 0;
  function isIndexLine(x) { return /^\s*\d+\s*$/.test(x); }

  while (i < lines.length) {
    while (i < lines.length && lines[i].trim() === "") i++;
    if (i >= lines.length) break;

    if (isIndexLine(lines[i])) i++;

    while (i < lines.length && lines[i].trim() === "") i++;
    if (i >= lines.length) break;

    const timeLine = lines[i];
    const tm = timeLine.match(/^\s*([0-9]+:\d{1,2}:\d{1,2}(?:[.,]\d{1,3})?)\s*-->\s*([0-9]+:\d{1,2}:\d{1,2}(?:[.,]\d{1,3})?)/);
    if (!tm) { i++; continue; }

    const start = parseTimeToSeconds(tm[1]);
    const end = parseTimeToSeconds(tm[2]);
    i++;

    const textLines = [];
    while (i < lines.length && lines[i].trim() !== "") {
      textLines.push(lines[i]);
      i++;
    }
    const text = stripCurly(textLines.join("\n"));
    if (Number.isFinite(start) && Number.isFinite(end) && end > start && text) {
      out.push({ start, end, text });
    }
  }

  out.sort((a,b)=>a.start-b.start);
  return out;
}

function getSubDelay() {
  try {
    const d = mpv.getNumber("sub-delay");
    return Number.isFinite(d) ? d : 0;
  } catch (_) { return 0; }
}

function closestRowIndexByTime(t) {
  const subDelay = getSubDelay();
  const tAdj = t - subDelay;

  if (!rows.length) return -1;
  let lo = 0, hi = rows.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].start < tAdj) lo = mid + 1;
    else hi = mid - 1;
  }
  if (lo <= 0) return 0;
  if (lo >= rows.length) return rows.length - 1;
  return (Math.abs(rows[lo].start - tAdj) < Math.abs(rows[lo-1].start - tAdj)) ? lo : (lo-1);
}

async function refresh(force=false) {
  allSubTracks = await buildTrackList();

  if (trackId === null) {
    const selected = allSubTracks.find(t => t.selected);
    trackId = selected ? selected.id : (allSubTracks[0]?.id ?? null);
  }
  if (trackId !== null && !allSubTracks.find(t => t.id === trackId)) {
    trackId = allSubTracks[0]?.id ?? null;
  }

  post("setTracks", { tracks: allSubTracks, trackId });

  if (!trackId) {
    rows = [];
    post("setRows", { rows: [], meta: { error: "No suitable subtitle tracks found. Please load subtitles in IINA." } });
    return;
  }

  const track = allSubTracks.find(t => t.id === trackId);
  const path = track?.path || "";
  const isEmbedded = track?.isEmbedded || false;
  const stateKey = `${trackId}|${path}|${isEmbedded}`;
  if (!force && stateKey === lastStateKey && rows.length) {
    post("setRows", { rows, meta: { count: rows.length } });
    return;
  }
  lastStateKey = stateKey;

  try {
    let text = "";
    if (isEmbedded) {
      const vidPath = mpv.getString("path");
      if (!vidPath) throw new Error("无法获取当前视频路径以提取字幕。");
      if (track.ffIndex == null) throw new Error("无法获取该字幕的流索引。");
      
      const tmpSrt = "/tmp/iina-subtitle-navigator-ext.srt";
      await execStdout("/bin/bash", ["-lc", `rm -f ${shQuote(tmpSrt)}`]);
      const cmd = `/opt/homebrew/bin/ffmpeg -y -hide_banner -loglevel error -i ${shQuote(vidPath)} -map 0:${track.ffIndex} -f srt ${shQuote(tmpSrt)}`;
      try {
        await execStdout("/bin/bash", ["-lc", cmd]);
      } catch (err) {
        throw new Error("使用 ffmpeg 提取内嵌字幕失败，可能是因为字幕为图片格式或视频路径无效。");
      }
      text = await readTextFromPath(tmpSrt);
    // } else {
    //   if (!path.toLowerCase().endsWith(".srt")) throw new Error(`Selected external subtitle is not .srt: ${path}`);
    //   text = await readSubtitleTextById(trackId, path);
    // }
    } else {
      const lowerPath = path.toLowerCase();
      const isSrt = lowerPath.endsWith(".srt");
      const isAss = lowerPath.endsWith(".ass") || lowerPath.endsWith(".ssa");

      // 允许 srt, ass, ssa 格式通过
      if (!isSrt && !isAss) {
        throw new Error(`Selected external subtitle is not supported (.srt/.ass/.ssa): ${path}`);
      }
      text = await readSubtitleTextById(trackId, path);
    }
    cues = parseSubtitle(text);
    rows = cues.map(c => ({ start: c.start, end: c.end, text: c.text }));
    post("setRows", { rows, meta: { count: rows.length } });

    // Track watched movie
    const vidPath = mpv.getString("path");
    if (vidPath && db.users[db.currentUser]) {
      const fname = vidPath.split("/").pop();
      db.users[db.currentUser].watched[fname] = 1;
      saveStats();
    }
  } catch (e) {
    rows = [];
    post("setRows", { rows: [], meta: { error: fmtErr(e) } });
  }
}

function startTicker() {
  if (timeTicker) return;
  timeTicker = setInterval(() => {
    try {
      const t = mpv.getNumber("time-pos");
      if (Number.isFinite(t)) {
        post("time", { t });
        if (loop.enabled && t > loop.end + 0.02) core.seekTo(loop.start);
      }
    } catch (_) {}
  }, 250);
}

let lastLiveKey = "";
setInterval(() => {
  try {
    const t = mpv.getNumber("time-pos");
    if (!Number.isFinite(t)) return;
    const idx = closestRowIndexByTime(t);
    if (idx < 0) return;
    const r = rows[idx];
    const key = `${idx}|${r.start}|${r.end}`;
    if (key === lastLiveKey) return;
    lastLiveKey = key;
    post("liveSubtitle", { text: r.text, start: r.start, idx });
  } catch (_) {}
}, 200);

standaloneWindow.onMessage("windowClosed", () => { uiReady = false; windowLoaded = false; });

standaloneWindow.onMessage("togglePause", () => {
  try {
    const p = mpv.getNative("pause");
    mpv.setNative("pause", !p);
  } catch (_) {
    try { mpv.command("cycle", ["pause"]); } catch (_) {}
  }
});

standaloneWindow.onMessage("setSpeed", (data) => {
  const speed = Number(data?.speed);
  if (Number.isFinite(speed)) {
    try {
      mpv.command("set", ["speed", speed.toString()]);
      core.osd(`Speed: ${speed.toFixed(2)}x`);
    } catch (_) {
      try { 
        mpv.setNumber("speed", speed); 
        core.osd(`Speed: ${speed.toFixed(2)}x`);
      } catch (_) {}
    }
  }
});

standaloneWindow.onMessage("uiReady", () => {
  uiReady = true;
  post("statsData", { currentUser: db.currentUser, usersList: db.usersList });
  startTicker();
  refresh(true);
});

standaloneWindow.onMessage("setSelection", (data) => {
  const id = Number(data?.trackId);
  if (Number.isFinite(id)) trackId = id;
  lastStateKey = "";
  refresh(true);
});

standaloneWindow.onMessage("seekTo", (data) => {
  const t = Number(data?.time);
  if (Number.isFinite(t)) core.seekTo(t + getSubDelay());
});

standaloneWindow.onMessage("seekNearest", (data) => {
  const t = Number(data?.time);
  if (!Number.isFinite(t)) return;
  const idx = closestRowIndexByTime(t);
  if (idx >= 0) core.seekTo(rows[idx].start + getSubDelay());
});

standaloneWindow.onMessage("seekCurrentLine", () => {
  const t = mpv.getNumber("time-pos");
  if (!Number.isFinite(t)) return;
  const idx = closestRowIndexByTime(t);
  if (idx >= 0) core.seekTo(rows[idx].start + getSubDelay());
});

standaloneWindow.onMessage("scrollToCurrent", () => {
  const t = mpv.getNumber("time-pos");
  if (!Number.isFinite(t)) return;
  const idx = closestRowIndexByTime(t);
  post("scrollToIndex", { idx });
});

standaloneWindow.onMessage("loopLine", async (data) => {
  const enabled = Boolean(data?.enabled);
  const start = Number(data?.start);
  const end = Number(data?.end);
  if (enabled && Number.isFinite(start) && Number.isFinite(end) && end > start) {
    const d = getSubDelay();
    loop = { enabled: true, start: start + d, end: end + d };
    core.osd("Loop: ON");

    // Track looped sentence
    if (data.text && db.users[db.currentUser]) {
      const u = db.currentUser;
      db.users[u].loops[data.text] = (db.users[u].loops[data.text] || 0) + 1;
      await saveStats();
    }
  } else {
    loop = { enabled: false, start: 0, end: 0 };
    core.osd("Loop: OFF");
  }
});

standaloneWindow.onMessage("statsAction", async (data) => {
  if (data.action === "switchUser") {
    const u = data.user;
    if (u) {
      db.currentUser = u;
      if (!db.usersList.includes(u)) db.usersList.push(u);
      if (!db.users[u]) db.users[u] = { watched: {}, loops: {} };
      await saveStats();
    }
  } else if (data.action === "getStats") {
    const u = db.currentUser;
    const stats = db.users[u] || { watched: {}, loops: {} };
    post("statsData", { currentUser: db.currentUser, usersList: db.usersList, stats });
  }
});

standaloneWindow.onMessage("reload", () => {
  lastStateKey = "";
  refresh(true);
});

standaloneWindow.onMessage("copyFallback", async (data) => {
  const text = String(data?.text ?? "");
  if (!text) return;
  try {
    const tmp = "@tmp/subtitle-navigator-clipboard.txt";
    file.write(tmp, text);
    const real = utils.resolvePath(tmp);
    await utils.exec("/bin/bash", ["-lc", `/usr/bin/pbcopy < "${real.replace(/"/g, '\\"')}"`]);
    core.osd("Copied");
  } catch (e) {
    core.osd("Copy failed");
    log.error(fmtErr(e));
  }
});

event.on("mpv.file-loaded", () => { lastStateKey = ""; refresh(true); });
event.on("mpv.track-list.changed", () => { lastStateKey = ""; refresh(true); });
event.on("mpv.sid.changed", () => { lastStateKey = ""; refresh(true); });
event.on("mpv.sub-file.changed", () => { lastStateKey = ""; refresh(true); });
