#!/usr/bin/env node
/*
 * sheet.mjs — contact sheets for a visual check, composed from capture directories.
 *
 *   node sheet.mjs <refCapDir> <buildCapDir> <outDir>     side-by-side A = REFERENCE vs B = BUILD
 *   node sheet.mjs --ref-only <refCapDir> <outDir>        reference-only study sheets
 *
 * Every sheet is about 1560 px wide (nothing needs downscaling to be read at ~1500 px) and at most
 * ~2800 px tall. Each is an HTML page screenshotted in the installed Chrome (playwright-core,
 * channel 'chrome'), which also decodes the JPEG motion frames and draws the labels.
 *
 * Comparison mode (at most 10 sheets; A = blue label, left or upper row; B = amber label):
 *   fold-1440.png       both first screens at 1440, A left, B right
 *   full-1440-<k>.png   full pages at 1440 in <= 4 slices (one sheet each), slice k = the same
 *                       fraction of each page's own height, A left, B right, same scale
 *   full-768.png        full pages at 768 on one sheet: S slices, columns A1 | B1 | A2 | B2 ...
 *   full-390.png        the same at 390
 *   states.png          scrolled states (1440, 768, 390), component crops, hover before/after pairs
 *   motion-<k>.png      frame strips, rows of 5, for each chunk the A row directly above the B row, time
 *                       under each frame: (1) the load, both rows over one span from each row's start
 *                       (first paint, or the end of a lead-in the capture skipped: media still arriving,
 *                       explained in the row note) long enough for both loads to settle (+500 ms, >= 1.5 s,
 *                       <= the recording), <= 15 frames per row, settled frame outlined green; (2) up to 2
 *                       zoomed crops of a first-screen media box that moves on either side (the matching
 *                       box or the same rect on the other side, 5 frames of the settled-page sample);
 *                       (3) reveal i (B's reveal i is recorded at A's page position, so index pairing is
 *                       right), from the wheel input, every second frame, with the measured time the
 *                       scroll position settled. The motion sheets use what is left of the 10-sheet
 *                       budget: fewer frames per strip first, then taller sheets.
 * Reference-only mode (refOnly: true in sheets.json):
 *   ref-fold.png, ref-scrolled.png (1440 | 768 | 390 at equal height), ref-bands-<k>.png (every
 *   1440 band in page order, two columns, labelled index / role / height px and vh),
 *   ref-full-768.png, ref-full-390.png (slices side by side), ref-components.png (component crops
 *   + hover pairs), ref-motion-<k>.png (load + reveal strips, rows of 5).
 * Writes sheets.json (schema restyle-sheets/2: file, desc, size, bytes per sheet). Prints one JSON
 * summary line; exits non-zero on failure.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { settleNote } from './lib/frames.mjs';
import { appearNote } from './lib/frames.mjs';
import { mediaRate, mediaNote } from './lib/frames.mjs';

const W = 1528;            // content width (sheet = W + 2 * 16 padding)
const MAX_H = 2800;        // target sheet height
const GAP = 16;
const MAX_BYTES = 3 * 1024 * 1024;
const MAX_SHEETS = 10;     // comparison mode: all sheets together

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const url = (p) => pathToFileURL(p).href;
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const exists = (f) => !!f && fs.existsSync(f);

function imgSize(file) {
  try {
    const fd = fs.openSync(file, 'r'); const b = Buffer.alloc(64 * 1024); const n = fs.readSync(fd, b, 0, b.length, 0); fs.closeSync(fd);
    if (b.readUInt32BE(12) === 0x49484452) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }; // PNG IHDR
    if (b[0] === 0xff && b[1] === 0xd8) { // JPEG: find SOFn
      let i = 2;
      while (i + 9 < n) {
        if (b[i] !== 0xff) { i++; continue; }
        const m = b[i + 1];
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
        i += 2 + b.readUInt16BE(i + 2);
      }
    }
  } catch { /* fallthrough */ }
  return null;
}

const CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #e9e9ec; font-family: Arial, Helvetica, sans-serif; color: #111; padding: 16px; width: ${W + 32}px; }
  .row { display: flex; gap: ${GAP}px; align-items: flex-start; }
  .col { display: flex; flex-direction: column; gap: 6px; }
  .stack { display: flex; flex-direction: column; gap: 22px; }
  .lab { min-height: 40px; display: flex; align-items: center; flex-wrap: wrap; column-gap: 10px; font-size: 22px; font-weight: 700; padding: 4px 10px; border-radius: 6px; color: #fff; }
  .lab small { font-size: 16px; font-weight: 400; opacity: .95; }
  .lab.sm { min-height: 0; font-size: 17px; padding: 4px 8px; flex-direction: column; align-items: flex-start; }
  .lab.sm small { font-size: 14px; }
  .A { background: #1d4ed8; } .B { background: #b45309; } .N { background: #374151; }
  .crop { position: relative; overflow: hidden; background: #fff; outline: 1px solid #999; }
  .crop img { position: absolute; left: 0; top: 0; display: block; }
  .frame { display: block; outline: 1px solid #999; background: #fff; }
  .cap { font-size: 14px; color: #222; }
  .none { display: flex; align-items: center; justify-content: center; background: #d4d4d8; color: #333; font-size: 17px; outline: 1px dashed #777; text-align: center; padding: 6px; }
  .title { font-size: 24px; font-weight: 700; }
  .sub { font-size: 16px; color: #333; font-weight: 400; }
  .h2 { font-size: 20px; font-weight: 700; border-bottom: 2px solid #999; padding-bottom: 4px; }
  .box { background: #fff; border-radius: 6px; padding: 8px; display: flex; flex-direction: column; gap: 6px; }
  .cell { display: flex; align-items: center; justify-content: center; background: repeating-conic-gradient(#f3f3f3 0 25%, #fff 0 50%) 0 0 / 16px 16px; outline: 1px solid #bbb; overflow: hidden; }
  .cell img { max-width: 100%; max-height: 100%; display: block; }
  .tag { font-size: 14px; font-weight: 700; color: #fff; padding: 2px 6px; border-radius: 4px; align-self: flex-start; }
  .ctitle { font-size: 16px; font-weight: 700; }
  .seq { background: #fff; border-radius: 8px; padding: 10px; display: flex; flex-direction: column; gap: 10px; }
  .chunk { display: flex; flex-direction: column; gap: 4px; padding-bottom: 8px; border-bottom: 1px dashed #bbb; }
  .chunk:last-child { border-bottom: 0; padding-bottom: 0; }
  .srow { display: flex; gap: 8px; align-items: stretch; }
  .side { width: 62px; flex: none; display: flex; flex-direction: column; align-items: center; justify-content: center; color: #fff; font-weight: 700; font-size: 26px; border-radius: 6px; line-height: 1.1; }
  .side small { font-size: 11px; font-weight: 400; text-align: center; }
`;
const page = (title, sub, body) => `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body><div class="stack" style="gap:14px"><div class="title">${esc(title)}${sub ? ` <span class="sub">${esc(sub)}</span>` : ''}</div>${body}</div></body></html>`;
const NAMES = { A: ['A &middot; REFERENCE', 'A &middot; REF'], B: ['B &middot; BUILD', 'B &middot; BUILD'], N: ['', ''] };
const label = (which, extra = '', small = false) => `<div class="lab ${which}${small ? ' sm' : ''}">${NAMES[which][small ? 1 : 0]}${extra ? ` <small>${esc(extra)}</small>` : ''}</div>`;
const noneBox = (w, h, text) => `<div class="none" style="width:${w}px;height:${h}px">${esc(text)}</div>`;
const img = (f, w) => `<img class="frame" src="${url(f)}" style="width:${w}px">`;

/** rows [y0, y1) of a tall image, scaled to width w */
function crop(file, natW, y0, y1, w) {
  const s = w / natW;
  const h = Math.max(1, Math.round((y1 - y0) * s));
  // a full shot with tail shots past its height cap ({parts: [{f, y, h}]}): each part placed at its page row
  if (file && file.parts) return `<div class="crop" style="width:${w}px;height:${h}px">${file.parts.filter((p) => p.y < y1 && p.y + p.h > y0).map((p) => `<img src="${url(p.f)}" style="width:${w}px;top:${Math.round((p.y - y0) * s)}px">`).join('')}</div>`;
  return `<div class="crop" style="width:${w}px;height:${h}px"><img src="${url(file)}" style="width:${w}px;top:${-Math.round(y0 * s)}px"></div>`;
}
/** Size of an image file, or of a full shot with tail shots ({w, h} of the whole page). */
const sizeOf = (f) => (f && f.parts ? { w: f.w, h: f.h } : f ? imgSize(f) : null);

class Renderer {
  async open() {
    this.browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--hide-scrollbars', '--allow-file-access-from-files'] });
    this.ctx = await this.browser.newContext({ viewport: { width: W + 32, height: 800 }, deviceScaleFactor: 1 });
    this.page = await this.ctx.newPage();
  }
  async shoot(html, outFile, tmpDir, zoom) {
    const tmp = path.join(tmpDir, `.sheet-${process.pid}.html`);
    fs.writeFileSync(tmp, zoom === 1 ? html : html.replace('<body>', `<body style="zoom:${zoom}">`));
    await this.page.setViewportSize({ width: W + 32, height: 800 });
    await this.page.goto(url(tmp), { waitUntil: 'load', timeout: 90000 });
    await this.page.evaluate(async () => { await Promise.all([...document.images].map((i) => (i.complete ? null : new Promise((r) => { i.onload = i.onerror = r; })))); });
    const box = await this.page.evaluate(() => ({ w: Math.ceil(document.documentElement.scrollWidth), h: Math.ceil(document.body.getBoundingClientRect().height) }));
    await this.page.setViewportSize({ width: Math.max(320, box.w), height: Math.max(200, Math.min(box.h, 16000)) });
    await this.page.screenshot({ path: outFile, fullPage: true });
    fs.rmSync(tmp, { force: true });
    return { bytes: fs.statSync(outFile).size, w: box.w, h: box.h };
  }
  async render(html, outFile, tmpDir) {
    let r = await this.shoot(html, outFile, tmpDir, 1);
    for (const z of [0.85, 0.7]) { if (r.bytes <= MAX_BYTES) break; r = await this.shoot(html, outFile, tmpDir, z); r.zoom = z; }
    return r;
  }
  async close() { await this.browser?.close(); }
}

/* ---------------------------------------------------------------- capture access */
function cap(dir) {
  const c = readJson(path.join(dir, 'capture.json'));
  if (!c) throw new Error(`no readable capture.json in ${dir}`);
  const p = (rel) => (rel ? path.join(dir, rel) : null);
  const ok = (f) => (exists(f) ? f : null);
  return {
    dir, c,
    full: (vp) => ok(p(c.shots?.[vp]?.full || `shots/${vp}-full.png`)),
    // the full shot plus its tail shots (rows past the capture's height cap) as one page: {parts, w, h}; the plain
    // file path when there are no tail shots
    fullSet: (vp) => {
      const f = ok(p(c.shots?.[vp]?.full || `shots/${vp}-full.png`)), z = f && imgSize(f);
      const tails = (c.shots?.[vp]?.tails || []).map((t) => ({ f: ok(p(t.file)), y: t.y })).filter((t) => t.f);
      if (!z || !tails.length) return f;
      const parts = [{ f, y: 0, h: z.h }, ...tails.map((t) => ({ f: t.f, y: t.y, h: (imgSize(t.f) || { h: 0 }).h }))];
      return { f, parts, w: z.w, h: Math.max(...parts.map((q) => q.y + q.h)) };
    },
    fold: (vp) => ok(p(c.shots?.[vp]?.fold || `shots/${vp}-fold.png`)),
    scrolled: (vp) => ok(p(c.shots?.[vp]?.scrolled)),
    comps: () => Object.keys(c.shots?.components || {}),
    comp: (n) => ok(p(c.shots?.components?.[n])),
    hover: (kind) => { const h = (c.motion?.frames?.hover || []).find((x) => x.kind === kind); return h ? p(h.dir) : null; },
    hoverKinds: () => (c.motion?.frames?.hover || []).map((h) => h.kind),
    frames: (rel) => { const d = p(rel); if (!d || !fs.existsSync(d)) return []; return fs.readdirSync(d).filter((f) => /^f-\d+\.(jpe?g|png)$/i.test(f)).sort().map((f) => path.join(d, f)); },
  };
}

/* ---------------------------------------------------------------- layouts */

/** Equal-height row of images (fit total width), height capped. items: [{f, which, text}] */
function equalRow(items, maxH, small = true) {
  const sz = items.map((it) => (it.f ? imgSize(it.f) : null) || it.fallback || { w: 16, h: 10 });
  const gaps = (items.length - 1) * GAP;
  const H = Math.min(maxH, Math.floor((W - gaps) / sz.reduce((s, z) => s + z.w / z.h, 0)));
  return `<div class="row">${items.map((it, i) => {
    const w = Math.floor((H * sz[i].w) / sz[i].h);
    return `<div class="col" style="width:${w}px">${label(it.which, it.text, small && w < 330)}${it.f ? img(it.f, w) : noneBox(w, H, 'not captured')}</div>`;
  }).join('')}</div>`;
}

/**
 * Slice geometry for one or two full-page images at a viewport: chooses the number of slices S (<= maxS)
 * that maximises the rendered column width given `colsPerSlice` columns per slice on one sheet.
 */
function sliceLayout(sizes, vpW, contentMax, colsPerSlice, maxS) {
  let best = null;
  for (let S = 1; S <= maxS; S++) {
    const ncols = S * colsPerSlice;
    const colW = Math.min(vpW, Math.floor((W - (ncols - 1) * GAP) / ncols));
    const tallest = Math.max(...sizes.filter(Boolean).map((z) => (z.h * colW) / z.w / S));
    const w = Math.floor(colW * Math.min(1, contentMax / tallest));
    if (!best || w > best.w + 2) best = { S, w };
  }
  return best;
}
const sliceRange = (z, k, S) => [Math.round((z.h * k) / S), Math.round((z.h * (k + 1)) / S)];
const pct = (k, S) => `${Math.round((100 * k) / S)}%`;
const sliceName = (k, S) => (S === 1 ? 'whole page' : S === 2 ? (k === 0 ? 'top half' : 'bottom half') : `part ${k + 1}/${S}`);

/** Full-page slices at 1440 for A and B: one sheet per slice (<= 4). */
function full1440Sheets(fa, fb) {
  const za = sizeOf(fa), zb = sizeOf(fb);
  if (!za && !zb) return [];
  const colW = Math.floor((W - GAP) / 2);
  const contentMax = MAX_H - 140;
  const need = (z) => (z ? Math.ceil((z.h * colW) / z.w / contentMax) : 1);
  const S = Math.min(4, Math.max(1, need(za), need(zb)));
  const tallest = Math.max(...[za, zb].filter(Boolean).map((z) => (z.h * colW) / z.w / S));
  const w = Math.floor(colW * Math.min(1, contentMax / tallest));
  const out = [];
  for (let k = 0; k < S; k++) {
    const part = S > 1 ? `slice ${k + 1}/${S}: ${pct(k, S)}-${pct(k + 1, S)} of page height` : 'whole page';
    const col = (which, f, z) => {
      if (!z) return `<div class="col" style="width:${colW}px">${label(which, '1440px')}${noneBox(colW, 300, 'no screenshot')}</div>`;
      const [y0, y1] = sliceRange(z, k, S);
      return `<div class="col" style="width:${colW}px">${label(which, `1440px · page ${z.h}px · rows ${y0}-${y1}`)}${crop(f, z.w, y0, y1, w)}</div>`;
    };
    out.push({ k: k + 1, S, html: page(`Full page at 1440 — ${part}`, `each slice is the same fraction of each page's own height; same scale (${Math.round((100 * w) / 1440)}%) both sides`, `<div class="row">${col('A', fa, za)}${col('B', fb, zb)}</div>`) });
  }
  return out;
}

/** Narrow full pages on one sheet. sides: [{which, f}] (1 or 2). */
function narrowSheet(vp, sides, title) {
  const vpW = Number(vp);
  const zs = sides.map((s) => sizeOf(s.f));
  if (!zs.some(Boolean)) return null;
  const contentMax = MAX_H - 170;
  const { S, w } = sliceLayout(zs, vpW, contentMax, sides.length, sides.length === 2 ? 4 : 6);
  const small = w < 330;
  let cols = '';
  for (let k = 0; k < S; k++) {
    sides.forEach((s, i) => {
      const z = zs[i];
      const part = `${sliceName(k, S)}${S > 1 ? ` (${pct(k, S)}-${pct(k + 1, S)})` : ''}`;
      const ml = i === 0 && k > 0 && sides.length === 2 ? ' style="margin-left:14px"' : '';
      cols += `<div class="col"${ml}><div style="width:${w}px">${label(s.which, part, small)}</div>${z ? crop(s.f, z.w, ...sliceRange(z, k, S), w) : noneBox(w, 300, 'no screenshot')}</div>`;
    });
  }
  const scale = Math.round((100 * w) / vpW);
  const order = sides.length === 2 ? `columns: ${Array.from({ length: S }, (_, k) => `A${k + 1} | B${k + 1}`).join(' · ')}` : `${S} slice${S > 1 ? 's' : ''} left to right`;
  return { S, html: page(title, `${order}; ${scale}% scale; page heights ${zs.map((z, i) => `${sides[i].which} ${z ? z.h : '-'}px`).join(', ')}`, `<div class="row" style="gap:10px">${cols}</div>`) };
}

/** Component crops: wide ones (aspect >= 5) as full-width rows, the rest 4 per row. */
function componentsBlock(names, sides) {
  if (!names.length) return '';
  const two = sides.length === 2;
  const aspect = (n) => { for (const s of sides) { const f = s.x.comp(n); const z = f && imgSize(f); if (z) return z.w / z.h; } return 1; };
  const wide = names.filter((n) => aspect(n) >= 5), small = names.filter((n) => aspect(n) < 5);
  const cell = (f, w, h) => `<div class="cell" style="width:${w}px;height:${h}px">${f ? `<img src="${url(f)}">` : '<span class="cap">not found</span>'}</div>`;
  const tag = (which) => `<span class="tag ${which}">${which === 'A' ? 'A · REF' : which === 'B' ? 'B · BUILD' : ''}</span>`;
  let html = '';
  for (const n of wide) {
    const cw = two ? Math.floor((W - GAP - 16) / 2) : W - 16;
    html += `<div class="box"><div class="ctitle">${esc(n)}</div><div class="row">${sides.map((s) => `<div class="col">${tag(s.which)}${cell(s.x.comp(n), cw, 80)}</div>`).join('')}</div></div>`;
  }
  if (small.length) {
    const per = 4, bw = Math.floor((W - (per - 1) * GAP) / per), cw = bw - 16;
    html += `<div class="row" style="flex-wrap:wrap">${small.map((n) => `<div class="box" style="width:${bw}px"><div class="ctitle">${esc(n)}</div>${sides.map((s) => `${tag(s.which)}${cell(s.x.comp(n), cw, two ? 130 : 170)}`).join('')}</div>`).join('')}</div>`;
  }
  return html;
}

/** Hover before/after pairs. Two sides: one row per kind (A before, A hover, B before, B hover). */
function hoverBlock(kinds, sides) {
  if (!kinds.length) return '';
  const two = sides.length === 2;
  const fr = (d, n) => (d && exists(path.join(d, `f-0${n}.png`)) ? path.join(d, `f-0${n}.png`) : null);
  const cell = (f, w, h) => `<div class="cell" style="width:${w}px;height:${h}px">${f ? `<img src="${url(f)}">` : '<span class="cap">none</span>'}</div>`;
  const tag = (which, t) => `<span class="tag ${which}">${which === 'A' ? 'A' : 'B'} · ${t}</span>`;
  if (two) {
    const cw = Math.floor((W - 16 - 3 * 10) / 4);
    return kinds.map((k) => `<div class="box"><div class="ctitle">${esc(k)}</div><div class="row" style="gap:10px">${sides.map((s) => { const d = s.x.hover(k); return [0, 1].map((n) => `<div class="col">${tag(s.which, n ? 'hover' : 'before')}${cell(fr(d, n), cw, 150)}</div>`).join(''); }).join('')}</div></div>`).join('');
  }
  const per = Math.min(3, kinds.length), bw = Math.floor((W - (per - 1) * GAP) / per), cw = Math.floor((bw - 16 - 8) / 2);
  return `<div class="row" style="flex-wrap:wrap">${kinds.map((k) => { const d = sides[0].x.hover(k); return `<div class="box" style="width:${bw}px"><div class="ctitle">${esc(k)}</div><div class="row" style="gap:8px">${[0, 1].map((n) => `<div class="col">${tag('A', n ? 'hover' : 'before')}${cell(fr(d, n), cw, 190)}</div>`).join('')}</div></div>`; }).join('')}</div>`;
}

/* ---------------------------------------------------------------- motion */
const FW = 280; // frame width: 5 frames + side tag fit inside the sequence box
const FH = Math.round(FW * 0.625);
const SHOT_W = 1440, SHOT_H = 900; // load/reveal/media frames are 1440x900 first screens
const LOAD_MIN_SPAN = 1500, LOAD_MARGIN = 500;
const sideName = (w) => (w === 'A' ? 'A reference' : 'B build');
const frameIdx = (f) => Number((path.basename(f).match(/\d+/) || [0])[0]);

/**
 * Load strips of all sides over ONE time span from each row's start (first contentful paint, or the end of
 * a skipped lead-in), long enough to hold every side's load until it settled (+500 ms), at least 1.5 s, at
 * most what was recorded; the frame step keeps each row to maxFrames frames (rows of 5).
 */
function loadSeq(sides, maxFrames) {
  const info = sides.map((s) => {
    const L = s.x.c.motion?.frames?.load || null;
    const fr = s.x.frames(L?.dir || 'motion/frames/load');
    const fps = L?.fps || 12;
    const recMs = fr.length ? Math.round(((fr.length - 1) * 1000) / fps) : 0;
    const skip = Math.min(L?.leadIn?.skippedMs || 0, Math.max(0, recMs - 500));
    const avail = Math.max(0, recMs - skip);
    // ms from the row start until the load settled; unknown (older capture) or never settled = the whole recording
    const rel = typeof L?.settleMs === 'number' && L.settled !== false ? Math.max(0, L.settleMs - skip) : avail;
    return { s, L, fr, fps, recMs, skip, avail, rel };
  });
  const have = info.filter((i) => i.fr.length);
  const maxAvail = Math.max(0, ...have.map((i) => i.avail));
  const fps = have[0]?.fps || 12, fms = 1000 / fps;
  let span = Math.min(maxAvail, Math.max(LOAD_MIN_SPAN, Math.max(0, ...have.map((i) => i.rel)) + LOAD_MARGIN));
  const stepF = Math.max(1, Math.ceil(span / Math.max(1, maxFrames - 1) / fms));
  const stepMs = stepF * fms;
  const n = Math.min(maxFrames, Math.floor(span / stepMs + 1e-6) + 1);
  span = Math.round((n - 1) * stepMs);
  const per = info.map(({ s, L, fr, fps: f, recMs, skip }) => {
    if (!fr.length) return { ...s, cells: [], note: 'no load sequence captured' };
    const settle = typeof L?.settleMs === 'number' ? L.settleMs : null;
    let marked = false;
    const cells = [];
    for (let k = 0; k < n; k++) {
      const t = Math.round(skip + k * stepMs);
      const idx = Math.round((t * f) / 1000);
      if (idx >= fr.length) { cells.push({ none: `not recorded (this strip ends at ${recMs} ms)`, t }); continue; }
      const mark = settle !== null && L.settled !== false && !marked && t >= settle - 1 ? `settled (~${settle} ms)` : '';
      if (mark) marked = true;
      cells.push({ f: fr[idx], t, label: `t = ${t} ms`, mark });
    }
    // the same wording on every row: when the content settled, then what keeps moving after it (media, other)
    const parts = [`${L?.run ? `${L.run} load` : 'load'}`, settleNote(L)];
    // how the first screen arrives (frames.mjs loadAppear): one step (no transition) vs a fade / slide
    if (L?.appear && L.appear.kind !== 'none') parts.push(`first screen ${appearNote(L.appear, { at: 'ms' })}`);
    parts.push(skip ? `row starts ${skip} ms after first paint; the first ${skip} ms are not shown: ${L.leadIn.why}` : 'row starts at first paint');
    return { ...s, cells, note: parts.join('; ') };
  });
  return { kind: 'load', title: `Page load: ${span} ms from each row's start, one frame every ${Math.round(stepMs)} ms`, sub: 't = ms after first contentful paint; green frame = settled', per, chunks: Math.ceil(n / 5) };
}

/** Reveal strip i of all sides: every `every`-th frame (12 fps) from the wheel input. */
function revealSeq(sides, i, every) {
  const per = sides.map((s) => {
    const r = (s.x.c.motion?.frames?.reveals || [])[i];
    const fr = s.x.frames(r?.dir);
    if (!fr.length) return { ...s, cells: [], note: 'no reveal sequence captured' };
    const fps = r?.fps || 12;
    const anchored = r?.t0 === 'wheel';
    const cells = fr.filter((f) => frameIdx(f) % every === 0).map((f) => { const t = Math.round((frameIdx(f) * 1000) / fps); return { f, t, label: `t = ${t} ms` }; });
    const sc = r?.scroll;
    // a page whose first animation frame after the input comes late was busy (script work), not designed to wait
    const busy = sc && sc.firstFrameMs > 50 ? `; page busy: its first frame after the input ran at ~${sc.firstFrameMs} ms` : '';
    const scrollNote = !sc ? '' : Math.abs(sc.px) < 2 ? 'the page did not scroll' : sc.settleMs !== null ? `scroll position settled ~${sc.settleMs} ms after the wheel input (${sc.px} px)${busy}` : `scrolled ${sc.px} px, still moving at the end${busy}`;
    const where = `scroll ${r.scrollFrom}->${r.scrollTo}px${r.band ? `, band ${r.band}` : ''}`;
    // how the content in view arrives after the scroll stops (frames.mjs stripAppear)
    const ap = r?.content?.appear;
    const apNote = ap ? (ap.kind === 'none' ? 'content in place when the scroll stops' : `content ${appearNote(ap, { at: 'ms' })}`) : '';
    return { ...s, cells, note: [scrollNote, apNote, where, anchored ? '' : 'start not anchored to the wheel input (older capture)'].filter(Boolean).join('; ') };
  });
  const n = Math.max(1, ...per.map((p) => p.cells.length));
  // a strip recorded across the reference's first page-colour change (scroll tint) rather than a reveal
  const tint = sides.some((s) => ((s.x.c.motion?.frames?.reveals || [])[i] || {}).why === 'scroll tint');
  const what = tint ? `Scroll strip ${i + 1}: one wheel step across the reference's page colour change` : `Scroll reveal ${i + 1}: one wheel step brings a band into view`;
  return { kind: 'reveal', title: `${what}, ${per[0]?.cells.length ? '1.5 s' : ''}`.replace(/, $/, ''), sub: `t = ms after the wheel input; one frame every ${Math.round((every * 1000) / 12)} ms`, per, chunks: Math.ceil(n / 5) };
}

/**
 * First-screen media boxes that move on either side, paired with the matching media box on the other side
 * (largest overlap), else the same viewport rect. Boxes over half the screen are readable in the strips.
 */
function zoomPairs(sides, maxPairs) {
  const area = (b) => b[2] * b[3];
  const clip = (b) => { const x = Math.max(0, b[0]), y = Math.max(0, b[1]); return [x, y, Math.min(SHOT_W, b[0] + b[2]) - x, Math.min(SHOT_H, b[1] + b[3]) - y]; };
  const iou = (a, b) => { const w = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0])), h = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1])); const i = w * h; return i / Math.max(1, area(a) + area(b) - i); };
  const rank = { high: 3, medium: 2, low: 1 };
  // level, rate and how it moves: the compare rule for any capture version (frames.mjs mediaRate / mediaNote)
  const ent = (m) => { const mr = mediaRate(m); return { box: clip(m.box), kind: m.kind, el: m.el, activity: mr.level || 'static', rate: mr.rate, hot: m.hot, note: mediaNote(m) }; };
  const all = (c) => (c.motion?.load?.media || []).filter((m) => Array.isArray(m.box)).map(ent);
  // every moving box of any size (a box over a third of the screen is shown by its most-moving half, below)
  const moving = (c) => {
    const out = all(c).filter((m) => m.activity !== 'static');
    for (const it of c.motion?.ambient?.items || []) if (it.kind === 'media' && Array.isArray(it.box) && !out.some((o) => iou(o.box, clip(it.box)) > 0.8)) out.push(ent({ ...it, kind: it.media || 'media' }));
    return out.filter((m) => m.box[2] >= 16 && m.box[3] >= 16);
  };
  // a large box (>= a third of the screen) is zoomed to its most-moving half-size region (capture `hot`; else
  // its centre), the same relative region on the other side, so the crop is big enough to see how much moves
  const big = (b) => area(b) >= SHOT_W * SHOT_H / 3;
  const region = (b, hot) => (Array.isArray(hot) ? clip(hot) : [b[0] + b[2] / 4, b[1] + b[3] / 4, b[2] / 2, b[3] / 2]);
  const mapRel = (r, from, to) => [to[0] + ((r[0] - from[0]) / Math.max(1, from[2])) * to[2], to[1] + ((r[1] - from[1]) / Math.max(1, from[3])) * to[3], (r[2] / Math.max(1, from[2])) * to[2], (r[3] / Math.max(1, from[3])) * to[3]];
  const cands = sides.flatMap((s, si) => moving(s.x.c).map((m) => ({ ...m, si }))).sort((a, b) => a.si - b.si || (rank[b.activity] || 0) - (rank[a.activity] || 0) || area(a.box) - area(b.box));
  const pairs = [];
  for (const m of cands) {
    if (pairs.length >= maxPairs) break;
    if (pairs.some((p) => iou((p.full || p.boxes)[m.si], m.box) > 0.3)) continue;
    const boxes = sides.map((s, j) => {
      if (j === m.si) return m.box;
      const best = all(s.x.c).map((o) => ({ o, v: iou(o.box, m.box) })).sort((a, b) => b.v - a.v)[0];
      return best && best.v >= 0.1 ? best.o.box : m.box;
    });
    const how = sides.map((s, j) => {
      if (j === m.si) return `${m.kind} box moving (${m.note})`;
      const best = all(s.x.c).map((o) => ({ o, v: iou(o.box, m.box) })).sort((a, b) => b.v - a.v)[0];
      if (best && best.v >= 0.1) return `matching ${best.o.kind} box, measured ${best.o.note}`;
      return 'no media box here: same viewport rect';
    });
    // large boxes: crop to the owner's most-moving region, mapped into the other side's box
    let crops = boxes, part = null;
    if (big(m.box)) {
      const r = region(m.box, m.hot);
      crops = boxes.map((b, j) => (j === m.si ? r : mapRel(r, m.box, b)));
      part = `the box is large, so the crop is its most-moving half-size region (${r.map(Math.round).join(',')} on ${sides[m.si].which})`;
    }
    pairs.push({ boxes: crops, full: boxes, how, owner: sides[m.si].which, ownerIdx: m.si, part });
  }
  return pairs;
}
function zoomSeq(sides, pair, k) {
  const per = sides.map((s, j) => {
    const M = s.x.c.motion?.frames?.media;
    let fr = M ? s.x.frames(M.dir) : [], fps = M?.fps || 6, src = `a ${Math.round((M?.durationMs || 2500) / 100) / 10} s sample of the settled first screen`;
    if (!fr.length) {
      // no media sample on this side: the end of its load strip (the settled first screen)
      const L = s.x.c.motion?.frames?.load;
      const lf = s.x.frames(L?.dir || 'motion/frames/load');
      fps = L?.fps || 12;
      const from = Math.max(0, lf.length - Math.round(2.5 * fps) - 1);
      fr = lf.slice(from);
      src = lf.length ? 'the end of the load strip (no media sample on this side)' : '';
      if (!fr.length) return { ...s, cells: [], note: 'no frames of the first screen captured' };
    }
    const picks = [...new Set(Array.from({ length: Math.min(5, fr.length) }, (_, i) => Math.round((i * (fr.length - 1)) / Math.max(1, Math.min(5, fr.length) - 1))))];
    const base = frameIdx(fr[0]);
    const cells = picks.map((i) => { const t = Math.round(((frameIdx(fr[i]) - base) * 1000) / fps); return { f: fr[i], t, label: `t = ${t} ms`, crop: pair.boxes[j] }; });
    const b = (pair.full || pair.boxes)[j];
    return { ...s, cells, note: `${pair.how[j]}; box ${b.map(Math.round).join(',')} (x,y,w,h at 1440x900)${pair.part && j === pair.ownerIdx ?`; ${pair.part}` : ''}; frames from ${src}` };
  });
  const b0 = pair.boxes[sides.findIndex((s) => s.which === pair.owner)] || pair.boxes[0];
  const ch = Math.max(60, Math.min(FW, Math.round((FW * b0[3]) / Math.max(1, b0[2]))));
  return { kind: 'zoom', title: `First-screen media zoomed${k > 1 ? ` (${k})` : ''}: moves on ${pair.owner}${sides.length > 1 ? ', same box role on the other side' : ''}`, sub: 't = ms into the sample; each crop scaled up from the first screen so small motion is visible', per, chunks: 1, cellH: ch };
}

/** All motion sequences at a detail level (0 = full; higher = fewer frames). */
function motionSeqs(sides, level = 0) {
  const seqs = [loadSeq(sides, level >= 2 ? 10 : 15)];
  for (const [k, p] of zoomPairs(sides, level >= 2 ? 1 : 2).entries()) seqs.push(zoomSeq(sides, p, k + 1));
  const n = Math.max(...sides.map((s) => (s.x.c.motion?.frames?.reveals || []).length));
  for (let i = 0; i < n; i++) seqs.push(revealSeq(sides, i, level >= 1 ? 4 : 2));
  return seqs;
}
function cellHtml(c, w, h) {
  const cap = `<div class="cap">${esc(c.label || '')}${c.mark ? ` <b style="color:#15803d">${esc(c.mark)}</b>` : ''}</div>`;
  if (c.none) return `<div class="col" style="gap:2px">${noneBox(w, h, c.none)}<div class="cap">t = ${c.t} ms</div></div>`;
  const ring = c.mark ? 'outline:4px solid #16a34a;outline-offset:-2px;' : '';
  if (c.crop) {
    const [bx, by, bw, bh] = c.crop;
    const z = imgSize(c.f) || { w: SHOT_W, h: SHOT_H };
    const sx = z.w / SHOT_W, s = Math.min(w / (bw * sx), h / (bh * sx));
    const left = Math.round(-bx * sx * s + (w - bw * sx * s) / 2), top = Math.round(-by * sx * s + (h - bh * sx * s) / 2);
    return `<div class="col" style="gap:2px"><div class="crop" style="width:${w}px;height:${h}px;background:#3f3f46;${ring}"><img src="${url(c.f)}" style="width:${Math.round(z.w * s)}px;left:${left}px;top:${top}px"></div>${cap}</div>`;
  }
  return `<div class="col" style="gap:2px"><img class="frame" src="${url(c.f)}" style="width:${w}px;height:${h}px;object-fit:contain;background:#000;${ring}">${cap}</div>`;
}
function seqHtml(seq) {
  const h = seq.cellH || FH;
  const rowsW = 5 * FW + 4 * 8;
  let body = '';
  for (let c = 0; c < Math.max(1, seq.chunks); c++) {
    body += `<div class="chunk">${seq.per.map((p) => {
      const side = `<div class="side ${p.which}">${p.which}<small>${p.which === 'A' ? 'REF' : 'BUILD'}</small></div>`;
      if (!p.cells.length) return `<div class="srow">${side}${noneBox(rowsW, c === 0 ? 70 : 40, `${sideName(p.which)}: ${p.note}`)}</div>`;
      const list = p.cells.slice(c * 5, c * 5 + 5);
      if (!list.length) return `<div class="srow">${side}${noneBox(rowsW, 40, `${sideName(p.which)}: no more frames`)}</div>`;
      return `<div class="srow">${side}<div class="row" style="gap:8px">${list.map((x) => cellHtml(x, FW, h)).join('')}</div></div>`;
    }).join('')}</div>`;
  }
  const notes = seq.per.map((p) => `<div class="cap" style="margin-top:2px"><b>${p.which}:</b> ${esc(p.note)}</div>`).join('');
  return `<div class="seq"><div><div class="h2">${esc(seq.title)} <span class="sub">(${esc(seq.sub)}; rows of 5${seq.per.length === 2 ? ', A row above B row' : ''})</span></div>${notes}</div>${body}</div>`;
}
const seqEst = (s, sidesN) => 60 + sidesN * 22 + Math.max(1, s.chunks) * (sidesN * ((s.cellH || FH) + 26) + 14);
/** pack sequences into sheets by estimated height; at most `budget` sheets (lower detail first, then taller sheets) */
function packMotion(sides, budget) {
  const pack = (seqs, maxH) => {
    const sheets = []; let cur = [], h = 60;
    for (const s of seqs) {
      const e = seqEst(s, sides.length);
      if (cur.length && h + e > maxH) { sheets.push(cur); cur = []; h = 60; }
      cur.push(s); h += e + 14;
    }
    if (cur.length) sheets.push(cur);
    return sheets;
  };
  let seqs = null, packs = null;
  for (const level of [0, 1, 2]) { seqs = motionSeqs(sides, level); packs = pack(seqs, MAX_H); if (packs.length <= budget) return packs; }
  // still over budget: fill exactly `budget` sheets, taller than usual (the 3 MB zoom-out keeps them in size)
  const total = seqs.reduce((s, q) => s + seqEst(q, sides.length) + 14, 60);
  for (let mh = Math.ceil(total / Math.max(1, budget)); ; mh += 200) { packs = pack(seqs, mh); if (packs.length <= Math.max(1, budget) || mh > total) return packs; }
}

/* ---------------------------------------------------------------- reference bands */
function bandSheets(x) {
  const f = x.fullSet('1440'); const z = sizeOf(f);
  const secs = (x.c.sections || []).filter((s) => s.h > 0 && s.y < (z?.h || 0));
  if (!z || !secs.length) return [];
  const colW = Math.floor((W - GAP) / 2), s = colW / z.w;
  const colMax = MAX_H - 120, LAB = 52;
  const tiles = [];
  for (const b of secs) {
    const y0 = Math.max(0, b.y), y1 = Math.min(z.h, b.y + b.h);
    const maxRows = Math.floor((colMax - LAB) / s);
    const parts = Math.max(1, Math.ceil((y1 - y0) / maxRows));
    for (let p = 0; p < parts; p++) {
      const a = y0 + Math.round(((y1 - y0) * p) / parts), e = y0 + Math.round(((y1 - y0) * (p + 1)) / parts);
      const vh = b.vh ?? (b.h / 900);
      const text = `#${b.i} ${b.role || 'band'} · ${b.h}px · ${Number(vh).toFixed(2)} vh · y ${b.y}${parts > 1 ? ` · part ${p + 1}/${parts}` : ''}${b.navOverlay ? ' · nav over it' : ''}`;
      tiles.push({ h: LAB + Math.round((e - a) * s) + 10, html: `<div class="col" style="margin-bottom:10px">${label('N', text, false).replace('class="lab N"', 'class="lab N" style="font-size:18px"')}${crop(f, z.w, a, e, colW)}</div>` });
    }
  }
  const sheets = []; let cols = [[]], used = 0;
  for (const t of tiles) {
    if (used + t.h > colMax && cols[cols.length - 1].length) {
      if (cols.length === 2) { sheets.push(cols); cols = [[]]; } else cols.push([]);
      used = 0;
    }
    cols[cols.length - 1].push(t.html); used += t.h;
  }
  if (cols[0].length) sheets.push(cols);
  return sheets.map((cs, k) => ({ k: k + 1, n: sheets.length, html: page(`Reference bands at 1440 in page order — sheet ${k + 1}/${sheets.length}`, `read left column top to bottom, then right column; ${Math.round(s * 100)}% scale; band index / role / height / start y`, `<div class="row">${cs.map((c) => `<div class="col" style="width:${colW}px;gap:0">${c.join('')}</div>`).join('')}</div>`) }));
}

/* ---------------------------------------------------------------- main */
async function main() {
  const args = process.argv.slice(2);
  const refOnly = args[0] === '--ref-only';
  const rest = (refOnly ? args.slice(1) : args).map((p) => p && path.resolve(p));
  const [refDir, buildDir, outDir] = refOnly ? [rest[0], null, rest[1]] : rest;
  if (!refDir || !outDir || (!refOnly && !buildDir)) {
    console.error('usage: node sheet.mjs <refCapDir> <buildCapDir> <outDir>\n       node sheet.mjs --ref-only <refCapDir> <outDir>'); process.exit(2);
  }
  const A = cap(refDir), B = refOnly ? null : cap(buildDir);
  fs.mkdirSync(outDir, { recursive: true });
  for (const f of fs.readdirSync(outDir)) if (/\.png$|^sheets\.json$/.test(f)) fs.rmSync(path.join(outDir, f));
  const R = new Renderer();
  await R.open();
  const out = [];
  const emit = async (name, html, desc) => {
    const r = await R.render(html, path.join(outDir, name), outDir);
    out.push({ file: name, desc: desc + (r.zoom ? ` (rendered at ${Math.round(r.zoom * 100)}% to stay under 3 MB)` : ''), bytes: r.bytes, size: `${r.w}x${r.h}` });
  };
  try {
    if (!refOnly) await comparison(A, B, emit, () => out.length);
    else await referenceOnly(A, emit);
  } finally { await R.close(); }
  const index = {
    schema: 'restyle-sheets/2', refOnly,
    layout: refOnly ? 'reference only (blue A labels); grey labels = band index / role / height' : 'A = REFERENCE (blue label; left column, or upper row in motion strips), B = BUILD (amber label; right column, or lower row)',
    ref: refDir, ...(refOnly ? {} : { build: buildDir }),
    sheets: out.map(({ file, desc, size, bytes }) => ({ file, desc, size, bytes })),
  };
  fs.writeFileSync(path.join(outDir, 'sheets.json'), JSON.stringify(index, null, 1));
  const big = out.filter((o) => o.bytes > MAX_BYTES).map((o) => o.file);
  console.log(JSON.stringify({ outDir, refOnly, sheets: out.length, maxBytes: Math.max(0, ...out.map((o) => o.bytes)), overSize: big }));
}

async function comparison(A, B, emit, emitted = () => 0) {
  // 1. fold
  const half = Math.floor((W - GAP) / 2);
  const foldCol = (which, f) => `<div class="col" style="width:${half}px">${label(which, '1440 x 900, first screen at scroll 0')}${f ? img(f, half) : noneBox(half, Math.round(half * 0.625), 'no screenshot')}</div>`;
  await emit('fold-1440.png', page('First screen at 1440', '', `<div class="row">${foldCol('A', A.fold('1440'))}${foldCol('B', B.fold('1440'))}</div>`),
    'First screen at 1440x900: A reference left, B build right. Compare hero composition, nav, headline size, theme.');
  // 2. full 1440 slices
  const fs1440 = full1440Sheets(A.fullSet('1440'), B.fullSet('1440'));
  for (const s of fs1440) await emit(`full-1440-${s.k}.png`, s.html,
    `Full page at 1440, slice ${s.k} of ${s.S} (${pct(s.k - 1, s.S)}-${pct(s.k, s.S)} of each page's own height), A left, B right, same scale: compare band order, heights, rhythm, grids, colours.`);
  // 3. narrow full pages
  for (const vp of ['768', '390']) {
    const s = narrowSheet(vp, [{ which: 'A', f: A.fullSet(vp) }, { which: 'B', f: B.fullSet(vp) }], `Full page at ${vp}`);
    if (s) await emit(`full-${vp}.png`, s.html,
      `Full page at ${vp} in ${s.S} slice${s.S > 1 ? 's' : ''}, columns A1|B1${s.S > 1 ? '|A2|B2...' : ''} (A reference, B build, each slice the same fraction of its page): compare how bands stack and collapse at ${vp === '768' ? 'tablet' : 'phone'} width.`);
  }
  // 4. states: scrolled + components + hover
  {
    const sides = [{ which: 'A', x: A }, { which: 'B', x: B }];
    let body = '';
    const s1440 = [A.scrolled('1440'), B.scrolled('1440')];
    const sN = ['768', '390'].flatMap((vp) => [{ which: 'A', f: A.scrolled(vp), text: `${vp}px`, fallback: { w: Number(vp), h: vp === '768' ? 1024 : 844 } }, { which: 'B', f: B.scrolled(vp), text: `${vp}px`, fallback: { w: Number(vp), h: vp === '768' ? 1024 : 844 } }]);
    if (s1440.some(Boolean) || sN.some((x) => x.f)) {
      body += `<div class="h2">Scrolled 1.5 viewport heights down and settled <span class="sub">(header scrolled state, sticky elements)</span></div>`;
      if (s1440.some(Boolean)) body += equalRow([{ which: 'A', f: s1440[0], text: '1440px', fallback: { w: 1440, h: 900 } }, { which: 'B', f: s1440[1], text: '1440px', fallback: { w: 1440, h: 900 } }], 440);
      if (sN.some((x) => x.f)) body += equalRow(sN, 420);
    }
    const names = [...new Set([...A.comps(), ...B.comps()])];
    if (names.length) body += `<div class="h2">Components at 1440 <span class="sub">(each crop scaled to fit its cell; A above B)</span></div>${componentsBlock(names, sides)}`;
    const kinds = [...new Set([...A.hoverKinds(), ...B.hoverKinds()])];
    if (kinds.length) body += `<div class="h2">Hover at 1440 <span class="sub">(before / during hover: A pair left, B pair right)</span></div>${hoverBlock(kinds, sides)}`;
    if (body) await emit('states.png', page('States: scrolled, components, hover', '', body),
      `Scrolled states (1440, 768, 390), component crops (${names.join(', ') || 'none'}) and hover before/after pairs (${kinds.join(', ') || 'none'}): A reference vs B build. Compare the header's scrolled state, component styling and hover feedback.`);
  }
  // 5. motion: whatever is left of the 10-sheet budget (at least one sheet)
  {
    const packs = packMotion([{ which: 'A', x: A }, { which: 'B', x: B }], Math.max(1, MAX_SHEETS - emitted()));
    for (let k = 0; k < packs.length; k++) {
      const titles = packs[k].map((s) => s.title.split(':')[0].replace(/ \(\d+\) $/, '').trim()).join(', ');
      await emit(`motion-${k + 1}.png`, page(`Motion ${packs.length > 1 ? `${k + 1}/${packs.length}` : ''}: ${titles}`, 'A row directly above B row for each chunk of 5 frames; the time of each frame is printed under it', `<div class="stack" style="gap:14px">${packs[k].map(seqHtml).join('')}</div>`),
        `Frame strips (${titles}), rows of 5, A reference row above B build row. Load: both rows over the same time span from each row's start (first paint, or the end of a skipped lead-in that the row note explains), long enough for both loads to settle (green frame = settled). Reveals: from the wheel input. Zoomed media: crops of a moving first-screen media box. Compare whether and how things fade/slide/scale in and their timing.`);
    }
  }
}

async function referenceOnly(A, emit) {
  const fb = (vp) => ({ w: Number(vp), h: { 1440: 900, 768: 1024, 390: 844 }[vp] });
  await emit('ref-fold.png', page('Reference first screens', '1440 | 768 | 390 at equal height', equalRow(['1440', '768', '390'].map((vp) => ({ which: 'A', f: A.fold(vp), text: `${vp}px first screen`, fallback: fb(vp) })), 900)),
    'Reference first screen at 1440, 768 and 390 side by side (equal height).');
  if (['1440', '768', '390'].some((vp) => A.scrolled(vp))) await emit('ref-scrolled.png', page('Reference scrolled states', 'viewport after scrolling 1.5 screens down and settling: header scrolled state, sticky elements', equalRow(['1440', '768', '390'].map((vp) => ({ which: 'A', f: A.scrolled(vp), text: `${vp}px scrolled`, fallback: fb(vp) })), 900)),
    'Reference viewport after scrolling 1.5 screens at 1440, 768, 390: does the header stay, change or hide; what is sticky.');
  for (const s of bandSheets(A)) await emit(`ref-bands-${s.k}.png`, s.html,
    `Reference bands at 1440 in page order, sheet ${s.k} of ${s.n} (left column then right), each labelled with band index, role, height in px and vh, and start y.`);
  for (const vp of ['768', '390']) {
    const s = narrowSheet(vp, [{ which: 'A', f: A.fullSet(vp) }], `Reference full page at ${vp}`);
    if (s) await emit(`ref-full-${vp}.png`, s.html, `Reference full page at ${vp} in ${s.S} slice${s.S > 1 ? 's' : ''} side by side (left to right = top to bottom).`);
  }
  const names = A.comps(), kinds = A.hoverKinds();
  if (names.length || kinds.length) {
    const sides = [{ which: 'A', x: A }];
    let body = '';
    if (names.length) body += `<div class="h2">Components at 1440 <span class="sub">(each crop scaled to fit its cell)</span></div>${componentsBlock(names, sides)}`;
    if (kinds.length) body += `<div class="h2">Hover at 1440 <span class="sub">(before / during hover)</span></div>${hoverBlock(kinds, sides)}`;
    await emit('ref-components.png', page('Reference components and hover', '', body), `Reference component crops (${names.join(', ') || 'none'}) and hover before/after pairs (${kinds.join(', ') || 'none'}).`);
  }
  const packs = packMotion([{ which: 'A', x: A }], 3);
  for (let k = 0; k < packs.length; k++) {
    const titles = packs[k].map((s) => s.title.split(':')[0].replace(/ \(\d+\) $/, '').trim()).join(', ');
    await emit(`ref-motion-${k + 1}.png`, page(`Reference motion: ${titles}`, 'rows of 5; the time of each frame is printed under it', `<div class="stack" style="gap:14px">${packs[k].map(seqHtml).join('')}</div>`),
      `Reference frame strips (${titles}), rows of 5: the load until it settled (green frame), zoomed moving first-screen media, scroll reveals from the wheel input.`);
  }
}

main().catch((e) => { console.error(`sheet: ${e.stack || e.message}`); process.exit(1); });
