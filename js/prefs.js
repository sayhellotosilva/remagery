// Small settings kept on this phone: appearance, text size, speed, voice, view, chime.
const KEY = "remagery.prefs";
let saved = {};
try { saved = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch (e) {}

export const prefs = Object.assign({ appearance: "system", textSize: 21, speed: 1, voice: null, chime: true, mode: "images" }, saved);
export function savePrefs() { try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch (e) {} }
