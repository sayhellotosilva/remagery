// Remagery settings for this copy of the web app.
// VOICE_SERVER: the address of your voice server (Cloudflare Worker). See SETUP.md, step 2.
// Leave it empty to use the browser's own voice (it stops when the phone locks).
export const VOICE_SERVER = "https://long-frost-78a5.sayhellotosilva.workers.dev";

// Google sign-in and Drive (see SETUP.md, step 2). Leave empty to use Remagery without an account.
export const GOOGLE_CLIENT_ID = "489478449653-b5du0muci7lj8sscrinkt7ag2g9trrpf.apps.googleusercontent.com";   // OAuth client ID, ends in .apps.googleusercontent.com
export const GOOGLE_API_KEY = "AIzaSyDTm97ESNh7evsIPzd_DYFVOisQJfthLDo";     // API key for the Google Drive picker
export const GOOGLE_APP_ID = "489478449653";      // Google Cloud project number

// Google voices offered in Settings, three per book language
// (WaveNet: inside the 4 million free characters a month). Voice 1 is the default.
export const VOICES_BY_LANG = {
  en: [
    { id: "en-GB-Wavenet-F", label: "Voice 1" }, // British woman
    { id: "en-US-Wavenet-F", label: "Voice 2" }, // American woman
    { id: "en-GB-Wavenet-B", label: "Voice 3" }, // British man
  ],
  pt: [
    { id: "pt-BR-Wavenet-A", label: "Voice 1" }, // Brazilian woman
    { id: "pt-BR-Wavenet-C", label: "Voice 2" }, // Brazilian woman
    { id: "pt-BR-Wavenet-B", label: "Voice 3" }, // Brazilian man
  ],
  es: [
    { id: "es-ES-Wavenet-F", label: "Voice 1" }, // Spanish woman (Spain)
    { id: "es-US-Wavenet-A", label: "Voice 2" }, // Latin American woman
    { id: "es-ES-Wavenet-E", label: "Voice 3" }, // Spanish man (Spain)
  ],
};
export const LANG_NAMES = { en: "English", pt: "Portuguese", es: "Spanish" };
export const voicesFor = lang => VOICES_BY_LANG[lang] || VOICES_BY_LANG.en;
export const VOICES = Object.values(VOICES_BY_LANG).flat();
export const DEFAULT_VOICE = "en-GB-Wavenet-F";

// Narration pace (same idea as Pace in the iPhone app)
export const PACE = {
  rate: 0.92,              // Google speaking rate (1.0 = normal)
  paragraphMs: 1300,       // pause between paragraphs
  sentence: 0.65,          // browser voice: estimated pause between sentences (s)
  paragraph: 1.3,          // browser voice: estimated pause between paragraphs (s)
  charactersPerSecond: 14, // browser voice: estimated speaking speed
};
