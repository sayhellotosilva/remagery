// Everything is kept on the phone, in the browser's own storage (IndexedDB).
// books: library records · packages: book.json · files: images · audio: made voice per chapter

const DB_NAME = "remagery";
let dbp;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      for (const s of ["books", "packages", "files", "audio"]) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s);
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}

async function tx(store, mode, fn) {
  const d = await open();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    Promise.resolve(fn(s)).then(v => { out = v; });
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}

const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const db = {
  get: (store, key) => tx(store, "readonly", s => req(s.get(key))),
  put: (store, key, val) => tx(store, "readwrite", s => { s.put(val, key); }),
  del: (store, key) => tx(store, "readwrite", s => { s.delete(key); }),
  all: store => tx(store, "readonly", s => req(s.getAll())),
  keys: store => tx(store, "readonly", s => req(s.getAllKeys())),
  async delPrefix(store, prefix) {
    const keys = await db.keys(store);
    await tx(store, "readwrite", s => { for (const k of keys) if (String(k).startsWith(prefix)) s.delete(k); });
  },
};

// Ask the browser to keep Remagery's books (not clear them when space runs low).
export async function keepStorage() {
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) {}
}
