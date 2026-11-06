import { VOICES } from "./config.js";
// Small settings kept on this phone: appearance, text size, speed, voice, view, chime.
const KEY = "remagery.prefs";
let saved = {};
try { saved = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch (e) {}

export const prefs = Object.assign({ appearance: "light", textSize: 21, speed: 1, voice: null, chime: true, mode: "images" }, saved);
// A voice that's no longer offered goes back to Voice 1
if (prefs.voice && !VOICES.some(v => v.id === prefs.voice)) prefs.voice = null;
export function savePrefs() { try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch (e) {} }
