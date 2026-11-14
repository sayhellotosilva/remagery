import { voicesFor } from "./config.js";
// Small settings kept on this phone: appearance, text size, speed, voices, view, chime.
const KEY = "remagery.prefs";
let saved = {};
try { saved = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch (e) {}

export const prefs = Object.assign({ appearance: "light", textSize: 21, speed: 1, voices: {}, chime: true, mode: "images" }, saved);
if (!prefs.voices || typeof prefs.voices !== "object") prefs.voices = {};
// Older versions kept one English voice
if (prefs.voice) { if (!prefs.voices.en) prefs.voices.en = prefs.voice; delete prefs.voice; }

export function savePrefs() { try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch (e) {} }

/// The chosen voice for a book language ("en", "pt", "es"). A voice no longer offered goes back to Voice 1.
export function voiceFor(lang) {
  const list = voicesFor(lang), id = prefs.voices[lang || "en"];
  return list.some(v => v.id === id) ? id : list[0].id;
}
export function setVoice(lang, id) { prefs.voices[lang || "en"] = id; savePrefs(); }
