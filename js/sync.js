// Keeps your library in your Google Drive, in a folder called Remagery:
//   Remagery/
//     library.json              your books, progress and bookmarks
//     <Book title>/
//       cover.jpg
//       <Book title>.remagery   the book: text and images (a zip)
// The phone keeps its own copy, so books open fast and play without internet.
// The voice is never saved to Drive (it stays on the phone).

import { db } from "./db.js";
import * as G from "./google.js";

const ROOT_KEY = "remagery.driveRoot";
const GONE_KEY = "remagery.removed";
let status = "", lastError = "";
export const syncError = () => lastError;
const listeners = new Set();
export const onSync = fn => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = (kind) => { for (const f of listeners) f(kind); };
const setStatus = s => { status = s; emit("status"); };
export const syncStatus = () => status;

function removedLocal() { try { return JSON.parse(localStorage.getItem(GONE_KEY) || "[]"); } catch (e) { return []; } }
function addRemoved(id) { const r = removedLocal(); if (!r.some(x => x.id === id)) r.push({ id, at: Date.now() }); try { localStorage.setItem(GONE_KEY, JSON.stringify(r)); } catch (e) {} }

const safeName = s => (s || "Book").replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "Book";

export async function rootFolder() {
  const cached = (() => { try { return JSON.parse(localStorage.getItem(ROOT_KEY) || "null"); } catch (e) { return null; } })();
  const email = G.account();
  if (cached && cached.email === email) return cached.id;
  const found = await G.list("appProperties has { key='remagery' and value='root' } and trashed=false");
  const id = found.length ? found[0].id : await G.createFolder("Remagery", null, { remagery: "root" });
  try { localStorage.setItem(ROOT_KEY, JSON.stringify({ email, id })); } catch (e) {}
  return id;
}
export async function rootLink() { return G.folderLink(await rootFolder()); }

// ---------- One book ----------

async function bundle(id) {
  const zip = new window.JSZip();
  const pkg = await db.get("packages", id);
  zip.file("book.json", JSON.stringify(pkg));
  const keys = (await db.keys("files")).filter(k => String(k).startsWith(id + "/"));
  for (const k of keys) zip.file(String(k).slice(id.length + 1), await db.get("files", k));
  return await zip.generateAsync({ type: "blob", compression: "STORE" });
}

/// Saves a book from this phone into the Remagery folder.
export async function uploadBook(rec, onProgress) {
  const root = await rootFolder();
  const folderId = await G.createFolder(safeName(rec.title), root, { remagery: "book", bookId: rec.id });
  let coverId = null;
  if (rec.cover) {
    const c = await db.get("files", `${rec.id}/${rec.cover}`);
    if (c) coverId = await G.upload(c, { name: "cover.jpg", parent: folderId, props: { remagery: "cover", bookId: rec.id }, mime: "image/jpeg" });
  }
  const blob = await bundle(rec.id);
  const bundleId = await G.upload(blob, { name: safeName(rec.title) + ".remagery", parent: folderId, mime: "application/zip",
    props: { remagery: "bundle", bookId: rec.id }, onProgress });
  rec.drive = { folderId, bundleId, coverId };
  await db.put("books", rec.id, rec);
  return rec;
}

/// Brings a book from Drive onto this phone.
export async function downloadBook(rec, onProgress) {
  if (!rec.drive || !rec.drive.bundleId) throw new Error("This book isn't in your Google Drive.");
  const blob = await G.download(rec.drive.bundleId, onProgress);
  const zip = await window.JSZip.loadAsync(blob);
  const pkg = JSON.parse(await zip.file("book.json").async("string"));
  for (const f of Object.values(zip.files)) {
    if (f.dir || f.name === "book.json") continue;
    const type = /\.png$/i.test(f.name) ? "image/png" : "image/jpeg";
    await db.put("files", `${rec.id}/${f.name}`, new Blob([await f.async("arraybuffer")], { type }));
  }
  await db.put("packages", rec.id, pkg);
  rec.local = true;
  await db.put("books", rec.id, rec);
  return rec;
}

/// Removes a book from this phone and moves its Drive folder to the bin.
export async function removeBook(rec) {
  addRemoved(rec.id);
  await Promise.all([db.del("books", rec.id), db.del("packages", rec.id), db.delPrefix("files", rec.id + "/"), db.delPrefix("audio", rec.id + "/")]);
  if (rec.drive && rec.drive.folderId && G.token()) { try { await G.trash(rec.drive.folderId); } catch (e) {} }
  scheduleSync(500);
}

// ---------- The library ----------

async function readLibrary(root) {
  const f = await G.list(`'${root}' in parents and appProperties has { key='remagery' and value='library' } and trashed=false`);
  if (!f.length) return { id: null, data: { books: [], removed: [] } };
  try {
    const blob = await G.download(f[0].id);
    return { id: f[0].id, data: JSON.parse(await blob.text()) };
  } catch (e) { return { id: f[0].id, data: { books: [], removed: [] } }; }
}

const SHARED = ["title", "authors", "cover", "chapters", "added", "lastOpened", "progress", "finished", "percent", "bookmarks", "updatedAt", "drive"];
const pick = r => Object.fromEntries(SHARED.filter(k => r[k] !== undefined).map(k => [k, r[k]]).concat([["id", r.id]]));

let running = null, again = false, timer = null;
export function scheduleSync(ms = 15000) {
  clearTimeout(timer);
  timer = setTimeout(() => sync(), ms);
}

/// Brings the phone and your Drive up to date with each other. Newest progress wins.
export async function sync() {
  if (!G.token()) return false;
  if (running) { again = true; return running; }
  running = (async () => {
    try {
      setStatus("Syncing");
      if (!(await G.checkScope())) { const e = new Error("Google Drive wasn't allowed when you signed in."); e.status = 403; throw e; }
      const root = await rootFolder();
      const remote = await readLibrary(root);
      const removed = [...(remote.data.removed || [])];
      for (const r of removedLocal()) if (!removed.some(x => x.id === r.id)) removed.push(r);
      const gone = new Set(removed.map(r => r.id));

      const local = new Map(((await db.all("books")) || []).map(b => [b.id, b]));
      const far = new Map((remote.data.books || []).map(b => [b.id, b]));
      let changedLocal = false;

      // Removed on another device
      for (const id of gone) if (local.has(id)) {
        await Promise.all([db.del("books", id), db.del("packages", id), db.delPrefix("files", id + "/"), db.delPrefix("audio", id + "/")]);
        local.delete(id); changedLocal = true;
      }

      const merged = [];
      for (const id of new Set([...local.keys(), ...far.keys()])) {
        if (gone.has(id)) continue;
        let L = local.get(id), R = far.get(id);
        if (L && R) {
          const newer = (R.updatedAt || 0) > (L.updatedAt || 0) ? R : L;
          const m = { ...L, ...pick(newer), drive: L.drive || R.drive, local: L.local !== false };
          if (newer === R) { await db.put("books", id, m); changedLocal = true; }
          merged.push(m);
        } else if (R) {
          // A book added on another device: show it here; it downloads when you open it
          const m = { ...pick(R), local: false };
          if (R.cover && R.drive && R.drive.coverId) {
            try { await db.put("files", `${id}/${R.cover}`, await G.download(R.drive.coverId)); } catch (e) {}
          }
          await db.put("books", id, m);
          changedLocal = true;
          merged.push(m);
        } else if (L) {
          if (!L.drive && L.local !== false) {
            setStatus(`Saving “${L.title}” to Google Drive`);
            try { L = await uploadBook(L, p => setStatus(`Saving “${L.title}” · ${Math.round(p * 100)}%`)); changedLocal = true; }
            catch (e) { continue; }
          }
          if (L.drive) merged.push(L);
        }
      }

      const out = { app: "Remagery", version: 1, updated: Date.now(), books: merged.map(pick), removed };
      const file = new Blob([JSON.stringify(out, null, 1)], { type: "application/json" });
      if (remote.id) await G.upload(file, { id: remote.id, mime: "application/json" });
      else await G.upload(file, { name: "library.json", parent: root, props: { remagery: "library" }, mime: "application/json" });
      lastError = "";
      setStatus("");
      emit(changedLocal ? "library" : "done");
      return true;
    } catch (e) {
      lastError = e.message || String(e);
      console.warn("[Remagery] sync failed:", lastError);
      setStatus(e.status === 401 ? "Tap to sync" : !G.hasDrive() ? "Drive not allowed" : "Not synced");
      emit("error");
      return false;
    } finally {
      running = null;
      if (again) { again = false; scheduleSync(2000); }
    }
  })();
  return running;
}

// Progress and bookmarks changed: save to Drive a little later
window.addEventListener("remagery:changed", () => scheduleSync(15000));
