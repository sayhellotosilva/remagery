// Makes a chapter's narration as real audio (so it keeps playing when the phone is locked).
// Text goes to the voice server, which asks Google Text-to-Speech. Each sentence gets a marker,
// so the app knows exactly when each sentence starts: the highlight and pictures follow it.

import { db } from "./db.js";
import { VOICE_SERVER, PACE } from "./config.js";
import { fetchVoice, scheduleSync } from "./sync.js";
import { token, account } from "./google.js";

// The voice server's pass: proves who you are for 30 days, so the voice keeps being made
// after Google's one-hour sign-in runs out.
const PASS_KEY = "remagery.voicePass";
function getPass() { try { const p = JSON.parse(localStorage.getItem(PASS_KEY) || "null"); return p && p.email === account() ? p.pass : ""; } catch (e) { return ""; } }
function keepPass(j) { if (j && j.pass && j.email) try { localStorage.setItem(PASS_KEY, JSON.stringify({ email: j.email, pass: j.pass })); } catch (e) {} }

export const hasVoiceServer = () => !!VOICE_SERVER;

const MAX_BYTES = 4200; // Google takes up to 5000 bytes per request
const enc = new TextEncoder();
const esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export class VoiceError extends Error {
  constructor(msg, kind) { super(msg); this.kind = kind; }
}

/// The SSML pieces of a chapter, each small enough for one request.
function chunks(chapter) {
  const out = [];
  let cur = "", k = 0;
  const flush = () => { if (cur) out.push(`<speak>${cur}</speak>`); cur = ""; };
  for (const p of chapter.paragraphs || []) {
    const ss = (p.sentences || []).map(s => `<mark name="s${k++}"/>${esc(s.text)} `);
    const para = `<p>${ss.join("")}</p><break time="${PACE.paragraphMs}ms"/>`;
    if (enc.encode(cur + para).length + 20 <= MAX_BYTES) { cur += para; continue; }
    flush();
    if (enc.encode(para).length + 20 <= MAX_BYTES) { cur = para; continue; }
    // A very long paragraph: split it between sentences
    let part = "";
    for (const s of ss) {
      if (enc.encode(part + s).length + 60 > MAX_BYTES) { out.push(`<speak><p>${part}</p></speak>`); part = ""; }
      part += s;
    }
    cur = `<p>${part}</p><break time="${PACE.paragraphMs}ms"/>`;
  }
  flush();
  return out;
}

export function chapterCharacters(chapter) {
  return chunks(chapter).reduce((n, c) => n + c.length, 0);
}

async function speak(ssml, voice, bookId = "") {
  const t = token(), pass = getPass();
  if (!t && !pass) throw new VoiceError("Sign in with Google again to make the voice.", "auth");
  let r;
  try {
    r = await fetch(VOICE_SERVER.replace(/\/$/, "") + "/speak", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ssml, voice, rate: PACE.rate, bookId, token: t || "", pass }),
    });
  } catch (e) {
    throw new VoiceError("No internet connection. The voice is made online the first time you play a chapter.", "offline");
  }
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) { try { localStorage.removeItem(PASS_KEY); } catch (e) {} }
  if (r.status === 401) throw new VoiceError(j.error || "Sign in with Google again to make the voice.", "auth");
  if (r.status === 429) throw new VoiceError(j.error || "This month's free voice allowance is used up. It starts again on the 1st.", j.kind || "limit");
  if (!r.ok) throw new VoiceError(j.error || "The voice server didn't answer. Try again in a moment.", "server");
  keepPass(j);
  return j;
}

const b64 = s => { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };

/// Cleans an MP3 piece so pieces join into one file (no ID3 tag, no Xing/Info header frame) and measures it.
function mp3Frames(u8) {
  const BR1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
  const BR2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  const SR = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
  let i = 0;
  if (u8[0] === 0x49 && u8[1] === 0x44 && u8[2] === 0x33) i = 10 + ((u8[6] << 21) | (u8[7] << 14) | (u8[8] << 7) | u8[9]);
  const parts = [];
  let seconds = 0, first = true;
  while (i + 4 <= u8.length) {
    const b1 = u8[i + 1], b2 = u8[i + 2];
    if (u8[i] !== 0xFF || (b1 & 0xE0) !== 0xE0) { i++; continue; }
    const ver = (b1 >> 3) & 3, layer = (b1 >> 1) & 3;
    const brI = (b2 >> 4) & 15, srI = (b2 >> 2) & 3, pad = (b2 >> 1) & 1;
    if (ver === 1 || layer !== 1 || brI === 0 || brI === 15 || srI === 3) { i++; continue; }
    const rate = SR[ver][srI], br = (ver === 3 ? BR1 : BR2)[brI];
    const samples = ver === 3 ? 1152 : 576;
    const size = Math.floor((samples / 8 * br * 1000) / rate) + pad;
    if (size < 4) { i++; continue; }
    if (first) {
      first = false;
      const head = String.fromCharCode(...u8.subarray(i + 4, Math.min(i + 48, u8.length)));
      if (head.includes("Xing") || head.includes("Info")) { i += size; continue; }
    }
    parts.push(u8.subarray(i, Math.min(i + size, u8.length)));
    seconds += samples / rate;
    i += size;
  }
  return { parts, seconds };
}

/// Returns { url, duration, starts[] } for a chapter, making and saving it the first time.
export async function chapterAudio(bookId, ci, chapter, voice, onProgress) {
  const key = `${bookId}/${ci}/${voice}`;
  const saved = await db.get("audio", key);
  if (saved) return saved;
  // Already made on another device? Download it from Drive instead of using the voice allowance
  const fromDrive = await fetchVoice(bookId, ci, voice);
  if (fromDrive) { await db.put("audio", key, fromDrive); return fromDrive; }

  const pieces = chunks(chapter);
  const results = new Array(pieces.length);
  let done = 0, next = 0;
  onProgress && onProgress(0, pieces.length);
  async function worker() {
    while (next < pieces.length) {
      const i = next++;
      results[i] = await speak(pieces[i], voice, bookId);
      done++;
      onProgress && onProgress(done, pieces.length);
    }
  }
  await Promise.all([worker(), worker(), worker()]);

  const count = (chapter.paragraphs || []).reduce((n, p) => n + (p.sentences || []).length, 0);
  const starts = new Array(count).fill(null);
  const allParts = [];
  let offset = 0;
  for (const r of results) {
    const { parts, seconds } = mp3Frames(b64(r.audio));
    for (const tp of r.timepoints || []) {
      const k = +String(tp.markName).slice(1);
      if (k >= 0 && k < count) starts[k] = offset + tp.timeSeconds;
    }
    allParts.push(...parts);
    offset += seconds;
  }
  // Any sentence without a marker time takes the previous one's time
  for (let k = 0; k < count; k++) if (starts[k] === null) starts[k] = k ? starts[k - 1] : 0;
  const rec = { blob: new Blob(allParts, { type: "audio/mpeg" }), duration: offset, starts };
  await db.put("audio", key, rec);
  scheduleSync(5000); // saves it to Drive
  return rec;
}

export async function hasChapterAudio(bookId, ci, voice) {
  return !!(await db.get("audio", `${bookId}/${ci}/${voice}`));
}

/// This month's use: everyone's characters, and your own new books (when signed in).
export async function usage() {
  if (!VOICE_SERVER) return null;
  try {
    const r = await fetch(VOICE_SERVER.replace(/\/$/, "") + "/usage", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: token() || "", pass: getPass() }),
    });
    const j = r.ok ? await r.json() : null;
    keepPass(j);
    return j;
  } catch (e) { return null; }
}

/// A short sample of a voice, for Settings.
export async function sample(voice) {
  const r = await speak(`<speak>This is how your books will sound.</speak>`, voice);
  const { parts } = mp3Frames(b64(r.audio));
  return URL.createObjectURL(new Blob(parts, { type: "audio/mpeg" }));
}
