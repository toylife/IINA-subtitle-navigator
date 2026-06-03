let tracks = [];
let trackId = null;

let rows = [];
let filtered = [];
let selected = new Set();
let lastClicked = null;

let currentTime = 0;
let currentIdx = -1;

let liveStart = null;

function fmt(t) {
  const s = Math.max(0, Math.floor(t));
  const h = String(Math.floor(s / 3600)).padStart(2, "0");
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${h}:${m}:${ss}`;
}

function populateSelect() {
  const sel = document.getElementById("track");
  sel.innerHTML = "";
  tracks.forEach(t => {
    const op = document.createElement("option");
    op.value = String(t.id);
    let text = [t.id, t.lang, t.title].filter(Boolean).join(" ").trim();
    if (t.isEmbedded) text += " (内嵌)";
    op.textContent = text;
    sel.appendChild(op);
  });
  if (trackId != null) sel.value = String(trackId);
}

function applyFilter() {
  const q = document.getElementById("q").value.trim().toLowerCase();
  selected.clear();
  lastClicked = null;
  filtered = q ? rows.filter(r => (r.text || "").toLowerCase().includes(q)) : rows.slice();
  render();
}

function findCurrentIndex() {
  let lo = 0, hi = filtered.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = filtered[mid];
    if (currentTime < r.start) hi = mid - 1;
    else if (currentTime > r.end) { best = mid; lo = mid + 1; }
    else return mid;
  }
  return best;
}

function updateCurrentClass() {
  document.querySelectorAll("#list .item").forEach((el, i) => {
    if (i === currentIdx) el.classList.add("current");
    else el.classList.remove("current");
  });
}

function updateSelectionClass() {
  document.querySelectorAll("#list .item").forEach((el, i) => {
    if (selected.has(i)) el.classList.add("selected");
    else el.classList.remove("selected");
  });
}

function render() {
  const list = document.getElementById("list");
  list.innerHTML = "";
  currentIdx = findCurrentIndex();

  filtered.forEach((r, i) => {
    const item = document.createElement("div");
    const isSel = selected.has(i);
    const isCur = (i === currentIdx);

    item.className = "item" + (isSel ? " selected" : "") + (isCur ? " current" : "");
    item.dataset.index = String(i);
    item.innerHTML = `
      <div class="time">${fmt(r.start)}</div>
      <div class="line"></div>
    `;
    item.querySelector(".line").innerText = r.text || "";

    item.addEventListener("click", (e) => {
      const idx = i;
      const isRange = e.shiftKey && lastClicked != null;
      const isToggle = e.metaKey || e.ctrlKey;

      if (isRange) {
        const a = Math.min(lastClicked, idx);
        const b = Math.max(lastClicked, idx);
        selected.clear();
        for (let k = a; k <= b; k++) selected.add(k);
      } else if (isToggle) {
        if (selected.has(idx)) selected.delete(idx); else selected.add(idx);
        lastClicked = idx;
      } else {
        selected.clear();
        selected.add(idx);
        lastClicked = idx;
        iina.postMessage("seekTo", { time: r.start });
      }

      const loopOn = document.getElementById("loopToggle").checked;
      if (loopOn) iina.postMessage("loopLine", { enabled: true, start: r.start, end: r.end, text: r.text });
      updateSelectionClass();
    });

    item.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      copyText(r.text);
      const lineDiv = item.querySelector(".line");
      const oldText = lineDiv.innerText;
      lineDiv.innerText = "[已复制 Copied!] " + oldText;
      lineDiv.style.color = "#4ade80";
      setTimeout(() => {
        lineDiv.innerText = oldText;
        lineDiv.style.color = "";
      }, 800);
    });

    list.appendChild(item);
  });
}

async function copyText(text) {
  if (!text) return;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch (_) { }
  iina.postMessage("copyFallback", { text });
}

function selectedRows() {
  const out = [];
  for (const idx of selected) {
    const r = filtered[idx];
    if (r) out.push(r);
  }
  return out.sort((a, b) => a.start - b.start);
}

function scrollToIndex(idx) {
  const el = document.querySelector(`.item[data-index="${idx}"]`);
  if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
}

/** Toolbar actions */
document.getElementById("q").addEventListener("input", applyFilter);
document.getElementById("reload").addEventListener("click", () => iina.postMessage("reload", {}));

document.getElementById("track").addEventListener("change", () => {
  trackId = Number(document.getElementById("track").value);
  iina.postMessage("setSelection", { trackId });
});

document.getElementById("clearSel").addEventListener("click", () => {
  selected.clear();
  lastClicked = null;
  updateSelectionClass();
});

document.getElementById("copySel").addEventListener("click", async () => {
  const parts = selectedRows().map(r => r.text || "").filter(Boolean);
  await copyText(parts.join("\n\n"));
});

document.getElementById("loopToggle").addEventListener("change", () => {
  const on = document.getElementById("loopToggle").checked;
  if (!on) iina.postMessage("loopLine", { enabled: false });
  else if (currentIdx >= 0) {
    const r = filtered[currentIdx];
    if (r) iina.postMessage("loopLine", { enabled: true, start: r.start, end: r.end, text: r.text });
  }
});

let currentUser = "Default User";
let usersList = ["Default User"];

function updateUserDropdown() {
  const sel = document.getElementById("userSelect");
  if (!sel) return;
  sel.innerHTML = "";
  usersList.forEach(u => {
    const op = document.createElement("option");
    op.value = u;
    op.textContent = u;
    sel.appendChild(op);
  });
  sel.value = currentUser;
}

document.getElementById("btnNewUser")?.addEventListener("click", () => {
  const name = prompt("Enter new user name:");
  if (name && name.trim()) {
    const clean = name.trim();
    if (!usersList.includes(clean)) usersList.push(clean);
    currentUser = clean;
    updateUserDropdown();
    iina.postMessage("statsAction", { action: "switchUser", user: currentUser });
  }
});

document.getElementById("userSelect")?.addEventListener("change", (e) => {
  currentUser = e.target.value;
  iina.postMessage("statsAction", { action: "switchUser", user: currentUser });
});

document.getElementById("btnStats")?.addEventListener("click", () => {
  iina.postMessage("statsAction", { action: "getStats" });
});

document.getElementById("btnCloseStats")?.addEventListener("click", () => {
  document.getElementById("statsModal").style.display = "none";
});

// 手动切换自动滚动开关时的逻辑
document.getElementById("autoScrollToggle").addEventListener("change", () => {
  const on = document.getElementById("autoScrollToggle").checked;
  if (on && currentIdx >= 0) {
    scrollToIndex(currentIdx);
  }
});

document.getElementById("scrollTop").addEventListener("click", () => {
  document.getElementById("list").scrollTo({ top: 0, behavior: "smooth" });
});

document.getElementById("jumpCurrent").addEventListener("click", () => iina.postMessage("seekCurrentLine", {}));
document.getElementById("scrollCurrent").addEventListener("click", () => iina.postMessage("scrollToCurrent", {}));

document.getElementById("jumpTime").addEventListener("click", () => {
  const hh = Number(document.getElementById("hh")?.value || "0");
  const mm = Number(document.getElementById("mm")?.value || "0");
  const ss = Number(document.getElementById("ss")?.value || "0");
  if (![hh, mm, ss].every(n => Number.isFinite(n) && n >= 0)) return;
  const t = Math.max(0, hh * 3600 + (mm % 60) * 60 + (ss % 60));
  iina.postMessage("seekNearest", { time: t });
});

document.getElementById("live").addEventListener("click", () => {
  if (typeof liveStart === "number") iina.postMessage("seekTo", { time: liveStart });
});

/** Messages */
iina.onMessage("setTracks", (data) => {
  tracks = Array.isArray(data?.tracks) ? data.tracks : [];
  trackId = data?.trackId ?? null;
  populateSelect();
});

iina.onMessage("setRows", ({ rows: r, meta }) => {
  rows = Array.isArray(r) ? r : [];
  filtered = rows.slice();
  selected.clear();
  lastClicked = null;

  const el = document.getElementById("meta");
  if (meta?.error) el.innerText = `Error: ${meta.error}`;
  else el.innerText = `Rows: ${meta?.count ?? rows.length}`;

  render();
});

iina.onMessage("time", ({ t }) => {
  if (typeof t === "number" && isFinite(t)) {
    currentTime = t;
    const idx = findCurrentIndex();

    if (idx !== currentIdx) {
      currentIdx = idx;
      updateCurrentClass();
      const autoScroll = document.getElementById("autoScrollToggle")?.checked;
      if (autoScroll && idx !== -1) {
        scrollToIndex(idx);
      }
    }
  }
});

iina.onMessage("scrollToIndex", ({ idx }) => {
  if (typeof idx === "number") scrollToIndex(idx);
});

iina.onMessage("liveSubtitle", (data) => {
  document.getElementById("liveText").innerText = data?.text || "";
  liveStart = (typeof data?.start === "number") ? data.start : null;
});

iina.onMessage("statsData", (data) => {
  if (data.usersList) usersList = data.usersList;
  if (data.currentUser) {
    currentUser = data.currentUser;
    updateUserDropdown();
  }
  if (data.stats) {
    document.getElementById("statsModal").style.display = "block";
    let html = `<h3>User: ${currentUser}</h3>`;
    
    html += `<h4>Watched Movies</h4><ul>`;
    const watched = data.stats.watched || {};
    for (const [k, v] of Object.entries(watched)) {
      html += `<li>${k}</li>`;
    }
    html += `</ul>`;
    
    html += `<h4>Looped Sentences</h4><ul>`;
    const loops = data.stats.loops || {};
    const sortedLoops = Object.entries(loops).sort((a,b)=>b[1]-a[1]).slice(0, 50);
    for (const [k, v] of sortedLoops) {
      html += `<li>[${v}x] ${k}</li>`;
    }
    html += `</ul>`;
    
    document.getElementById("statsContent").innerHTML = html;
  }
});

iina.postMessage("uiReady", {});

window.addEventListener('beforeunload', () => {
  try { iina.postMessage('windowClosed', {}); } catch (_) { }
});

window.addEventListener("keydown", (e) => {
  if (document.activeElement && document.activeElement.tagName === "INPUT") return;

  const isCmdOrCtrl = e.metaKey || e.ctrlKey;
  if (isCmdOrCtrl && (e.key === "]" || e.code === "BracketRight" || e.key === "】")) {
    e.preventDefault();
    iina.postMessage("setSpeed", { speed: 2.0 });
    return;
  } else if (isCmdOrCtrl && (e.key === "[" || e.code === "BracketLeft" || e.key === "【")) {
    e.preventDefault();
    iina.postMessage("setSpeed", { speed: 0.5 });
    return;
  } else if (isCmdOrCtrl && (e.key === "\\" || e.code === "Backslash" || e.key === "、")) {
    e.preventDefault();
    iina.postMessage("setSpeed", { speed: 1.0 });
    return;
  }

  if (e.code === "Space") {
    e.preventDefault();
    iina.postMessage("togglePause", {});
  } else if (e.code === "ArrowUp") {
    e.preventDefault();
    if (currentIdx > 0) {
      const prev = filtered[currentIdx - 1];
      if (prev) iina.postMessage("seekTo", { time: prev.start });
    }
  } else if (e.code === "ArrowDown") {
    e.preventDefault();
    if (currentIdx >= 0 && currentIdx < filtered.length - 1) {
      const next = filtered[currentIdx + 1];
      if (next) iina.postMessage("seekTo", { time: next.start });
    } else if (currentIdx === -1 && filtered.length > 0) {
      iina.postMessage("seekTo", { time: filtered[0].start });
    }
  }
});