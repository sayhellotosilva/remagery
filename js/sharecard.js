// The share card: "Reading in November." with this month's covers, drawn as a 1080×1920 picture
// (Instagram Stories size), in the Studio look. Shared with the phone's own share sheet.

const W = 1080, H = 1920;
const SANS = `-apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif`;
const MONO = `ui-monospace, "SF Mono", Menlo, monospace`;
const C = { paper: "#D8D8D5", ink: "#111111", soft: "#5A5A57", line: "#8D8D8A", sheet: "#E2E2DF" };
export const SITE = "remagery.pages.dev";

/// The books read this month: opened since the 1st, and started or finished. Newest first.
export function booksThisMonth(books, now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  return books
    .filter(b => (b.lastOpened || 0) >= start && (b.progress || b.finished || (b.percent || 0) > 0))
    .sort((a, b) => (b.lastOpened || 0) - (a.lastOpened || 0));
}

function loadImage(url) {
  return new Promise(res => {
    if (!url) { res(null); return; }
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => res(null);
    im.src = url;
  });
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/// Text in small mono capitals with a little letter spacing, like the app's labels.
function mono(ctx, text, x, y, { align = "left", color = C.soft, size = 30, weight = 400 } = {}) {
  ctx.font = `${weight} ${size}px ${MONO}`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  if ("letterSpacing" in ctx) ctx.letterSpacing = `${size * 0.06}px`;
  ctx.fillText(text.toUpperCase(), x, y);
  if ("letterSpacing" in ctx) ctx.letterSpacing = "0px";
}

/// Draws one cover: tilted, white edge, soft shadow, picture cropped to fill.
function drawCover(ctx, img, title, cx, cy, w, h, deg) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(deg * Math.PI / 180);
  ctx.shadowColor = "rgba(0,0,0,0.18)"; ctx.shadowBlur = 56; ctx.shadowOffsetY = 28;
  roundRect(ctx, -w / 2 - 8, -h / 2 - 8, w + 16, h + 16, 22);
  ctx.fillStyle = "rgba(255,255,255,0.75)"; ctx.fill();
  ctx.shadowColor = "transparent";
  roundRect(ctx, -w / 2, -h / 2, w, h, 16);
  ctx.save(); ctx.clip();
  if (img) {
    const s = Math.max(w / img.width, h / img.height);
    ctx.drawImage(img, -img.width * s / 2, -img.height * s / 2, img.width * s, img.height * s);
  } else {
    ctx.fillStyle = C.sheet; ctx.fillRect(-w / 2, -h / 2, w, h);
    ctx.fillStyle = C.ink; ctx.textAlign = "left";
    ctx.font = `800 44px ${SANS}`;
    const words = (title || "").toUpperCase().split(/\s+/);
    let line = "", y = -h / 2 + 76;
    for (const wd of words) {
      const t = line ? line + " " + wd : wd;
      if (ctx.measureText(t).width > w - 64 && line) { ctx.fillText(line, -w / 2 + 32, y); line = wd; y += 48; }
      else line = t;
      if (y > h / 2 - 40) break;
    }
    if (line && y <= h / 2 - 40) ctx.fillText(line, -w / 2 + 32, y);
  }
  ctx.restore();
  ctx.restore();
}

/// Makes the card. books: this month's books; coverURL(rec) gives each cover's picture; tilt(id) its angle.
/// Returns a PNG Blob.
export async function makeShareCard(books, coverURL, tilt, now = new Date()) {
  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const ctx = cv.getContext("2d");
  const pad = 88;
  ctx.fillStyle = C.paper; ctx.fillRect(0, 0, W, H);

  // Top: "Reading in" … "4 books"
  const n = books.length;
  mono(ctx, "Reading in", pad, 150);
  mono(ctx, `${n} ${n === 1 ? "PDF" : "PDFs"}`, W - pad, 150, { align: "right" });

  // The month, as big as fits
  const month = now.toLocaleString("en", { month: "long" }).toUpperCase() + ".";
  let size = 132;
  ctx.font = `800 ${size}px ${SANS}`;
  if ("letterSpacing" in ctx) ctx.letterSpacing = `${-size * 0.035}px`;
  while (ctx.measureText(month).width > W - pad * 2 && size > 60) {
    size -= 4; ctx.font = `800 ${size}px ${SANS}`;
    if ("letterSpacing" in ctx) ctx.letterSpacing = `${-size * 0.035}px`;
  }
  ctx.fillStyle = C.ink; ctx.textAlign = "left";
  ctx.fillText(month, pad - 4, 214 + size * 0.78);
  if ("letterSpacing" in ctx) ctx.letterSpacing = "0px";

  // Hairline
  const lineY = 214 + size + 50;
  ctx.fillStyle = C.line; ctx.fillRect(pad, lineY, W - pad * 2, 2);

  // Covers: two columns, up to four, tilted like the library
  const shown = books.slice(0, 4);
  const imgs = await Promise.all(shown.map(async b => loadImage(await coverURL(b))));
  const gx = 60, gy = 72, inner = 12;
  const cw = (W - pad * 2 - inner * 2 - gx) / 2, ch = cw / 0.77;
  const top = lineY + 76;
  shown.forEach((b, i) => {
    const col = i % 2, row = Math.floor(i / 2);
    const cx = pad + inner + col * (cw + gx) + cw / 2;
    const cy = top + row * (ch + gy) + ch / 2;
    drawCover(ctx, imgs[i], b.title, cx, cy, cw, ch, tilt(b.id));
  });

  // Bottom: tagline, name and address
  mono(ctx, "Read aloud, images in sync", pad, H - 104, { size: 26 });
  mono(ctx, "Remagery", W - pad, H - 146, { align: "right", color: C.ink, weight: 500 });
  ctx.font = `400 30px ${MONO}`; ctx.fillStyle = C.soft; ctx.textAlign = "right";
  ctx.fillText(SITE, W - pad, H - 104);

  return await new Promise(res => cv.toBlob(res, "image/png"));
}
