// Remagery web app: library, player and sheets in the Studio look.
import { db, keepStorage } from "./db.js";
import { prefs, savePrefs } from "./prefs.js";
import { player } from "./player.js";
import { makeBookFromPDF, Cancelled } from "./bookmaker.js";
import { VOICES, DEFAULT_VOICE } from "./config.js";
import { hasVoiceServer, usage, sample, chapterAudio } from "./voice.js";
import * as G from "./google.js";
import { sync, onSync, syncStatus, syncError, uploadBook, downloadBook, removeBook, rootLink, scheduleSync } from "./sync.js";

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
// ---------- First screens: Home Screen guide (iPhone browsers) and welcome (sign in) ----------
const ua = navigator.userAgent;
const isIOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isStandalone = navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;
/// On iPhone, Remagery is used from the Home Screen only: a browser tab has its own separate storage.
const needsHomeScreen = isIOS && !isStandalone;

function browserName() {
  if (/CriOS/.test(ua)) return "chrome";
  if (/FxiOS/.test(ua)) return "firefox";
  if (/EdgiOS/.test(ua)) return "edge";
  if (/Safari/.test(ua) && !/(OPiOS|YaBrowser|DuckDuckGo|GSA)/.test(ua)) return "safari";
  return "other";
}

const DOTS = '<span class="ios-btn" aria-label="More"><svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg></span>';
const SHARE = '<span class="ios-btn" aria-label="Share"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7.5 7.5 12 3l4.5 4.5"/><path d="M6 11H5v10h14V11h-1"/></svg></span>';
const ADD = '<span class="ios-btn" aria-label="Add"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="4" y="4" width="16" height="16" rx="4"/><path d="M12 8v8M8 12h8"/></svg></span>';

function renderGuide() {
  const b = browserName();
  const first = {
    safari: `Tap ${DOTS} at the bottom right, then ${SHARE} <b>Share</b>.`,
    chrome: `Tap ${SHARE} <b>Share</b> in the address bar at the top.`,
    firefox: `Tap ${DOTS} (the menu), then ${SHARE} <b>Share</b>.`,
    edge: `Tap ${DOTS} (the menu), then ${SHARE} <b>Share</b>.`,
    other: `Open your browser's ${SHARE} <b>Share</b> menu.`,
  }[b];
  const top = b === "chrome";
  const el = h(`<main class="gate gutter">
    ${top ? `<div class="pointer top mono soft">Start here ↗</div>` : ""}
    <div class="brand"><img class="app-icon" alt="" src="icon-180.png"><span class="mono soft">Remagery</span></div>
    <h1 class="title gate-title">Put Remagery on your Home Screen.</h1>
    <p class="gate-text">On iPhone, Remagery works as an app. It keeps reading when the phone is locked, works offline, and keeps your books in one place.</p>
    <hr class="hair">
    <div class="steps">
      <div class="step"><span class="mono soft">01</span><span>${first}</span></div>
      <div class="step"><span class="mono soft">02</span><span>Scroll down and tap ${ADD} <b>Add to Home Screen</b>.</span></div>
      <div class="step"><span class="mono soft">03</span><span>Tap <b>Add</b>, then open Remagery from your Home Screen.</span></div>
    </div>
    ${top ? "" : `<div class="pointer mono soft">${b === "safari" ? "Start here ↘" : "Start with the menu ↘"}</div>`}
  </main>`);
  $app.innerHTML = "";
  $app.appendChild(el);
}

function welcomeView() {
  return h(`<main class="gate gutter">
    <span class="mono soft">Welcome</span>
    <h1 class="title welcome-title">Remagery.</h1>
    <p class="gate-text">Design books read aloud, with each image shown when the text talks about it.</p>
    <div class="facts">
      <div class="fact"><span class="mono soft">Your library</span><span>Books and progress live in a Remagery folder in your own Google Drive.</span></div>
      <div class="fact"><span class="mono soft">Your privacy</span><span>Remagery only sees the files it makes and the PDFs you pick.</span></div>
    </div>
    <div class="gate-bottom">
      <button class="add" data-act="signin"><span class="g-dot">G</span>Sign in with Google</button>
      <p class="help" style="text-align:center;margin-top:12px">Google will ask to let Remagery use its own folder in your Drive. Tick the box and tap Continue.</p>
      <p class="help" style="text-align:center;margin-top:10px"><a class="mono" style="color:inherit" href="privacy.html">Privacy</a></p>
    </div>
  </main>`);
}

async function renderLibrary() {
  if (needsHomeScreen) { renderGuide(); return; }
  // Signing in is required: your library lives in your Google Drive
  if (G.googleReady() && !G.account()) {
    const w = welcomeView();
    if (libraryEl) libraryEl.replaceWith(w); else $app.prepend(w);
    libraryEl = w;
    return;
  }
  await loadBooks();
  const playing = !!player.record;
  const el = h(`<main class="library gutter ${playing ? "playing" : ""}">
    <div class="lib-top"><h1>Library</h1>${switchHTML()}</div>
    <div id="acctSlot"></div>
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
      ${G.googleReady() && !G.account() ? `<div class="step"><span class="mono">01</span><span>Sign in with Google. Your books and progress are kept in a Remagery folder in your Google Drive.</span></div>` : ""}
      <div class="step"><span class="mono">${G.googleReady() && !G.account() ? "02" : "01"}</span><span>Tap Add book and choose a book's PDF, from Google Drive or this phone.</span></div>
      <div class="step"><span class="mono">${G.googleReady() && !G.account() ? "03" : "02"}</span><span>Remagery gets it ready, voice included, in a minute or two. Keep this page open while it works.</span></div>
      <div class="step"><span class="mono">${G.googleReady() && !G.account() ? "04" : "03"}</span><span>Tap the book. Images appear as they're mentioned. Read shows the text.</span></div>
    </div>`));
  }
  for (const job of making) grid.appendChild(makingCard(job));
  for (const b of books) {
    if (making.some(j => j.id === b.id)) continue; // being downloaded: its card shows progress instead
    const remote = b.local === false;
    const card = h(`<button class="cover ${remote ? "remote" : ""}" style="transform:rotate(${coverTilt(b.id)}deg)" aria-label="${esc(b.title)}. ${esc(stateText(b))}${remote ? ". In Google Drive, downloads when you open it" : ""}">
      <div class="frame"><div class="titlecard">${esc(b.title)}</div>${remote ? `<span class="drive-tag mono">In Drive</span>` : ""}
      ${(b.progress || b.finished) ? `<div class="bar"><i style="width:${b.finished ? 100 : Math.round((b.percent || 0) * 100)}%"></i></div>` : ""}</div></button>`);
    coverURL(b).then(u => { if (u) card.querySelector(".titlecard").replaceWith(h(`<img alt="" src="${u}">`)); });
    card.addEventListener("click", () => openBook(b));
    longPress(card, () => confirmDialog("Remove this book?",
      b.drive ? "It's removed from this phone and its folder goes to the bin in your Google Drive. Your original PDF isn't touched." : "Its images and voice are deleted from this phone.",
      "Remove", async () => {
        if (player.record && player.record.id === b.id) player.close();
        await removeBook(b);
        renderLibrary();
      }));
    grid.appendChild(card);
  }
  el.querySelector("#miniSlot").replaceWith(miniPlayer());
  el.querySelector("#acctSlot").replaceWith(accountLine());
  if (libraryEl) libraryEl.replaceWith(el); else $app.prepend(el);
  libraryEl = el;
}

/// Under the Library title: who's signed in and whether the library is saved in Drive.
function accountLine() {
  if (!G.googleReady()) return h(`<div id="acctSlot" hidden></div>`);
  const email = G.account();
  if (!email) {
    const el = h(`<div id="acctSlot" class="acct"><button class="tag" data-act="signin">Sign in with Google</button><span class="mono soft">Keep your books in your Google Drive</span></div>`);
    return el;
  }
  const st = syncStatus();
  const tokenOK = !!G.token();
  const text = (st && st.length < 22 ? st : st ? "Syncing" : "") || (tokenOK ? "Synced" : "Tap to sync");
  const el = h(`<div id="acctSlot" class="acct"><button class="mono soft acct-btn">${esc(email)} · ${esc(text)}</button></div>`);
  el.querySelector("button").onclick = () => {
    if (!tokenOK) { G.signIn(); return; }
    if (!G.hasDrive()) {
      confirmDialog("Remagery can't use your Drive", "On Google's page, the box for Google Drive was left unticked. Sign in again and tick it, so Remagery can save your books in its own folder.", "Sign in again", () => G.signIn({ consent: true }));
      return;
    }
    if (st && syncError()) {
      confirmDialog("Not synced", "Google Drive answered: " + syncError(), "Try again", () => sync());
      return;
    }
    settingsSheet();
  };
  return el;
}
function refreshAccount() { const a = libraryEl && libraryEl.querySelector("#acctSlot"); if (a) a.replaceWith(accountLine()); }

function addSheet() {
  if (!G.googleReady()) { picker.click(); return; }
  openSheet("Add a book", close => {
    const wrap = h(`<div class="options">
      <button class="opt add-opt" data-src="drive"><span><span class="opt-title">From Google Drive</span><span class="opt-sub">Choose a PDF in your Drive</span></span></button>
      <button class="opt add-opt" data-src="phone"><span><span class="opt-title">From this phone</span><span class="opt-sub">Files, iCloud, Downloads</span></span></button>
    </div>`);
    wrap.querySelector('[data-src="phone"]').onclick = () => { close(); picker.click(); };
    wrap.querySelector('[data-src="drive"]').onclick = () => { close(); addFromDrive(); };
    const note = h(`<p class="help" style="margin-top:14px">${G.account() ? "Finished books are saved in the Remagery folder in your Google Drive." : "You'll sign in with Google first. Finished books are saved in a Remagery folder in your Google Drive."}</p>`);
    const box = document.createElement("div"); box.append(wrap, note);
    return box;
  });
}

async function addFromDrive() {
  if (!G.token()) { G.signIn({ intent: "add-drive" }); return; }
  if (!(await G.checkScope())) { G.signIn({ intent: "add-drive", consent: true }); return; }
  let picked = [];
  try { picked = await G.pickFromDrive(); }
  catch (e) { alertDialog("Google Drive didn't open", "Check your internet connection and try again."); return; }
  for (const f of picked) startMaking({ driveId: f.id, name: f.name, type: f.mimeType });
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
  const isPDF = /\.pdf$/i.test(file.name) || /pdf/.test(file.type || "");
  if (!isPDF) { alertDialog("That isn't a PDF", "Remagery makes books from PDF files. Choose the book's PDF."); return; }
  // Each person can start 5 new books a month: say so before doing the work
  const u = await usage();
  if (u && u.bookLimit && u.books >= u.bookLimit) {
    alertDialog("No new books this month", `You've started ${u.bookLimit} new books this month. You can add more from the 1st. Books you've already started keep playing.`);
    return;
  }
  const fromDrive = !!file.driveId;
  const job = { id, title: file.name.replace(/\.[^.]+$/, "").replace(/[_-]/g, " "), status: "Reading the PDF", progress: 0, cancelled: false };
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
    if (fromDrive) {
      progress("Downloading from Drive", 0);
      const blob = await G.download(file.driveId, p => progress("Downloading from Drive", p * 0.15));
      file = new File([blob], file.name, { type: blob.type || file.type });
    }
    const base = fromDrive ? 0.15 : 0;
    const book = await makeBookFromPDF(file, id, (s, p) => progress(s, base + p * (0.6 - base)), job);
    if (job.cancelled) throw new Cancelled();
    await db.put("packages", id, book);
    const rec = {
      id, title: book.title, authors: book.authors || "", cover: book.cover || null,
      chapters: book.chapters.map(c => ({ number: c.number ?? 0, title: c.title || "" })),
      added: Date.now(), lastOpened: null, progress: null, finished: false, bookmarks: [], percent: 0, updatedAt: Date.now(),
    };
    // The first chapter's voice, so it plays straight away when you open the book
    await prepareVoice(rec, book, 0, job, progress, 0.6, 0.95);
    if (job.cancelled) throw new Cancelled();
    await db.put("books", id, rec);
    // Save it in the Remagery folder in Google Drive
    if (G.token()) {
      try { await uploadBook(rec, p => progress("Saving to Google Drive", 0.95 + p * 0.04)); scheduleSync(500); }
      catch (e) { scheduleSync(5000); }
    }
  } catch (e) {
    await Promise.all([db.delPrefix("files", id + "/"), db.del("packages", id)]).catch(() => {});
    if (!(e instanceof Cancelled)) alertDialog("Couldn't make the book", e.message || "Something went wrong.");
  }
  making.splice(making.indexOf(job), 1);
  renderLibrary();
}

/// Makes one chapter's voice while the book card shows progress. If it fails (offline, limit),
/// the book is still added and the voice is made when you press play.
async function prepareVoice(rec, book, ci, job, progress, from, to) {
  if (!hasVoiceServer() || !book.chapters[ci]) return;
  try {
    const audio = await chapterAudio(rec.id, ci, book.chapters[ci], prefs.voice || DEFAULT_VOICE, (d, n) => {
      if (job.cancelled) return;
      progress(`Preparing the voice · ${d} of ${n}`, from + (n ? d / n : 0) * (to - from));
    });
    if (rec.chapters[ci]) rec.chapters[ci].duration = audio.duration;
  } catch (e) {}
}

// ---------- Player screen ----------
let playerEl = null;
let follow = true;

async function openBook(b) {
  player.unlock();
  if (b.local === false || !(await db.get("packages", b.id))) {
    b.local = false;
    // The book is in Google Drive but not on this phone yet: download it first
    if (!G.token()) { G.signIn({ intent: "open:" + b.id }); return; }
    if (making.some(j => j.id === b.id)) return;
    const job = { id: b.id, title: b.title, status: "Downloading", progress: 0, cancelled: false };
    making.unshift(job);
    await renderLibrary();
    try {
      let last = 0;
      b = await downloadBook(b, p => {
        job.progress = p * 0.5;
        if (Date.now() - last > 250 && job.card) { last = Date.now(); job.card.replaceWith(makingCard(job)); }
      });
    } catch (e) {
      making.splice(making.indexOf(job), 1);
      renderLibrary();
      alertDialog("Couldn't download the book", e.status === 401 ? "Sign in again and try once more." : "Check your internet connection and try again.");
      return;
    }
    const pkg = await db.get("packages", b.id);
    const ci = (b.progress && b.progress.ch) || 0;
    if (pkg) {
      let last = 0;
      await prepareVoice(b, pkg, ci, job, (s, p) => {
        job.status = s; job.progress = p;
        if (Date.now() - last > 250 && job.card) { last = Date.now(); job.card.replaceWith(makingCard(job)); }
      }, 0.5, 0.99);
      await db.put("books", b.id, b);
    }
    making.splice(making.indexOf(job), 1);
    await renderLibrary();
  }
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

// ---------- Sheets (as in the iPhone app: sheet colour, close circle, outlined rows) ----------
function openSheet(title, body, { head = true } = {}) {
  const back = h(`<div class="sheet-back"><div class="sheet" role="dialog" aria-label="${esc(title)}">
    <div class="grabber"></div>
    ${head ? `<div class="sheet-head"><h2 class="title">${esc(title)}</h2><button class="close" data-x aria-label="Close">${I.x}</button></div>` : ""}
    <div class="sheet-body"></div></div></div>`);
  const close = () => back.remove();
  back.addEventListener("click", e => { if (e.target === back || e.target.closest("[data-x]")) close(); });
  document.body.appendChild(back);
  const fill = () => { const b = back.querySelector(".sheet-body"); b.innerHTML = ""; b.appendChild(body(close, fill)); };
  fill();
  return close;
}

/// iOS-style segmented control.
const segHTML = (items, current, attr) => `<div class="seg" role="group">${items.map(([v, label]) =>
  `<button ${attr}="${v}" aria-pressed="${String(v) === String(current)}">${esc(label)}</button>`).join("")}</div>`;

/// Chapter length: the real one once its voice is made, otherwise an estimate from the text.
function chapterSeconds(i) {
  const known = player.record && player.record.chapters[i] && player.record.chapters[i].duration;
  if (known) return known;
  const c = player.book.chapters[i];
  let n = 0;
  for (const p of c.paragraphs || []) for (const s of p.sentences || []) n += s.text.length + 1;
  return n / 13 / player.speed;
}

function chaptersSheet(tab = 0) {
  openSheet("Chapters", (close, refill) => {
    const wrap = h(`<div><div class="sheet-row">${segHTML([[0, "Chapters"], [1, "Bookmarks"]], tab, "data-tab")}<button class="close" data-x aria-label="Close">${I.x}</button></div><div class="list chapters"></div></div>`);
    wrap.querySelectorAll("[data-tab]").forEach(b => b.onclick = () => { tab = +b.dataset.tab; refill(); });
    const list = wrap.querySelector(".list");
    if (!player.book) return wrap;
    if (tab === 0) {
      player.book.chapters.forEach((c, i) => {
        const on = i === player.ch;
        const num = c.number ?? i;
        const isNotes = (c.title || "").toLowerCase().startsWith("notes");
        const row = h(`<button class="ch-row ${on ? "on" : ""}">
          <span class="ch-num">${num === 0 || isNotes ? "—" : String(num).padStart(2, "0")}</span>
          <span class="ch-name">${esc(c.title)}</span>
          <span class="ch-time">${fmt(chapterSeconds(i))}</span></button>`);
        row.onclick = () => { player.unlock(); close(); player.load(i, 0, true); };
        list.appendChild(row);
      });
      setTimeout(() => { const on = list.querySelector(".on"); if (on) on.scrollIntoView({ block: "center" }); }, 0);
    } else {
      const bms = [...(player.record.bookmarks || [])].sort((a, b) => a.ch - b.ch || a.s - b.s);
      if (!bms.length) list.appendChild(h(`<p class="help">No bookmarks yet.</p>`));
      for (const b of bms) {
        const c = player.book.chapters[b.ch];
        const row = h(`<div class="bm-row"><button class="bm-go"><span class="bm-label">${esc(c ? chapterLabel(c) : "")}</span><span class="bm-text">${esc(b.text)}</span></button><button class="close" aria-label="Remove bookmark">${I.x}</button></div>`);
        const [go, rm] = row.querySelectorAll("button");
        go.onclick = () => { player.unlock(); close(); player.goToBookmark(b); };
        rm.onclick = () => { player.removeBookmark(b.sid); refill(); };
        list.appendChild(row);
      }
    }
    return wrap;
  }, { head: false });
}

function sleepSheet() {
  openSheet("Sleep timer", close => {
    const opts = [["Off", null], ["15 minutes", { minutes: 15 }], ["30 minutes", { minutes: 30 }], ["45 minutes", { minutes: 45 }], ["1 hour", { minutes: 60 }], ["End of this chapter", { endOfChapter: true }]];
    const wrap = h(`<div class="options"></div>`);
    for (const [label, mode] of opts) {
      const on = JSON.stringify(player.sleep) === JSON.stringify(mode);
      const row = h(`<button class="opt ${on ? "on" : ""}"><span>${label}</span><span>${on ? I.tick : ""}</span></button>`);
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
    const speeds = [0.8, 1, 1.15, 1.25, 1.5, 1.75, 2];
    const wrap = h(`<div>
      <div class="label">Voice</div>
      ${voiceOn ? `<div class="options" id="voices"></div><div id="use"></div>`
        : `<p class="help">The Google voice isn't connected, so the browser's own voice reads. It stops when the phone locks.</p>`}
      <div class="label">Images</div>
      <div class="toggle-row"><span>Sound when an image appears</span><button class="toggle" id="chime" aria-pressed="${prefs.chime !== false}" aria-label="Sound when an image appears"></button></div>
      <div class="label">Appearance</div>
      ${segHTML([["system", "Auto"], ["light", "Light"], ["dark", "Dark"]], prefs.appearance, "data-ap")}
      <div class="label">Text size</div>
      <div class="sizes"><span class="serif" style="font-size:15px">A</span><input type="range" id="tsize" min="16" max="32" step="1" value="${prefs.textSize}" aria-label="Text size"><span class="serif" style="font-size:26px">A</span></div>
      <div class="sample serif" id="sample">Design can help people <mark>imagine that things could be different.</mark></div>
      <div class="label">Speed</div>
      <div class="speed-grid">${speeds.map(s => `<button class="opt ${player.speed === s ? "on" : ""}" data-sp="${s}">${s}x</button>`).join("")}</div>
      ${G.googleReady() ? `<div class="label">Google account</div>
        ${G.account() ? `<p class="help">Signed in as ${esc(G.account())}. Your books, progress and bookmarks are kept in the Remagery folder in your Google Drive, with the voice of each chapter once it’s made.</p>
          <div class="btn-row"><a class="tag line" id="driveLink" href="https://drive.google.com" target="_blank" rel="noopener">Open Remagery folder</a><button class="tag line" id="syncNow">Sync now</button><button class="tag line" id="signOut">Sign out</button></div>`
        : `<p class="help">Sign in to keep your books and progress in your Google Drive, and see them on any device.</p><div class="btn-row"><button class="tag" data-act="signin">Sign in with Google</button></div>`}` : ""}
      <div class="label">On your Home Screen</div>
      <p class="help">In Safari, tap Share, then Add to Home Screen. Remagery opens full screen and keeps your books safe.</p>
      <p class="help" style="margin-top:18px"><a class="mono" style="color:inherit" href="privacy.html">Privacy</a></p>
    </div>`);
    const sampleBox = wrap.querySelector("#sample");
    sampleBox.style.fontSize = prefs.textSize + "px";
    wrap.querySelectorAll("[data-ap]").forEach(b => b.onclick = () => { prefs.appearance = b.dataset.ap; savePrefs(); applyTheme(); player.artCache && player.artCache.clear(); refill(); });
    wrap.querySelector("#tsize").oninput = e => { prefs.textSize = +e.target.value; savePrefs(); applyTheme(); sampleBox.style.fontSize = prefs.textSize + "px"; };
    wrap.querySelectorAll("[data-sp]").forEach(b => b.onclick = () => { player.speed = +b.dataset.sp; refill(); });
    const so = wrap.querySelector("#signOut");
    if (so) so.onclick = () => confirmDialog("Sign out?", "Your books stay in your Google Drive and on this phone.", "Sign out", async () => { await G.signOut(); close(); renderLibrary(); });
    const sn = wrap.querySelector("#syncNow");
    if (sn) sn.onclick = async () => { if (!G.token()) { G.signIn(); return; } sn.textContent = "Syncing…"; await sync(); sn.textContent = "Sync now"; };
    const dl = wrap.querySelector("#driveLink");
    if (dl && G.token()) rootLink().then(u => { dl.href = u; }).catch(() => {});
    wrap.querySelector("#chime").onclick = e => { prefs.chime = !(prefs.chime !== false); savePrefs(); e.currentTarget.setAttribute("aria-pressed", prefs.chime); };
    if (voiceOn) {
      const list = wrap.querySelector("#voices");
      for (const v of VOICES) {
        const on = v.id === cur;
        const row = h(`<button class="opt ${on ? "on" : ""}"><span>${esc(v.label)}</span><span>${on ? I.tick : ""}</span></button>`);
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
        const mine = u.books != null ? `<p class="help">Your new books this month: ${u.books} of ${u.bookLimit}. More chapters of a book you've started are free.</p><div class="meter"><i style="width:${Math.min(100, u.books / u.bookLimit * 100)}%"></i></div>` : "";
        box.innerHTML = `${mine}<p class="help">Free voice this month, everyone together: ${(u.used / 1e6).toFixed(2)} of ${(u.limit / 1e6).toFixed(1)} million characters.</p><div class="meter"><i style="width:${pct}%"></i></div>`;
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
    case "add": addSheet(); break;
    case "signin": G.signIn(); break;
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
  if (document.visibilityState === "hidden") { player.saveProgress(true); if (G.token()) sync(); }
  else { player.tick(player.useAudio ? player.audio.currentTime : player.time); renderFigure(); }
});

// ---------- Drive sync ----------
let askedDrive = false;
onSync(kind => {
  refreshAccount();
  if (kind === "error" && !G.hasDrive() && !askedDrive) {
    askedDrive = true;
    confirmDialog("Allow Google Drive", "When you signed in, the Google Drive box was left unticked, so Remagery can't save your books. Sign in again and tick the box: Remagery only sees the files it makes and the ones you pick.", "Sign in again", () => G.signIn({ consent: true }));
  }
  if (kind === "library" && !making.length) renderLibrary();
});

// ---------- Start ----------
// Keep a copy of the app on the phone so it opens without internet
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
applyTheme();
renderLibrary();
if (!needsHomeScreen) startGoogle();

async function startGoogle() {
  if (!G.googleReady()) return;
  const back = await G.handleReturn();
  if (back && back.ok) {
    renderLibrary();
    await sync();
    if (back.intent === "add-drive") addFromDrive();
    else if (back.intent && back.intent.startsWith("open:")) {
      const b = await db.get("books", back.intent.slice(5));
      if (b) openBook(b);
    }
    return;
  }
  if (back && !back.ok && !back.silent && back.error !== "access_denied") alertDialog("Sign-in didn't finish", "Try again from Library.");
  // Signed in before, but the hour-long pass has run out: renew it quietly (at most every 10 minutes)
  if (G.account() && !G.token() && !(back && back.silent)) {
    let tried = false;
    try { tried = Date.now() - (+localStorage.getItem("remagery.silent") || 0) < 10 * 60000; localStorage.setItem("remagery.silent", String(Date.now())); } catch (e) {}
    if (!tried && !player.isPlaying) { G.signIn({ silent: true }); return; }
  }
  if (G.token()) sync();
  refreshAccount();
}
