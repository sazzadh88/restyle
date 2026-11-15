// fontmatch.mjs — rank Google Fonts families against a reference text crop (inspect.mjs fontmatch).
//
// Input: <capDir>/capture.json type.samples[role] = { text, bbox, px, weight, declared?, ls, color, bg,
// family, style, shot, sampleQuality? } and the tight crop <capDir>/<shot> (bbox + 4 px). The reference family name is
// information only and never a candidate unless the caller passes it in `candidates` and it is in the public
// Google Fonts catalogue (lib/font-catalogue.mjs; every candidate must be). Output `referenceFonts` = the
// reference's own families with their catalogue verdict, `catalogue` = which list was checked.
//
// Method: every candidate is rendered as DOM text in the installed Chrome (lib/browser.mjs context, device
// scale 1) with the sample's exact text, px, letter-spacing and style, in the crop's own text and
// background colours, for a weight grid (and wdth / FLAR variants where they matter; the font is linked
// with those axes, so a reported axis value is the one drawn). Crop and renders are converted to ink
// (projection of each pixel on the background->text colour line, divided by the line's own ink peak:
// contrast-normalised) and compared on:
//   adv      ink width of the line at the same px and letter-spacing
//   ink      ink coverage per (width x px), like capture's role ink
//   xHeight  body-band height (x-height for mixed case, cap height for all caps) at the same px
//   contrast stroke modulation: thick/thin ratio (horizontal vs vertical soft run masses), foot-serif
//            ratio and stem flare along vertical stems
//   shape    chunked normalised cross-correlation of the body-band-normalised, width-normalised images,
//            with per-chunk drift tracking
// Candidate pool: Roboto first (calibrates an ink-equivalent weight and a width ratio), then one or two
// probe families per style group, then ~30 catalogue families chosen by the probe group scores, group
// affinities and the measured width class; the top families are refined to 25 weight units. Families with
// an opsz axis are drawn both with automatic optical size and in their default instance where those differ
// at px (candidate `opsz`: auto | default).
// Weight: when the capture measured the role's ink (type.roles[vp][role].ink), each final candidate's
// weight is the one whose probe ink (the capture's ink probe, at apply size and tracking) equals it: ink is
// what compare scores, so fontmatch and compare agree (weightBasis 'role ink'; the crop fit is cropWeight).
// Output sampleQuality {level: good|poor, reason}: whether the crop can be trusted (sampleVerdict(), the
// same verdict the digest prints). A crop with no contrast or no ink is a poor sample with no candidates.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { newCaptureContext } from './browser.mjs';
import { loadCatalogue, isSystemFamily, normFamily } from './font-catalogue.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CATALOGUE = path.join(HERE, 'google-fonts.json');

const GROUP = {
  'neo-grotesque': 'grotesque', grotesque: 'grotesque', display: 'grotesque', geometric: 'geometric', humanist: 'humanist',
  flared: 'flared', glyphic: 'flared', rounded: 'rounded', 'condensed-display': 'condensed',
  transitional: 'serif', 'contemporary-serif': 'serif', oldstyle: 'serif', didone: 'didone', slab: 'slab',
  monospace: 'mono', handwriting: 'script', script: 'script',
};
const AFFINITY = {
  flared: ['humanist', 'serif'], serif: ['flared', 'didone', 'slab'], didone: ['serif'], humanist: ['flared', 'grotesque'],
  grotesque: ['geometric', 'humanist'], geometric: ['grotesque', 'rounded'], rounded: ['geometric', 'humanist'],
  condensed: ['grotesque'], slab: ['serif'], mono: ['grotesque'], script: [],
};
const KIND = { grotesque: 'sans', geometric: 'sans', humanist: 'sans', rounded: 'sans', condensed: 'sans', mono: 'mono', flared: 'flared', serif: 'serif', didone: 'serif', slab: 'slab', script: 'script' };
// one or two probes per group; `axes` pins a variant (Commissioner with its flare axis on)
const PROBES = [
  ['Inter'], ['Montserrat'], ['DM Sans'], ['Open Sans'], ['Source Sans 3'],
  ['Commissioner', { FLAR: 100 }], ['Marcellus'], ['Belleza'], ['Nunito'], ['Fredoka'], ['Oswald'], ['Anton'],
  ['Source Serif 4'], ['EB Garamond'], ['Playfair Display'], ['Roboto Slab'], ['Roboto Mono'],
];
// stroke-feature prototypes for the reference classification (all are probes too)
const PROTOS = [
  ['Roboto', {}, 'sans'], ['Nunito', {}, 'sans'], ['Source Serif 4', {}, 'serif'], ['Playfair Display', {}, 'serif'],
  ['Commissioner', { FLAR: 100 }, 'flared'], ['Marcellus', {}, 'flared'],
];
const QUOTA = [10, 7, 6, 4, 3];   // pool slots for the 1st..5th style group (30 families)
const PART_W = { adv: 0.2, ink: 0.18, xHeight: 0.12, contrast: 0.2, shape: 0.30 };
const TOL = { adv: 0.07, ink: 0.12, xHeight: 0.07, contrast: 0.3, serif: 0.5, flare: 0.1 };
const ABOVE = 0.65, BELOW = 0.55, MARGIN = 4;

const r3 = (x) => Math.round(x * 1000) / 1000;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const gauss = (e, t) => Math.exp(-Math.LN2 * (e / t) ** 2);
const median = (a) => { if (!a.length) return null; const s = [...a].sort((p, q) => p - q); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const cssFam = (f) => `"${String(f).replace(/["\\]/g, '')}"`;
const axKey = (ax) => Object.keys(ax || {}).sort().map((k) => `${k}${ax[k]}`).join(',');
const hexRgb = (h) => { const m = /^#?([0-9a-f]{6})$/i.exec(String(h || '').trim()); if (!m) return null; const n = parseInt(m[1], 16); return [n >> 16, (n >> 8) & 255, n & 255]; };
const rgbCss = (c) => `rgb(${c.map((v) => Math.round(v)).join(',')})`;
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// ---------------------------------------------------------------- reference
// the reference's own families (capture type.families) with their public-catalogue verdict: a family in the
// catalogue may be used as is (still matched for weight and tracking); one outside it never is, and is never
// a candidate (lib/font-catalogue.mjs; the css2 API status is not a test)
function referenceFonts(cap, cat, s) {
  return ((cap.type && cap.type.families) || []).slice(0, 8).map((f) => {
    const v = isSystemFamily(f.family) ? 'system' : cat.verdict(f.family);
    const as = v === true ? cat.matchOf(f.family) : null;
    return { family: f.family, ...(s && s.family && normFamily(s.family) === normFamily(f.family) ? { thisRole: true } : {}), webfont: !!f.webfont, inCatalogue: v,
      ...(as && normFamily(as) !== normFamily(f.family) ? { catalogueAs: as } : {}),
      use: v === true ? `in the public catalogue: may be used as "${as}"` : v === 'system' ? 'system font: only as the reference\'s own system stack (font-substitutes §system)'
        : v === false ? 'not in the public catalogue: never use it (pick a substitute)' : `unverified (${cat.source}): do not use it unless a later online run says it is in the catalogue` };
  });
}
function readSample(capDir, role) {
  const capFile = path.join(capDir, 'capture.json');
  if (!fs.existsSync(capFile)) throw new Error(`no capture.json in ${capDir}`);
  const cap = JSON.parse(fs.readFileSync(capFile, 'utf8'));
  const samples = cap.type && cap.type.samples;
  const have = samples && typeof samples === 'object' ? Object.keys(samples).filter((k) => samples[k]) : [];
  if (!have.length) throw new Error(`${capFile} has no type.samples (capture the reference with the current capture.mjs)`);
  const s = samples[role];
  if (!s) throw new Error(`role "${role}" has no type sample in ${capFile}; roles with samples: ${have.join(', ')}`);
  if (!s.text || !String(s.text).trim()) throw new Error(`type.samples.${role}.text is empty`);
  if (!(+s.px > 0)) throw new Error(`type.samples.${role}.px is missing`);
  return { s, ...readCrop(capDir, s, role), capFile, cap };
}
// the sample's tight crop: <capDir>/<s.shot> (bbox + 4 px), else cut from shots/1440-full.png
function readCrop(capDir, s, role) {
  let png = null, shot = null;
  const rel = s.shot || `shots/type-${role}.png`;
  if (fs.existsSync(path.join(capDir, rel))) { shot = path.join(capDir, rel); png = PNG.sync.read(fs.readFileSync(shot)); }
  else if (Array.isArray(s.bbox) && fs.existsSync(path.join(capDir, 'shots', '1440-full.png'))) {
    // fallback: cut bbox + 4 px from the full-page shot
    const full = PNG.sync.read(fs.readFileSync(path.join(capDir, 'shots', '1440-full.png')));
    const x = Math.max(0, Math.floor(s.bbox[0] - 4)), y = Math.max(0, Math.floor(s.bbox[1] - 4));
    const w = Math.min(full.width - x, Math.ceil(s.bbox[2] + 8)), h = Math.min(full.height - y, Math.ceil(s.bbox[3] + 8));
    if (w < 4 || h < 4) throw new Error(`type.samples.${role}.bbox is outside shots/1440-full.png`);
    png = new PNG({ width: w, height: h });
    for (let r = 0; r < h; r++) full.data.copy(png.data, r * w * 4, ((y + r) * full.width + x) * 4, ((y + r) * full.width + x + w) * 4);
    shot = path.join(capDir, 'shots', '1440-full.png') + ` (bbox ${s.bbox.join(',')})`;
  } else throw new Error(`no crop for role "${role}": ${path.join(capDir, rel)} is missing`);
  return { png, shot };
}

// text and background colour of the crop: the declared ones when the pixels agree, else measured
function refColours(png, s) {
  const { width: w, height: h, data } = png;
  const ch = [[], [], []];
  const push = (x, y) => { const i = (y * w + x) * 4; ch[0].push(data[i]); ch[1].push(data[i + 1]); ch[2].push(data[i + 2]); };
  for (let x = 0; x < w; x++) for (const y of new Set([0, 1, h - 2, h - 1])) if (y >= 0 && y < h) push(x, y);
  for (let y = 2; y < h - 2; y++) for (const x of new Set([0, 1, w - 2, w - 1])) if (x >= 0 && x < w) push(x, y);
  const bgCrop = ch.map((a) => median(a));
  const notes = [];
  let bg = hexRgb(s.bg);
  if (!bg || dist(bg, bgCrop) > 30) { if (bg) notes.push(`declared bg ${s.bg} differs from the crop border; used the measured ${rgbCss(bgCrop)}`); bg = bgCrop; }
  const ds = new Float32Array(w * h);
  for (let i = 0, p = 0; p < w * h; p++, i += 4) ds[p] = Math.hypot(data[i] - bg[0], data[i + 1] - bg[1], data[i + 2] - bg[2]);
  const sorted = Float32Array.from(ds).sort();
  const cut = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.995))] * 0.92;
  const acc = [0, 0, 0]; let n = 0;
  for (let i = 0, p = 0; p < w * h; p++, i += 4) if (ds[p] >= cut && ds[p] > 0) { acc[0] += data[i]; acc[1] += data[i + 1]; acc[2] += data[i + 2]; n++; }
  const far = n ? acc.map((v) => v / n) : [255 - bg[0], 255 - bg[1], 255 - bg[2]];
  let fg = far;
  const decl = hexRgb(s.color);
  if (decl && dist(decl, bg) >= 40) {
    const v1 = decl.map((v, k) => v - bg[k]), v2 = far.map((v, k) => v - bg[k]);
    const l1 = Math.hypot(...v1), l2 = Math.hypot(...v2);
    const cos = l2 ? (v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2]) / (l1 * l2) : 0;
    if (cos > 0.85 && l2 >= 0.3 * l1 && l2 <= 1.25 * l1) fg = decl;
    else notes.push(`declared text colour ${s.color} does not match the crop's ink; used the measured ${rgbCss(far)}`);
  } else if (decl) notes.push(`declared text colour ${s.color} is too close to the background; used the measured ${rgbCss(far)}`);
  if (dist(fg, bg) < 25) throw new Error('the crop has almost no contrast between text and background');
  return { fg: fg.map(Math.round), bg: bg.map(Math.round), notes };
}

// ink in [0,1]: projection of each pixel on the bg -> fg line (works for light-on-dark crops), then
// contrast-normalised: divided by the line's own ink peak (98th percentile of its ink pixels), so text
// drawn dimmer than its declared colour (ancestor opacity, a muted colour that differs from the computed
// one) measures like full-contrast text. Stems of 1.5 px or more reach full coverage (peak 1, unchanged);
// thinner strokes peak lower in the crop and in a candidate of the same weight alike, so both scale the same.
function inkMap(png, r, fg, bg) {
  const dr = fg[0] - bg[0], dg = fg[1] - bg[1], db = fg[2] - bg[2];
  const d2 = dr * dr + dg * dg + db * db;
  const a = new Float32Array(r.w * r.h);
  const ink = [];
  for (let j = 0; j < r.h; j++) {
    let k = ((r.y + j) * png.width + r.x) * 4;
    for (let i = 0; i < r.w; i++, k += 4) {
      const v = ((png.data[k] - bg[0]) * dr + (png.data[k + 1] - bg[1]) * dg + (png.data[k + 2] - bg[2]) * db) / d2;
      const x = v <= 0.03 ? 0 : v >= 1 ? 1 : (v - 0.03) / 0.97;
      a[j * r.w + i] = x;
      if (x > 0.1) ink.push(x);
    }
  }
  let peak = 1;
  if (ink.length >= 12) {
    ink.sort((p, q) => p - q);
    peak = ink[Math.min(ink.length - 1, Math.floor(ink.length * 0.98))];
    if (peak >= 0.2 && peak < 0.98) for (let p = 0; p < a.length; p++) a[p] = Math.min(1, a[p] / peak);
    else peak = 1;
  }
  return { w: r.w, h: r.h, a, peak };
}

// ---------------------------------------------------------------- sample quality
// Can the crop be trusted for weight / width / tracking? Pixel checks on the crop itself (they also work
// on captures that predate type.samples[].sampleQuality) plus the capture's own verdict when present:
//   busy background  the 2 px frame around the line is not one colour (photo, video, gradient, pattern)
//   two colours      strong ink pixels off the bg -> text colour line (a second hue), or whole glyph runs
//                    peaking clearly dimmer than the rest (a muted second half in the same hue)
//   low contrast     WCAG contrast of the text as drawn (peak) against the background below 1.8
//   too few glyphs   fewer than 4 visible characters
const relLum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
const contrastRatio = (a, b) => { const la = relLum(a), lb = relLum(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };
function sampleQuality(png, s, text, col, refMap, RF) {
  const { width: w, height: h, data } = png;
  const bad = [], meas = [];
  const fgbg = dist(col.fg, col.bg);
  const v = col.fg.map((c, k) => c - col.bg[k]), v2 = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
  const tolB = Math.max(20, 0.15 * fgbg), tolR = Math.max(30, 0.3 * fgbg);
  // residual of a pixel from the bg -> fg segment (0 = a mix of text and background colour)
  const resid = (i) => {
    const d = [data[i] - col.bg[0], data[i + 1] - col.bg[1], data[i + 2] - col.bg[2]];
    const t = clamp((d[0] * v[0] + d[1] * v[1] + d[2] * v[2]) / v2, 0, 1);
    return { len: Math.hypot(d[0], d[1], d[2]), r: Math.hypot(d[0] - t * v[0], d[1] - t * v[1], d[2] - t * v[2]) };
  };
  // frame: 2 px border (the crop is the line box + 4 px, so the line's own glyphs do not reach it). Left
  // and right columns that differ from the background, or top/bottom rows that differ in another hue, are a
  // busy backdrop; text-coloured pixels in the top/bottom rows only are a neighbouring line reaching in.
  let ns = 0, os = 0, nt = 0, ot = 0, otOff = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const side = (x < 2 || x >= w - 2) && y >= 4 && y < h - 4, tb = y < 2 || y >= h - 2;
    if (!side && !tb) continue;
    const q = resid((y * w + x) * 4), o = q.len > tolB;
    if (side) { ns++; if (o) os++; } else { nt++; if (o) { ot++; if (q.r > tolR) otOff++; } }
  }
  const sideOut = ns ? os / ns : 0, tbOut = nt ? ot / nt : 0;
  const busy = sideOut > 0.1 || (tbOut > 0.1 && otOff > 0.5 * ot);
  if (busy) bad.push(`busy background (${Math.round(Math.max(sideOut, tbOut) * 100)}% of the frame around the line differs from ${rgbCss(col.bg)})`);
  // (a few ascender tips of the next line in the 4 px margin add little ink: poor only when they fill the edge)
  else if (tbOut > 0.2) bad.push(`other text reaches into the crop (${Math.round(tbOut * 100)}% of its top/bottom edge)`);
  const frameOut = busy ? Math.max(sideOut, tbOut) : sideOut;
  if (!busy && tbOut > 0.05 && tbOut <= 0.2) meas.push(`neighbouring text touches ${Math.round(tbOut * 100)}% of the top/bottom edge`);
  // second hue: strong pixels far from the bg -> fg segment
  let strong = 0, off = 0;
  for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) {
    const q = resid((y * w + x) * 4);
    if (q.len < 0.5 * fgbg) continue;
    strong++;
    if (q.r > tolR) off++;
  }
  const offShare = strong ? off / strong : 0;
  // same hue, dimmer part: ink-weighted share of glyph runs whose peak stays below 0.72 of the line's
  // (only where stems are thick enough to reach full coverage)
  let dimShare = 0;
  if (RF.stem && RF.stem >= 1.8) {
    const m = refMap, colS = new Float64Array(m.w), colM = new Float64Array(m.w);
    for (let j = 0; j < m.h; j++) for (let i = 0; i < m.w; i++) { const a = m.a[j * m.w + i]; colS[i] += a; if (a > colM[i]) colM[i] = a; }
    let tot = 0, dim = 0, s0 = -1, mass = 0, mx = 0;
    for (let i = 0; i <= m.w; i++) {
      const on = i < m.w && colS[i] > 0.3;
      if (on) { if (s0 < 0) { s0 = i; mass = 0; mx = 0; } mass += colS[i]; if (colM[i] > mx) mx = colM[i]; }
      else if (s0 >= 0) { tot += mass; if (mx < 0.72) dim += mass; s0 = -1; }
    }
    dimShare = tot ? dim / tot : 0;
  }
  // (on a busy backdrop the background itself is off the colour line: no colour verdict)
  if (busy) { /* reported above */ }
  else if (offShare > 0.12) bad.push(`two colours in the line (${Math.round(offShare * 100)}% of the strong ink is another hue)`);
  else if (dimShare > 0.15 && dimShare < 0.9) bad.push(`two colours in the line (${Math.round(dimShare * 100)}% of the ink is drawn clearly dimmer)`);
  // the text colour's contrast, and the contrast actually drawn (peak: lower for hairlines and dimmed text)
  const drawn = col.bg.map((c, k) => c + (col.fg[k] - c) * (refMap.peak || 1));
  const cr = contrastRatio(col.fg, col.bg), crD = contrastRatio(drawn, col.bg);
  const cr1 = Math.round(cr * 10) / 10;
  if (cr < 1.8) bad.push(`low contrast (${cr1}:1)`);
  else if (crD < 1.3) bad.push(`low contrast (${Math.round(crD * 10) / 10}:1 as drawn)`);
  const glyphs = text.replace(/\s/g, '').length;
  if (glyphs < 4) bad.push(`too few glyphs (${glyphs})`);
  // the capture's verdict (DOM: exact text colours, media/gradient behind the line); for the backdrop the
  // crop's own frame is the better evidence, so a capture "busy background" is dropped when the frame is uniform
  const cap = s.sampleQuality;
  if (cap && cap.level === 'poor' && cap.reason) {
    for (const r of String(cap.reason).split(/;\s*/)) {
      if (!r || (/^busy background/.test(r) && !busy)) continue;
      if (!bad.some((b) => b.startsWith(r.split(' (')[0]))) bad.push(`${r} (capture)`);
    }
  }
  meas.push(`frame ${Math.round(frameOut * 100)}% off`, `contrast ${cr1}:1`, `${glyphs} glyphs`);
  return bad.length ? { level: 'poor', reason: bad.join('; ') } : { level: 'good', reason: `uniform background, one text colour (${meas.join(', ')})` };
}

// The crop's measurements and THE sample verdict: crop colours, ink map, features, sampleQuality(). A crop
// with no usable contrast or no text ink is poor (never an error), so fontmatch can report it.
function measureCrop(png, s) {
  const text = String(s.text || '').replace(/\s+/g, ' ');
  const px = +s.px, italic = /italic|oblique/i.test(s.style || '');
  let col;
  try { col = refColours(png, s); } catch (e) { return { q: { level: 'poor', reason: `low contrast (${e.message})` }, text }; }
  const refMap = inkMap(png, { x: 0, y: 0, w: png.width, h: png.height }, col.fg, col.bg);
  const RF = features(refMap, px, italic);
  if (!RF) return { q: { level: 'poor', reason: 'no text ink in the crop (the line was not drawn when the page was shot: hidden, revealed later or covered)' }, text, col };
  return { q: sampleQuality(png, s, text, col, refMap, RF), text, col, refMap, RF };
}

/**
 * The one sampleQuality verdict for a capture's type sample, shared by the digest (summary.mjs) and
 * fontmatch so both always say the same: the crop's pixel checks plus the capture's own verdict (its
 * "busy background" dropped when the crop's frame is uniform). `s` = type.samples[role] (read from
 * <capDir>/capture.json when omitted). Returns {level, reason} or null when there is no crop.
 */
export function sampleVerdict(capDir, role, s = null) {
  try {
    const smp = s || readSample(capDir, role).s;
    if (!smp || !smp.text || !(+smp.px > 0)) return null;
    return measureCrop(readCrop(capDir, smp, role).png, smp).q;
  } catch { return null; }
}

// ---------------------------------------------------------------- measurements
function runs1d(get, n, thr) {
  const out = [];
  let s = -1;
  for (let i = 0; i <= n; i++) {
    const v = i < n ? get(i) : 0;
    if (v > thr) { if (s < 0) s = i; } else if (s >= 0) {
      let m = 0; for (let k = Math.max(0, s - 1); k <= Math.min(n - 1, i); k++) m += get(k);   // + partial edge pixels
      out.push([s, i, m]); s = -1;
    }
  }
  return out;
}

function features(m, px, italic) {
  const { w, h, a } = m;
  const col = new Float64Array(w), row = new Float64Array(h);
  let S = 0;
  for (let j = 0; j < h; j++) { let rs = 0; const o = j * w; for (let i = 0; i < w; i++) { const v = a[o + i]; if (v) { rs += v; col[i] += v; } } row[j] = rs; S += rs; }
  if (S < 3) return null;
  const ext = (p, n, t) => { let lo = -1, hi = -1; for (let i = 0; i < n; i++) if (p[i] > t) { if (lo < 0) lo = i; hi = i; } return lo < 0 ? null : [lo, hi + 1]; };
  const ex = ext(col, w, 0.25), ey = ext(row, h, 0.25);
  if (!ex || !ey) return null;
  const [x0, x1] = ex;
  const r = new Float64Array(h);
  for (let j = 0; j < h; j++) r[j] = (j > 0 ? row[j - 1] : 0) * 0.25 + row[j] * 0.5 + (j < h - 1 ? row[j + 1] : 0) * 0.25;
  let pmax = 0; for (let j = 0; j < h; j++) if (r[j] > pmax) pmax = r[j];
  const T = 0.4 * pmax;
  let jt = -1, jb = -1;
  for (let j = 0; j < h; j++) if (r[j] >= T) { if (jt < 0) jt = j; jb = j; }
  const top = jt > 0 ? jt - 0.5 + (T - r[jt - 1]) / ((r[jt] - r[jt - 1]) || 1) : jt;
  const base = jb < h - 1 ? jb + 0.5 + (r[jb] - T) / ((r[jb] - r[jb + 1]) || 1) : jb + 1;
  const bodyH = Math.max(1, base - top);
  // stem widths: horizontal soft runs through the middle of the band; bar widths: vertical runs
  const stems = [];
  for (let j = Math.ceil(top + 0.3 * bodyH); j <= Math.floor(top + 0.7 * bodyH); j++) {
    if (j < 0 || j >= h) continue;
    for (const [, , ms] of runs1d((i) => a[j * w + x0 + i], x1 - x0, 0.15)) if (ms <= 0.6 * bodyH && ms > 0.3) stems.push(ms);
  }
  const bars = [];
  const ya = clamp(Math.floor(top - 0.1 * bodyH), 0, h), yb = clamp(Math.ceil(base + 0.1 * bodyH), 0, h);
  for (let i = x0; i < x1; i++) for (const [, , ms] of runs1d((k) => a[(ya + k) * w + i], yb - ya, 0.15)) if (ms <= 0.45 * bodyH && ms > 0.3) bars.push(ms);
  const stem = median(stems), bar = median(bars);
  // vertical stem chains through the band: foot serifs (bottom end) and flare (terminal zones vs waist)
  const j0 = Math.max(0, Math.ceil(top)), j1 = Math.min(h - 1, Math.floor(base - 0.01));
  let active = [];
  const done = [];
  for (let j = j0; j <= j1; j++) {
    const rr = runs1d((i) => a[j * w + x0 + i], x1 - x0, 0.15).map(([s, e, ms]) => ({ s, e, ms, j }));
    const next = [];
    const hits = active.map((c) => rr.filter((q) => q.s < c.last.e && c.last.s < q.e));
    const used = new Set();
    active.forEach((c, ci) => {
      const hs = hits[ci];
      if (hs.length === 1 && active.filter((c2, k) => hits[k].includes(hs[0])).length === 1) { c.runs.push(hs[0]); c.last = hs[0]; next.push(c); used.add(hs[0]); }
      else done.push(c);
    });
    for (const q of rr) if (!used.has(q)) next.push({ runs: [q], last: q });
    active = next;
  }
  done.push(...active);
  const serifs = [], flares = [];
  for (const c of done) {
    if (c.runs.length < 0.7 * bodyH) continue;
    const ms = c.runs.map((q) => q.ms);
    if (median(ms) > 0.4 * bodyH) continue;
    const cx = (q) => (q.s + q.e) / 2;
    if (Math.abs(cx(c.runs[c.runs.length - 1]) - cx(c.runs[0])) > (italic ? 0.4 : 0.25) * bodyH) continue;
    const t = (q) => (q.j + 0.5 - top) / bodyH;
    const mid = median(c.runs.filter((q) => t(q) >= 0.35 && t(q) <= 0.65).map((q) => q.ms));
    if (!mid) continue;
    const bot = c.runs.filter((q) => t(q) >= 0.9).map((q) => q.ms);
    if (bot.length) serifs.push(Math.max(...bot) / mid);
    // lower zone only: the upper one is full of arch / bowl junctions (n, m, h, a, d) in lowercase text
    const zone = c.runs.filter((q) => t(q) >= 0.7 && t(q) <= 0.88).map((q) => q.ms);
    if (zone.length && bot.length) flares.push(zone.reduce((p, q) => p + q, 0) / zone.length / mid);
  }
  return {
    x0, x1, W: x1 - x0, top, base, bodyH, S, ink: S / ((x1 - x0) * px),
    stem, bar, contrast: stem && bar ? stem / bar : null, stemEm: stem ? stem / px : null,
    serif: serifs.length >= 2 ? median(serifs) : null, flare: flares.length >= 2 ? median(flares) : null, stems: serifs.length,
  };
}

function bil(m, x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
  const g = (i, j) => (i < 0 || j < 0 || i >= m.w || j >= m.h ? 0 : m.a[j * m.w + i]);
  return (g(xi, yi) * (1 - fx) + g(xi + 1, yi) * fx) * (1 - fy) + (g(xi, yi + 1) * (1 - fx) + g(xi + 1, yi + 1) * fx) * fy;
}
// resample so the ink extent fills [MARGIN, Wn - MARGIN] and the body band maps to [ABOVE*Hb, (ABOVE+1)*Hb]
function normalise(m, f, G) {
  const sy = G.Hb / f.bodyH, sx = (G.Wn - 2 * MARGIN) / f.W;
  const ss = clamp(Math.ceil(Math.max(1 / sx, 1 / sy)), 1, 4), inv = 1 / (ss * ss), above = ABOVE * G.Hb;
  const out = new Float32Array(G.Wn * G.Hn);
  for (let v = 0; v < G.Hn; v++) for (let u = 0; u < G.Wn; u++) {
    let acc = 0;
    for (let b = 0; b < ss; b++) {
      const yy = f.top + (v + (b + 0.5) / ss - above) / sy - 0.5;
      for (let c = 0; c < ss; c++) acc += bil(m, f.x0 + (u + (c + 0.5) / ss - MARGIN) / sx - 0.5, yy);
    }
    out[v * G.Wn + u] = acc * inv;
  }
  return blur(out, G.Wn, G.Hn);
}
function blur(src, w, h) {
  const t = new Float32Array(w * h), o = new Float32Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) { const k = j * w + i; t[k] = (src[k] + (i > 0 ? src[k - 1] : 0) + (i < w - 1 ? src[k + 1] : 0)) / 3; }
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) { const k = j * w + i; o[k] = (t[k] + (j > 0 ? t[k - w] : 0) + (j < h - 1 ? t[k + w] : 0)) / 3; }
  return o;
}
// chunked NCC with drift tracking (letters of a different width drift apart along the line)
function shapeNcc(R, C, G) {
  const { Wn, Hn, Hb } = G;
  const cw = Math.max(16, 2 * Hb), step = Math.max(2, Math.round(Hb / 8));
  let prev = 0, num = 0, den = 0;
  for (let xs = MARGIN; xs < Wn - MARGIN; xs += cw) {
    const xe = Math.min(Wn - MARGIN, xs + cw), n = (xe - xs) * Hn;
    let sr = 0, srr = 0;
    for (let v = 0; v < Hn; v++) for (let u = xs; u < xe; u++) { const q = R[v * Wn + u]; sr += q; srr += q * q; }
    const varR = srr - (sr * sr) / n;
    if (sr < 0.3 * Hb || varR <= 1e-6) continue;
    let best = -1, bestDx = prev;
    for (let dx = prev - step; dx <= prev + step; dx++) for (let dy = -1; dy <= 1; dy++) {
      let sc = 0, scc = 0, src = 0;
      for (let v = 0; v < Hn; v++) {
        const vv = v + dy; if (vv < 0 || vv >= Hn) continue;
        const ro = v * Wn, co = vv * Wn + dx;
        for (let u = Math.max(xs, -dx); u < Math.min(xe, Wn - dx); u++) { const c = C[co + u]; sc += c; scc += c * c; src += R[ro + u] * c; }
      }
      const varC = scc - (sc * sc) / n;
      const ncc = varC > 1e-9 ? (src - (sr * sc) / n) / Math.sqrt(varR * varC) : 0;
      if (ncc > best) { best = ncc; bestDx = dx; }
    }
    prev = bestDx; num += best * sr; den += sr;
  }
  return den ? num / den : 0;
}

function partsOf(RF, f, ncc) {
  const p = {
    adv: gauss(Math.log(f.W / RF.W), TOL.adv),
    ink: gauss(Math.log(f.ink / RF.ink), TOL.ink),
    xHeight: gauss(Math.log(f.bodyH / RF.bodyH), TOL.xHeight),
    contrast: null,
    shape: clamp((ncc - 0.75) / 0.23, 0, 1),
  };
  if (RF.contrast && f.contrast) {
    const terms = [(Math.log(f.contrast / RF.contrast) / TOL.contrast) ** 2];
    if (RF.serif != null && f.serif != null) terms.push(((f.serif - RF.serif) / TOL.serif) ** 2);
    if (RF.flare != null && f.flare != null) terms.push(((f.flare - RF.flare) / TOL.flare) ** 2);
    p.contrast = Math.exp(-Math.LN2 * (terms.reduce((s, x) => s + x, 0) / terms.length));
  }
  let s = 0, wsum = 0;
  for (const k of Object.keys(PART_W)) if (p[k] != null) { s += PART_W[k] * p[k]; wsum += PART_W[k]; }
  return { parts: p, score: wsum ? s / wsum : 0 };
}

// ---------------------------------------------------------------- fonts in the page
// css2 family query: every axis the family has among opsz / wdth / FLAR as its full range (also on a
// family whose weights are static, e.g. a single-weight face with a width axis: without the range the API
// serves the default width and font-stretch has nothing to apply), wght as a range on a variable family or
// one tuple per static weight; tags lowercase-alphabetical then uppercase, ital first, as the API requires.
function familyQuery(e, italic) {
  const name = e.family.trim().replace(/ +/g, '+');
  const axes = (e.axes || []).filter((a) => ['opsz', 'wdth', 'FLAR'].includes(a.tag) || (e.variable && a.tag === 'wght'))
    .sort((p, q) => { const lp = p.tag === p.tag.toLowerCase(), lq = q.tag === q.tag.toLowerCase(); return lp !== lq ? (lp ? -1 : 1) : p.tag < q.tag ? -1 : 1; });
  const ws = e.variable ? [null] : (italic && e.italicWeights) || e.weights;
  const staticW = !e.variable && !(ws.length === 1 && ws[0] === 400 && !italic);
  const tags = [...axes.map((a) => a.tag), ...(staticW ? ['wght'] : [])]
    .sort((p, q) => { const lp = p === p.toLowerCase(), lq = q === q.toLowerCase(); return lp !== lq ? (lp ? -1 : 1) : p < q ? -1 : 1; });
  if (!tags.length && !italic) return name;
  const tuple = (w) => tags.map((t) => (t === 'wght' && staticW ? w : `${axes.find((a) => a.tag === t).min}..${axes.find((a) => a.tag === t).max}`));
  const tuples = [...new Set(ws.map((w) => [...(italic ? ['1'] : []), ...tuple(w)].join(',')))];
  return `${name}:${[...(italic ? ['ital'] : []), ...tags].join(',')}@${tuples.join(';')}`;
}

async function linkFamilies(page, entries, italic) {
  const qs = entries.map((e) => ({ family: e.family, q: familyQuery(e, italic && e.italic) }));
  const url = (list) => `https://fonts.googleapis.com/css2?${list.map((x) => `family=${x.q}`).join('&')}&display=block`;
  const add = (href) => page.evaluate((h) => new Promise((res) => {
    const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = h;
    const t = setTimeout(() => res(false), 20000);
    l.onload = () => { clearTimeout(t); res(true); }; l.onerror = () => { clearTimeout(t); l.remove(); res(false); };
    document.head.appendChild(l);
  }), href);
  const okFams = new Set();
  for (let i = 0; i < qs.length; i += 8) {
    const batch = qs.slice(i, i + 8);
    if (await add(url(batch))) batch.forEach((x) => okFams.add(x.family));
    else for (const x of batch) if (await add(url([x]))) okFams.add(x.family);
  }
  return okFams;
}

async function ensureFaces(page, items, text) {
  const specs = [...new Set(items.map((it) => `${it.italic ? 'italic ' : ''}${it.weight} 40px ${cssFam(it.family)}`))];
  return page.evaluate(async ({ specs, text }) => {
    await Promise.race([Promise.all(specs.map((s) => document.fonts.load(s, text).catch(() => []))), new Promise((r) => setTimeout(r, 30000))]);
    await document.fonts.ready;
    return [...new Set([...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replace(/^["']|["']$/g, '')))];
  }, { specs, text });
}

// wdth goes into font-stretch (face selection) AND font-variation-settings (the exact axis value, also
// outside font-stretch's 50-200% range), so the width that is reported is the width that is drawn
function rowStyle(it, px, lsEm) {
  const fvs = Object.keys(it.axes || {}).map((k) => `'${k}' ${it.axes[k]}`).join(', ');
  return `white-space:pre;font-family:'${String(it.family).replace(/['"\\]/g, '')}','Courier New';font-size:${r3(px)}px;font-weight:${it.weight};font-style:${it.italic ? 'italic' : 'normal'};`
    + `letter-spacing:${r3(lsEm)}em;font-synthesis:none;font-kerning:normal;${it.axes && it.axes.wdth ? `font-stretch:${it.axes.wdth}%;` : ''}${fvs ? `font-variation-settings:${fvs};` : ''}`;
}

async function renderRows(page, items, R, onRow) {
  const rowH = Math.ceil(R.px * 2.4) + 6, pad = Math.ceil(R.px * 0.6) + 8;
  const estW = clamp(Math.round(R.refW * 2.2 + 2 * pad), 300, 8000);
  const per = Math.max(1, Math.min(Math.floor(7000 / rowH), Math.floor(2e7 / (estW * rowH))));
  for (let c = 0; c < items.length; c += per) {
    const chunk = items.slice(c, c + per);
    const html = chunk.map((it, i) => `<div style="position:absolute;left:${pad}px;top:${i * rowH}px;height:${rowH}px;line-height:${rowH}px;color:${rgbCss(R.fg)};${rowStyle(it, R.px, R.lsEm)}">${esc(R.text)}</div>`).join('');
    const rights = await page.evaluate((h) => { const box = document.getElementById('rows'); box.innerHTML = h; return [...box.children].map((e) => Math.ceil(e.getBoundingClientRect().right)); }, html);
    const W = clamp(Math.max(...rights) + pad, 200, 8000);
    await page.setViewportSize({ width: W, height: chunk.length * rowH });
    const png = PNG.sync.read(await page.screenshot({ type: 'png', caret: 'hide', animations: 'disabled' }));
    chunk.forEach((it, i) => onRow(it, inkMap(png, { x: 0, y: i * rowH, w: Math.min(png.width, rights[i] + pad), h: rowH }, R.fg, R.bg)));
  }
}

// unknown family (not in the bundled list): ask the css2 API which weights exist
async function probeFamily(name) {
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
  const q = name.trim().replace(/ +/g, '+');
  const get = async (spec) => { try { const r = await fetch(`https://fonts.googleapis.com/css2?family=${spec}&display=block`, { headers: { 'User-Agent': UA } }); return r.ok ? await r.text() : null; } catch { return null; } };
  let css = await get(`${q}:wght@100..900`);
  if (css) return { family: name.trim(), variable: true, weights: [100, 900], axes: [{ tag: 'wght', min: 100, max: 900 }], italic: false, unknown: true };
  css = await get(`${q}:wght@100;200;300;400;500;600;700;800;900`);
  if (!css) return null;
  const ws = [...new Set([...css.matchAll(/font-weight:\s*(\d+)/g)].map((m) => +m[1]))].sort((a, b) => a - b);
  return ws.length ? { family: name.trim(), variable: false, weights: ws, italic: false, unknown: true } : null;
}

// ---------------------------------------------------------------- weight by role ink
// compare scores visual heaviness by the capture's role ink (lib/page-analyze.mjs probeInk: INK_SAMPLE
// drawn black on white in the role's exact font with 0.3 em padding, ink / (advance x size), averaged over
// px, 0.94 px and 1.06 px for text <= 24 px). Ink decides weight (font-substitutes §weight): a candidate's
// weight is the one whose probe ink, drawn the same way at the size and tracking the build will set
// (apply.fontSize, apply.letterSpacingEm), equals the reference role's ink.
const INK_SAMPLE = 'Hamburgefonstiv 0123';
async function probeInks(page, items) {
  const parts = [];
  items.forEach((it, i) => { for (const sz of it.sizes) parts.push({ i, sz, html: `<div style="${rowStyle(it, sz, it.lsEm)}display:block;width:max-content;line-height:normal;color:#000;background:#fff;padding:0.3em;margin:0 0 8px 0;box-sizing:content-box">${esc(INK_SAMPLE)}</div>` }); });
  const acc = items.map(() => ({ v: 0, n: 0 }));
  const PER = 60;
  for (let c = 0; c < parts.length; c += PER) {
    const chunk = parts.slice(c, c + PER);
    const rects = await page.evaluate(async (h) => {
      let box = document.getElementById('inkp');
      if (!box) { box = document.createElement('div'); box.id = 'inkp'; document.body.appendChild(box); }
      box.setAttribute('style', 'position:absolute;left:0;top:0;padding:8px;background:#fff;z-index:9');
      box.innerHTML = h;
      await document.fonts.ready;
      return [...box.children].map((e) => { const r = e.getBoundingClientRect(), cs = getComputedStyle(e); return [r.left, r.top, r.width, r.height, r.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)]; });
    }, chunk.map((p) => p.html).join(''));
    const W = clamp(Math.ceil(Math.max(...rects.map((r) => r[0] + r[2]))) + 16, 200, 8000), H = clamp(Math.ceil(Math.max(...rects.map((r) => r[1] + r[3]))) + 16, 100, 16000);
    await page.setViewportSize({ width: W, height: H });
    const png = PNG.sync.read(await page.screenshot({ type: 'png', caret: 'hide', animations: 'disabled' }));
    chunk.forEach((p, k) => {
      const r = rects[k];
      const x0 = Math.max(0, Math.round(r[0])), x1 = Math.min(png.width, Math.round(r[0] + r[2]));
      const y0 = Math.max(0, Math.round(r[1])), y1 = Math.min(png.height, Math.round(r[1] + r[3]));
      let ink = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const q = (y * png.width + x) * 4; ink += Math.max(0, 255 - (0.2126 * png.data[q] + 0.7152 * png.data[q + 1] + 0.0722 * png.data[q + 2])) / 255; }
      if (r[4] > 0) { acc[p.i].v += ink / (r[4] * p.sz); acc[p.i].n++; }
    });
  }
  await page.evaluate(() => { const b = document.getElementById('inkp'); if (b) b.remove(); });
  return acc.map((a) => (a.n ? a.v / a.n : null));
}
// the weight whose probe ink equals `target` on a family's weight grid (linear between grid points for a
// variable family, rounded to 5; the nearest drawn weight for a static one), clamped to the family's range
function weightForInk(pts, target, variable) {
  const ok = pts.filter((p) => p.ink != null).sort((a, b) => a.w - b.w);
  if (!ok.length) return null;
  if (!variable) return ok.reduce((b, p) => (Math.abs(p.ink - target) < Math.abs(b.ink - target) ? p : b)).w;
  if (target <= ok[0].ink) return ok[0].w;
  if (target >= ok[ok.length - 1].ink) return ok[ok.length - 1].w;
  for (let i = 1; i < ok.length; i++) {
    const a = ok[i - 1], b = ok[i];
    if (target >= a.ink && target <= b.ink) return Math.round((a.w + (b.ink > a.ink ? (target - a.ink) / (b.ink - a.ink) : 0) * (b.w - a.w)) / 5) * 5;
  }
  return ok.reduce((b, p) => (Math.abs(p.ink - target) < Math.abs(b.ink - target) ? p : b)).w;
}

// ---------------------------------------------------------------- main
export async function fontmatch(browser, { capDir, role, candidates = null, top = 5 }) {
  const t0 = Date.now();
  const { s, png: refPng, shot, cap } = readSample(capDir, role);
  const px = +s.px, lsRef = +s.ls || 0, italic = /italic|oblique/i.test(s.style || '');
  // public catalogue (cached next to the capture dir, i.e. in <out>/.restyle/): filters every candidate
  const cat = await loadCatalogue(path.dirname(capDir));
  const catNotes = cat.full ? [] : [cat.note];
  const refFonts = referenceFonts(cap, cat, s);
  const M = measureCrop(refPng, s);
  const text = M.text;
  if (!M.RF) {
    // nothing to match in the crop (no contrast, no ink): a poor sample, reported like any other result
    return {
      cmd: 'fontmatch', role, ref: { text, px, weight: s.weight ?? null, ls: lsRef, style: s.style || null, family: s.family || null, class: null },
      catalogue: cat.source, referenceFonts: refFonts,
      sampleQuality: M.q, candidates: [], composite: null, rendered: 0, families: 0, groups: [],
      notes: [...catNotes, ...(M.col ? M.col.notes : []), `sampleQuality poor (${M.q.reason}) in ${shot}: no candidates; take the face from a role of the same family with a good sample (or the sheets), and the weight from the role's ink (font-substitutes §weight)`],
      ms: Date.now() - t0,
    };
  }
  const { col, refMap, RF } = M;
  const Hb = clamp(Math.round(RF.bodyH), 14, 32);
  const G = { Hb, Hn: Math.round((ABOVE + 1 + BELOW) * Hb), Wn: Math.round(RF.W * (Hb / RF.bodyH)) + 2 * MARGIN };
  const Rimg = normalise(refMap, RF, G);
  const notes = [...catNotes, ...col.notes];
  if (refMap.peak < 0.8) notes.push(`the line is drawn at ${Math.round(refMap.peak * 100)}% of its colour's contrast (thin strokes, opacity or a muted colour); ink was contrast-normalised`);
  const quality = M.q;
  if (quality.level === 'poor') notes.push(`sampleQuality poor (${quality.reason}): do not trust this sample's width, tracking or size factor (prefer a role of the same family with a good sample); a weight matched by role ink still stands, a crop-fit weight does not (use the declared weight)`);

  // FONTMATCH_EXCLUDE="A,B" drops families everywhere (testing aid: simulate a reference font that is not on Google Fonts)
  const exclude = new Set(String(process.env.FONTMATCH_EXCLUDE || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean));
  const all = JSON.parse(fs.readFileSync(CATALOGUE, 'utf8')).families;
  // the bundled list is catalogue families; a family the public catalogue no longer lists is dropped too
  const catalogue = all.filter((e) => !exclude.has(e.family.toLowerCase()) && cat.verdict(e.family) !== false);
  // --candidates: only public-catalogue families (a reference brand face that css2 happens to serve is never one)
  if (candidates) {
    const kept = [];
    for (const name of candidates) {
      const v = cat.verdict(name);
      if (v === true) kept.push(cat.matchOf(name));
      else notes.push(v === false ? `candidate "${name}" dropped: not in the public Google Fonts catalogue (${cat.source}); never use it`
        : `candidate "${name}" dropped: not verified (${cat.source}: the catalogue was not reachable and it is not in the bundled subset)`);
    }
    if (!kept.length) throw new Error(`none of the candidates is in the public Google Fonts catalogue (${cat.source}): ${candidates.join(', ')}`);
    candidates = [...new Set(kept)];
  }
  const byName = new Map(catalogue.map((e) => [e.family.toLowerCase(), e]));
  const ctx = await newCaptureContext(browser, { width: 1200, height: 800 });
  const page = await ctx.newPage();
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:${rgbCss(col.bg)}}</style></head><body><div id="rows" style="position:relative"></div></body></html>`);
  const R = { text, px, lsEm: lsRef, fg: col.fg, bg: col.bg, refW: RF.W };

  const results = new Map(), linked = new Set(), unavailable = new Set();
  const famItalic = (e) => italic && !!e.italic;
  async function run(specs) {   // specs: [{e, weights[], variants[]}]
    const toLink = [...new Map(specs.filter((x) => !linked.has(x.e.family) && !unavailable.has(x.e.family)).map((x) => [x.e.family, x.e])).values()];
    if (toLink.length) { const ok = await linkFamilies(page, toLink, italic); for (const e of toLink) (ok.has(e.family) ? linked : unavailable).add(e.family); }
    const items = [];
    for (const x of specs) {
      if (!linked.has(x.e.family)) continue;
      for (const w of x.weights) for (const ax of x.variants) {
        const it = { family: x.e.family, weight: w, italic: famItalic(x.e), axes: ax, e: x.e };
        it.key = `${it.family}|${w}|${it.italic ? 'i' : ''}|${axKey(ax)}`;
        if (!results.has(it.key) && !items.some((q) => q.key === it.key)) items.push(it);
      }
    }
    if (!items.length) return;
    const have = new Set(await ensureFaces(page, items, text));
    const ok = items.filter((it) => { if (have.has(it.family)) return true; unavailable.add(it.family); linked.delete(it.family); return false; });
    await renderRows(page, ok, R, (it, m) => {
      const f = features(m, px, italic);
      if (!f) { results.set(it.key, { it, score: 0, failed: true }); return; }
      const ncc = shapeNcc(Rimg, normalise(m, f, G), G);
      const { parts, score } = partsOf(RF, f, ncc);
      results.set(it.key, { it, f, ncc, parts, score });
    });
    // a wdth variant that draws exactly as wide as the same face at its default width did not get the axis
    // (font served without it): dropped, so a reported axis value is always one that was drawn and scored
    for (const it of ok) {
      const wd = it.axes && it.axes.wdth, r = results.get(it.key);
      if (wd == null || Math.abs(wd - 100) < 5 || !r || r.failed) continue;
      const rest = Object.assign({}, it.axes); delete rest.wdth;
      const base = results.get(`${it.family}|${it.weight}|${it.italic ? 'i' : ''}|${axKey(rest)}`);
      if (!base || base.failed || Math.abs(r.f.W / base.f.W - 1) >= 0.01) continue;
      results.set(it.key, { it, score: 0, failed: true });
      notes.push(`${it.family}: wdth ${wd} drew at the default width (axis not served); variant dropped`);
    }
  }
  const entry = (name) => byName.get(name.toLowerCase());
  const famBest = (fam) => { let b = null; for (const r of results.values()) if (r.it.family === fam && !r.failed && (!b || r.score > b.score)) b = r; return b; };
  const range = (e) => (e.variable ? [e.weights[0], e.weights[e.weights.length - 1]] : [Math.min(...e.weights), Math.max(...e.weights)]);
  // weight grid: multiples of 100 (plus range ends) inside [c - span, c + span]; statics: available ones in the window
  const grid = (e, c, span) => {
    const [lo, hi] = range(e);
    let ws;
    if (e.variable) { ws = []; for (let w = Math.ceil(lo / 100) * 100; w <= hi; w += 100) ws.push(w); if (!ws.includes(lo)) ws.unshift(lo); if (!ws.includes(hi)) ws.push(hi); }
    else ws = [...((italic && e.italic && e.italicWeights) || e.weights)];
    const inWin = ws.filter((w) => Math.abs(w - c) <= span);
    return inWin.length ? inWin : [...ws].sort((p, q) => Math.abs(p - c) - Math.abs(q - c)).slice(0, 2);
  };

  // ---- stage 0: Roboto at every 100 calibrates the width class: line width per body-band height,
  // relative to Roboto at the same stem thickness (stem/px; ink when no stems were found)
  const roboto = all.find((e) => e.family === 'Roboto');   // calibration only when excluded
  await run([{ e: roboto, weights: grid(roboto, 500, 500), variants: [{}] }]);
  const cal = [...results.values()].filter((r) => r.it.family === 'Roboto' && !r.failed && !axKey(r.it.axes)).sort((p, q) => p.it.weight - q.it.weight);
  if (!cal.length) throw new Error('could not load fonts from fonts.googleapis.com (offline?)');
  let robotoW = null;
  {
    const by = RF.stemEm && cal.every((r) => r.f.stemEm) ? (f) => f.stemEm : (f) => f.ink;
    const v = by(RF), rel = (f) => f.W / f.bodyH;
    const k = cal.findIndex((r) => by(r.f) >= v);
    if (k === 0) robotoW = rel(cal[0].f);
    else if (k < 0) robotoW = rel(cal[cal.length - 1].f);
    else { const a = cal[k - 1].f, b = cal[k].f, t = (v - by(a)) / ((by(b) - by(a)) || 1); robotoW = rel(a) + t * (rel(b) - rel(a)); }
  }
  // Roboto itself is a slightly narrow "normal": below 0.95 counts as (semi-)condensed, below 0.86 as condensed
  const opszAxis = (e) => (e.axes || []).find((a) => a.tag === 'opsz' && a.def != null) || null;
  const opszDiffers = (e) => { const op = opszAxis(e); return !!op && Math.abs(clamp(px, op.min, op.max) - op.def) / op.def >= 0.25; };
  const widthRatio = RF.W / RF.bodyH / robotoW;
  const widthClass = widthRatio < 0.95 ? 'condensed' : widthRatio > 1.25 ? 'extended' : 'normal';
  const semi = widthClass === 'condensed' && widthRatio >= 0.86;
  const variantsFor = (e) => {
    const out = [{}];
    const wd = (e.axes || []).find((a) => a.tag === 'wdth');
    if (wd && widthClass === 'condensed' && wd.min < 100) { out.length = 0; for (const v of [wd.min, Math.round((wd.min + 100) / 2), 100]) if (v >= wd.min && v <= wd.max && !out.some((o) => o.wdth === v)) out.push(v === 100 ? {} : { wdth: v }); }
    if (wd && widthClass === 'extended' && wd.max > 100) { out.length = 0; for (const v of [100, Math.round((wd.max + 100) / 2), wd.max]) if (!out.some((o) => (o.wdth || 100) === v)) out.push(v === 100 ? {} : { wdth: v }); }
    const fl = (e.axes || []).find((a) => a.tag === 'FLAR');
    let res = fl ? out.flatMap((o) => [o, Object.assign({}, o, { FLAR: fl.max })]) : out;
    // optical size: the automatic cut for px (axis range loaded, font-optical-sizing auto) and, where it
    // differs at this px, the family's default instance (what is served when opsz is not requested: a
    // display-size reference may well be drawn in a text cut)
    if (opszDiffers(e)) res = res.flatMap((o) => [o, Object.assign({}, o, { opsz: opszAxis(e).def })]);
    return res;
  };

  // ---- stage 1: probes (or only the classification prototypes when the caller names candidates)
  const probeList = candidates ? PROTOS.map(([f, ax]) => [f, ax]) : [...PROBES, ...PROTOS.map(([f, ax]) => [f, ax])];
  const seenProbe = new Set();
  const probeSpecs = [];
  for (const [f, ax] of probeList) {
    const e = entry(f); if (!e) continue;
    const k = `${f}|${axKey(ax)}`; if (seenProbe.has(k)) continue; seenProbe.add(k);
    probeSpecs.push({ e, weights: grid(e, 500, 500), variants: [ax || {}] });
  }
  await run(probeSpecs);

  // group scores from the probes
  const groupScore = {};
  for (const r of results.values()) {
    if (r.failed) continue;
    const e = entry(r.it.family); if (!e) continue;
    const g = GROUP[e.style] || 'grotesque';
    if (!(g in groupScore) || r.score > groupScore[g]) groupScore[g] = r.score;
  }
  const groupRank = Object.entries(groupScore).sort((p, q) => q[1] - p[1]);

  // ---- reference classification: stroke features vs prototypes at their best weight + probe group vote
  const protoF = [];
  for (const [f, ax, kind] of PROTOS) {
    let b = null; for (const r of results.values()) if (r.it.family === f && axKey(r.it.axes) === axKey(ax) && !r.failed && (!b || r.score > b.score)) b = r;
    if (b) protoF.push({ family: f, kind, f: b.f });
  }
  const refClass = classifyRef(RF, protoF, groupRank, widthRatio, widthClass, px);

  // ---- stage 2: the pool
  let pool;
  if (candidates) {
    pool = [];
    for (const name of candidates) {
      const e = entry(name) || await probeFamily(name);
      if (e) pool.push(e); else unavailable.add(name.trim());
    }
    if (!pool.length) throw new Error(`none of the candidates could be loaded from Google Fonts: ${candidates.join(', ')}`);
  } else {
    // slots per style group, in probe-score order (the best group's affinities get a small lift), so the
    // pool always spans several neighbouring styles; inside a group: width class match, italics, popularity
    const order = [];
    if (groupRank.length) {
      const g1 = groupRank[0][0], aff = new Set(AFFINITY[g1] || []);
      order.push(g1, ...groupRank.slice(1).map(([g, v]) => [g, v + (aff.has(g) ? 0.08 : 0)]).sort((a, b) => b[1] - a[1]).map(([g]) => g));
    }
    const famPrior = (e) => {
      let p = 0;
      const wd = (e.axes || []).find((a) => a.tag === 'wdth');
      if (widthClass === 'condensed') p += e.width === 'condensed' || (wd && wd.min <= 80) ? (semi ? 0.4 : 0.6) : e.width === 'extended' ? -0.8 : semi ? 0 : -0.3;
      else if (widthClass === 'extended') p += e.width === 'extended' || (wd && wd.max >= 115) ? 0.6 : e.width === 'condensed' ? -0.8 : -0.3;
      else p += e.width === 'normal' ? 0.2 : -0.6;
      if (italic && !e.italic) p -= 0.5;
      return p - Math.log10(1 + (e.popularity || 500)) * 0.05;
    };
    // a clear leader gets more of the 30 slots
    const lead = groupRank.length > 1 ? groupRank[0][1] - groupRank[1][1] : 1;
    const quota = lead > 0.12 ? [16, 6, 4, 2, 2] : lead > 0.06 ? [13, 7, 5, 3, 2] : QUOTA;
    pool = [];
    order.slice(0, quota.length).forEach((g, i) => {
      pool.push(...catalogue.filter((e) => (GROUP[e.style] || 'grotesque') === g).sort((a, b) => famPrior(b) - famPrior(a)).slice(0, quota[i]));
    });
  }
  await run(pool.map((e) => ({ e, weights: grid(e, 500, 500), variants: variantsFor(e) })));

  // ---- stage 3: refine the best families to 50 and 25 weight units
  const inPool = new Set(pool.map((e) => e.family));
  const eligible = () => [...new Set([...results.values()].filter((r) => !r.failed && !exclude.has(r.it.family.toLowerCase()) && (!candidates || inPool.has(r.it.family))).map((r) => r.it.family))];
  // the same outlines under two names (Roboto wdth 75 = Roboto Condensed) count once
  const same = (a, b) => a.f.W === b.f.W && Math.abs(a.f.ink - b.f.ink) < 1e-3 && Math.abs(a.f.bodyH - b.f.bodyH) < 0.02;
  const ranked = () => eligible().map((f) => famBest(f)).filter(Boolean)
    .sort((a, b) => b.score - a.score || axKey(a.it.axes).length - axKey(b.it.axes).length)
    .filter((b, i, arr) => !arr.slice(0, i).some((a) => same(a, b)));
  for (const stepW of [50, 25]) {
    const specs = [];
    for (const b of ranked().slice(0, Math.max(top, 6))) {
      const e = b.it.e; if (!e.variable) continue;
      const [lo, hi] = range(e);
      const ws = [b.it.weight - stepW, b.it.weight + stepW].filter((w) => w >= lo && w <= hi);
      if (ws.length) specs.push({ e, weights: ws, variants: [b.it.axes] });
    }
    if (specs.length) await run(specs);
  }

  if (process.env.FONTMATCH_DEBUG) {   // tuning aid: every render's measurements on stderr
    const fx = (f) => `W ${f.W} ink ${r3(f.ink)} bodyH ${r3(f.bodyH)} c ${f.contrast && r3(f.contrast)} serif ${f.serif && r3(f.serif)} flare ${f.flare && r3(f.flare)} stemEm ${f.stemEm && r3(f.stemEm)}`;
    console.error(`REF ${fx(RF)} widthRatio ${r3(widthRatio)}`);
    const want = String(process.env.FONTMATCH_DEBUG).split(',');
    for (const r of [...results.values()].sort((a, b) => (a.it.family < b.it.family ? -1 : a.it.family > b.it.family ? 1 : a.it.weight - b.it.weight))) {
      if (r.failed || (want[0] !== '1' && !want.includes(r.it.family))) continue;
      console.error(`${r.it.family} ${r.it.weight} ${axKey(r.it.axes)} score ${r3(r.score)} ncc ${r3(r.ncc)} | ${fx(r.f)} | ${Object.entries(r.parts).map(([k, v]) => `${k} ${v == null ? '-' : r3(v)}`).join(' ')}`);
    }
  }

  // ---- result
  const finals = ranked().slice(0, Math.max(1, top));
  if (!finals.length) throw new Error('no candidate could be rendered');
  const gaps = Math.max(0, [...text].length - 1);
  const rawSizes = [];
  const candOut = finals.map((b) => {
    const f = b.f, e = b.it.e;
    const rawSize = RF.bodyH / f.bodyH;
    rawSizes.push(rawSize);
    const sizeAdjust = clamp(rawSize, 0.7, 1.4);
    const w0 = f.W - lsRef * px * gaps;   // candidate width at px without tracking
    const L = gaps ? (RF.W - sizeAdjust * w0) / (sizeAdjust * px * gaps) : lsRef;
    const lsAdjustEm = clamp(L - lsRef, -0.2, 0.2);
    const g = GROUP[e.style];
    const o = {
      family: b.it.family, weight: b.it.weight, score: r3(b.score), lsAdjustEm: r3(lsAdjustEm), sizeAdjust: r3(sizeAdjust),
      class: e.unknown ? { kind: null, note: 'not in the bundled list' } : { kind: KIND[g] || null, style: e.style, contrast: e.contrast, width: e.width, category: e.category },
      parts: Object.fromEntries(Object.entries(b.parts).map(([k, v]) => [k, v == null ? null : r3(v)])),
    };
    if (axKey(b.it.axes)) {
      const { opsz, ...rest } = b.it.axes;
      if (Object.keys(rest).length) o.axes = rest;
    }
    // opsz: "auto" = the reference draws this family's optical-size cut for its px (request the opsz range,
    // leave it automatic); "default" = it draws the default (text) cut at this size (do not request opsz)
    if (opszDiffers(e)) o.opsz = b.it.axes && b.it.axes.opsz != null ? 'default' : 'auto';
    if (b.it.italic) o.italic = true;
    o.apply = { fontSize: r3(px * sizeAdjust), letterSpacingEm: r3(lsRef + lsAdjustEm) };
    // the size and tracking corrections are clamped (x0.7-1.4, +-0.2em): say so when a clamp bit
    if (rawSize !== sizeAdjust) o.sizeClamped = { wanted: r3(rawSize), used: r3(sizeAdjust) };
    if (Math.abs(L - lsRef - lsAdjustEm) > 1e-6) {
      o.trackingClamped = { wanted: r3(L), used: r3(lsRef + lsAdjustEm) };
      notes.push(`${o.family} ${o.weight}: tracking clamped (wanted letter-spacing ${r3(L)}em, used ${r3(lsRef + lsAdjustEm)}em): the width does not match at this size; distrust this candidate's width fit`);
    }
    return o;
  });
  // a poor sample whose body band yields an implausible size factor for every candidate measures the
  // crop, not the font: flag it (the factors are kept as computed)
  let sizeAdjustSuspect = null;
  if (quality.level === 'poor' && rawSizes.every((v) => v < 0.85 || v > 1.15)) {
    sizeAdjustSuspect = `sampleQuality is poor and every candidate's size factor is outside 0.85-1.15 (${rawSizes.map(r3).join(', ')}): the crop's body band is probably mis-measured; keep the reference px (sizeAdjust 1) or take the size from a role with a good sample`;
    notes.push(`sizeAdjust suspect: ${sizeAdjustSuspect}`);
  }

  // ---- weight by role ink: when the capture measured this role's ink, each candidate's weight is the one
  // whose probe ink at its apply size and tracking equals it (the measure compare scores); the crop-fit
  // weight stays as cropWeight. Without a measured ink (older captures) the crop-fit weight stands.
  const refInk = (() => {
    const R0 = cap && cap.type && cap.type.roles;
    if (!R0) return null;
    const vp = R0['1440'] ? '1440' : Object.keys(R0).sort((a, b) => b - a)[0];
    const v = vp && R0[vp] && R0[vp][role];
    return v && v.ink > 0 ? v.ink : null;
  })();
  if (refInk) {
    const items = [];
    finals.forEach((b, i) => {
      const e = b.it.e, c = candOut[i];
      const [lo, hi] = range(e);
      let ws;
      if (e.variable) { ws = []; for (let w = Math.max(lo, Math.floor((b.it.weight - 300) / 25) * 25); w <= Math.min(hi, b.it.weight + 300); w += 25) ws.push(w); if (!ws.includes(lo) && lo >= b.it.weight - 300) ws.unshift(lo); if (!ws.includes(hi) && hi <= b.it.weight + 300) ws.push(hi); }
      else ws = [...((italic && e.italic && e.italicWeights) || e.weights)];
      const sz = c.apply.fontSize;
      for (const w of ws) items.push({ ci: i, family: b.it.family, weight: w, italic: b.it.italic, axes: b.it.axes, e, lsEm: c.apply.letterSpacingEm, sizes: sz <= 24 ? [sz, r3(sz * 0.94), r3(sz * 1.06)] : [sz] });
    });
    await ensureFaces(page, items, INK_SAMPLE);
    const inks = await probeInks(page, items);
    finals.forEach((b, i) => {
      const c = candOut[i];
      const pts = items.map((it, k) => ({ it, ink: inks[k] })).filter((x) => x.it.ci === i).map((x) => ({ w: x.it.weight, ink: x.ink }));
      const w = weightForInk(pts, refInk, b.it.e.variable);
      if (w == null) return;
      const at = pts.reduce((m, p) => (p.ink != null && (!m || Math.abs(p.w - w) < Math.abs(m.w - w)) ? p : m), null);
      c.cropWeight = c.weight; c.weight = w; c.weightBasis = 'role ink';
      c.ink = { ref: r3(refInk), candidate: at ? r3(at.ink) : null };
      const okI = pts.filter((p) => p.ink != null);
      if (okI.length && refInk > Math.max(...okI.map((p) => p.ink)) * 1.03) c.ink.beyond = `heavier than ${c.family} draws (max ${Math.max(...okI.map((p) => p.w))})`;
      else if (okI.length && refInk < Math.min(...okI.map((p) => p.ink)) * 0.97) c.ink.beyond = `lighter than ${c.family} draws (min ${Math.min(...okI.map((p) => p.w))})`;
    });
    notes.push(`weights matched to the reference ${role} ink ${r3(refInk)} (capture type.roles, the measure compare scores); crop-fit weights kept as cropWeight`);
  } else candOut.forEach((c) => { c.weightBasis = 'crop'; });

  // ---- composite: reference crop on top, each candidate beneath (applied weight, size and tracking)
  const compPath = path.resolve(capDir, `fontmatch-${role}.png`);
  const shown = finals.map((b, i) => ({ ...b, it: { ...b.it, weight: candOut[i].weight } }));
  if (refInk) await ensureFaces(page, shown.map((b) => b.it), text);
  await composite(page, { refPng, s, role, px, lsRef, text, col, refClass, finals: shown, candOut, quality, out: compPath });
  await ctx.close().catch(() => {});

  const out = {
    cmd: 'fontmatch', role,
    ref: { text, px, weight: s.weight ?? null, ls: lsRef, style: s.style || null, family: s.family || null, class: refClass },
    catalogue: cat.source, referenceFonts: refFonts,
    sampleQuality: quality,
    ...(sizeAdjustSuspect ? { sizeAdjustSuspect: true, sizeAdjustSuspectReason: sizeAdjustSuspect } : {}),
    candidates: candOut, composite: compPath,
    rendered: results.size, families: eligible().length,
    groups: groupRank.slice(0, 6).map(([g, v]) => ({ group: g, score: r3(v) })),
  };
  if (unavailable.size) out.unavailable = [...unavailable];
  if (notes.length) out.notes = notes;
  out.ms = Date.now() - t0;
  return out;
}

// --brief: a short JSON (top candidates with the fields a builder applies) and a human table for stderr
export function fontmatchBrief(o) {
  const cls = (c) => (c.class && c.class.kind ? `${c.class.kind}/${c.class.style}` : (c.class && c.class.note) || '?');
  const fam = (c) => `${c.family}${c.axes ? ' ' + Object.entries(c.axes).map(([t, v]) => `${t}${v}`).join(',') : ''}${c.opsz ? ` opsz ${c.opsz}` : ''}${c.italic ? ' italic' : ''}`;
  const json = {
    cmd: 'fontmatch', role: o.role, brief: true, catalogue: o.catalogue, referenceFonts: o.referenceFonts, sampleQuality: o.sampleQuality,
    ...(o.sizeAdjustSuspect ? { sizeAdjustSuspect: true, sizeAdjustSuspectReason: o.sizeAdjustSuspectReason } : {}),
    candidates: o.candidates.map((c, i) => {
      const x = { rank: i + 1, family: c.family, class: cls(c), weight: c.weight, weightBasis: c.weightBasis, sizeAdjust: c.sizeAdjust, apply: c.apply, score: c.score };
      if (c.cropWeight != null) x.cropWeight = c.cropWeight;
      if (c.ink) x.ink = c.ink;
      if (c.opsz) x.opsz = c.opsz;
      if (c.axes) x.axes = c.axes;
      if (c.italic) x.italic = true;
      if (c.sizeClamped) x.sizeClamped = c.sizeClamped;
      if (c.trackingClamped) x.trackingClamped = c.trackingClamped;
      return x;
    }),
    composite: o.composite,
  };
  const head = ['#', 'family', 'class', 'wght', 'size x', 'fontSize', 'ls em', 'score'];
  const rows = o.candidates.map((c, i) => [String(i + 1), fam(c), cls(c), `${c.weight}${c.weightBasis === 'role ink' ? ' ink' : ''}`,
    `${c.sizeAdjust}${c.sizeClamped ? '!' : ''}`, String(c.apply.fontSize), `${c.apply.letterSpacingEm}${c.trackingClamped ? '!' : ''}`, c.score.toFixed(3)]);
  const wid = head.map((h, k) => Math.max(h.length, ...rows.map((r) => r[k].length)));
  const line = (r) => r.map((v, k) => (k >= 3 ? v.padStart(wid[k]) : v.padEnd(wid[k]))).join('  ');
  const lines = [`fontmatch ${o.role}: ref ${o.ref.px}px weight ${o.ref.weight ?? '?'} ls ${o.ref.ls}em; sample ${o.sampleQuality.level}${o.sampleQuality.level === 'poor' ? ` (${o.sampleQuality.reason})` : ''}`,
    line(head), line(wid.map((n) => '-'.repeat(n))), ...rows.map(line)];
  if (o.candidates.some((c) => c.weightBasis === 'role ink')) lines.push('wght "ink" = matched to the reference role ink (what compare scores); cropWeight = the crop fit; ls em and fontSize are absolute values to apply');
  if (!o.candidates.length) lines.push('no candidates: the sample is poor (see above)');
  for (const f of o.referenceFonts || []) lines.push(`reference family ${f.family}${f.thisRole ? ' (this role)' : ''}: ${f.use}`);
  if (o.catalogue && !/^google/.test(o.catalogue)) lines.push(`! catalogue: ${o.catalogue}`);
  for (const c of o.candidates) {
    if (c.ink && c.ink.beyond) lines.push(`! ${fam(c)}: reference ink is ${c.ink.beyond}`);
    if (c.sizeClamped) lines.push(`! ${fam(c)}: size factor clamped (wanted x${c.sizeClamped.wanted}, used x${c.sizeClamped.used})`);
    if (c.trackingClamped) lines.push(`! ${fam(c)}: tracking clamped (wanted ${c.trackingClamped.wanted}em, used ${c.trackingClamped.used}em)`);
  }
  if (o.sizeAdjustSuspect) lines.push(`! sizeAdjust suspect: ${o.sizeAdjustSuspectReason}`);
  lines.push(`composite: ${o.composite}`);
  return { json, table: lines.join('\n') };
}

function classifyRef(RF, protos, groupRank, widthRatio, widthClass, px) {
  const measured = {
    contrast: RF.contrast ? r3(RF.contrast) : null, serif: RF.serif != null ? r3(RF.serif) : null, flare: RF.flare != null ? r3(RF.flare) : null,
    stems: RF.stems, stemEm: RF.stemEm ? r3(RF.stemEm) : null, widthRatio: r3(widthRatio), bodyHpx: r3(RF.bodyH),
  };
  // nearest prototype in stroke-feature space (same text, same px, each prototype at its best weight)
  const near = protos.map((p) => {
    const t = [];
    if (RF.contrast && p.f.contrast) t.push((Math.log(RF.contrast / p.f.contrast) / 0.25) ** 2);
    if (RF.serif != null && p.f.serif != null) t.push(((RF.serif - p.f.serif) / 0.4) ** 2);
    if (RF.flare != null && p.f.flare != null) t.push(((RF.flare - p.f.flare) / 0.08) ** 2);
    return { family: p.family, kind: p.kind, d: t.length ? Math.sqrt(t.reduce((s, x) => s + x, 0) / t.length) : Infinity };
  }).sort((a, b) => a.d - b.d);
  const vote = groupRank.length ? KIND[groupRank[0][0]] : null;
  // contrast class against the prototypes' measured contrast (text-calibrated)
  const pc = (f) => { const p = protos.find((q) => q.family === f); return p && p.f.contrast; };
  const lo = pc('Roboto'), mid = pc('Source Serif 4'), hi = pc('Playfair Display');
  const c1 = lo && mid ? Math.sqrt(lo * mid) : 1.55, c2 = mid && hi ? Math.sqrt(mid * hi) : 2.5;
  const contrast = RF.contrast ? (RF.contrast < c1 ? 'low' : RF.contrast < c2 ? 'medium' : 'high') : null;
  // kind from the stroke terminals when enough stems were measured: foot serifs (bottom-end / waist run
  // ratio >= 1.5) -> serif; widened terminals (1.15-1.5) or a stroke-modulated sans (thick/thin above the
  // Roboto/Source Serif midpoint) -> flared; else sans. Without stems: the probe group vote.
  let byFeat = null;
  if (RF.serif != null && RF.stems >= 4) byFeat = RF.serif >= 1.5 ? 'serif' : RF.serif >= 1.15 || (RF.contrast && RF.contrast >= c1) ? 'flared' : 'sans';
  const kind = byFeat || vote || (near.length && isFinite(near[0].d) ? near[0].kind : null);
  const res = RF.bodyH >= 22 && RF.stems >= 6 ? 2 : RF.bodyH >= 12 && RF.stems >= 4 ? 1 : 0;
  const agree = byFeat && vote ? byFeat === vote : false;
  const confidence = res === 0 || !byFeat ? 'low' : agree && res === 2 ? 'high' : agree || res === 2 ? 'medium' : 'low';
  const out = { kind, contrast, width: widthClass, confidence, measured, basis: `terminals/contrast say ${byFeat || 'n/a'} (${RF.stems} stems); probe vote ${vote || 'n/a'}${groupRank.length ? ` (best group ${groupRank[0][0]})` : ''}; stroke features nearest ${near.length ? `${near[0].family} (${near[0].kind})` : 'n/a'}; body band ${r3(RF.bodyH)} px` };
  if (widthRatio < 0.72) out.compressed = true;
  return out;
}

async function composite(page, o) {
  const { refPng, s, role, px, lsRef, text, col, refClass, finals, candOut, quality } = o;
  const W = 1500, padX = 28, inner = W - 2 * padX - 24;
  const k = Math.min(1, inner / refPng.width);
  const fams = [...new Map(finals.map((b) => [b.it.family, b.it.e])).values()];
  const italic = finals.some((b) => b.it.italic);
  const qs = fams.map((e) => `family=${familyQuery(e, italic && e.italic)}`).join('&');
  const b64 = PNG.sync.write(refPng).toString('base64');
  const lab = (h) => `<div class="lab">${h}</div>`;
  const rc = refClass;
  let body = lab(`<b>Reference</b> &middot; ${esc(role)} &middot; ${r3(px)}px &middot; weight ${esc(s.weight ?? '?')}${s.style ? ' ' + esc(s.style) : ''} &middot; letter-spacing ${r3(lsRef)}em absolute${s.family ? ` &middot; site font: ${esc(s.family)}` : ''} &middot; measured: ${esc(rc.kind || '?')}, ${esc(rc.contrast || '?')} contrast, ${esc(rc.width)}${rc.compressed ? ' (compressed)' : ''} (${esc(rc.confidence)} confidence)`
    + (quality && quality.level === 'poor' ? `<br><b>sample quality: poor</b> &middot;${esc(quality.reason)}` : ''))
    + `<div class="panel" style="background:${rgbCss(col.bg)}"><img src="data:image/png;base64,${b64}" style="display:block;width:${Math.round(refPng.width * k)}px;height:${Math.round(refPng.height * k)}px"></div>`;
  finals.forEach((b, i) => {
    const c = candOut[i];
    const ax = c.axes ? ' ' + Object.entries(c.axes).map(([t, v]) => `${t} ${v}`).join(' ') : '';
    const cls = c.class && c.class.kind ? ` &middot; ${esc(c.class.style)} / ${esc(c.class.contrast)} contrast / ${esc(c.class.width)}` : '';
    // apply values are absolute (what the build sets); the adjustment is relative to the reference's
    const adj = `${c.lsAdjustEm >= 0 ? '+' : ''}${c.lsAdjustEm}em`;
    body += lab(`<b>${i + 1}. ${esc(c.family)} ${c.weight}${esc(ax)}</b>${c.weightBasis === 'role ink' && c.cropWeight != null && c.cropWeight !== c.weight ? ` (crop fit ${c.cropWeight})` : ''} &middot; score ${c.score.toFixed(3)} &middot; font-size ${c.apply.fontSize}px (reference &times;${c.sizeAdjust}${c.sizeClamped ? `, clamped, wanted &times;${c.sizeClamped.wanted}` : ''}) &middot; letter-spacing ${c.apply.letterSpacingEm}em absolute (reference ${r3(lsRef)}em ${adj} adjustment${c.trackingClamped ? `, clamped, wanted ${c.trackingClamped.wanted}em` : ''})${c.opsz ? ` &middot; opsz ${esc(c.opsz)}` : ''}${cls}`)
      + `<div class="panel" style="background:${rgbCss(col.bg)};color:${rgbCss(col.fg)}"><div style="${rowStyle(b.it, px * c.sizeAdjust * k, lsRef + c.lsAdjustEm)}line-height:1.25">${esc(text)}</div></div>`;
  });
  await page.setViewportSize({ width: W, height: 200 });   // fullPage grows it to the content
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?${qs}&display=block"><style>
html,body{margin:0;background:#f3f3f1}
.wrap{width:${W}px;box-sizing:border-box;padding:18px ${padX}px 26px;font-family:"Segoe UI",system-ui,Arial,sans-serif;color:#1b1b1b}
.lab{font-size:15px;line-height:20px;margin:16px 0 6px}
.lab b{font-weight:600}
.panel{padding:8px 12px;overflow:hidden}
</style></head><body><div class="wrap">${body}</div></body></html>`, { waitUntil: 'load' });
  await page.evaluate(async (specs) => { await Promise.all(specs.map((x) => document.fonts.load(x[0], x[1]).catch(() => []))); await document.fonts.ready; },
    finals.map((b) => [`${b.it.italic ? 'italic ' : ''}${b.it.weight} 40px ${cssFam(b.it.family)}`, text]));
  await page.screenshot({ path: o.out, fullPage: true, type: 'png' });
}
