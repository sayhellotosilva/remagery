// "Later": titles you want to read in the future, typed in before you have their PDF.
// Kept on this phone and in library.json in your Google Drive, so every device has the same list.
// A removed title is kept as a small "removed" note, so other devices remove it too.

const KEY = "remagery.later";

function load() { try { return JSON.parse(localStorage.getItem(KEY) || "[]"); } catch (e) { return []; } }
function save(list) { try { localStorage.setItem(KEY, JSON.stringify(list)); } catch (e) {} }

/// Every entry, removed ones included (for syncing).
export const allLater = () => load();
/// The titles to show, newest first.
export const laterList = () => load().filter(x => !x.removed).sort((a, b) => (b.added || 0) - (a.added || 0));

export function addLater(title, author = "") {
  const list = load();
  const now = Date.now();
  const item = { id: "l" + now.toString(36) + Math.random().toString(36).slice(2, 6), title: title.trim(), author: author.trim(), added: now, updatedAt: now };
  list.push(item);
  save(list);
  return item;
}

export function updateLater(id, title, author = "") {
  const list = load();
  const x = list.find(i => i.id === id);
  if (!x) return;
  x.title = title.trim(); x.author = author.trim(); x.updatedAt = Date.now();
  save(list);
}

export function removeLater(id) {
  const list = load();
  const x = list.find(i => i.id === id);
  if (!x) return;
  x.removed = true; x.updatedAt = Date.now();
  save(list);
}

/// Joins this phone's list with the one from Drive. Newest change wins. Returns { list, changed }.
export function mergeLater(remote = []) {
  const local = load();
  const byId = new Map(local.map(x => [x.id, x]));
  let changed = false;
  for (const r of remote) {
    const l = byId.get(r.id);
    if (!l || (r.updatedAt || 0) > (l.updatedAt || 0)) { byId.set(r.id, r); changed = true; }
  }
  // Removed notes older than 90 days aren't needed any more
  const cutoff = Date.now() - 90 * 864e5;
  const list = [...byId.values()].filter(x => !(x.removed && (x.updatedAt || 0) < cutoff));
  save(list);
  return { list, changed };
}
