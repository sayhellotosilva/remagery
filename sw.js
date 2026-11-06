// Lets Remagery open without internet: keeps a copy of the app's own files on the phone.
// Books, images and voice are already kept on the phone by the app itself.
const CACHE = "remagery-app-v7";
const APP = ["./", "index.html", "privacy.html", "app.css", "manifest.webmanifest", "icon-180.png", "icon-192.png", "icon-512.png",
  "chime.mp3", "silent.mp3", "js/app.js", "js/player.js", "js/voice.js", "js/bookmaker.js", "js/db.js",
  "js/prefs.js", "js/config.js", "js/google.js", "js/sync.js"];
const LIBS = ["https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll([...APP, ...LIBS])).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Libraries never change at a fixed version: phone copy first
  if (url.hostname === "cdnjs.cloudflare.com") {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); return res;
    })));
    return;
  }
  if (url.origin !== location.origin) return; // Google, Drive and the voice server always go online
  // The app's own files: newest version when online, phone copy when offline
  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    } catch (err) {
      const hit = await caches.match(req, { ignoreSearch: true });
      if (hit) return hit;
      if (req.mode === "navigate") return (await caches.match("./")) || (await caches.match("index.html"));
      throw err;
    }
  })());
});
