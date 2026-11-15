// PNG maths for capture.mjs (pngjs + culori): crops, region dominant colour, histograms.
import fs from 'node:fs';
import { PNG } from 'pngjs';
import { converter, differenceEuclidean, formatHex } from 'culori';

const toLab = converter('oklab');
const dLab = differenceEuclidean('oklab');

export function readPng(file) {
  return PNG.sync.read(fs.readFileSync(file));
}

// How much a before/after pair of crops differs (hover pairs): changed = share of pixels whose RGB differs by
// > 30 (sum), mean = mean absolute difference / 765; null when a file is missing or the sizes differ.
export const PAIR_CHANGED_MIN = 0.005; // a crop pair differing on >= 0.5% of its pixels shows a visible change
export function pairDelta(fileA, fileB) {
  try {
    if (!fs.existsSync(fileA) || !fs.existsSync(fileB)) return null;
    const a = readPng(fileA), b = readPng(fileB);
    if (a.width !== b.width || a.height !== b.height) return null;
    let n = 0, t = 0;
    for (let i = 0; i < a.data.length; i += 4) {
      const d = Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]);
      t += d; if (d > 30) n++;
    }
    const N = a.width * a.height;
    return { changed: Math.round((n / N) * 10000) / 10000, mean: Math.round((t / N / 765) * 10000) / 10000 };
  } catch { return null; }
}
// What a hover crop pair visibly does, in words, from the pixels that change (RGB sum > 30): `look` =
// 'none' (< PAIR_CHANGED_MIN of the crop), 'lightens' / 'darkens' (>= 75% of the changed pixels move one
// way in luma, by `dL` levels on average), else 'recolours or moves' (mixed: an underline, an arrow, a
// colour swap). `share` = changed share. null when a file is missing or the sizes differ.
export function pairLook(fileA, fileB) {
  try {
    if (!fs.existsSync(fileA) || !fs.existsSync(fileB)) return null;
    const a = readPng(fileA), b = readPng(fileB);
    if (a.width !== b.width || a.height !== b.height) return null;
    let n = 0, up = 0, down = 0, sum = 0;
    for (let i = 0; i < a.data.length; i += 4) {
      const d = Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]);
      if (d <= 30) continue;
      n++;
      const dl = (0.299 * (b.data[i] - a.data[i]) + 0.587 * (b.data[i + 1] - a.data[i + 1]) + 0.114 * (b.data[i + 2] - a.data[i + 2]));
      sum += dl; if (dl > 4) up++; else if (dl < -4) down++;
    }
    const share = n / (a.width * a.height);
    const dL = n ? Math.round(sum / n) : 0;
    const look = share < PAIR_CHANGED_MIN ? 'none' : up >= 0.75 * n ? 'lightens' : down >= 0.75 * n ? 'darkens' : 'recolours or moves';
    return { look, share: Math.round(share * 10000) / 10000, dL };
  } catch { return null; }
}

export function cropToFile(png, x, y, w, h, outFile) {
  x = Math.max(0, Math.round(x)); y = Math.max(0, Math.round(y));
  w = Math.min(Math.round(w), png.width - x); h = Math.min(Math.round(h), png.height - y);
  if (w < 2 || h < 2) return false;
  const out = new PNG({ width: w, height: h });
  for (let row = 0; row < h; row++) {
    const s = ((y + row) * png.width + x) * 4;
    png.data.copy(out.data, row * w * 4, s, s + w * 4);
  }
  fs.writeFileSync(outFile, PNG.sync.write(out, { colorType: 2 }));
  return true;
}

// Stack PNG tiles (buffers, top to bottom) into one image file.
export function stitchToFile(buffers, outFile) {
  const tiles = buffers.map((b) => PNG.sync.read(b));
  const w = Math.min(...tiles.map((t) => t.width));
  const h = tiles.reduce((s, t) => s + t.height, 0);
  const out = new PNG({ width: w, height: h });
  let y = 0;
  for (const t of tiles) {
    for (let row = 0; row < t.height; row++) t.data.copy(out.data, (y + row) * w * 4, row * t.width * 4, row * t.width * 4 + w * 4);
    y += t.height;
  }
  fs.writeFileSync(outFile, PNG.sync.write(out, { colorType: 2 }));
  return { width: w, height: h };
}

// Mean absolute RGB difference between rows [ya, ya+n) of A and [yb, yb+n) of B (sampled grid).
function rowsDiff(A, ya, B, yb, n) {
  const w = Math.min(A.width, B.width);
  let s = 0, c = 0;
  for (let k = 0; k < n; k += 2) {
    const ra = ya + k, rb = yb + k;
    if (ra < 0 || rb < 0 || ra >= A.height || rb >= B.height) continue;
    for (let x = 0; x < w; x += 7) {
      const i = (ra * A.width + x) * 4, j = (rb * B.width + x) * 4;
      s += Math.abs(A.data[i] - B.data[j]) + Math.abs(A.data[i + 1] - B.data[j + 1]) + Math.abs(A.data[i + 2] - B.data[j + 2]);
      c++;
    }
  }
  return c ? s / c : null;
}
function rowsVariance(P, y, n) {
  const v = [];
  for (let k = 0; k < n; k += 2) for (let x = 0; x < P.width; x += 9) { const i = ((y + k) * P.width + x) * 4; if (i + 2 < P.data.length) v.push(P.data[i] + P.data[i + 1] + P.data[i + 2]); }
  if (!v.length) return 0;
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  return v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length;
}
/**
 * Seam self-check for overlapping full-page tiles. prev covers document rows [prevY0, ...), cur covers
 * [curY0, ...); rows [curY0, seamY) are in both. Returns {diff, offset}: diff = mean RGB difference over
 * the overlap (small = consistent); offset = document shift of cur's content found by matching a
 * textured strip of cur against prev (0 = aligned, null = no confident match).
 */
export function seamCheck(prev, prevY0, cur, curY0, seamY) {
  const ov = seamY - curY0;
  if (ov < 8) return { diff: null, offset: null };
  const diff = rowsDiff(prev, curY0 - prevY0, cur, 0, ov);
  // choose the most textured 40-row strip inside the overlap for matching
  let sy = 0, sv = -1;
  for (let y = 0; y + 40 <= ov; y += 20) { const v = rowsVariance(cur, y, 40); if (v > sv) { sv = v; sy = y; } }
  let offset = null;
  if (sv > 50) {
    let best = Infinity, bestRow = null;
    const lo = Math.max(0, curY0 - prevY0 + sy - 2400), hi = Math.min(prev.height - 40, curY0 - prevY0 + sy + 2400);
    for (let r = lo; r <= hi; r++) { const d = rowsDiff(prev, r, cur, sy, 40); if (d !== null && d < best) { best = d; bestRow = r; } }
    if (bestRow !== null && best < 4) offset = (curY0 + sy) - (prevY0 + bestRow);
  }
  return { diff: diff === null ? null : Math.round(diff * 100) / 100, offset };
}
/** Stack decoded tiles top to bottom, dropping `skip` rows at the top of each (the overlap). */
export function stitchTiles(tiles, outFile) {
  const w = Math.min(...tiles.map((t) => t.png.width));
  const h = tiles.reduce((s, t) => s + t.png.height - (t.skip || 0), 0);
  const out = new PNG({ width: w, height: h });
  let y = 0;
  for (const t of tiles) {
    const from = t.skip || 0;
    for (let row = from; row < t.png.height; row++) t.png.data.copy(out.data, (y + row - from) * w * 4, row * t.png.width * 4, row * t.png.width * 4 + w * 4);
    y += t.png.height - from;
  }
  fs.writeFileSync(outFile, PNG.sync.write(out, { colorType: 2 }));
  return { width: w, height: h };
}
export function decodePng(buf) { return PNG.sync.read(buf); }
export function writePng(png, outFile) { fs.writeFileSync(outFile, PNG.sync.write(png, { colorType: 2 })); }
export function clonePng(png) { const o = new PNG({ width: png.width, height: png.height }); png.data.copy(o.data); return o; }
// Share of a region's pixels (sampled every `step` px) that differ from its most common colour (5-bit bins) by
// > 40 (RGB sum): ~0 = flat (blank), text lines read 3-30%, photos and UI far more. null for an empty region.
export function inkShare(png, rect, step = 2) { const r = inkOf(png, rect, step); return r ? r.share : null; }
// Same measure with the number of sampled pixels that differ (`n`): a short word in a wide box has a small share
// but still a few dozen inked pixels.
export function inkOf(png, rect, step = 2) {
  const { width, height, data } = png;
  const x0 = Math.max(0, Math.floor(rect.x)), y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(width, Math.ceil(rect.x + rect.w)), y1 = Math.min(height, Math.ceil(rect.y + rect.h));
  if (x1 - x0 < 2 || y1 - y0 < 2) return null;
  const bins = new Map();
  for (let y = y0; y < y1; y += step) for (let x = x0; x < x1; x += step) { const i = (y * width + x) * 4; const k = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3); bins.set(k, (bins.get(k) || 0) + 1); }
  let bk = 0, bn = -1; for (const [k, n] of bins) if (n > bn) { bn = n; bk = k; }
  const br = ((bk >> 10) & 31) * 8 + 4, bg = ((bk >> 5) & 31) * 8 + 4, bb = (bk & 31) * 8 + 4;
  let n = 0, t = 0;
  for (let y = y0; y < y1; y += step) for (let x = x0; x < x1; x += step) { const i = (y * width + x) * 4; t++; if (Math.abs(data[i] - br) + Math.abs(data[i + 1] - bg) + Math.abs(data[i + 2] - bb) > 40) n++; }
  return t ? { share: n / t, n } : null;
}
// Copy rows [srcY, srcY + n) of src onto rows [dstY, ...) of dst (same width; clipped to both).
export function pasteRows(dst, src, srcY, dstY, n) {
  const w = Math.min(dst.width, src.width);
  for (let k = 0; k < n; k++) {
    const sy = srcY + k, dy = dstY + k;
    if (sy < 0 || dy < 0 || sy >= src.height || dy >= dst.height) continue;
    src.data.copy(dst.data, dy * dst.width * 4, sy * src.width * 4, sy * src.width * 4 + w * 4);
  }
}
// Paints the background region of rows [y0, y1) with colour `to` (a scroll-theme band's rest background shown in
// its in-view colour): the pixels within RGB distance `tol` of colour `from` (hex) that connect (4-way) to the
// band's edge rows or columns. Same-coloured pixels enclosed by other content (text or fills on a card inside the
// band) are left as they are. Returns the number of pixels changed.
export function recolorRows(png, y0, y1, from, to, tol = 14) {
  const rgb = (h) => [1, 3, 5].map((k) => parseInt(String(h).slice(k, k + 2), 16));
  const [fr, fg, fb] = rgb(from), [tr, tg, tb] = rgb(to);
  if ([fr, fg, fb, tr, tg, tb].some((v) => Number.isNaN(v))) return 0;
  const { width, data } = png;
  const top = Math.max(0, y0), bot = Math.min(png.height, y1), h = bot - top;
  if (h <= 0 || width <= 0) return 0;
  const seen = new Uint8Array(width * h), queue = new Int32Array(width * h);
  const match = (k) => { const i = ((top + Math.floor(k / width)) * width + (k % width)) * 4; const dr = data[i] - fr, dg = data[i + 1] - fg, db = data[i + 2] - fb; return dr * dr + dg * dg + db * db <= tol * tol; };
  let qh = 0, qt = 0;
  const push = (k) => { if (!seen[k] && match(k)) { seen[k] = 1; queue[qt++] = k; } };
  for (let x = 0; x < width; x++) { push(x); push((h - 1) * width + x); }
  for (let y = 0; y < h; y++) { push(y * width); push(y * width + width - 1); }
  while (qh < qt) {
    const k = queue[qh++], x = k % width, y = (k - x) / width;
    if (x > 0) push(k - 1);
    if (x < width - 1) push(k + 1);
    if (y > 0) push(k - width);
    if (y < h - 1) push(k + width);
  }
  for (let j = 0; j < qt; j++) { const k = queue[j], i = ((top + Math.floor(k / width)) * width + (k % width)) * 4; data[i] = tr; data[i + 1] = tg; data[i + 2] = tb; }
  return qt;
}
// Rows [y, y + h) of a page shot in parts ([{png, y}] in page coordinates: a full shot and its tail shots past the
// height cap) as one PNG of the first part's width; null when the parts do not cover at least 2 of those rows.
export function rowsOf(parts, y, h) {
  if (!parts || !parts.length) return null;
  const end = Math.max(...parts.map((p) => p.y + p.png.height));
  const y0 = Math.max(0, Math.round(y)), y1 = Math.min(Math.round(y + h), end);
  if (y1 - y0 < 2) return null;
  const out = new PNG({ width: parts[0].png.width, height: y1 - y0 });
  out.data.fill(255);
  for (const p of parts) { const a = Math.max(y0, p.y), b = Math.min(y1, p.y + p.png.height); if (b > a) pasteRows(out, p.png, a - p.y, a - y0, b - a); }
  return out;
}

// 5-bit-per-channel histogram over a region, sampled every `step` px.
function hist(png, rect, step, holes = null) {
  const { width, height, data } = png;
  const x0 = Math.max(0, Math.floor(rect.x)), y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(width, Math.ceil(rect.x + rect.w)), y1 = Math.min(height, Math.ceil(rect.y + rect.h));
  const bins = new Map();
  let total = 0;
  for (let y = y0; y < y1; y += step) {
    const hs = holes ? holes.filter((h) => y >= h.y && y < h.y + h.h) : null;
    for (let x = x0; x < x1; x += step) {
      if (hs && hs.length && hs.some((h) => x >= h.x && x < h.x + h.w)) continue;
      const i = (y * width + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const k = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      let e = bins.get(k);
      if (!e) { e = [0, 0, 0, 0]; bins.set(k, e); }
      e[0]++; e[1] += r; e[2] += g; e[3] += b; total++;
    }
  }
  return { bins, total };
}
const hexOf = (e) => formatHex({ mode: 'rgb', r: e[1] / e[0] / 255, g: e[2] / e[0] / 255, b: e[3] / e[0] / 255 });

// Most common colour of a region (bins merged within OKLab distance 0.02) and its share.
export function dominant(png, rect, step = 4) {
  const { bins, total } = hist(png, rect, step);
  if (!total) return null;
  const top = merge(bins, total, 0.02, 1);
  return top[0] || null;
}

// Background colour of a region: the dominant colour of its pixels outside `holes` (rects in the same pixel
// coordinates: media, images, moving tracks), with `n` = pixels sampled; null when < 2% of the region is left.
export function dominantBg(png, rect, holes, step = 4) {
  const { bins, total } = hist(png, rect, step, holes && holes.length ? holes : null);
  const all = Math.max(1, Math.ceil(rect.w / step) * Math.ceil(rect.h / step));
  if (!total || total < all * 0.02) return null;
  const top = merge(bins, total, 0.02, 1);
  return top[0] ? Object.assign({ n: total, free: Math.round((total / all) * 100) / 100 }, top[0]) : null;
}

// Top colours of a region merged in OKLab (distance < dist), with shares.
export function topColors(png, rect, step = 3, n = 10, dist = 0.035) {
  const { bins, total } = hist(png, rect, step);
  if (!total) return [];
  return merge(bins, total, dist, n);
}

function merge(bins, total, dist, n) {
  const arr = [...bins.values()].sort((a, b) => b[0] - a[0]).slice(0, 400);
  const cl = [];
  for (const e of arr) {
    const hex = hexOf(e);
    const lab = toLab(hex);
    const c = cl.find((k) => dLab(k.lab, lab) < dist);
    if (c) { c.n += e[0]; } else cl.push({ hex, lab, n: e[0] });
  }
  cl.sort((a, b) => b.n - a.n);
  return cl.slice(0, n).map((c) => ({ hex: c.hex, share: Math.round((c.n / total) * 1000) / 1000 }));
}

// Share of the region's pixels within `dist` (OKLab) of a colour.
export function shareOf(topList, hex, dist = 0.04) {
  const lab = toLab(hex);
  let s = 0;
  for (const t of topList) if (dLab(toLab(t.hex), lab) < dist) s += t.share;
  return Math.round(s * 1000) / 1000;
}

// A text line's crop judged on the screenshot's pixels (type sample choice): the line box + 4 px margin.
// frameOut = share of the 2 px frame (left/right columns, top/bottom rows) differing from the frame's median
// colour by > 48 (RGB sum): a busy backdrop (photo, canvas, gradient) or neighbouring text; bg = that median
// colour; contrast = WCAG contrast of the pixel inside farthest from bg against bg (what is drawn, whatever
// the DOM says paints the background). null when the box is outside the image.
export function lineCropStats(png, bbox) {
  if (!png || !bbox) return null;
  const { width: W, height: H, data } = png;
  const x0 = Math.max(0, Math.floor(bbox[0] - 4)), y0 = Math.max(0, Math.floor(bbox[1] - 4));
  const x1 = Math.min(W, Math.ceil(bbox[0] + bbox[2] + 4)), y1 = Math.min(H, Math.ceil(bbox[1] + bbox[3] + 4));
  if (x1 - x0 < 8 || y1 - y0 < 8) return null;
  const frame = [];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    if (!(x < x0 + 2 || x >= x1 - 2 || y < y0 + 2 || y >= y1 - 2)) continue;
    const i = (y * W + x) * 4; frame.push([data[i], data[i + 1], data[i + 2]]);
  }
  const med = [0, 1, 2].map((k) => { const a = frame.map((p) => p[k]).sort((p, q) => p - q); return a[a.length >> 1]; });
  const off = frame.filter((p) => Math.abs(p[0] - med[0]) + Math.abs(p[1] - med[1]) + Math.abs(p[2] - med[2]) > 48).length;
  let far = med, fd = -1;
  for (let y = y0 + 2; y < y1 - 2; y++) for (let x = x0 + 2; x < x1 - 2; x++) {
    const i = (y * W + x) * 4, d = Math.abs(data[i] - med[0]) + Math.abs(data[i + 1] - med[1]) + Math.abs(data[i + 2] - med[2]);
    if (d > fd) { fd = d; far = [data[i], data[i + 1], data[i + 2]]; }
  }
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const a = lum(far), b = lum(med);
  const hex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
  return { frameOut: Math.round((off / Math.max(1, frame.length)) * 100) / 100, bg: hex(med), contrast: Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 10) / 10 };
}
