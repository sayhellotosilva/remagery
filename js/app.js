// Remagery web app: library, player and sheets in the Studio look.
import { db, keepStorage } from "./db.js";
import { prefs, savePrefs } from "./prefs.js";
import { player } from "./player.js";
import { makeBookFromPDF, Cancelled } from "./bookmaker.js";
import { importPackage } from "./package.js";
import { VOICES, DEFAULT_VOICE } from "./config.js";
import { hasVoiceServer, usage, sample } from "./voice.js";

const $app = document.getElementById("app");
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const h = html => { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; };

// ---------- Icons ----------
const I = {
  back: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l12.5-7.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 4h4.2v16H6zM13.8 4H18v16h-4.2z"/></svg>',
  b15: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.5 3.5v3.7h3.7"/><text x="12.3" y="15.3" font-size="7.4" text-anchor="middle" fill="currentColor" stroke="none" font-family="-apple-system,Arial" font-weight="600">15</text></svg>',
  f30: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 3.5v3.7h-3.7"/><text x="11.7" y="15.3" font-size="7.4" text-anchor="middle" fill="currentColor" stroke="none" font-family="-apple-system,Arial" font-weight="600">30</text></svg>',
  prev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M6 5v14"/><path d="M19 5.5v13L9 12z"/></svg>',
  next: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M18 5v14"/><path d="M5 5.5v13L15 12z"/></svg>',
  bm: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M6.5 3.5h11v17l-5.5-4-5.5 4z"/></svg>',
  bmFull: '<svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor" stroke="currentColor" stroke-width="1.6"><path d="M6.5 3.5h11v17l-5.5-4-5.5 4z"/></svg>',
  x: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  plus: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  tick: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7"/></svg>',
};

// ---------- Helpers ----------
const fmt = s => {
  s = Math.max(0, Math.floor(isFinite(s) ? s : 0));
  const hh = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return hh ? `${hh}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}` : `${m}:${String(ss).padStart(2, "0")}`;
};
const speedText = s => (s === Math.round(s) ? `${s}x` : `${s}x`);
function chapterLabel(c) {
  const t = (c.title || "").toLowerCase();
  if (c.number === 0 || t.startsWith("intro") || t.startsWith("preface")) return "Introduction";
  if (t.startsWith("notes")) return "Notes";
  return `Chapter ${c.number}`;
}
function coverTilt(id) {
  let sum = 0;
  for (const ch of id) sum = (sum * 31 + ch.charCodeAt(0)) & 0xFFFF;
  return [-2.6, 1.8, -1.2, 2.8, -2.0, 1.1, 2.2, -2.8][sum % 8];
}
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// ---------- Theme ----------
const darkQuery = matchMedia("(prefers-color-scheme: dark)");
function applyTheme() {
  const mode = prefs.appearance === "system" ? (darkQuery.matches ? "dark" : "light") : prefs.appearance;
  document.documentElement.dataset.mode = mode;
  document.documentElement.style.setProperty("--text", prefs.textSize + "px");
  const meta = document.querySelectorAll('meta[name="theme-color"]');
  meta.forEach(m => m.setAttribute("content", mode === "dark" ? "#161615" : "#D8D8D5"));
}
darkQuery.addEventListener("change", applyTheme);
function toggleTheme() {
  const dark = document.documentElement.dataset.mode === "dark";
  prefs.appearance = dark ? "light" : "dark"; savePrefs(); applyTheme();
  player.artCache && player.artCache.clear(); player.updateNowPlaying();
}
const switchHTML = () => `<button class="switch" data-act="theme" aria-label="Switch light or dark"><span></span></button>`;

// ---------- State ----------
let books = [];
const making = [];
const coverURLs = new Map();
async function coverURL(rec) {
  if (!rec.cover) return null;
  const key = `${rec.id}/${rec.cover}`;
  if (coverURLs.has(key)) return coverURLs.get(key);
  const b = await db.get("files", key);
  const u = b ? URL.createObjectURL(b) : null;
  coverURLs.set(key, u);
  return u;
}
async function loadBooks() {
  books = (await db.all("books")) || [];
  books.sort((a, b) => (b.lastOpened || b.added || 0) - (a.lastOpened || a.added || 0));
}
function stateText(b) {
  if (b.finished) return "Finished";
  if (!b.progress) return "New";
  const c = (b.chapters || [])[b.progress.ch];
  return `${c ? chapterLabel(c) : "Chapter"} · ${Math.round((b.percent || 0) * 100)}%`;
}

// ---------- Library ----------
let libraryEl = null;
async function renderLibrary() {
  await loadBooks();
  const playing = !!player.record;
  const el = h(`<main class="library gutter ${playing ? "playing" : ""}">
    <div class="lib-top"><h1>Library</h1>${switchHTML()}</div>
    <div class="grid" id="grid"></div>
    <div class="dock gutter">
      <div id="miniSlot"></div>
      <div class="dock-row">
        <button class="add" data-act="add" aria-label="Add a book">${I.plus}ADD BOOK</button>
        <button class="aa" data-act="settings" aria-label="Settings">Aa</button>
      </div>
    </div>
  </main>`);
  const grid = el.querySelector("#grid");
  if (!books.length && !making.length) {
    grid.replaceWith(h(`<div class="empty"><hr class="hair">
      <div class="step"><span class="mono">01</span><span>Tap Add book and choose the book's PDF, or a .zip made with the ChatGPT prompt.</span></div>
      <div class="step"><span class="mono">02</span><span>Remagery gets it ready on your phone in about a minute. Keep this page open while it works.</span></div>
      <div class="step"><span class="mono">03</span><span>Tap the book. Images appear as they're mentioned. Read shows the text.</span></div>
    </div>`));
  }
  for (const job of making) grid.appendChild(makingCard(job));
  for (const b of books) {
    const card = h(`<button class="cover" style="transform:rotate(${coverTilt(b.id)}deg)" aria-label="${esc(b.title)}. ${esc(stateText(b))}">
      <div class="frame"><div class="titlecard">${esc(b.title)}</div>
      ${(b.progress || b.finished) ? `<div class="bar"><i style="width:${b.finished ? 100 : Math.round((b.percent || 0) * 100)}%"></i></div>` : ""}</div></button>`);
    coverURL(b).then(u => { if (u) card.querySelector(".titlecard").replaceWith(h(`<img alt="" src="${u}">`)); });
    card.addEventListener("click", () => openBook(b));
    longPress(card, () => confirmDialog("Remove this book?", "Its images and voice are deleted from this phone.", "Remove", async () => {
      if (player.record && player.record.id === b.id) player.close();
      await Promise.all([db.del("books", b.id), db.del("packages", b.id), db.delPrefix("files", b.id + "/"), db.delPrefix("audio", b.id + "/")]);
      renderLibrary();
    }));
    grid.appendChild(card);
  }
  el.querySelector("#miniSlot").replaceWith(miniPlayer());
  if (libraryEl) libraryEl.replaceWith(el); else $app.prepend(el);
  libraryEl = el;
}

function makingCard(job) {
  const card = h(`<button class="cover making" style="transform:rotate(${coverTilt(job.id)}deg)" aria-label="Making ${esc(job.title)}. Tap to stop.">
    <div class="frame"><div class="titlecard">${esc(job.title)}</div><div class="bar"><i style="width:${Math.round(job.progress * 100)}%"></i></div></div>
    <span class="mono soft status">${esc(job.status)} · ${Math.round(job.progress * 100)}%</span></button>`);
  if (job.coverURL) card.querySelector(".titlecard").replaceWith(h(`<img alt="" src="${job.coverURL}">`));
  card.addEventListener("click", () => {
    if (job.progress < 0.99) confirmDialog("Stop making this book?", "", "Stop", () => { job.cancelled = true; }, "Keep going");
  });
  job.card = card;
  return card;
}

function longPress(el, fn) {
  let t = null, fired = false;
  el.addEventListener("touchstart", () => { fired = false; t = setTimeout(() => { fired = true; fn(); }, 600); }, { passive: true });
  ["touchend", "touchmove", "touchcancel"].forEach(e => el.addEventListener(e, () => clearTimeout(t), { passive: true }));
  el.addEventListener("contextmenu", e => { e.preventDefault(); if (!fired) fn(); });
  el.addEventListener("click", e => { if (fired) { e.stopImmediatePropagation(); e.preventDefault(); fired = false; } }, true);
}

function miniPlayer() {
  const r = player.record;
  if (!r) return h(`<div id="miniSlot" hidden></div>`);
  const c = player.chapterInfo();
  const el = h(`<div class="mini" id="miniSlot">
    <button class="open" aria-label="Open player"><span class="img"></span>
      <span style="min-width:0"><div class="t">${esc(r.title)}</div><div class="s mono">${c ? esc(chapterLabel(c) + " · " + c.title) : ""}</div></span></button>
    <button class="pp" aria-label="${player.isPlaying ? "Pause" : "Play"}"><span style="width:17px;height:17px;display:block">${player.isPlaying ? I.pause : I.play}</span></button>
  </div>`);
  coverURL(r).then(u => { if (u) el.querySelector(".img").replaceWith(h(`<img alt="" src="${u}">`)); });
  el.querySelector(".open").onclick = () => showPlayer();
  el.querySelector(".pp").onclick = () => { player.unlock(); player.toggle(); };
  return el;
}

// ---------- Adding books ----------
const picker = document.getElementById("filePick");
picker.addEventListener("change", () => {
  const files = [...picker.files];
  picker.value = "";
  for (const f of files) startMaking(f);
});

async function startMaking(file) {
  keepStorage();
  const id = uid();
  const isPDF = /\.pdf$/i.test(file.name) || file.type === "application/pdf";
  const job = { id, title: file.name.replace(/\.[^.]+$/, "").replace(/[_-]/g, " "), status: isPDF ? "Reading the PDF" : "Opening", progress: 0, cancelled: false };
  making.unshift(job);
  renderLibrary();
  let last = 0;
  const progress = (status, p) => {
    job.status = status; job.progress = p;
    if (job.cover && !job.coverURL) { job.coverURL = URL.createObjectURL(job.cover); last = 0; }
    if (Date.now() - last > 250 && job.card) {
      last = Date.now();
      const fresh = makingCard(job);
      job.card.replaceWith(fresh);
    }
  };
  try {
    const book = isPDF ? await makeBookFromPDF(file, id, progress, job) : await importPackage(file, id, progress);
    if (job.cancelled) throw new Cancelled();
    await db.put("packages", id, book);
    await db.put("books", id, {
      id, title: book.title, authors: book.authors || "", cover: book.cover || null,
      chapters: book.chapters.map(c => ({ number: c.number ?? 0, title: c.title || "" })),
      added: Date.now(), lastOpened: null, progress: null, finished: false, bookmarks: [], percent: 0,
    });
  } catch (e) {
    await Promise.all([db.delPrefix("files", id + "/"), db.del("packages", id)]).catch(() => {});
    if (!(e instanceof Cancelled)) alertDialog("Couldn't make the book", e.message || "Something went wrong.");
  }
  making.splice(making.indexOf(job), 1);
  renderLibrary();
}

// ---------- Player screen ----------
let playerEl = null;
let follow = true;

async function openBook(b) {
  player.unlock();
  showPlayer();
  await player.open(b);
}

function showPlayer() {
  if (playerEl) return;
  playerEl = h(`<section class="player" aria-label="Player">
    <div class="p-top"><div class="row">
      <button class="back" data-act="close" aria-label="Back to library">${I.back}</button>
      ${switchHTML()}
      <button class="tag chapters" data-act="chapters" aria-label="Chapters and bookmarks">Chapters</button>
    </div></div>
    <div class="p-scroll"><div class="p-inner gutter" id="pContent"></div></div>
    <button class="tag follow" data-act="follow" hidden>Follow the narrator ↓</button>
    <div class="controls gutter" id="pControls"></div>
  </section>`);
  document.body.appendChild(playerEl);
  const scroll = playerEl.querySelector(".p-scroll");
  const stopFollow = () => { if (prefs.mode === "read" && follow) { follow = false; playerEl.querySelector(".follow").hidden = false; } };
  scroll.addEventListener("touchmove", stopFollow, { passive: true });
  scroll.addEventListener("wheel", stopFollow, { passive: true });
  renderControls();
  renderContent();
}

function closePlayer() {
  if (!playerEl) return;
  playerEl.remove(); playerEl = null;
  renderLibrary();
}

function headerHTML() {
  const r = player.record, c = player.chapterInfo();
  if (!r || !c) return "";
  const label = chapterLabel(c);
  const count = r.chapters.filter(x => x.number > 0).length;
  const t = /[.?!]$/.test(c.title) ? c.title : c.title + ".";
  return `<span class="mono soft ch-label">${esc(label.startsWith("Chapter") ? `${label} of ${count}` : label)}</span><h2 class="title ch-title">${esc(t)}</h2>`;
}

function noticeHTML() {
  if (player.error) return `<div class="notice"><span>${esc(player.error)}</span><button class="tag" data-act="retry">Try again</button></div>`;
  return "";
}

async function renderContent() {
  if (!playerEl) return;
  const box = playerEl.querySelector("#pContent");
  if (!player.record) { box.innerHTML = ""; return; }
  if (prefs.mode === "read") {
    box.innerHTML = `${headerHTML()}${noticeHTML()}<hr class="hair" style="margin-top:18px">
      <div class="read-head"><span class="mono">Read-along</span><button class="mono soft" data-act="bookmarks" style="height:40px">Bookmarks (${(player.record.bookmarks || []).length})</button></div>
      <div class="read-text" id="readText"></div>`;
    const rt = box.querySelector("#readText");
    const S = player.sentences;
    player.paraStarts.forEach((st, pi) => {
      const en = pi + 1 < player.paraStarts.length ? player.paraStarts[pi + 1] : S.length;
      if (en <= st) return;
      const row = h(`<div class="para" data-p="${pi}"><p></p><span class="bmslot"></span></div>`);
      const p = row.querySelector("p");
      for (let k = st; k < en; k++) {
        const s = document.createElement("s");
        s.dataset.k = k; s.textContent = S[k].text;
        p.appendChild(s);
        if (k < en - 1) p.appendChild(document.createTextNode(" "));
      }
      rt.appendChild(row);
    });
    if (!S.length) rt.innerHTML = `<p style="font-size:calc(var(--text) - 1px)">This book has no text for read-along. Tap Images to see the pictures.</p>`;
    rt.addEventListener("click", e => {
      const k = e.target.dataset && e.target.dataset.k;
      if (k !== undefined) { player.unlock(); follow = true; playerEl.querySelector(".follow").hidden = true; player.jumpTo(+k); }
    });
    updateHighlight(true);
  } else {
    box.innerHTML = `${headerHTML()}${noticeHTML()}<div id="figSlot"></div>`;
    await renderFigure();
  }
}

async function renderFigure() {
  if (!playerEl || prefs.mode === "read") return;
  const slot = playerEl.querySelector("#figSlot");
  if (!slot) return;
  const im = player.image;
  if (im) {
    const u = await player.fileURL(im.file);
    if (player.image !== im) return;
    slot.innerHTML = `<div class="figure fade-in">
      ${u ? `<img alt="${esc(im.description || "Image")}" src="${u}">` : ""}
      <hr class="hair" style="margin-top:18px">
      <span class="mono cap">${esc(im.caption || "Image")}</span>
      ${im.description ? `<p class="desc">${esc(im.description)}</p>` : ""}
      <span class="mono soft" style="display:block;margin-top:16px">Tap the image to zoom</span></div>`;
    const img = slot.querySelector("img");
    if (img) img.onclick = () => showZoom(u);
  } else {
    const u = await coverURL(player.record);
    slot.innerHTML = `<div class="coverwait fade-in">${u ? `<img alt="Book cover" src="${u}">` : ""}<hr class="hair">
      <span class="mono soft">Images appear here when the narrator mentions them</span></div>`;
    const img = slot.querySelector("img");
    if (img) img.onclick = () => showZoom(u);
  }
}

let lastCur = -2;
function updateHighlight(force) {
  if (!playerEl || prefs.mode !== "read") return;
  const cur = player.cur;
  if (cur === lastCur && !force) return;
  lastCur = cur;
  const rt = playerEl.querySelector("#readText");
  if (!rt) return;
  rt.querySelectorAll("s.now").forEach(s => s.classList.remove("now"));
  const saved = new Set((player.record.bookmarks || []).filter(b => b.ch === player.ch).map(b => b.sid));
  rt.querySelectorAll("s").forEach(s => s.classList.toggle("saved", saved.has(player.sentenceID(+s.dataset.k))));
  const curLine = player.sentences[cur];
  rt.querySelectorAll(".para").forEach(row => {
    const pi = +row.dataset.p;
    row.classList.toggle("past", !!curLine && pi < curLine.paragraph);
    row.querySelector(".bmslot").innerHTML = "";
  });
  if (cur < 0 || !curLine) return;
  const s = rt.querySelector(`s[data-k="${cur}"]`);
  if (!s) return;
  s.classList.add("now");
  const row = s.closest(".para");
  const saved1 = player.isSaved(player.sentenceID(cur));
  row.querySelector(".bmslot").innerHTML = `<button class="bm" data-act="bookmark" aria-label="Bookmark this sentence">${saved1 ? I.bmFull : I.bm}</button>`;
  if (follow) {
    const scroll = playerEl.querySelector(".p-scroll");
    const top = s.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop - scroll.clientHeight * 0.35;
    scroll.scrollTo({ top: Math.max(0, top), behavior: force ? "auto" : "smooth" });
  }
}

let scrubbing = null;
function renderControls() {
  if (!playerEl) return;
  const box = playerEl.querySelector("#pControls");
  box.innerHTML = `
    <div class="prep mono soft" id="prep"></div>
    <div class="times"><span class="mono" id="tNow">0:00</span>
      <span class="mid"><button class="mono soft" data-act="sleep" id="sleepBtn" aria-label="Sleep timer">Sleep</button><button class="mono soft" data-act="settings" aria-label="Voice, text size and settings">Aa</button></span>
      <span class="mono soft" id="tLeft">-0:00</span></div>
    <div class="scrub" id="scrub" role="slider" aria-label="Position in chapter" tabindex="0"><div class="track"></div><div class="fill"></div><div class="knob"></div></div>
    <div class="buttons">
      <button class="tag line" data-act="speed" aria-label="Playback speed" id="speedBtn">${speedText(player.speed)}</button>
      <button class="ib" data-act="b15" aria-label="Back 15 seconds">${I.b15}</button>
      <button class="ib" data-act="prev" aria-label="Previous chapter">${I.prev}</button>
      <button class="playbtn" data-act="play" id="playBtn" aria-label="Play">${I.play}</button>
      <button class="ib" data-act="next" aria-label="Next chapter">${I.next}</button>
      <button class="ib" data-act="f30" aria-label="Forward 30 seconds">${I.f30}</button>
      <button class="tag line" data-act="mode" id="modeBtn">${prefs.mode === "read" ? "Images" : "Read"}</button>
    </div>`;
  const sc = box.querySelector("#scrub");
  const at = e => { const r = sc.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * (player.duration || 0); };
  sc.addEventListener("pointerdown", e => { sc.setPointerCapture(e.pointerId); scrubbing = at(e); updateTime(); });
  sc.addEventListener("pointermove", e => { if (scrubbing !== null) { scrubbing = at(e); updateTime(); } });
  sc.addEventListener("pointerup", e => { if (scrubbing !== null) { player.seek(at(e)); scrubbing = null; updateTime(); } });
  sc.addEventListener("keydown", e => { if (e.key === "ArrowLeft") player.skip(-15); if (e.key === "ArrowRight") player.skip(30); });
  updateState();
  updateTime();
}

function updateTime() {
  if (!playerEl) return;
  const t = scrubbing ?? player.time, d = player.duration || 0;
  const q = id => playerEl.querySelector(id);
  if (!q("#tNow")) return;
  q("#tNow").textContent = fmt(t);
  q("#tLeft").textContent = "-" + fmt(d - t);
  const pct = d ? Math.max(0, Math.min(100, t / d * 100)) : 0;
  q("#scrub .fill").style.width = pct + "%";
  q("#scrub .knob").style.left = pct + "%";
  q("#scrub").setAttribute("aria-valuetext", fmt(t));
}

function sleepLabel() {
  if (!player.sleep) return "Sleep";
  if (player.sleep.endOfChapter) return "Sleep: end";
  return "Sleep " + fmt((player.sleepEnd - Date.now()) / 1000);
}

function updateState() {
  if (!playerEl) return;
  const pb = playerEl.querySelector("#playBtn");
  if (pb) { pb.innerHTML = player.isPlaying ? I.pause : I.play; pb.setAttribute("aria-label", player.isPlaying ? "Pause" : "Play"); }
  const sp = playerEl.querySelector("#speedBtn");
  if (sp) sp.textContent = speedText(player.speed);
  const sl = playerEl.querySelector("#sleepBtn");
  if (sl) { sl.textContent = sleepLabel(); sl.classList.toggle("soft", !player.sleep); }
  const prep = playerEl.querySelector("#prep");
  if (prep) prep.textContent = player.preparing ? `Preparing the voice · ${player.preparing.done} of ${player.preparing.total}` : "";
}
setInterval(() => { if (playerEl && player.sleep && player.sleep.minutes) updateState(); }, 1000);

// ---------- Player events ----------
player.on(kind => {
  if (kind === "book" || kind === "chapter") { follow = true; lastCur = -2; if (playerEl) { playerEl.querySelector(".follow").hidden = true; playerEl.querySelector(".p-scroll").scrollTop = 0; } renderContent(); }
  if (kind === "image") renderFigure();
  if (kind === "sentence") updateHighlight();
  if (kind === "time") updateTime();
  if (kind === "bookmarks") { updateHighlight(true); const b = playerEl && playerEl.querySelector('[data-act="bookmarks"]'); if (b) b.textContent = `Bookmarks (${(player.record.bookmarks || []).length})`; }
  if (kind === "state") {
    updateState();
    const n = playerEl && playerEl.querySelector(".notice");
    if (!!n !== !!player.error) renderContent();
    if (!playerEl && libraryEl) { const m = libraryEl.querySelector("#miniSlot"); if (m) m.replaceWith(miniPlayer()); }
  }
});

// ---------- Sheets ----------
function openSheet(title, body, after) {
  const back = h(`<div class="sheet-back"><div class="sheet gutter" role="dialog" aria-label="${esc(title)}">
    <div class="sheet-head"><h2 class="title">${esc(title)}</h2><button class="close" data-x aria-label="Close">${I.x}</button></div>
    <div class="sheet-body"></div></div></div>`);
  const close = () => back.remove();
  back.addEventListener("click", e => { if (e.target === back || e.target.closest("[data-x]")) close(); });
  document.body.appendChild(back);
  const fill = () => { const b = back.querySelector(".sheet-body"); b.innerHTML = ""; b.appendChild(body(close, fill)); after && after(back); };
  fill();
  return close;
}

function chaptersSheet(tab = 0) {
  openSheet("Chapters", (close, refill) => {
    const wrap = h(`<div><div class="seg"><button aria-pressed="${tab === 0}">Chapters</button><button aria-pressed="${tab === 1}">Bookmarks</button></div><div class="list"></div></div>`);
    const [b0, b1] = wrap.querySelectorAll(".seg button");
    b0.onclick = () => { tab = 0; refill(); };
    b1.onclick = () => { tab = 1; refill(); };
    const list = wrap.querySelector(".list");
    if (!player.book) return wrap;
    if (tab === 0) {
      player.book.chapters.forEach((c, i) => {
        const on = i === player.ch;
        const row = h(`<button class="${on ? "on" : ""}"><span><span class="num">${esc(chapterLabel({ number: c.number ?? i, title: c.title }))}</span><span class="name">${esc(c.title)}</span></span><span>${on ? I.tick : ""}</span></button>`);
        row.onclick = () => { player.unlock(); close(); player.load(i, 0, true); };
        list.appendChild(row);
      });
    } else {
      const bms = [...(player.record.bookmarks || [])].sort((a, b) => a.ch - b.ch || a.s - b.s);
      if (!bms.length) list.appendChild(h(`<p class="help" style="margin:0">No bookmarks yet. In read-along, tap the bookmark next to the highlighted sentence to save it.</p>`));
      for (const b of bms) {
        const c = player.book.chapters[b.ch];
        const row = h(`<div><button style="text-align:left"><span class="num">${esc(c ? chapterLabel(c) : "")}</span><span class="name">${esc(b.text)}</span></button><button class="close" aria-label="Remove bookmark">${I.x}</button></div>`);
        const [go, rm] = row.querySelectorAll("button");
        go.onclick = () => { player.unlock(); close(); player.goToBookmark(b); };
        rm.onclick = () => { player.removeBookmark(b.sid); refill(); };
        list.appendChild(row);
      }
    }
    return wrap;
  });
}

function sleepSheet() {
  openSheet("Sleep", close => {
    const opts = [["Off", null], ["15 minutes", { minutes: 15 }], ["30 minutes", { minutes: 30 }], ["45 minutes", { minutes: 45 }], ["60 minutes", { minutes: 60 }], ["End of chapter", { endOfChapter: true }]];
    const wrap = h(`<div class="list"></div>`);
    for (const [label, mode] of opts) {
      const on = JSON.stringify(player.sleep) === JSON.stringify(mode);
      const row = h(`<button class="${on ? "on" : ""}"><span class="name">${label}</span><span>${on ? I.tick : ""}</span></button>`);
      row.onclick = () => { player.setSleep(mode); close(); };
      wrap.appendChild(row);
    }
    return wrap;
  });
}

let sampleAudio = null;
function settingsSheet() {
  openSheet("Settings", (close, refill) => {
    const voiceOn = hasVoiceServer();
    const cur = prefs.voice || DEFAULT_VOICE;
    const wrap = h(`<div>
      <div class="section"><span class="mono soft">Appearance</span>
        <div class="seg">${["system", "light", "dark"].map(m => `<button data-ap="${m}" aria-pressed="${prefs.appearance === m}">${m === "system" ? "Auto" : m}</button>`).join("")}</div></div>
      <div class="section"><span class="mono soft">Text size</span>
        <div class="sizes"><span style="font-size:15px">A</span><input type="range" id="tsize" min="16" max="30" step="1" value="${prefs.textSize}" aria-label="Text size"><span style="font-size:26px">A</span></div></div>
      <div class="section"><span class="mono soft">Speed</span>
        <div class="seg">${[0.8, 1, 1.15, 1.25, 1.5, 1.75, 2].map(s => `<button data-sp="${s}" aria-pressed="${player.speed === s}">${s}</button>`).join("")}</div></div>
      <div class="section"><span class="mono soft">Voice</span>
        ${voiceOn ? `<div class="list" id="voices"></div><p class="help">Tap a voice to choose it and hear it. Chapters you've played are kept in the voice they were made with.</p>
          <div id="use"></div>`
        : `<p class="help" style="margin-top:0">The Google voice isn't set up in this copy of Remagery, so the browser's own voice reads. It stops when the phone locks. See SETUP.md, step 2.</p>`}
      </div>
      <div class="section"><span class="mono soft">Images</span>
        <div class="list"><div><span class="name">Sound when an image appears</span><button class="toggle" id="chime" aria-pressed="${prefs.chime !== false}" aria-label="Sound when an image appears"></button></div></div></div>
      <div class="section"><span class="mono soft">On your Home Screen</span>
        <p class="help" style="margin-top:0">In Safari, tap Share, then Add to Home Screen. Remagery opens full screen, and iOS keeps your books safe.</p></div>
    </div>`);
    wrap.querySelectorAll("[data-ap]").forEach(b => b.onclick = () => { prefs.appearance = b.dataset.ap; savePrefs(); applyTheme(); player.artCache && player.artCache.clear(); refill(); });
    wrap.querySelector("#tsize").oninput = e => { prefs.textSize = +e.target.value; savePrefs(); applyTheme(); };
    wrap.querySelectorAll("[data-sp]").forEach(b => b.onclick = () => { player.speed = +b.dataset.sp; refill(); });
    wrap.querySelector("#chime").onclick = e => { prefs.chime = !(prefs.chime !== false); savePrefs(); e.currentTarget.setAttribute("aria-pressed", prefs.chime); };
    if (voiceOn) {
      const list = wrap.querySelector("#voices");
      for (const v of VOICES) {
        const on = v.id === cur;
        const row = h(`<button class="${on ? "on" : ""}"><span class="name">${esc(v.label)}</span><span>${on ? I.tick : ""}</span></button>`);
        row.onclick = async () => {
          const changed = prefs.voice !== v.id;
          prefs.voice = v.id; savePrefs(); refill();
          if (!player.isPlaying) {
            try { if (sampleAudio) sampleAudio.pause(); sampleAudio = new Audio(await sample(v.id)); sampleAudio.play(); } catch (e) {}
          }
          if (changed && player.record) player.load(player.ch, Math.max(player.cur, 0), player.isPlaying);
        };
        list.appendChild(row);
      }
      usage().then(u => {
        const box = wrap.querySelector("#use");
        if (!u || !box) return;
        const pct = Math.min(100, u.used / u.limit * 100);
        box.innerHTML = `<p class="help">Free voice this month: ${(u.used / 1e6).toFixed(2)} of ${(u.limit / 1e6).toFixed(1)} million characters. A book is roughly half a million.</p><div class="meter"><i style="width:${pct}%"></i></div>`;
      });
    }
    return wrap;
  });
}

// ---------- Zoom and dialogs ----------
function showZoom(url) {
  if (!url) return;
  const z = h(`<div class="zoom" role="dialog" aria-label="Image"><img alt="" src="${url}"><button class="close" aria-label="Close">${I.x}</button></div>`);
  z.querySelector(".close").onclick = () => z.remove();
  let lastTap = 0;
  z.querySelector("img").addEventListener("click", () => { const n = Date.now(); if (n - lastTap < 350) z.classList.toggle("big"); lastTap = n; });
  document.body.appendChild(z);
}

function confirmDialog(title, text, action, onYes, cancelText = "Cancel") {
  const d = h(`<div class="sheet-back" style="align-items:center"><div class="dialog" role="alertdialog">
    <h2 class="title">${esc(title)}</h2>${text ? `<p>${esc(text)}</p>` : ""}
    <div class="btn-row"><button class="tag" data-yes>${esc(action)}</button><button class="tag line" data-no>${esc(cancelText)}</button></div></div></div>`);
  d.querySelector("[data-yes]").onclick = () => { d.remove(); onYes(); };
  d.querySelector("[data-no]").onclick = () => d.remove();
  d.addEventListener("click", e => { if (e.target === d) d.remove(); });
  document.body.appendChild(d);
}
function alertDialog(title, text) {
  const d = h(`<div class="sheet-back" style="align-items:center"><div class="dialog" role="alertdialog">
    <h2 class="title">${esc(title)}</h2><p>${esc(text)}</p><div class="btn-row"><button class="tag" data-no>OK</button></div></div></div>`);
  d.querySelector("[data-no]").onclick = () => d.remove();
  document.body.appendChild(d);
}

// ---------- Taps ----------
document.addEventListener("click", e => {
  const b = e.target.closest("[data-act]");
  if (!b) return;
  const act = b.dataset.act;
  if (["play", "b15", "f30", "prev", "next", "retry"].includes(act)) player.unlock();
  switch (act) {
    case "theme": toggleTheme(); break;
    case "add": picker.click(); break;
    case "settings": settingsSheet(); break;
    case "close": closePlayer(); break;
    case "chapters": chaptersSheet(0); break;
    case "bookmarks": chaptersSheet(1); break;
    case "sleep": sleepSheet(); break;
    case "play": player.toggle(); break;
    case "b15": player.skip(-15); break;
    case "f30": player.skip(30); break;
    case "prev": player.prevChapter(); break;
    case "next": player.nextChapter(); break;
    case "retry": player.play(); break;
    case "bookmark": player.toggleBookmark(); break;
    case "speed": {
      const sp = [0.8, 1, 1.15, 1.25, 1.5, 1.75, 2];
      const i = sp.indexOf(player.speed);
      player.speed = sp[(i + 1) % sp.length];
      break;
    }
    case "mode":
      prefs.mode = prefs.mode === "read" ? "images" : "read"; savePrefs();
      follow = true; lastCur = -2;
      playerEl.querySelector(".follow").hidden = true;
      b.textContent = prefs.mode === "read" ? "Images" : "Read";
      renderContent();
      break;
    case "follow":
      follow = true; b.hidden = true; updateHighlight(true); break;
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") player.saveProgress(true);
  else { player.tick(player.useAudio ? player.audio.currentTime : player.time); renderFigure(); }
});

// ---------- Start ----------
applyTheme();
renderLibrary();
