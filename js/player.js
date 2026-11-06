// The player: plays a chapter's voice and keeps the highlight, pictures and lock screen in sync.
// With the voice server: real audio (keeps playing when locked).
// Without it: the browser's own voice (stops when the phone locks).

import { db } from "./db.js";
import { PACE, DEFAULT_VOICE } from "./config.js";
import { hasVoiceServer, chapterAudio, VoiceError } from "./voice.js";
import { prefs, savePrefs } from "./prefs.js";

const SILENT = "silent.mp3";

class Player {
  constructor() {
    this.audio = document.getElementById("audio");
    this.listeners = new Set();
    this.record = null; this.book = null; this.ch = 0;
    this.sentences = []; this.paraStarts = []; this.shots = [];
    this.cur = -1; this.image = null; this.time = 0; this.duration = 0;
    this.isPlaying = false; this.preparing = null; this.error = null;
    this.sleep = null; this.sleepEnd = null; this.sleepTimer = null;
    this.urls = new Map(); this.lastSave = 0; this.loadToken = 0;
    this.useAudio = hasVoiceServer();
    this.unlocked = false;

    const a = this.audio;
    a.addEventListener("timeupdate", () => { if (this.useAudio) this.tick(a.currentTime); });
    a.addEventListener("play", () => { if (this.useAudio && this.loaded) { this.isPlaying = true; this.setState(); } });
    a.addEventListener("pause", () => { if (this.useAudio && this.loaded) { this.isPlaying = false; this.saveProgress(true); this.setState(); } });
    a.addEventListener("ended", () => { if (this.useAudio && this.loaded) this.chapterEnded(); });
    this.setupLockScreen();
    window.speechSynthesis && speechSynthesis.getVoices();
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(kind) { for (const f of this.listeners) f(kind); }
  setState() {
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = this.isPlaying ? "playing" : "paused";
    this.emit("state");
  }

  /// iOS only lets a page start sound from a tap. Call this inside every tap that may start playing.
  unlock() {
    if (!this.useAudio || this.unlocked) return;
    const a = this.audio;
    if (!a.src) { a.src = SILENT; a.play().then(() => { if (!this.loaded) a.pause(); }).catch(() => {}); }
    this.unlocked = true;
  }

  get voice() { return prefs.voice || DEFAULT_VOICE; }
  get speed() { return prefs.speed || 1; }
  set speed(v) {
    prefs.speed = v; savePrefs();
    this.audio.playbackRate = v; this.audio.defaultPlaybackRate = v;
    if (!this.useAudio && this.isPlaying) this.speakFrom(Math.max(this.cur, 0));
    this.emit("state");
  }

  // ---------- Books and chapters ----------

  async open(record) {
    if (this.record && this.record.id === record.id) return;
    this.close();
    const book = await db.get("packages", record.id);
    if (!book) return;
    if (record.finished) { record.finished = false; record.progress = null; }
    record.lastOpened = Date.now();
    this.record = record; this.book = book;
    await db.put("books", record.id, record);
    this.emit("book");
    const pr = record.progress || { ch: 0, s: 0 };
    await this.load(pr.ch, pr.s || 0, true);
  }

  close() {
    if (!this.record) return;
    this.saveProgress(true);
    this.stopVoice();
    this.isPlaying = false; this.loaded = false;
    this.setSleep(null);
    this.record = null; this.book = null; this.sentences = []; this.shots = []; this.cur = -1; this.image = null;
    if ("mediaSession" in navigator) navigator.mediaSession.metadata = null;
    this.emit("book");
  }

  chapterInfo(i = this.ch) { return this.book && this.book.chapters[i]; }

  async load(index, sentence = 0, play = true) {
    if (!this.book) return;
    const token = ++this.loadToken;
    this.stopVoice();
    this.loaded = false;
    const i = Math.max(0, Math.min(index, this.book.chapters.length - 1));
    const c = this.book.chapters[i];
    this.ch = i; this.error = null;

    // Sentences in order, with their paragraph
    const lines = [], starts = [];
    (c.paragraphs || []).forEach((p, pi) => {
      starts.push(lines.length);
      for (const s of p.sentences || []) lines.push({ id: s.id, text: s.text, paragraph: pi, start: 0, end: 0 });
    });
    this.sentences = lines; this.paraStarts = starts;
    this.cur = -1; this.image = null;
    this.emit("chapter");

    if (this.useAudio) {
      this.preparing = { done: 0, total: 1 };
      this.emit("state");
      let rec;
      try {
        rec = await chapterAudio(this.record.id, i, c, this.voice, (d, t) => {
          if (token === this.loadToken) { this.preparing = { done: d, total: t }; this.emit("state"); }
        });
      } catch (e) {
        if (token !== this.loadToken) return;
        this.preparing = null;
        this.error = e instanceof VoiceError ? e.message : "The voice couldn't be made. Try again.";
        this.isPlaying = false;
        this.emit("state");
        return;
      }
      if (token !== this.loadToken) return;
      this.preparing = null;
      lines.forEach((l, k) => { l.start = rec.starts[k]; l.end = k + 1 < lines.length ? rec.starts[k + 1] : rec.duration; });
      this.duration = rec.duration;
      this.shots = this.buildShots(c, lines);
      const a = this.audio;
      if (this.chapterUrl) URL.revokeObjectURL(this.chapterUrl);
      this.chapterUrl = URL.createObjectURL(rec.blob);
      a.src = this.chapterUrl;
      a.playbackRate = this.speed; a.defaultPlaybackRate = this.speed;
      const t = lines[Math.min(sentence, lines.length - 1)] ? lines[Math.min(sentence, lines.length - 1)].start : 0;
      await new Promise(res => { a.addEventListener("loadedmetadata", res, { once: true }); a.load(); setTimeout(res, 4000); });
      if (token !== this.loadToken) return;
      try { a.currentTime = t; } catch (e) {}
      this.loaded = true;
      this.tick(t);
      if (play) { try { await a.play(); } catch (e) { this.isPlaying = false; this.setState(); } }
      this.prepareNext();
    } else {
      // Browser voice: times are estimated from the text
      let t = 0;
      lines.forEach((l, k) => {
        l.start = t; l.end = t + l.text.length / PACE.charactersPerSecond;
        const lastInPara = k + 1 >= lines.length || lines[k + 1].paragraph !== l.paragraph;
        t = l.end + (lastInPara ? PACE.paragraph : PACE.sentence);
      });
      this.duration = t;
      this.shots = this.buildShots(c, lines);
      this.loaded = true;
      this.cur = Math.min(sentence, lines.length - 1);
      this.tick(lines[this.cur] ? lines[this.cur].start : 0);
      if (play) this.play(); else this.setState();
    }
    this.updateNowPlaying(true);
  }

  /// Makes the next chapter's voice in the background, so it plays straight on (also when locked).
  prepareNext() {
    const n = this.ch + 1;
    if (!this.book || n >= this.book.chapters.length) return;
    const id = this.record.id;
    chapterAudio(id, n, this.book.chapters[n], this.voice).catch(() => {});
  }

  /// Each picture shows from two paragraphs before it's mentioned until two paragraphs after.
  /// If the next picture comes sooner, it takes over; a picture never starts before the previous
  /// picture's own paragraph has been read.
  buildShots(c, lines) {
    const found = [];
    for (const im of c.images || []) {
      const k = lines.findIndex(l => l.id === im.sentence_id);
      if (k >= 0) found.push({ im, k });
    }
    found.sort((a, b) => a.k - b.k);
    const out = [];
    found.forEach((item, n) => {
      const line = lines[item.k], p = line.paragraph;
      let start = (lines.find(l => l.paragraph >= p - 2) || line).start;
      if (n > 0) {
        const prev = lines[found[n - 1].k];
        const prevEnd = [...lines].reverse().find(l => l.paragraph === prev.paragraph);
        start = Math.max(start, Math.min(prevEnd ? prevEnd.end : prev.end, line.start));
      }
      const endLine = [...lines].reverse().find(l => l.paragraph <= p + 2);
      out.push({ file: item.im.file, caption: item.im.caption, description: item.im.description,
        start, end: Math.max(endLine ? endLine.end : line.end, line.start + 4) });
    });
    for (let k = 0; k + 1 < out.length; k++) if (out[k].end > out[k + 1].start) out[k].end = out[k + 1].start;
    return out;
  }

  // ---------- Playing ----------

  play() {
    if (!this.book) return;
    this.unlock();
    if (this.error) { this.load(this.ch, Math.max(this.cur, 0), true); return; }
    if (this.useAudio) { if (this.loaded) this.audio.play().catch(() => {}); return; }
    this.isPlaying = true;
    this.speakFrom(Math.max(this.cur, 0));
    this.setState();
  }
  pause() {
    if (this.useAudio) { this.audio.pause(); return; }
    this.isPlaying = false;
    this.stopVoice();
    this.saveProgress(true);
    this.setState();
  }
  toggle() { this.isPlaying ? this.pause() : this.play(); }

  seek(t) {
    t = Math.max(0, Math.min(t, this.duration - 0.1));
    if (this.useAudio) { this.audio.currentTime = t; this.tick(t); return; }
    const k = this.sentenceAt(t);
    this.goToSentence(k);
  }
  skip(d) { this.seek(this.time + d); }
  nextChapter() { if (this.book && this.ch + 1 < this.book.chapters.length) this.load(this.ch + 1, 0, this.isPlaying || this.useAudio); }
  prevChapter() {
    if (this.time > 5 || this.ch === 0) this.seek(0);
    else this.load(this.ch - 1, 0, true);
  }
  jumpTo(k) {
    if (this.useAudio) { this.seek(this.sentences[k].start + 0.01); if (!this.isPlaying) this.play(); }
    else this.goToSentence(k, true);
  }
  goToSentence(k, startPlaying = false) {
    this.cur = k;
    this.tick(this.sentences[k] ? this.sentences[k].start : 0);
    if (this.isPlaying || startPlaying) { this.isPlaying = true; this.speakFrom(k); this.setState(); }
  }

  // ---------- Browser voice ----------

  stopVoice() {
    this.speakToken = (this.speakToken || 0) + 1;
    if (window.speechSynthesis) speechSynthesis.cancel();
    clearInterval(this.voiceClock);
  }
  pickBrowserVoice() {
    const vs = (window.speechSynthesis ? speechSynthesis.getVoices() : []).filter(v => v.lang.startsWith("en"));
    return vs.find(v => /premium|enhanced/i.test(v.name) && v.lang === "en-GB") || vs.find(v => /premium|enhanced/i.test(v.name))
      || vs.find(v => v.lang === "en-GB") || vs[0] || null;
  }
  speakFrom(k) {
    this.stopVoice();
    if (!window.speechSynthesis) { this.error = "This browser has no voice."; this.emit("state"); return; }
    const token = this.speakToken;
    const voice = this.pickBrowserVoice();
    const next = i => {
      if (token !== this.speakToken) return;
      if (i >= this.sentences.length) { this.chapterEnded(); return; }
      const u = new SpeechSynthesisUtterance(this.sentences[i].text);
      if (voice) u.voice = voice;
      u.rate = 0.9 * this.speed;
      u.onstart = () => { if (token !== this.speakToken) return; this.cur = i; this.startedAt = performance.now(); this.tick(this.sentences[i].start); };
      u.onend = () => {
        if (token !== this.speakToken) return;
        const lastInPara = i + 1 >= this.sentences.length || this.sentences[i + 1].paragraph !== this.sentences[i].paragraph;
        setTimeout(() => next(i + 1), (lastInPara ? PACE.paragraph : 0.15) * 1000 / this.speed);
      };
      speechSynthesis.speak(u);
    };
    next(k);
    this.voiceClock = setInterval(() => {
      if (this.cur >= 0 && this.startedAt) {
        const s = this.sentences[this.cur];
        this.tick(Math.min(s.end, s.start + (performance.now() - this.startedAt) / 1000 * this.speed));
      }
    }, 300);
  }

  // ---------- Time ----------

  sentenceAt(t) {
    let lo = 0, hi = this.sentences.length - 1, found = 0;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (this.sentences[m].start <= t + 0.05) { found = m; lo = m + 1; } else hi = m - 1; }
    return found;
  }

  tick(t) {
    this.time = t;
    if (this.useAudio && this.sentences.length) {
      const k = this.sentenceAt(t);
      if (k !== this.cur) { this.cur = k; this.emit("sentence"); }
    } else this.emit("sentence");
    const im = this.shots.find(s => t >= s.start && t < s.end) || null;
    if ((im && im.file) !== (this.image && this.image.file)) {
      const fresh = im && this.isPlaying && document.visibilityState === "visible";
      this.image = im;
      if (fresh && prefs.chime !== false) chime();
      this.emit("image");
      this.updateNowPlaying(true);
    }
    this.emit("time");
    if (Date.now() - this.lastSave > 5000) this.saveProgress(false);
    this.updatePosition();
  }

  async chapterEnded() {
    if (this.sleep && this.sleep.endOfChapter) { this.setSleep(null); this.pause(); return; }
    if (this.book && this.ch + 1 < this.book.chapters.length) { await this.load(this.ch + 1, 0, true); return; }
    this.isPlaying = false;
    if (this.record) { this.record.finished = true; this.record.progress = null; await db.put("books", this.record.id, this.record); }
    this.setState();
  }

  saveProgress(force) {
    if (!this.record || !this.loaded) return;
    if (!force && Date.now() - this.lastSave < 5000) return;
    this.lastSave = Date.now();
    const total = this.book.chapters.length;
    this.record.progress = { ch: this.ch, s: Math.max(this.cur, 0) };
    this.record.percent = Math.min(1, (this.ch + (this.duration ? this.time / this.duration : 0)) / total);
    db.put("books", this.record.id, this.record).catch(() => {});
  }

  // ---------- Bookmarks ----------

  sentenceID(k) { return (this.sentences[k] && this.sentences[k].id) || `c${this.ch}-s${k}`; }
  isSaved(sid) { return !!(this.record && (this.record.bookmarks || []).some(b => b.sid === sid)); }
  toggleBookmark() {
    if (!this.record || this.cur < 0) return;
    const sid = this.sentenceID(this.cur);
    const list = this.record.bookmarks || (this.record.bookmarks = []);
    const i = list.findIndex(b => b.sid === sid);
    if (i >= 0) list.splice(i, 1);
    else list.push({ sid, ch: this.ch, s: this.cur, text: this.sentences[this.cur].text, added: Date.now() });
    db.put("books", this.record.id, this.record);
    this.emit("bookmarks");
  }
  removeBookmark(sid) {
    if (!this.record) return;
    this.record.bookmarks = (this.record.bookmarks || []).filter(b => b.sid !== sid);
    db.put("books", this.record.id, this.record);
    this.emit("bookmarks");
  }
  async goToBookmark(b) {
    if (b.ch !== this.ch) await this.load(b.ch, b.s, true);
    else this.jumpTo(b.s);
  }

  // ---------- Sleep timer ----------

  setSleep(mode) {
    clearTimeout(this.sleepTimer);
    this.sleep = mode; this.sleepEnd = null;
    if (mode && mode.minutes) {
      this.sleepEnd = Date.now() + mode.minutes * 60000;
      this.sleepTimer = setTimeout(() => { this.pause(); this.sleep = null; this.sleepEnd = null; this.emit("state"); }, mode.minutes * 60000);
    }
    this.emit("state");
  }

  // ---------- Pictures and lock screen ----------

  async fileURL(path) {
    if (!this.record || !path) return null;
    const key = `${this.record.id}/${path}`;
    if (this.urls.has(key)) return this.urls.get(key);
    const blob = await db.get("files", key);
    if (!blob) return null;
    const u = URL.createObjectURL(blob);
    this.urls.set(key, u);
    return u;
  }

  setupLockScreen() {
    if (!("mediaSession" in navigator)) return;
    const ms = navigator.mediaSession;
    const h = (a, f) => { try { ms.setActionHandler(a, f); } catch (e) {} };
    h("play", () => this.play());
    h("pause", () => this.pause());
    h("seekbackward", d => this.skip(-((d && d.seekOffset) || 15)));
    h("seekforward", d => this.skip((d && d.seekOffset) || 30));
    h("seekto", d => this.seek(d.seekTime));
  }

  updatePosition() {
    if (!("mediaSession" in navigator) || !navigator.mediaSession.setPositionState || !this.duration) return;
    try { navigator.mediaSession.setPositionState({ duration: this.duration, playbackRate: this.speed, position: Math.min(this.time, this.duration) }); } catch (e) {}
  }

  /// Lock screen: book, chapter, and the picture on screen right now (or the cover).
  async updateNowPlaying() {
    if (!("mediaSession" in navigator) || !this.record) return;
    const c = this.chapterInfo();
    const path = (this.image && this.image.file) || this.book.cover;
    const art = path ? await this.artwork(path) : null;
    if (!this.record) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: c ? c.title : this.record.title,
      artist: this.record.title,
      album: this.record.authors || "Remagery",
      artwork: art ? [{ src: art, sizes: "600x600", type: "image/png" }] : [],
    });
  }

  /// The lock-screen picture is square: the whole image on the Studio grey, nothing cut off.
  async artwork(path) {
    const theme = document.documentElement.dataset.mode || "light";
    const key = `${path}|${theme}`;
    this.artCache = this.artCache || new Map();
    if (this.artCache.has(key)) return this.artCache.get(key);
    const url = await this.fileURL(path);
    if (!url) return null;
    const img = new Image();
    await new Promise(res => { img.onload = res; img.onerror = res; img.src = url; });
    if (!img.naturalWidth) return null;
    const S = 600, pad = 36;
    const c = document.createElement("canvas");
    c.width = c.height = S;
    const x = c.getContext("2d");
    x.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--paper").trim() || "#D8D8D5";
    x.fillRect(0, 0, S, S);
    const k = Math.min((S - pad * 2) / img.naturalWidth, (S - pad * 2) / img.naturalHeight);
    const w = img.naturalWidth * k, h = img.naturalHeight * k;
    x.drawImage(img, (S - w) / 2, (S - h) / 2, w, h);
    let out = null;
    try { out = c.toDataURL("image/png"); } catch (e) {}
    this.artCache.set(key, out);
    return out;
  }
}

// A soft chime when a new picture appears (only while you're looking at the screen)
let actx = null, chimeBuf = null;
async function chime() {
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    if (!chimeBuf) chimeBuf = await actx.decodeAudioData(await (await fetch("chime.mp3")).arrayBuffer());
    if (actx.state === "suspended") await actx.resume();
    const s = actx.createBufferSource(); const g = actx.createGain();
    g.gain.value = 0.6; s.buffer = chimeBuf; s.connect(g).connect(actx.destination); s.start();
  } catch (e) {}
}

export const player = new Player();
