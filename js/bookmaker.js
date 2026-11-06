// Turns a book PDF into a Remagery book, in the browser (a web version of PDFBookMaker.swift):
// reads the text (or recognises it on scanned pages), splits it into chapters and sentences,
// and cuts out the pictures with their captions and a short description from the book's own text.

import { db } from "./db.js";
import { PACE } from "./config.js";

const pdfjsLib = window.pdfjsLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

export class Cancelled extends Error {}

const SKIP_WORDS = ["contents", "notes", "endnotes", "index", "bibliography", "references",
  "acknowledg", "copyright", "further reading", "credits", "colophon"];

const r2 = x => Math.round(x * 100) / 100;
const fontSize = it => Math.hypot(it.transform[2], it.transform[3]) || Math.abs(it.transform[3]) || 0;

export async function makeBookFromPDF(file, id, progress, job) {
  const check = () => { if (job.cancelled) throw new Cancelled(); };
  progress("Reading the PDF", 0);
  let doc;
  try {
    doc = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  } catch (e) {
    if (e && e.name === "PasswordException") throw new Error("This PDF is locked with a password.");
    throw new Error("This PDF couldn't be opened.");
  }
  const n = doc.numPages;
  if (!n) throw new Error("This PDF has no pages.");

  // Title, authors, cover
  let meta = {};
  try { meta = (await doc.getMetadata()).info || {}; } catch (e) {}
  const title = bookTitle(meta.Title, file.name);
  const authors = (meta.Author || "").trim();
  let cover = null;
  try {
    const b = await renderPage(await doc.getPage(1), 1000);
    await db.put("files", `${id}/images/cover.jpg`, b);
    cover = "images/cover.jpg";
    job.cover = b;
  } catch (e) {}

  // Read every page once: text lines (with font sizes) and pictures
  const pages = [];
  for (let i = 0; i < n; i++) {
    check();
    progress("Reading pages", 0.55 * i / n);
    const page = await doc.getPage(i + 1);
    const tc = await page.getTextContent();
    const items = tc.items.filter(it => typeof it.str === "string");
    const lines = toLines(items);
    const raw = lines.map(l => l.text).join("\n");
    let scanned = false, text = raw;
    let pics = await pictureRects(page);
    const [vx0, vy0, vx1, vy1] = page.view;
    // A scanned page: almost no text and a picture covering most of the page. Recognise its text.
    const pageArea = (vx1 - vx0) * (vy1 - vy0);
    if (raw.replace(/\s/g, "").length <= 20 && pics.some(r => r.w * r.h >= pageArea * 0.5)) {
      scanned = true;
      pics = [];
      progress("Recognising scanned pages", 0.55 * i / n);
      text = await recogniseText(page).catch(() => "");
    }
    pages.push({ items, lines, raw, text, scanned, pics, box: { w: vx1 - vx0, h: vy1 - vy0 } });
    // Let go of the page's decoded pictures and fonts straight away: on iPhone, keeping every page
    // in memory makes Safari close the page on big, picture-heavy books.
    page.cleanup();
    if (i % 10 === 9) { try { await doc.cleanup(); } catch (e) {} await pause(); }
  }

  // Keep only text in the book's main size: drops footnotes, side notes, footnote numbers,
  // captions and running headers, which are set smaller.
  const bodySize = mainTextSize(pages);
  if (bodySize) for (const p of pages) if (!p.scanned) p.text = mainText(p.lines, bodySize);
  // The copyright page (ISBN, printer, licence) isn't read
  for (const p of pages) if (p.text.includes("ISBN")) p.text = "";

  // The table of contents isn't read. If the PDF has no chapter list, it's used to find the chapters.
  const rawTexts = pages.map(p => p.raw);
  const contents = tableOfContents(rawTexts);
  for (const i of contents.pages) pages[i].text = "";
  let labels = null;
  try { labels = await doc.getPageLabels(); } catch (e) {}
  const printed = printedPageMap(labels, rawTexts);

  // A scan with a text layer has a full-page picture on most pages: ignore those
  const isFull = (r, p) => (r.w * r.h) / (p.box.w * p.box.h) >= 0.9;
  const fullPages = pages.filter(p => p.pics.some(r => isFull(r, p))).length;
  if (fullPages > n / 2) for (const p of pages) p.pics = p.pics.filter(r => !isFull(r, p));

  // Captions: short text in a different or smaller font right under each picture
  const captionTexts = pages.map(() => []);
  pages.forEach((p, i) => {
    if (!p.pics.length) return;
    const body = bodyFont(p.items);
    if (!body) return;
    for (const pic of p.pics) {
      const c = caption(p.items, pic, body);
      if (c) { pic.caption = c; captionTexts[i].push(squash(c)); }
    }
  });

  const headers = repeatedLines(pages.map(p => p.text));

  // Chapters → paragraphs → sentences
  progress("Finding chapters", 0.58);
  const ranges = await chapterRanges(doc, n, contents.entries, printed);
  const drafts = [];
  for (const r of ranges) {
    const paras = paragraphs(r.start, r.end, pages.map(p => p.text), headers, captionTexts, r.title);
    if (paras.length) drafts.push({ title: r.title, start: r.start, end: r.end, paragraphs: paras });
  }
  if (!drafts.length) throw new Error("No readable text was found in this PDF.");

  const chapters = [];
  for (let ci = 0; ci < drafts.length; ci++) {
    check();
    progress(`Chapter ${ci + 1} of ${drafts.length}`, 0.6 + 0.39 * ci / drafts.length);
    const d = drafts[ci];
    const flat = d.paragraphs.flat();
    const timings = estimateTimings(d.paragraphs.map(p => p.map(s => s.text)));
    let k = 0;
    const pkgParas = d.paragraphs.map(p => ({ sentences: p.map(s => ({ id: `c${ci}-s${k++}`, text: s.text })) }));

    // Pictures appear when the narration reaches their page.
    // Several pictures on one page are spread over that page's sentences.
    const images = [];
    let lastStart = -10;
    for (let pi = d.start; pi < d.end; pi++) {
      const pics = pages[pi].pics;
      if (!pics.length) continue;
      let onPage = flat.map((s, i) => (s.page === pi ? i : -1)).filter(i => i >= 0);
      if (!onPage.length) { const f = flat.findIndex(s => s.page >= pi); onPage = [f >= 0 ? f : flat.length - 1]; }
      await pause();
      for (let m = 0; m < pics.length; m++) {
        const idx = onPage[Math.min(onPage.length - 1, Math.floor(m * onPage.length / pics.length))];
        const start = Math.max(timings.sentences[idx].start, lastStart + 4);
        if (start >= timings.duration) continue;
        const name = `images/p${pi + 1}-${m + 1}.jpg`;
        check();
        const pg = await doc.getPage(pi + 1);
        const blob = await saveCrop(pg, pics[m]).catch(() => null);
        pg.cleanup();
        if (!blob) continue;
        await db.put("files", `${id}/${name}`, blob);
        const nearby = [];
        flat.forEach((s, j) => { if (Math.abs(s.page - pi) <= 1) nearby.push({ index: j, text: s.text, page: s.page }); });
        images.push({
          id: `c${ci}-i${images.length}`, file: name, source_page: pi + 1, caption: pics[m].caption || null,
          description: describeFromBook(nearby, pi, idx, pics[m].caption), sentence_id: `c${ci}-s${idx}`,
        });
        lastStart = start;
      }
    }
    const pagesList = [];
    for (let p = d.start; p < d.end; p++) pagesList.push(p + 1);
    chapters.push({ number: ci, title: d.title, source_pages: pagesList, paragraphs: pkgParas, images });
  }
  progress("Finishing", 0.99);
  try { await doc.destroy(); } catch (e) {}
  return { format: "remagery-web", title, authors, cover, chapters };
}

// ---------- Page text ----------

/// Groups pdf.js text pieces into lines (top to bottom).
function toLines(items) {
  const lines = [];
  let cur = null;
  for (const it of items) {
    const y = it.transform[5], size = fontSize(it);
    if (!cur || Math.abs(y - cur.y) > Math.max(2, size * 0.5)) {
      if (cur) lines.push(cur);
      cur = { y, parts: [] };
    }
    if (it.str) cur.parts.push({ str: it.str, size, x: it.transform[4], w: it.width });
    if (it.hasEOL) { lines.push(cur); cur = null; }
  }
  if (cur) lines.push(cur);
  for (const l of lines) {
    let t = "";
    let lastEnd = null;
    for (const p of l.parts) {
      if (lastEnd !== null && p.x - lastEnd > p.size * 0.15 && !t.endsWith(" ") && !p.str.startsWith(" ")) t += " ";
      t += p.str;
      lastEnd = p.x + p.w;
    }
    l.text = t.trim();
  }
  return lines.filter(l => l.text.length);
}

/// The font size most of the book's text is set in (the main text).
function mainTextSize(pages) {
  const count = {};
  for (const p of pages) if (!p.scanned) for (const l of p.lines) for (const part of l.parts) {
    const k = Math.round(part.size * 2);
    count[k] = (count[k] || 0) + part.str.length;
  }
  let best = null, bc = 0;
  for (const k in count) if (count[k] > bc) { bc = count[k]; best = +k; }
  return best ? best / 2 : null;
}

/// The page's text without anything set clearly smaller than the main text.
function mainText(lines, body) {
  return lines.map(l => l.parts.filter(p => p.size >= body * 0.85).map(p => p.str).join("").trim()).join("\n");
}

/// Text recognition for scanned pages (loads Tesseract only when a scanned page appears).
let tesseractWorker = null;
async function recogniseText(page) {
  if (!window.Tesseract) {
    await new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.0/dist/tesseract.min.js";
      s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
  }
  if (!tesseractWorker) tesseractWorker = await window.Tesseract.createWorker("eng");
  const vp = page.getViewport({ scale: 2 });
  const c = document.createElement("canvas");
  c.width = vp.width; c.height = vp.height;
  await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
  const { data } = await tesseractWorker.recognize(c);
  c.width = c.height = 0;
  return (data.text || "").trim();
}

// ---------- Chapters ----------

async function destPageIndex(doc, dest) {
  try {
    if (typeof dest === "string") dest = await doc.getDestination(dest);
    if (!Array.isArray(dest) || !dest.length) return null;
    const ref = dest[0];
    if (typeof ref === "number") return ref;
    return await doc.getPageIndex(ref);
  } catch (e) { return null; }
}

async function chapterRanges(doc, pageCount, contents, printed) {
  let marks = [];
  let outline = null;
  try { outline = await doc.getOutline(); } catch (e) {}
  if (outline && outline.length) {
    let level = outline;
    // A single top item (often the book title) → use what's inside it
    while (level.length === 1 && level[0].items && level[0].items.length > 1) level = level[0].items;
    let items = level;
    // A few big parts with chapters inside → use the chapters
    if (items.length <= 6 && items.some(o => (o.items || []).length >= 2)) {
      items = items.flatMap(o => ((o.items || []).length >= 2 ? o.items : [o]));
    }
    for (const o of items) {
      const idx = await destPageIndex(doc, o.dest);
      if (idx !== null) marks.push([(o.title || "").trim(), idx]);
    }
  }
  // No usable chapter list in the PDF: use the book's own table of contents
  if (marks.length < 2 && contents.length >= 2) {
    marks = [];
    const offset = typicalOffset(printed);
    for (const e of contents) {
      const idx = printed[e.page] ?? (offset !== null ? e.page + offset : null);
      if (idx !== null && idx >= 0 && idx < pageCount) marks.push([e.title, idx]);
    }
  }
  marks.sort((a, b) => a[1] - b[1]);
  const unique = [];
  for (const m of marks) if (!unique.length || unique[unique.length - 1][1] !== m[1]) unique.push(m);

  const out = [];
  if (unique.length >= 2) {
    unique.forEach((m, i) => {
      const end = i + 1 < unique.length ? unique[i + 1][1] : pageCount;
      const low = m[0].toLowerCase();
      if (SKIP_WORDS.some(w => low.includes(w))) return;
      if (end > m[1]) out.push({ title: m[0] || `Chapter ${out.length + 1}`, start: m[1], end });
    });
  }
  if (!out.length) {
    // No usable chapter list: split every 20 pages
    for (let s = 0; s < pageCount; s += 20) {
      const e = Math.min(s + 20, pageCount);
      out.push({ title: `Pages ${s + 1}–${e}`, start: s, end: e });
    }
  }
  return out;
}

// ---------- Text into paragraphs and sentences ----------

/// Lines that repeat at the top or bottom of many pages (running headers, footers).
function repeatedLines(texts) {
  const count = new Map();
  for (const t of texts) {
    const lines = t.split("\n").map(normalLine).filter(Boolean);
    const set = new Set([...lines.slice(0, 2), ...lines.slice(-2)]);
    for (const l of set) if (l.length < 70) count.set(l, (count.get(l) || 0) + 1);
  }
  return new Set([...count].filter(([, c]) => c >= 4).map(([l]) => l));
}

const normalLine = s => s.trim().toLowerCase().replace(/\d/g, "").trim();
const squash = s => s.toLowerCase().replace(/\s+/g, " ").trim();

/// True for lines where every letter is doubled ("SSTTAARRTT"): broken running headers.
function isDoubled(line) {
  const c = [...line.replace(/\s/g, "")];
  if (c.length < 6 || c.length % 2) return false;
  for (let i = 0; i < c.length; i += 2) if (c[i] !== c[i + 1]) return false;
  return true;
}

const segmenter = typeof Intl !== "undefined" && Intl.Segmenter ? new Intl.Segmenter("en", { granularity: "sentence" }) : null;
function splitSentences(text) {
  if (segmenter) return [...segmenter.segment(text)].map(s => s.segment.trim()).filter(Boolean);
  return text.split(/(?<=[.!?…]["”’)]?)\s+(?=[A-Z“"‘(])/).map(s => s.trim()).filter(Boolean);
}

function paragraphs(start, end, texts, skip, captions, title = "") {
  const lines = [];
  const titleLine = normalLine(title);
  let titleSkipped = false;
  for (let p = start; p < end; p++) {
    const raw = (texts[p] || "").normalize("NFKC"); // ﬁ → fi
    for (const l of raw.split("\n")) {
      const t = l.trim();
      if (!t) continue;
      if (/^[\d\s]+$/.test(t)) continue; // page numbers
      const nl = normalLine(t);
      if (!nl || skip.has(nl)) continue;
      // The chapter's own title at its start isn't read again (it's shown as the big title)
      if (!titleSkipped && !lines.length && titleLine && nl === titleLine) { titleSkipped = true; continue; }
      if (isDoubled(t)) continue;
      const low = t.toLowerCase();
      if (low.startsWith("http") || low.startsWith("www.")) continue;
      // Captions are shown with the picture, not read
      const sq = squash(t);
      if (sq.length >= 3 && captions[p].some(c => c.includes(sq))) continue;
      lines.push([t, p]);
    }
  }
  if (!lines.length) return [];
  const lengths = lines.map(l => l[0].length).sort((a, b) => a - b);
  const typical = lengths[Math.floor(lengths.length * 3 / 4)];
  const enders = new Set([".", "?", "!", ":", "\"", "”", "’", ")"]);

  // Join lines into paragraphs, remembering where each page starts
  const paras = [];
  let text = "", marks = [];
  lines.forEach(([line, page], i) => {
    if (!marks.length || marks[marks.length - 1][1] !== page) marks.push([text.length, page]);
    if (text.endsWith("-") && /^[a-z]/.test(line)) text = text.slice(0, -1) + line;
    else text += text ? " " + line : line;
    const short = line.length < typical * 0.75;
    if (i === lines.length - 1 || (short && enders.has(line[line.length - 1]))) {
      paras.push({ text, marks }); text = ""; marks = [];
    }
  });

  const out = [];
  for (const p of paras) {
    const clean = cleanForSpeech(p.text);
    // Skip paragraphs that are mostly numbers (lists of pages, tables of figures)
    const tokens = clean.split(" ");
    const numeric = tokens.filter(t => /\d/.test(t) || t === "p." || t === "pp.").length;
    if (tokens.length >= 6 && numeric / tokens.length > 0.45) continue;
    const ss = [];
    let off = 0;
    for (const s of splitSentences(clean)) {
      const at = clean.indexOf(s, off);
      if (at >= 0) off = at;
      if (/\p{L}/u.test(s)) {
        let page = p.marks[0] ? p.marks[0][1] : 0;
        for (const m of p.marks) if (m[0] <= off) page = m[1];
        ss.push({ text: s, page });
      }
    }
    if (ss.length) out.push(ss);
  }
  return out;
}

/// Removes footnote numbers and odd spacing so the voice reads it naturally.
export function cleanForSpeech(s) {
  let t = s;
  t = t.replace(/(?<=[A-Za-z.,;:”"’)])\d{1,3}(?=\s|$)/g, "");                       // "word.12 Next"
  t = t.replace(/\bpp?\.\s*\d+([–-]\d+)?/g, "");                                     // "p. 23", "pp. 12–14"
  t = t.replace(/(https?:\/\/|www\.)\S+/g, "");                                       // web links
  t = t.replace(/\((see |cf\. )?(fig|figs|figure|figures|p|pp|pl|plate|ch|chapter|note|n)\.?\s*[\d\s,–-]+\)/gi, "");
  t = t.replace(/\[\d+([,–-]\s*\d+)*\]/g, "");
  t = t.replace(/\(\s*\d{1,3}\s*\)/g, "");
  for (const [a, b] of [["e.g.", "for example"], ["i.e.", "that is"], ["etc.", "and so on"], ["&", "and"], ["%", " percent"], ["cf.", "compare"]]) t = t.split(a).join(b);
  t = t.replace(/\s+([,.;:])/g, "$1").replace(/\s+/g, " ");
  return t.trim();
}

/// Estimated sentence times (used only to space pictures apart, like the iPhone app).
function estimateTimings(paras) {
  let t = 0;
  const out = [];
  paras.forEach((para, pi) => para.forEach((text, si) => {
    const start = t, end = t + text.length / PACE.charactersPerSecond;
    out.push({ start, end });
    t = end + (si === para.length - 1 ? (pi === paras.length - 1 ? 0.5 : PACE.paragraph) : PACE.sentence);
  }));
  return { sentences: out, duration: t };
}

// ---------- Table of contents ----------

function tableOfContents(texts) {
  const endsWithNumber = /^(.*?)[\s.…·]*(?:p\.|pp\.|page)?\s*(\d{1,4})\s*$/i;
  const pages = [], entries = [];
  const idx = [...texts.keys()];
  const candidates = [...new Set([...idx.slice(0, 30), ...idx.slice(-10)])];
  for (const i of candidates) {
    const lines = texts[i].split("\n").map(l => l.trim())
      .filter(l => l && !isDoubled(l) && !/^\d+$/.test(l) && l.toLowerCase() !== "contents");
    if (lines.length < 4) continue;
    const found = [];
    let pending = "", numbered = 0;
    for (const l of lines) {
      const m = l.match(endsWithNumber);
      if (m && l.length > 3) {
        numbered++;
        const title = (pending + " " + m[1]).trim();
        if (/\p{L}/u.test(title)) found.push([title, +m[2]]);
        pending = "";
      } else if (!/\p{Ll}/u.test(l)) {
        pending = ""; // headings like "TABLE OF CONTENTS"
      } else {
        pending += (pending ? " " : "") + l;
      }
    }
    const mentions = texts[i].toLowerCase().includes("contents");
    let asc = true;
    for (let k = 1; k < found.length; k++) if (found[k][1] < found[k - 1][1]) asc = false;
    if (found.length >= 4 && asc && (numbered / lines.length >= 0.3 || mentions)) {
      pages.push(i);
      for (const f of found) entries.push({ title: cleanContentsTitle(f[0]), page: f[1] });
    }
  }
  return { pages, entries };
}

function cleanContentsTitle(t) {
  return t.replace(/^(chapter\s+)?\d{1,2}\s*[.):]\s*/i, "").replace(/\s*(p\.|pp\.|page)\s*$/i, "").replace(/[.…·\s]+$/, "").trim();
}

/// Printed page number → PDF page, from page labels or the number printed at the top or bottom of each page.
function printedPageMap(labels, texts) {
  const map = {};
  texts.forEach((t, i) => {
    const lab = labels && labels[i];
    if (lab && /^\d+$/.test(lab) && map[+lab] === undefined) { map[+lab] = i; return; }
    const lines = t.split("\n").map(l => l.trim()).filter(Boolean);
    for (const l of [...lines.slice(0, 2), ...lines.slice(-2)]) {
      if (/^\d+$/.test(l) && +l > 0 && +l < 2000 && map[+l] === undefined) { map[+l] = i; break; }
    }
  });
  return map;
}

function typicalOffset(map) {
  const count = {};
  for (const n in map) { const d = map[n] - n; count[d] = (count[d] || 0) + 1; }
  let best = null, bc = 0;
  for (const d in count) if (count[d] > bc) { bc = count[d]; best = +d; }
  return best;
}

// ---------- Pictures ----------

const mul = (m1, m2) => [ // pdf.js Util.transform
  m1[0] * m2[0] + m1[2] * m2[1], m1[1] * m2[0] + m1[3] * m2[1],
  m1[0] * m2[2] + m1[2] * m2[3], m1[1] * m2[2] + m1[3] * m2[3],
  m1[0] * m2[4] + m1[2] * m2[5] + m1[4], m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
];

/// Where the pictures sit on the page (in PDF coordinates), top to bottom.
async function pictureRects(page) {
  const OPS = pdfjsLib.OPS;
  const [x0, y0, x1, y1] = page.view;
  const box = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  let ops;
  try { ops = await page.getOperatorList(); } catch (e) { return []; }
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const found = [];
  const add = (w, h) => {
    if (w < 100 || h < 100) return;
    const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]]);
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    found.push({ x: Math.min(...xs), y: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) });
  };
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i], a = ops.argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() || ctm;
    else if (fn === OPS.transform) ctm = mul(ctm, a);
    else if (fn === OPS.paintFormXObjectBegin) { stack.push(ctm); if (a && a[0]) ctm = mul(ctm, a[0]); }
    else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || ctm;
    else if (fn === OPS.paintImageXObject) add(a[1], a[2]);
    else if (fn === OPS.paintInlineImageXObject && a[0]) add(a[0].width, a[0].height);
    else if (fn === OPS.paintJpegXObject) add(a[1], a[2]);
  }
  // Keep real pictures (not icons or rules), inside the page
  const minArea = box.w * box.h * 0.02;
  let rects = [];
  for (const f of found) {
    const x = Math.max(f.x, box.x), y = Math.max(f.y, box.y);
    const x2 = Math.min(f.x2, box.x + box.w), y2 = Math.min(f.y2, box.y + box.h);
    const w = x2 - x, h = y2 - y;
    if (w < 50 || h < 50 || w * h < minArea) continue;
    rects.push({ x, y, w, h, box });
  }
  // Join pictures that touch or overlap (some PDFs cut one picture into tiles)
  const merged = [];
  for (const r of rects) {
    let m = { ...r };
    let changed = true;
    while (changed) {
      changed = false;
      const i = merged.findIndex(o => o.x - 3 < m.x + m.w && o.x + o.w + 3 > m.x && o.y - 3 < m.y + m.h && o.y + o.h + 3 > m.y);
      if (i >= 0) {
        const o = merged.splice(i, 1)[0];
        const x = Math.min(o.x, m.x), y = Math.min(o.y, m.y);
        m = { x, y, w: Math.max(o.x + o.w, m.x + m.w) - x, h: Math.max(o.y + o.h, m.y + m.h) - y, box };
        changed = true;
      }
    }
    merged.push(m);
  }
  merged.sort((a, b) => Math.abs((a.y + a.h) - (b.y + b.h)) <= 10 ? a.x - b.x : (b.y + b.h) - (a.y + a.h));
  for (const m of merged) m.page = page;
  page.box = box;
  return merged;
}

/// The font used for most of the text on the page.
function bodyFont(items) {
  const count = {};
  const info = {};
  for (const it of items) {
    if (!it.str) continue;
    const s = fontSize(it);
    const key = it.fontName + "|" + Math.round(s * 2);
    count[key] = (count[key] || 0) + it.str.length;
    info[key] = { name: it.fontName, size: s };
  }
  let best = null, bc = 0;
  for (const k in count) if (count[k] > bc) { bc = count[k]; best = k; }
  return best ? info[best] : null;
}

/// Short text right under a picture, set in a smaller or different font than the body text.
function caption(items, r, body) {
  const zx0 = r.x - 6, zx1 = r.x + r.w + 6, zy0 = r.y - 44, zy1 = r.y - 1;
  const inZone = items.filter(it => {
    if (!it.str || !it.str.trim()) return false;
    const x = it.transform[4], y = it.transform[5];
    return x >= zx0 && x <= zx1 && y >= zy0 && y <= zy1;
  });
  if (!inZone.length) return null;
  let diff = 0, total = 0;
  for (const it of inZone) {
    total += it.str.length;
    if (fontSize(it) < body.size - 0.4 || it.fontName !== body.name) diff += it.str.length;
  }
  if (!total || diff / total < 0.6) return null;
  inZone.sort((a, b) => (b.transform[5] - a.transform[5]) || (a.transform[4] - b.transform[4]));
  const text = inZone.map(it => it.str).join(" ").replace(/\s+/g, " ").trim();
  if (text.length < 3 || text.length > 240 || !/\p{L}/u.test(text)) return null;
  return text;
}

/// Turns a canvas into a JPEG, then empties the canvas so iPhone frees its memory at once.
function toJPEG(c, quality) {
  return new Promise(res => c.toBlob(b => { c.width = c.height = 0; res(b); }, "image/jpeg", quality));
}
/// A short breath between pages, so the phone can tidy up memory.
const pause = () => new Promise(r => setTimeout(r, 0));

/// Renders just the picture area of the page as a sharp JPEG.
async function saveCrop(page, r) {
  const scale = Math.min(4, 1400 / Math.max(r.w, r.h));
  const base = page.getViewport({ scale });
  const [ax, ay, bx, by] = base.convertToViewportRectangle([r.x, r.y, r.x + r.w, r.y + r.h]);
  const left = Math.min(ax, bx), top = Math.min(ay, by);
  const w = Math.round(Math.abs(bx - ax)), h = Math.round(Math.abs(by - ay));
  if (w < 2 || h < 2) return null;
  const vp = page.getViewport({ scale, offsetX: -left, offsetY: -top });
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  return toJPEG(c, 0.85);
}

async function renderPage(page, width) {
  const v1 = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: width / v1.width });
  const c = document.createElement("canvas");
  c.width = Math.round(vp.width); c.height = Math.round(vp.height);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  return toJPEG(c, 0.82);
}

// ---------- Short descriptions of pictures, taken from the book's text ----------

const PICTURE_WORDS = ["image", "picture", "photo", "photograph", "figure", "fig.", "shown", "shows",
  "pictured", "illustrat", "drawing", "diagram", "poster", "cover", "above", "below", "opposite",
  "left", "right", "here", "depict", "view", "detail"];

function describeFromBook(sentences, page, near, cap) {
  const capWords = new Set((cap || "").toLowerCase().split(/[^\p{L}]+/u).filter(w => w.length >= 4));
  const words = t => t.split(" ").length;
  const score = s => {
    const low = s.text.toLowerCase();
    let v = s.page === page ? 3 : 1;
    v += PICTURE_WORDS.filter(w => low.includes(w)).length * 2;
    const own = new Set(low.split(/[^\p{L}]+/u).filter(w => w.length >= 4));
    let hits = 0; for (const w of own) if (capWords.has(w)) hits++;
    v += hits * 2;
    v += Math.max(0, 3 - Math.abs(s.index - near) / 2);
    return v;
  };
  const usable = sentences.filter(s => { const n = words(s.text); return n >= 5 && n <= 45; });
  if (!usable.length) return `Picture from page ${page + 1}.`;
  let best = usable[0];
  for (const s of usable) if (score(s) > score(best)) best = s;
  let text = best.text;
  const next = sentences.find(s => s.index === best.index + 1);
  if (words(text) < 14 && next && next.page === best.page && words(text) + words(next.text) <= 45) text += " " + next.text;
  return text;
}

function bookTitle(t, fileName) {
  t = (t || "").trim();
  if (t.length > 2 && !["untitled", ".doc", ".indd"].some(w => t.toLowerCase().includes(w))) return t;
  return fileName.replace(/\.[^.]+$/, "").replace(/[_-]/g, " ");
}
