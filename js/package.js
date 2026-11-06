// Imports a ChatGPT book package (.zip, format remagery-1): book.json + images/.
// Any audio in the package is ignored: the voice is made by Remagery.

import { db } from "./db.js";

export async function importPackage(file, id, progress) {
  progress("Opening the package", 0.05);
  let zip;
  try { zip = await window.JSZip.loadAsync(file); } catch (e) { throw new Error("This .zip couldn't be opened."); }
  const jsonEntry = Object.values(zip.files).find(f => !f.dir && /(^|\/)book\.json$/i.test(f.name) && !f.name.includes("__MACOSX"));
  if (!jsonEntry) throw new Error("This .zip has no book.json. Make it with the ChatGPT prompt.");
  const root = jsonEntry.name.replace(/book\.json$/i, "");
  let book;
  try { book = JSON.parse(await jsonEntry.async("string")); } catch (e) { throw new Error("book.json in this .zip couldn't be read."); }
  if (!Array.isArray(book.chapters) || !book.chapters.length) throw new Error("This package has no chapters.");

  const wanted = new Set();
  if (book.cover) wanted.add(book.cover);
  for (const c of book.chapters) for (const im of c.images || []) if (im.file) wanted.add(im.file);
  let done = 0;
  for (const path of wanted) {
    const f = zip.file(root + path);
    if (f) {
      const type = /\.png$/i.test(path) ? "image/png" : /\.webp$/i.test(path) ? "image/webp" : "image/jpeg";
      await db.put("files", `${id}/${path}`, new Blob([await f.async("arraybuffer")], { type }));
    }
    done++;
    progress("Saving images", 0.1 + 0.85 * done / wanted.size);
  }

  // Give every sentence an id so pictures and bookmarks can point at it
  book.chapters.forEach((c, ci) => {
    let k = 0;
    const all = [];
    for (const p of c.paragraphs || []) for (const s of p.sentences || []) {
      if (!s.id) s.id = `c${ci}-s${k}`;
      k++;
      all.push(s);
    }
    // Older packages place pictures by time: turn that into the sentence at that time
    for (const im of c.images || []) {
      if (!im.sentence_id && typeof im.start === "number") {
        let hit = all[0];
        for (const s of all) if (typeof s.start === "number" && s.start <= im.start + 0.05) hit = s;
        if (hit) im.sentence_id = hit.id;
      }
    }
    for (const s of all) { delete s.start; delete s.end; }
    delete c.audio; delete c.duration;
  });
  book.title = book.title || file.name.replace(/\.[^.]+$/, "");
  book.authors = book.authors || "";
  return book;
}
