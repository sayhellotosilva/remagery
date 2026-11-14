// Lets Remagery open without internet: keeps a copy of the app's own files on the phone.
// Books, images and voice are already kept on the phone by the app itself.
// IMPORTANT: change this name with every release, or phones keep the old version.
const CACHE = "remagery-app-v30";
const APP = ["./", "privacy", "stats", "app.css", "manifest.webmanifest", "icon-180.png", "icon-192.png", "icon-512.png",
  "chime.mp3", "silent.mp3", "js/app.js", "js/player.js", "js/voice.js", "js/bookmaker.js", "js/db.js",
  "js/prefs.js", "js/config.js", "js/google.js", "js/sync.js", "js/sharecard.js", "js/later.js"];
const LIBS = ["https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"];

// iPhone refuses a saved page that came through a redirect (Cloudflare turns "/stats.html" into "/stats"),
// so every saved copy is stored as a plain response.
const plain = res => res && res.redirected
  ? res.blob().then(b => new Response(b, { status: res.status, statusText: res.statusText, headers: res.headers }))
  : Promise.resolve(res);

self.addEventListener("install", e => {
  // "reload": always fetch fresh files for a new version, never an old copy from the browser
  e.waitUntil(caches.open(CACHE).then(async c => {
    await Promise.all(APP.map(async u => {
      const res = await fetch(new Request(u, { cache: "reload" }));
      if (!res.ok) throw new Error("Missing " + u);
      await c.put(u, await plain(res));
    }));
    await c.addAll(LIBS);
  }).then(() => self.skipWaiting()));
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
  // The app's own files: always from the phone copy, so Remagery opens at once even on slow or no
  // internet. Updates come with a new version of this file (new CACHE name): the browser checks for it
  // in the background, saves the whole new version, and the next opening uses it.
  e.respondWith((async () => {
    // Old links: "stats.html" is saved as "stats"
    const alt = /\/[^/.]+\.html$/.test(url.pathname) && !url.pathname.endsWith("/index.html") ? url.pathname.slice(0, -5) : null;
    const hit = (await caches.match(req, { ignoreSearch: true })) || (alt && (await caches.match(alt)))
      || (req.mode === "navigate" ? (await caches.match("./")) || (await caches.match("index.html")) : null);
    if (hit) return hit.redirected ? plain(hit) : hit;
    const res = await plain(await fetch(req));
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
    return res;
  })());
});
