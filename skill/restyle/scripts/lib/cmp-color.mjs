// Colour area (20): role deltaE, theme, palette distribution, gradients.
import fs from 'node:fs';
import path from 'node:path';
import { parse, converter } from 'culori';
import { COLOR as C } from './cmp-constants.mjs';
import { readPng } from './images.mjs';
import { Area, combine, lin, dE, lch, col, hueDist, isNum, r2, r3, presence } from './cmp-util.mjs';

const toOklab = converter('oklab');
const ROLE_USE = {
  pageBg: 'the page background (html/body)', surface: 'card and panel backgrounds', text: 'body and heading text',
  mutedText: 'secondary text', border: 'borders and dividers', accent: 'primary buttons, links and highlights', accent2: 'the secondary highlight colour',
};

/** Colour stops of a CSS gradient string -> [{c (culori), alpha}] */
export function gradientStops(css) {
  const re = /(rgba?\([^)]*\)|hsla?\([^)]*\)|oklab\([^)]*\)|oklch\([^)]*\)|lab\([^)]*\)|lch\([^)]*\)|#[0-9a-f]{3,8}\b|\btransparent\b)/gi;
  const out = [];
  for (const m of String(css || '').matchAll(re)) {
    const c = parse(m[1]);
    if (c) out.push({ c, alpha: c.alpha ?? 1 });
  }
  return out;
}

const toRgb = converter('rgb');
/** A stop composited over a solid colour (sRGB "over"): a culori colour. */
function over(stop, under) {
  const s = toRgb(stop.c), u = toRgb(under);
  if (!s || !u) return stop.c;
  const a = Math.max(0, Math.min(1, stop.alpha));
  return { mode: 'rgb', r: s.r * a + u.r * (1 - a), g: s.g * a + u.g * (1 - a), b: s.b * a + u.b * (1 - a) };
}

// under (hex, optional): what the gradient is drawn over; given, the gradient is visible only when two of its
// stops composited over it are >= compositeDeltaE apart (a fade of that colour to transparent is invisible)
export function gradientInfo(g, under = null) {
  const G = C.gradient;
  const stops = gradientStops(g.css);
  let visible = false;
  const opaque = stops.filter((s) => s.alpha >= G.visibleAlpha);
  const uc = under ? parse(under) : null;
  if (uc && !g.clipText) {
    const comp = stops.map((s) => over(s, uc));
    for (let i = 0; i < comp.length && !visible; i++) for (let j = i + 1; j < comp.length; j++) if ((dE({ c: comp[i] }, { c: comp[j] }) ?? 0) >= G.compositeDeltaE) { visible = true; break; }
  } else {
    for (let i = 0; i < opaque.length && !visible; i++) for (let j = i + 1; j < opaque.length; j++) if (dE({ c: opaque[i].c }, { c: opaque[j].c }) >= G.visibleStopDeltaE) { visible = true; break; }
    if (!visible && stops.length >= 2) {
      const al = stops.map((s) => s.alpha);
      if (Math.max(...al) - Math.min(...al) >= G.visibleAlphaSpan) visible = true;
    }
  }
  const hues = [], chrom = [];
  for (const s of opaque) {
    const l = lch({ c: s.c });
    if (l && l.c >= G.chromaMin && isNum(l.h)) { hues.push(l.h); if (s.alpha >= G.image.stopAlpha) chrom.push({ c: s.c, h: l.h }); }
  }
  const where = Array.isArray(g.where) ? g.where : String(g.where || '').split(',').filter(Boolean);
  return { visible, hues, chrom, area: g.areaFrac || 0, where, n: g.n || 1, bands: Array.isArray(g.bands) ? g.bands : [] };
}

// Band gradients of a capture (the same rule on both sides): visible as colour over its band's background
// (else the page background), not an overlay on media (capture flag onMedia, a gradient layered with a url()
// image, or a translucent gradient whose bands all have picture backgrounds), not a thin strip (capture flag
// thin), and >= bandShare of its bands' area (>= pageShare of the page without a band). Gradient text and
// gradient buttons only need to be visible. `left` counts what was left out and why, for the finding text.
const PIC_BG = new Set(['image', 'video', 'canvas', 'iframe']);
function gradSummary(cap) {
  const G = C.gradient;
  const secs = new Map((cap.sections || []).map((s) => [s.id, s]));
  const pageBg = cap.colors?.roles?.pageBg || '#ffffff';
  const docH = cap.meta?.pageHeight?.['1440'] || null;
  const list = [], left = { faint: 0, media: 0, small: 0 };
  for (const g of cap.colors?.gradients || []) {
    const bs = (g.bands || []).map((id) => secs.get(id)).filter(Boolean);
    const under = bs.length && bs[0].bg && bs[0].bg.color ? bs[0].bg.color : pageBg;
    const info = gradientInfo(g, under);
    if (!info.visible) { left.faint++; continue; }
    info.el = !!(g.clipText || info.where.includes('text') || info.where.includes('button'));
    if (!info.el) {
      const st = gradientStops(g.css);
      const translucent = st.some((s) => s.alpha < 0.95);
      // a shade: neutral stops of one colour whose alpha alone changes, never above 0.5 (soft shadows,
      // vignettes, scrims), is not a colour gradient
      const neutral = st.every((s) => (lch({ c: s.c })?.c ?? 0) < C.gradient.chromaMin || s.alpha < 0.05);
      const solid = st.filter((s) => s.alpha >= 0.05);
      if (neutral && solid.length && solid.every((s) => s.alpha < 0.5 && (dE({ c: s.c }, { c: solid[0].c }) ?? 0) < 0.05)) { left.faint++; continue; }
      if (g.onMedia || /url\(/.test(g.css || '') || (translucent && bs.length && bs.every((b) => PIC_BG.has(b.bg?.type)))) { left.media++; continue; }
      const bandFrac = docH && bs.length ? bs.reduce((s, b) => s + (b.h || 0), 0) / docH : 0;
      if (g.thin || (bandFrac > 0 ? info.area / bandFrac < G.bandShare : info.area < G.pageShare)) { left.small++; continue; }
    }
    list.push(info);
  }
  const where = new Set(list.flatMap((g) => g.where));
  return { list, n: list.length, area: list.reduce((a, g) => a + g.area, 0), where, hues: list.flatMap((g) => g.hues), images: 0, left };
}
// the same gradient on the other side: both have chromatic stops and every hue of each is within hueDeg[0]
// of a hue of the other, or both are neutral with an area within 2x
function sameGradient(a, b) {
  if (a.hues.length && b.hues.length) {
    const near = (X, Y) => X.every((h) => Y.some((k) => hueDist(h, k) <= C.gradient.hueDeg[0]));
    return near(a.hues, b.hues) && near(b.hues, a.hues);
  }
  if (a.hues.length || b.hues.length) return false;
  if (a.el && b.el) return true;
  return a.area > 0 && b.area > 0 && Math.max(a.area, b.area) / Math.min(a.area, b.area) <= 2;
}

// ---- gradients shipped as images: pixel evidence in the other side's full screenshot ----
const PNG_CACHE = new Map();
function fullShot(cap, dir) {
  const f = cap?.shots?.['1440']?.full;
  if (!dir || !f) return null;
  const file = path.join(dir, f);
  if (!PNG_CACHE.has(file)) { let png = null; try { if (fs.existsSync(file)) png = readPng(file); } catch { png = null; } PNG_CACHE.set(file, png); }
  return PNG_CACHE.get(file);
}
const SRGB = Array.from({ length: 256 }, (_, i) => { const c = i / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
function pxLab(r, g, b) {
  const R = SRGB[r], Gc = SRGB[g], B = SRGB[b];
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * Gc + 0.0514459929 * B), m = Math.cbrt(0.2119034982 * R + 0.6806995451 * Gc + 0.1073969566 * B), s = Math.cbrt(0.0883024619 * R + 0.2817188376 * Gc + 0.6299787005 * B);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
/** Share of the sampled pixels of rows [y0, y1) within dE of each target colour. */
function colourShares(png, rows, targets, step) {
  const T = targets.map((c) => { const o = toOklab(c); return [o.l, o.a, o.b]; });
  const hit = T.map(() => 0);
  let n = 0;
  const lim = G_IMG().stopDeltaE ** 2;
  for (const [y0, y1] of rows) {
    for (let y = Math.max(0, Math.round(y0)); y < Math.min(png.height, Math.round(y1)); y += step) {
      for (let x = 0; x < png.width; x += step) {
        const i = (y * png.width + x) * 4;
        const p = pxLab(png.data[i], png.data[i + 1], png.data[i + 2]);
        n++;
        for (let k = 0; k < T.length; k++) { const dl = p[0] - T[k][0], da = p[1] - T[k][1], db = p[2] - T[k][2]; if (dl * dl + da * da + db * db <= lim) hit[k]++; }
      }
    }
  }
  return n ? hit.map((h) => h / n) : null;
}
const G_IMG = () => C.gradient.image;
/**
 * CSS gradients of one side ("from") that the other side ("to") ships as an image: a visible gradient
 * with >= 2 chromatic stops whose aligned band on the other side has no visible CSS gradient, and whose
 * every chromatic stop colour covers >= minShare of that aligned band's pixels in the other side's full
 * 1440 screenshot. Returns the gradients to count as present on the "to" side.
 */
function imageGradients(fromCap, from, toCap, toDir, to, pairs, fromKey) {
  if (!pairs || !from.list.length) return [];
  const toKey = fromKey === 'A' ? 'B' : 'A';
  const idsToIdx = (cap) => new Map((cap.sections || []).map((s) => [s.id, s.i]));
  const fIdx = idsToIdx(fromCap);
  const tSec = new Map((toCap.sections || []).map((s) => [s.i, s]));
  const toCssBands = new Set(to.list.flatMap((g) => g.bands));
  const out = [];
  let png;
  for (const g of from.list) {
    if (g.chrom.length < 2) continue;
    let span = 0;
    for (let i = 0; i < g.chrom.length; i++) for (let j = i + 1; j < g.chrom.length; j++) span = Math.max(span, hueDist(g.chrom[i].h, g.chrom[j].h));
    if (span < G_IMG().minHueSpan) continue;
    const mine = new Set(g.bands.map((id) => fIdx.get(id)).filter(isNum));
    const other = new Set();
    for (const p of pairs) {
      if (!p.A || !p.B) continue;
      const fm = (p[fromKey].members || [p[fromKey]]).map((m) => Number(String(m.i).split('-')[0]));
      if (fm.some((i) => mine.has(i))) for (const m of p[toKey].members || [p[toKey]]) other.add(Number(String(m.i).split('-')[0]));
    }
    const secs = [...other].map((i) => tSec.get(i)).filter((s) => s && isNum(s.y) && isNum(s.h));
    if (!secs.length || secs.some((s) => toCssBands.has(s.id))) continue;
    if (png === undefined) png = fullShot(toCap, toDir);
    if (!png) return out;
    const shares = colourShares(png, secs.map((s) => [s.y, s.y + s.h]), g.chrom.map((s) => s.c), G_IMG().sampleStep);
    if (shares && shares.every((v) => v >= G_IMG().minShare)) out.push({ ...g, image: true, bands: secs.map((s) => s.id) });
  }
  return out;
}
/**
 * Build CSS gradients standing in for reference art: a band the reference paints with a canvas, image,
 * video or SVG (bg.type, or sections[].media of those kinds, by its `frac` of the band), or whose pixels
 * are not its CSS colour (bg.sampled vs bg.color dE > artSampledDeltaE: something else paints it), has an
 * art allowance on the aligned build band(s) = that share of the build band's page area. Build gradient
 * area inside those bands is taken out of the build's tally up to the allowance (CSS gradients are the
 * documented stand-in for painted art); gradients left with < 0.1% of the page are dropped.
 */
const ART_KINDS = new Set(['canvas', 'image', 'img', 'video', 'svg', 'bg-image', 'iframe', 'composite']);
function artAllowance(ref, build, pairs) {
  const out = new Map();
  if (!pairs) return out;
  const ph = build?.meta?.pageHeight?.['1440'] || null;
  if (!ph) return out;
  const rSec = new Map((ref.sections || []).map((s) => [s.i, s])), bSec = new Map((build.sections || []).map((s) => [s.i, s]));
  const idx = (m) => Number(String(m.i).split('-')[0]);
  for (const p of pairs) {
    if (!p.A || !p.B) continue;
    let frac = 0;
    for (const m of p.A.members || [p.A]) {
      const s = rSec.get(idx(m)); if (!s) continue;
      const bg = s.bg || {}, md = s.media || {};
      if (ART_KINDS.has(bg.type)) frac = 1;
      if (bg.type === 'color' && bg.color && bg.sampled && (dE(bg.color, bg.sampled) ?? 0) > C.gradient.artSampledDeltaE) frac = 1;
      if (ART_KINDS.has(md.kind) && isNum(md.frac)) frac = Math.max(frac, Math.min(1, md.frac));
    }
    if (frac <= 0) continue;
    for (const m of p.B.members || [p.B]) { const s = bSec.get(idx(m)); if (s && s.id && isNum(s.h)) out.set(s.id, (out.get(s.id) || 0) + frac * (s.h / ph)); }
  }
  return out;
}
// match (optional): the other side's band gradients; a gradient the other side also has (sameGradient) is that
// gradient, not a stand-in for art, and is kept
function discountArt(sum, allow, match = null) {
  if (!allow.size) return 0;
  let cut = 0;
  const keep = [];
  for (const g of sum.list) {
    let take = 0;
    // gradient text and gradient buttons are element gradients, never a stand-in for band art
    if (g.el || (match && match.some((m) => sameGradient(g, m)))) { keep.push(g); continue; }
    const bands = (g.bands || []).filter((id) => allow.has(id));
    if (bands.length && (g.bands || []).length === bands.length) {
      const per = g.area / bands.length;
      for (const id of bands) { const t = Math.min(per, allow.get(id)); allow.set(id, allow.get(id) - t); take += t; }
    }
    cut += take;
    const left = g.area - take;
    if (take > 0 && left < 0.001) continue;
    keep.push(take > 0 ? { ...g, area: left } : g);
  }
  if (cut > 0) {
    sum.list = keep; sum.n = keep.length; sum.area = keep.reduce((a, g) => a + g.area, 0);
    sum.where = new Set(keep.flatMap((g) => g.where)); sum.hues = keep.flatMap((g) => g.hues); sum.art = (sum.art || 0) + cut;
  }
  return cut;
}
function addImages(sum, list) {
  for (const g of list) { sum.n++; sum.images++; sum.area += g.area; for (const w of g.where) sum.where.add(w); sum.hues.push(...g.hues); }
}

function paletteEntries(cap) {
  return (cap.colors?.palette || []).filter((p) => p && p.hex).map((p) => {
    const l = lch(p.hex);
    const chroma = l?.c ?? 0;
    return { hex: p.hex, share: p.share || 0, chroma, w: ((p.share || 0) + C.paletteShareFloor) * (1 + C.paletteLoudness * chroma), uses: p.uses || {} };
  });
}
function nearestDir(A, B) {
  let num = 0, den = 0, worst = null;
  for (const a of A) {
    let best = Infinity, bestHex = null;
    for (const b of B) { const d = dE(a.hex, b.hex); if (d != null && d < best) { best = d; bestHex = b.hex; } }
    if (!isFinite(best)) best = 0.3;
    num += a.w * best; den += a.w;
    const loss = a.w * best;
    if (!worst || loss > worst.loss) worst = { loss, hex: a.hex, share: a.share, uses: a.uses, near: bestHex, d: best };
  }
  return { d: den > 0 ? num / den : 0, worst };
}
const useWord = (u) => Object.entries(u || {}).filter(([, v]) => v > 0.01).sort((a, b) => b[1] - a[1]).map(([k]) => (k === 'bg' ? 'backgrounds' : k === 'graphic' ? 'graphics' : k)).join('/') || 'small details';

// Best assignment of build roles to reference roles inside a group (e.g. accent/accent2): naming which
// colour is "the" accent is fragile, the colours themselves are what matters. A swapped pair counts
// swapPenalty less. Returns {role: {b (build role name), d, s}}.
function groupAssign(rr, br, group) {
  const refRoles = group.filter((k) => rr[k]);
  const bRoles = group.filter((k) => br[k]);
  const perms = (arr) => (arr.length <= 1 ? [arr] : arr.flatMap((x, i) => perms([...arr.slice(0, i), ...arr.slice(i + 1)]).map((p) => [x, ...p])));
  const slots = [...bRoles, ...Array(Math.max(0, refRoles.length - bRoles.length)).fill(null)];
  let best = null;
  for (const p of perms(slots)) {
    const asg = {};
    let tot = 0;
    refRoles.forEach((k, i) => {
      const bk = p[i];
      const d = bk ? dE(rr[k], br[bk]) : null;
      const sc = d == null ? 0 : lin(d, C.roleDeltaE) * (bk === k ? 1 : 1 - C.swapPenalty);
      asg[k] = { b: bk, d, s: sc };
      tot += sc * (C.roleWeights[k] || 1);
    });
    if (!best || tot > best.tot + 1e-9) best = { tot, asg };
  }
  return best ? best.asg : {};
}

const SECONDARY = { surface: 'bg', border: 'border', accent2: 'any' };

/**
 * Logo / brand-mark colours of a capture: never a reference requirement (accent, accent2, minor colours).
 * Captures leave brand marks out of roles and minor colours upstream (page-analyze) and may list them in
 * colors.brandMarks; for captures without that list, a minor colour seen on a single svg element (icon or
 * graphic use only) in the nav, footer or logo-row band is taken as a logo colour. Returns hex strings.
 */
export function brandColours(cap) {
  const out = (cap?.colors?.brandMarks || []).map((b) => b.hex).filter(Boolean);
  const roleOf = new Map((cap?.sections || []).map((s) => [s.id, s.role]));
  for (const m of cap?.colors?.minor || []) {
    const uses = m.uses || [];
    if ((m.n || 0) <= 1 && uses.length && uses.every((u) => u === 'icon' || u === 'graphic') && /^(nav|footer|logos)$/.test(roleOf.get(m.band) || '')) out.push(m.hex);
  }
  return [...new Set(out)];
}

export function scoreColor(ref, build, { refDir = null, buildDir = null, pairs = null } = {}) {
  const area = new Area('color', 20);
  const br = build.colors?.roles || {};
  // reference accents that are a brand-mark colour with no painted use (background, text or border) in its
  // palette are the logo, not the accent: not scored
  const brandA = brandColours(ref);
  const isBrand = (hex) => !!hex && brandA.some((h) => (dE(h, hex) ?? 1) < 0.04);
  const painted = (cap, hex) => (cap.colors?.palette || []).some((p) => (dE(p.hex, hex) ?? 1) < 0.04 && ((p.uses?.bg || 0) + (p.uses?.text || 0) + (p.uses?.border || 0)) > 0);
  const rr = { ...(ref.colors?.roles || {}) };
  const brandDropped = [];
  for (const k of ['accent', 'accent2']) if (rr[k] && isBrand(rr[k]) && !painted(ref, rr[k])) { brandDropped.push(`${k} ${rr[k]}`); rr[k] = null; }
  if (brandDropped.length) area.notes.push(`reference ${brandDropped.join(', ')} is a logo colour (brand mark, no painted use): not scored`);
  const rw = ref.colors?.roleWhere || {}, bw = build.colors?.roleWhere || {};
  const grouped = {};
  for (const g of C.roleGroups) Object.assign(grouped, groupAssign(rr, br, g));
  // a reference role marked WEAK (split or thin evidence in the capture) weighs weakRoleFactor
  const weakR = ref.colors?.weak || {};
  for (const [role, w0] of Object.entries(C.roleWeights)) {
    const a = rr[role];
    const w = weakR[role] && a ? w0 * C.weakRoleFactor : w0;
    if (weakR[role] && a) area.notes.push(`reference ${role} ${a} is WEAK (${weakR[role]}): weighed x${C.weakRoleFactor}`);
    if (!a) { area.add(`role:${role}`, w, null, { detail: 'not in reference' }); continue; }
    let bRole = role, b = br[role], d = b ? dE(a, b) : null, s = d == null ? 0 : lin(d, C.roleDeltaE);
    if (grouped[role]) { bRole = grouped[role].b; b = bRole ? br[bRole] : null; d = grouped[role].d; s = grouped[role].s; }
    // secondary roles (surface, border, accent2): the same colour used the same way anywhere in the build's
    // palette counts (90%), since which large background is called "surface" is fragile
    // accent2 ('any'): the build's minor colours (chromatic text/tag/icon colours, counted by element) are
    // part of that pool, since both sides often take accent2 from a tiny element of a different kind
    if (SECONDARY[role] && s < 0.9) {
      let best = null;
      const pool = [...(build.colors?.palette || []).map((p) => ({ hex: p.hex, uses: p.uses || {}, src: 'palette' })),
        ...(SECONDARY[role] === 'any' ? (build.colors?.minor || []).map((m) => ({ hex: m.hex, uses: null, src: `minor colour on ${(m.uses || []).join('/') || 'text'}${m.ex ? `, e.g. ${m.ex}` : ''}` })) : [])];
      for (const p of pool) { if (SECONDARY[role] !== 'any' && !(p.uses[SECONDARY[role]] > 0)) continue; const dd = dE(a, p.hex); if (dd != null && (!best || dd < best.d)) best = { d: dd, hex: p.hex, src: p.src }; }
      if (best && lin(best.d, C.roleDeltaE) * 0.9 > s) { s = lin(best.d, C.roleDeltaE) * 0.9; b = best.hex; d = best.d; bRole = best.src; }
    }
    const via = bRole && bRole !== role ? ` (build ${bRole})` : '';
    const where = rw[role] ? ` (reference uses it on ${rw[role]})` : '';
    area.add(`role:${role}`, w, s, { detail: `${a} vs ${b ?? 'n/a'}${via}${d != null ? ` dE ${r3(d)}` : ''}`,
      finding: { what: `${role} colour`, ref: a + where, build: b ? b + via + (bRole && bw[bRole] ? ` on ${bw[bRole]}` : '') : 'n/a', fix: b && d != null && d <= C.roleDeltaE[0] && bRole !== role
        ? `Reference ${role} ${a}${where} is in the build only as a ${bRole === 'palette' ? 'palette colour' : bRole}. Use it the way the reference does (${ROLE_USE[role]}).`
        : b
        ? `${role} colour is ${b}${via}${bRole && bw[bRole] ? ` (e.g. ${bw[bRole]})` : ''}; reference ${role} is ${a}${where} (OKLab dE ${r3(d)}). Set the ${role} token (${ROLE_USE[role]}) to ${a}.`
        : `No ${role} colour was detected in the build; reference uses ${a} for ${ROLE_USE[role]}${where}. Use ${a} there.` } });
  }

  const rt = ref.colors?.theme, bt = build.colors?.theme;
  if (rt) area.add('theme', C.weights.theme, rt === bt ? 1 : 0, { detail: `${rt} vs ${bt ?? 'n/a'}`,
    finding: { what: 'theme', ref: rt, build: bt ?? 'n/a', fix: `Page reads as ${bt ?? 'unknown'}; reference is a ${rt} theme. Switch the page background to ${rr.pageBg ?? (rt === 'dark' ? 'a near-black' : 'a near-white')} and text to ${rr.text ?? 'the contrasting colour'}.` } });
  else area.add('theme', C.weights.theme, null);

  const PA = paletteEntries(ref), PB = paletteEntries(build);
  if (PA.length) {
    if (!PB.length) area.add('palette', C.weights.palette, 0, { detail: 'build palette empty' });
    else {
      const ab = nearestDir(PA, PB), ba = nearestDir(PB, PA);
      const m = (ab.d + ba.d) / 2;
      const s = lin(m, C.paletteDist);
      const items = [];
      if (ab.worst && ab.worst.d > C.paletteDist[0]) items.push({ s: lin(ab.worst.d, C.roleDeltaE), w: ab.d, what: `reference colour ${ab.worst.hex} missing`, ref: `${ab.worst.hex} (${Math.round(ab.worst.share * 1000) / 10}% of area)`, build: `nearest ${ab.worst.near} (dE ${r3(ab.worst.d)})`,
        fix: `Reference colour ${ab.worst.hex} (${Math.round(ab.worst.share * 1000) / 10}% of painted area, used for ${useWord(ab.worst.uses)}) has no close match in the build (nearest ${ab.worst.near}, dE ${r3(ab.worst.d)}). Use ${ab.worst.hex} for ${useWord(ab.worst.uses)} as the reference does.` });
      if (ba.worst && ba.worst.d > C.paletteDist[0]) items.push({ s: lin(ba.worst.d, C.roleDeltaE), w: ba.d, what: `build colour ${ba.worst.hex} not in the reference palette`, ref: `nearest ${ba.worst.near} (dE ${r3(ba.worst.d)})`, build: `${ba.worst.hex} (${Math.round(ba.worst.share * 1000) / 10}% of area)`,
        fix: `Build colour ${ba.worst.hex} (${Math.round(ba.worst.share * 1000) / 10}% of painted area, ${useWord(ba.worst.uses)}) is not in the reference palette (nearest ${ba.worst.near}, dE ${r3(ba.worst.d)}). Replace it with ${ba.worst.near}.` });
      area.add('palette', C.weights.palette, s, { detail: `share-weighted nearest dE ref->build ${r3(ab.d)}, build->ref ${r3(ba.d)}`, items: combine(items).items });
    }
  } else area.add('palette', C.weights.palette, null);

  // minor colours: chromatic text/tag/icon colours that matter regardless of area (kicker tags,
  // category labels); each reference colour needs a close colour somewhere in the build
  // (colours that are the accent roles are scored as roles and left out here; tag/badge and icon colours
  // weigh double text-only colours, and the check weighs more when the reference uses coloured tags)
  const roleCols = [rr.accent, rr.accent2].filter(Boolean);
  // reference requirements: its first 8 minor colours used on text/tags/icons (graphic-only colours of large
  // SVGs are not required); the build's pool is all of its minor colours (SVG strokes/fills and small text
  // included) plus its palette
  // (logo / brand-mark colours are never required)
  // (a colour used on only a few small elements, below minorRequire, is not required: a status or sale colour)
  const MR = C.minorRequire;
  const used = (m) => (m.share != null && m.share >= MR.share) || (m.n || 0) >= ((m.uses || []).some((u) => u === 'tag' || u === 'icon') ? MR.tagN : MR.textN);
  const minorAll = (ref.colors?.minor || []).filter((m) => !((m.uses || []).length && (m.uses || []).every((u) => u === 'graphic')) && !isBrand(m.hex)).slice(0, 8)
    .filter((m) => !roleCols.some((h) => (dE(h, m.hex) ?? 1) < 0.04));
  const ma = minorAll.filter(used);
  if (ma.length < minorAll.length) area.notes.push(`minor colours on a few small elements not required: ${minorAll.filter((m) => !used(m)).map((m) => `${m.hex} x${m.n}`).join(', ')}`);
  if (ma.length) {
    const pool = [...(build.colors?.minor || []).map((m) => m.hex), ...(build.colors?.palette || []).map((p) => p.hex)];
    const items = ma.map((m) => {
      let best = Infinity, near = null;
      for (const h of pool) { const d = dE(m.hex, h); if (d != null && d < best) { best = d; near = h; } }
      const sc = isFinite(best) ? lin(best, C.minorDeltaE) : 0;
      return { s: sc, w: Math.sqrt(m.n || 1) * ((m.uses || []).some((u) => u === 'tag' || u === 'icon') ? 1 : 0.5), what: `minor colour ${m.hex}`, ref: `${m.hex} on ${(m.uses || []).join('/')} (${m.n} elements, e.g. ${m.ex}${m.band ? ` in band ${m.band}` : ''})`, build: near ? `nearest ${near} (dE ${r3(best)})` : 'none',
        fix: `Reference uses ${m.hex} on ${(m.uses || ['text']).join('/')} (${m.n} elements, e.g. ${m.ex}); the build has no close colour (nearest ${near ?? 'none'}${near ? `, dE ${r3(best)}` : ''}). Use ${m.hex} for those ${(m.uses || ['text']).includes('tag') ? 'tags/badges' : 'labels'}.` };
    });
    const c = combine(items);
    const wAll = items.reduce((x, it) => x + it.w, 0), wTag = items.filter((it, i) => (ma[i].uses || []).some((u) => u === 'tag' || u === 'icon')).reduce((x, it) => x + it.w, 0);
    area.add('minor', C.weights.minor * (0.5 + 0.5 * (wAll ? wTag / wAll : 0)), c.s, { detail: `${ma.length} reference minor colours: ${ma.map((m) => m.hex).join(' ')}`, items: c.items });
  } else area.add('minor', C.weights.minor, null, { detail: 'no reference minor colours' });

  // gradients
  if (ref.colors && Array.isArray(ref.colors.gradients)) {
    const G = C.gradient.parts;
    const ga = gradSummary(ref), gb = gradSummary(build);
    // a gradient one side draws in CSS and the other ships as an image counts on both sides when the
    // image side's pixels in the aligned band show every chromatic stop colour
    const refImg = imageGradients(build, gb, ref, refDir, ga, pairs, 'B');
    const buildImg = imageGradients(ref, ga, build, buildDir, gb, pairs, 'A');
    // build CSS gradients over bands the reference paints with art (canvas, image, video) are its stand-in
    // (the same rule on the reference's own gradients over its own art bands, so a page compared with itself
    // scores the same on both sides)
    // (a gradient both sides draw, matched by hue, is that gradient and never discounted on either side)
    const gaAll = ga.list.slice(), gbAll = gb.list.slice();
    discountArt(gb, artAllowance(ref, build, pairs), gaAll);
    discountArt(ga, artAllowance(ref, ref, (ref.sections || []).map((x) => ({ A: { i: x.i }, B: { i: x.i } }))), gbAll);
    addImages(ga, refImg); addImages(gb, buildImg);
    const p = presence(ga.n > 0, gb.n > 0);
    let s = p.s;
    if (p.kind === 'both') {
      const sa = lin(Math.abs(Math.log((gb.area + 0.01) / (ga.area + 0.01))), C.gradient.areaLog);
      const inter = [...ga.where].filter((x) => gb.where.has(x)).length, uni = new Set([...ga.where, ...gb.where]).size;
      const sw = uni ? inter / uni : 1;
      let sh = 1;
      if (ga.hues.length && gb.hues.length) {
        const nd = (X, Y) => X.reduce((acc, h) => acc + Math.min(...Y.map((k) => hueDist(h, k))), 0) / X.length;
        sh = lin((nd(ga.hues, gb.hues) + nd(gb.hues, ga.hues)) / 2, C.gradient.hueDeg);
      } else if (ga.hues.length || gb.hues.length) sh = 0;
      s = G.presence + G.area * sa + G.where * sw + G.hue * sh;
    }
    const hueTxt = (g) => (g.hues.length ? `hues ${[...new Set(g.hues.map((h) => Math.round(h / 10) * 10))].slice(0, 5).join('/')}deg` : 'neutral');
    const artTxt = (g) => (g.art ? `; ${Math.round(g.art * 1000) / 10}% of the page in gradients over bands the reference paints with a canvas/image not counted` : '');
    const leftTxt = (g) => { const l = g.left || {}; const parts = [l.faint ? `${l.faint} invisible fade(s) of the colour under them` : '', l.media ? `${l.media} overlay(s) on media` : '', l.small ? `${l.small} thin or small` : ''].filter(Boolean); return parts.length ? `; not band gradients: ${parts.join(', ')}` : ''; };
    const desc = (g) => (g.n ? `${g.n} visible${g.images ? ` (${g.images} drawn as an image, matched by its stop colours in the aligned band's pixels)` : ''} (${Math.round(g.area * 1000) / 10}% area, on ${[...g.where].join('/') || '?'}, ${hueTxt(g)}${artTxt(g)}${leftTxt(g)})` : `none counted${artTxt(g)}${leftTxt(g)}`);
    let fix;
    if (p.kind === 'missing') fix = `Reference uses ${desc(ga)} band gradients; the build has ${gb.art || (gb.left && (gb.left.faint + gb.left.media + gb.left.small)) ? `gradients but none that count as band gradients (${desc(gb)})` : 'none'}. Add gradients on ${[...ga.where].join('/') || 'the same elements'} (${hueTxt(ga)}).`;
    else if (p.kind === 'extra') fix = `Build uses ${desc(gb)} band gradients; the reference has none counted (${desc(ga)}). Replace them with flat colours.`;
    else fix = `Gradients differ: build ${desc(gb)}; reference ${desc(ga)}. Match where they are used and their hues.`;
    area.add('gradients', C.weights.gradients, s, { absent: p.absent, detail: `ref ${desc(ga)}; build ${desc(gb)}`, finding: { what: 'gradient usage', ref: desc(ga), build: desc(gb), fix } });
  } else area.add('gradients', C.weights.gradients, null);
  return { area };
}
