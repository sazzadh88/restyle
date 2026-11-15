#!/usr/bin/env node
/**
 * type-scale.mjs - design-spec.json -> CSS custom properties and role classes for the type scale.
 *
 * Usage:
 *   node type-scale.mjs <design-spec.json> [--out <file.css>]
 * Without --out the CSS goes to stdout and the JSON summary line to stderr
 * (`node type-scale.mjs spec.json > type-scale.css`). With --out the CSS is written to the file
 * (UTF-8) and the summary line goes to stdout. Exits non-zero with a message on failure.
 *
 * Reads:
 *   tokens.type["390"|"768"|"1440"][role] = {px, weight, lh, ls, tt, font, style?}
 *   tokens.fonts[] = {slot, use, source, weights, ls?, axes?}  (font family slot -> var(--font-<slot>))
 *     axes: {"wdth": 87.5, "FLAR": 100, "opsz": 60 | "auto" | "8..60"}. Fixed values become
 *     --fvs-font-<slot> (font-variation-settings) and --fvs-<role>; a fixed opsz sets
 *     font-optical-sizing: none, opsz "auto" or a range gets auto (--fos-*). opsz is requested only when
 *     axes.opsz is given (fontmatch candidate opsz "auto"); otherwise the default instance is drawn.
 *     Slots without axes emit no variation CSS. Every source:'google' family goes into one css2 URL
 *     (summary `fontsUrl`, and a comment on the first CSS line), with its weights and axes: an axis
 *     the spec fixes (wdth 108) is loaded as the family's whole axis range (lib/google-fonts.json, so
 *     the fixed value comes from font-variation-settings and other widths stay possible), and italic
 *     is requested (ital tuples) when `weights` names it ("ital 900", "400;ital 700") or a role on the
 *     slot has style italic/oblique; ital,lowercase axes,wght,uppercase axes order, tuples sorted.
 *   tokens.typeStep[] (optional)                    roles that must step instead of scaling fluidly
 *                                                   (or band<i> for one band heading)
 *   responsive.breakpoints = {tablet, desktop}      min-width breakpoints, default 768 / 1024;
 *                                                   must satisfy 390 < tablet <= 768 < desktop <= 1440
 *   bands[] = {i, role, headPx{vp}, headRole?}      per-band main heading sizes
 *
 * Emits, mobile first (base = the 390 layout, min-width tablet = the 768 layout, min-width desktop
 * = the 1440 layout):
 *   --fs-<role> (size), --lh-<role>, --ls-<role>, --fw-<role>, --ff-<role>, --tt-<role>, --fst-<role>
 *   --fs-band<i> for bands whose largest text is a real heading (not nav, footer, logo rows,
 *   announcement bars, or text smaller than 1.2 x body; a headRole naming a tokens.type role always
 *   counts, a headRole figure/quote/wordmark/label/stat never does)
 *   .t-<role> classes that apply those variables.
 * Sizes hit the spec's px exactly at 390, 768 and 1440. Between measured widths a size scales
 * linearly (clamp) unless the segment must step: the role changes font slot, text-transform or
 * style between the two widths, the size shrinks as the screen grows, or the role is listed in
 * tokens.typeStep. A role missing at a viewport carries the whole entry (size, weight, line-height,
 * tracking, case, font) of the nearest measured viewport; the summary lists every carried value.
 * A band heading (--fs-band<i>) follows the same rule through the heading role it is set in: the role
 * with the same px at 390, 768 and 1440, else the nearest heading role by size (display, h1-h4). The
 * band steps in a segment where that role steps (or is in typeStep), where its own size shrinks, or
 * when typeStep lists band<i>; otherwise it scales like the role. The summary's `stepped` lists both.
 * Band headPx are reference px; a role's px already carries its fontmatch size factor
 * (tokens.fonts[slot].match[role].sizeAdjust, font-substitutes §procedure 6), so roles are compared with
 * the band in reference px (px / factor) and the band heading gets its role's factor too (an exact match
 * takes the role's px, and so does a band at the followed role's reference px at one viewport). A role
 * without its own fontmatch entry carries the factor of the nearest matched role of its slot. headRole may
 * name a tokens.type role (h4, lead, cta = a CTA headline that is no h1-h3 tier): the band follows that
 * role. A heading band whose headPx is > 15% from every heading role (display, h1-h4, cta) at some
 * viewport, with no headRole or headRole "heading", is warned about on stderr (and in `warnings`): it is
 * sized from its own headPx (fine for a size of its own); naming its role clears the warning, a tier
 * between two heading roles gets a tokens.type role of its own (any name, e.g. "h1b") named in headRole,
 * and figure/quote/wordmark/label/stat skips the band (no --fs-band<i>). A band set in a named role whose
 * headPx differs from that role's px is noted in `skipped` with the viewports where it differs.
 * A band (or role) whose 768-1440 segment is fluid has no desktop-block value: the tablet block's clamp()
 * reaches the 1440 size at 1440.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalogue, normFamily } from './lib/font-catalogue.mjs';

const VPS = [390, 768, 1440];
const NEAREST = { 390: [768, 1440], 768: [390, 1440], 1440: [768, 390] };
const NOT_HEADING_BANDS = /nav|footer|announce|logo|ticker|legal|cookie/i;
const NOT_HEADING_HEAD = /^(figure|quote|wordmark|label|stat|price|mark)$/i;

function fail(msg) {
  process.stderr.write(`type-scale: ${msg}\n`);
  process.exit(1);
}

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const outFile = outIdx >= 0 ? args[outIdx + 1] : null;
if (outIdx >= 0 && !outFile) fail('--out needs a file path');
const specPath = args.find((a, i) => !a.startsWith('--') && (outIdx < 0 || i !== outIdx + 1));
if (!specPath) fail('usage: node type-scale.mjs <design-spec.json> [--out <file.css>]');

let spec;
try { spec = JSON.parse(fs.readFileSync(specPath, 'utf8')); } catch (e) { fail(`cannot read ${specPath}: ${e.message}`); }
const T = spec?.tokens?.type;
if (!T || typeof T !== 'object') fail('spec has no tokens.type');

const bp = { tablet: 768, desktop: 1024, ...(spec.responsive?.breakpoints || {}) };
bp.tablet = Number(bp.tablet); bp.desktop = Number(bp.desktop);
if (!(bp.tablet > 390 && bp.tablet <= 768 && bp.desktop > 768 && bp.desktop <= 1440)) {
  fail(`responsive.breakpoints ${JSON.stringify(spec.responsive?.breakpoints)} must satisfy 390 < tablet <= 768 < desktop <= 1440 so that 390, 768 and 1440 land in three different ranges`);
}

const warnings = [];
const carried = [];
const stepped = [];
const fonts = Object.fromEntries((spec.tokens.fonts || []).filter((f) => f && f.slot).map((f) => [f.slot, f]));
const forceStep = new Set(spec.tokens.typeStep || []);

const r3 = (n) => Math.round(n * 1000) / 1000;
const r4 = (n) => Math.round(n * 10000) / 10000;
const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

// Optical-size ranges of Google families that have an opsz axis (font-substitutes §axes), used when the
// slot's axes.opsz asks for automatic optical size ("auto") or fixes a value. Without axes.opsz no opsz
// is requested and the browser draws the family's default (text) instance at every size.
const OPSZ = {
  'Inter': '14..32', 'DM Sans': '9..40', 'Source Serif 4': '8..60', 'Newsreader': '6..72',
  'Fraunces': '9..144', 'Bodoni Moda': '6..96', 'Bricolage Grotesque': '12..96', 'Big Shoulders': '10..72',
  'Nunito Sans': '6..12', 'Literata': '7..72', 'Playfair': '5..1200',
};
const RANGE = /^\s*(-?\d+(?:\.\d+)?)\s*\.\.\s*(-?\d+(?:\.\d+)?)\s*$/;
// Bundled Google Fonts list (axes with min/max, italic availability), used for the css2 URL only.
const CATALOGUE = (() => {
  try {
    const f = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lib', 'google-fonts.json');
    return new Map(JSON.parse(fs.readFileSync(f, 'utf8')).families.map((e) => [e.family.toLowerCase(), e]));
  } catch { return new Map(); }
})();

// Axis settings of every slot that declares non-empty tokens.fonts[].axes:
//   fvs = font-variation-settings for the fixed values ("wdth" 87.5, "FLAR" 100), or null
//   fos = font-optical-sizing: 'none' when opsz is fixed, 'auto' when the family has an opsz axis
//         (OPSZ table, or axes.opsz given as "auto" / a range), else null
// Slots with no axes get no entry, so their CSS is unchanged.
const slotAxes = {};
for (const f of Object.values(fonts)) {
  const ax = f.axes && typeof f.axes === 'object' ? f.axes : {};
  const keys = Object.keys(ax).filter((k) => /^[A-Za-z]{4}$/.test(k) && ax[k] != null && ax[k] !== '');
  if (!keys.length) continue;
  const fixed = [];
  let fos = null;
  for (const k of keys) {
    const v = ax[k];
    if (num(v) != null) {
      let val = num(v);
      const known = k === 'opsz' ? OPSZ[f.use] : null;
      const m = known && known.match(RANGE);
      if (m && (val < +m[1] || val > +m[2])) {
        const c = Math.min(Math.max(val, +m[1]), +m[2]);
        warnings.push(`slot "${f.slot}" fixes opsz ${val} outside ${f.use}'s range ${known}: clamped to ${c}`);
        val = c;
      }
      fixed.push(`"${k}" ${val}`);
      if (k === 'opsz') fos = 'none';
    } else if (k === 'opsz' && (v === 'auto' || RANGE.test(String(v)))) {
      fos = 'auto';
    } else if (!RANGE.test(String(v))) {
      warnings.push(`slot "${f.slot}" axis ${k} has value ${JSON.stringify(v)}: expected a number or "min..max"`);
    }
  }
  // (optical size is never added on its own: a family with an opsz axis gets it only when axes.opsz asks,
  // i.e. when fontmatch said the reference draws the optical-size cut, candidate opsz "auto")
  slotAxes[f.slot] = { fvs: fixed.length ? fixed.join(', ') : null, fos };
}

// Google Fonts css2 URL for every source:'google' family: weights from `weights`, axes from `axes`,
// italic from `weights` / the roles' style. An axis the spec fixes is loaded as the family's whole range
// (catalogue; OPSZ table for opsz) and set exactly by --fvs-*; a range is requested as given; a single
// value only for a family whose range is unknown. opsz range from OPSZ when not fixed. Tags: ital, then
// lowercase-alphabetical, then uppercase-alphabetical; tuples sorted numerically, as the css2 API requires.
// weights -> {up, it, named}: up / it = {range: "300..700"} | {list: [400, 700]} | null for upright and
// italic; tokens split on ";" or ","; a token naming ital/italic is an italic weight ("ital 900").
function weightDecl(w) {
  if (w == null || w === '') return null;
  const toks = (Array.isArray(w) ? w.map(String) : String(w).split(/[;,]/)).map((t) => t.trim()).filter(Boolean);
  const parse = (ts) => {
    const decl = ts.join(';');
    const range = decl.match(/(\d{3,4})\s*\.\.\s*(\d{3,4})/);
    if (range) return { range: `${range[1]}..${range[2]}` };
    const list = [...new Set((decl.match(/\d{3,4}/g) || []).map(Number))].sort((a, b) => a - b);
    return list.length ? { list } : null;
  };
  const itT = toks.filter((t) => /ital/i.test(t)), upT = toks.filter((t) => !/ital/i.test(t));
  const up = parse(upT), it = parse(itT) || (itT.length ? up : null);
  return up || it ? { up, it, named: itT.length > 0 } : null;
}
// upright / italic use of each slot by the roles (tokens.type[vp][role].style)
const slotStyle = {};
for (const vp of VPS) {
  for (const e of Object.values(T[String(vp)] || {})) {
    if (!e || !e.font) continue;
    const s = slotStyle[e.font] || (slotStyle[e.font] = { up: false, it: false });
    if (/italic|oblique/i.test(e.style || '')) s.it = true; else s.up = true;
  }
}
function familyParam(f) {
  const name = String(f.use).trim().replace(/\s+/g, '+');
  const cat = CATALOGUE.get(String(f.use).trim().toLowerCase());
  const catRange = (k) => { const a = cat && (cat.axes || []).find((x) => x.tag === k); return a ? `${a.min}..${a.max}` : null; };
  const axes = {};
  const ax = f.axes && typeof f.axes === 'object' ? f.axes : {};
  for (const [k, v] of Object.entries(ax)) {
    if (!/^[A-Za-z]{4}$/.test(k) || k === 'wght' || v == null || v === '') continue;
    const known = (k === 'opsz' && OPSZ[f.use]) || catRange(k);
    if (num(v) != null) {
      const val = num(v), m = known && known.match(RANGE);
      if (m) {
        axes[k] = known;
        if (k !== 'opsz' && (val < +m[1] || val > +m[2])) warnings.push(`slot "${f.slot}" fixes ${k} ${val} outside ${f.use}'s range ${known}: the font clamps it`);
      } else {
        axes[k] = String(val);
        warnings.push(`slot "${f.slot}" fixes ${k} ${val} but the ${k} range of ${f.use} is not in the bundled font list: the URL pins that single value (give axes.${k} as "min..max" to load the range)`);
      }
    } else if (RANGE.test(String(v))) axes[k] = String(v).replace(/\s+/g, '');
    else if (k === 'opsz' && v === 'auto') {
      if (known) axes.opsz = known;
      else warnings.push(`slot "${f.slot}" asks for automatic opsz but the opsz range of ${f.use} is unknown: give axes.opsz as "min..max"`);
    }
  }
  const wd = weightDecl(f.weights);
  const use = slotStyle[f.slot] || { up: false, it: false };
  let wantIt = !!((wd && wd.named) || f.italic === true || use.it);
  if (wantIt && cat && !cat.italic) {
    warnings.push(`slot "${f.slot}" asks for italic but ${f.use} has no italic on Google Fonts: not requested (the browser slants the upright)`);
    wantIt = false;
  }
  const itW = wantIt ? (wd && (wd.it || wd.up)) || null : null;
  const upW = (wd && wd.up) || (use.up || !wantIt ? (wd && wd.it) || null : null);
  const wantUp = !wantIt || !!(wd && wd.up) || use.up;
  const order = (a, b) => {
    const la = a === a.toLowerCase(), lb = b === b.toLowerCase();
    if (la !== lb) return la ? -1 : 1;
    return a < b ? -1 : a > b ? 1 : 0;
  };
  const hasW = !!((wantUp && upW) || (wantIt && itW));
  const tags = [...(wantIt ? ['ital'] : []), ...Object.keys(axes), ...(hasW ? ['wght'] : [])].sort(order);
  if (!tags.length) return `family=${name}`;
  const tuples = [];
  for (const [on, ital, ws] of [[wantUp, '0', upW], [wantIt, '1', itW]]) {
    if (!on) continue;
    const wl = !hasW ? [null] : !ws ? [null] : ws.range ? [ws.range] : ws.list.map(String);
    for (const w of wl) {
      if (hasW && w == null) continue;
      tuples.push(tags.map((t) => (t === 'ital' ? ital : t === 'wght' ? w : axes[t])).join(','));
    }
  }
  const key = (s) => s.split(',').map((x) => parseFloat(x));
  const uniq = [...new Set(tuples)].sort((a, b) => { const p = key(a), q = key(b); for (let i = 0; i < p.length; i++) if (p[i] !== q[i]) return p[i] - q[i]; return 0; });
  return `family=${name}:${tags.join(',')}@${uniq.join(';')}`;
}
const googleFonts = [];
const seenFamily = new Set();
// every source:'google' family must be in the public Google Fonts catalogue (lib/font-catalogue.mjs, cached
// next to design-spec.json): css2 also serves proprietary brand faces, so its status is no test. Not in the
// catalogue -> exit 1 naming it; catalogue unreachable and the family outside the bundled subset -> warning
const googleSlots = (spec.tokens.fonts || []).filter((f) => f && f.source === 'google' && f.use);
const fontCatalogue = googleSlots.length ? await loadCatalogue(path.dirname(path.resolve(specPath))) : null;
if (fontCatalogue) {
  const bad = [...new Set(googleSlots.filter((f) => fontCatalogue.verdict(f.use) === false).map((f) => f.use))];
  if (bad.length) fail(`${bad.map((b) => `"${b}"`).join(', ')} ${bad.length > 1 ? 'are' : 'is'} not in the public Google Fonts catalogue (${fontCatalogue.source}): never use ${bad.length > 1 ? 'them' : 'it'}, even if fonts.googleapis.com serves ${bad.length > 1 ? 'them' : 'it'}. Pick a catalogue family with inspect.mjs fontmatch (font-substitutes §procedure) and set tokens.fonts[].use to it`);
  for (const f of googleSlots) if (fontCatalogue.verdict(f.use) == null) warnings.push(`slot "${f.slot}": "${f.use}" could not be checked against the public Google Fonts catalogue (${fontCatalogue.source}); run type-scale again online before shipping`);
  for (const f of googleSlots) { const m = fontCatalogue.matchOf(f.use); if (m && normFamily(m) !== normFamily(f.use)) warnings.push(`slot "${f.slot}": set use to the catalogue name "${m}" (not "${f.use}"), or the css2 URL may not resolve`); }
}
for (const f of googleSlots) {
  if (seenFamily.has(f.use)) continue;
  seenFamily.add(f.use);
  googleFonts.push(familyParam(f));
}
const fontsUrl = googleFonts.length ? `https://fonts.googleapis.com/css2?${googleFonts.join('&')}&display=swap` : null;

// Weight coverage of a font slot: "300..700", "400;700", "400", [400, 700], "wght 100..900".
function weightCovered(slot, w) {
  const f = fonts[slot];
  if (!f || w == null || f.weights == null) return true;
  const decl = Array.isArray(f.weights) ? f.weights.join(';') : String(f.weights);
  const range = decl.match(/(\d{3})\s*\.\.\s*(\d{3,4})/);
  if (range) return w >= +range[1] && w <= +range[2];
  const list = (decl.match(/\d{3,4}/g) || []).map(Number);
  return list.length === 0 || list.includes(Number(w));
}

function entryAt(map, vp) {
  const own = map?.[String(vp)];
  if (own && num(own.px) != null) return { e: own, from: vp };
  for (const n of NEAREST[vp]) {
    const o = map?.[String(n)];
    if (o && num(o.px) != null) return { e: o, from: n };
  }
  return null;
}

// Straight line through (w1, s1) and (w2, s2), clamped to the two sizes.
function fluid(w1, s1, w2, s2) {
  if (s1 === s2) return `${s1}px`;
  const m = (s2 - s1) / (w2 - w1);
  const k = s1 - m * w1;
  return `clamp(${Math.min(s1, s2)}px, ${r3(k)}px + ${r4(m * 100)}vw, ${Math.max(s1, s2)}px)`;
}

// Decide how the size moves between two measured widths.
function segMode(name, lo, hi, step) {
  if (lo.px === hi.px) return 'const';
  if (step) return 'step';
  if ((lo.font || null) !== (hi.font || null)) return 'step';
  if ((lo.tt || null) !== (hi.tt || null)) return 'step';
  if ((lo.style || 'normal') !== (hi.style || 'normal')) return 'step';
  if (hi.px < lo.px) return 'step';
  return 'fluid';
}

const blocks = { base: [], tablet: [], desktop: [] };
const classes = [];
const roles = [...new Set(VPS.flatMap((v) => Object.keys(T[String(v)] || {})))];
let bodyPx = {};
const roleInfo = {};   // role -> {px{vp}, step1, step2}: sizes as emitted and whether each segment steps

for (const role of roles) {
  const per = {};
  for (const vp of VPS) {
    const h = entryAt(Object.fromEntries(VPS.map((v) => [String(v), T[String(v)]?.[role]])), vp);
    if (!h) continue;
    per[vp] = { ...h.e, px: num(h.e.px), weight: num(h.e.weight) };
    if (h.from !== vp) carried.push(`${role}@${vp} <- ${h.from}`);
  }
  if (!per[390]) { warnings.push(`role ${role} has no px at any viewport: skipped`); continue; }
  if (role === 'body') bodyPx = { 390: per[390].px, 768: per[768].px, 1440: per[1440].px };

  const step = forceStep.has(role);
  const m1 = segMode(role, per[390], per[768], step);
  const m2 = segMode(role, per[768], per[1440], step);
  if (m1 === 'step') stepped.push(`${role} 390-768`);
  if (m2 === 'step') stepped.push(`${role} 768-1440`);
  roleInfo[role] = { px: { 390: per[390].px, 768: per[768].px, 1440: per[1440].px }, step1: m1 === 'step' || step, step2: m2 === 'step' || step };

  // size: base covers < tablet, tablet block covers >= tablet (and keeps applying above desktop
  // unless the desktop block overrides it).
  const seg1End = Math.min(768, bp.tablet);
  const fsBase = m1 === 'fluid' ? fluid(390, per[390].px, seg1End, per[768].px) : `${per[390].px}px`;
  const fsTab = m2 === 'fluid' ? fluid(768, per[768].px, 1440, per[1440].px) : `${per[768].px}px`;
  const fsDesk = m2 === 'step' ? `${per[1440].px}px` : null;

  const anyStyle = VPS.some((v) => per[v]?.style && per[v].style !== 'normal');
  const anyAxes = VPS.some((v) => per[v]?.font && slotAxes[per[v].font]);
  const props = (e, list) => {
    if (anyAxes) {
      const sa = slotAxes[e.font];
      list.push(`--fvs-${role}: ${sa ? `var(--fvs-font-${e.font})` : 'normal'}`);
      list.push(`--fos-${role}: ${sa ? `var(--fos-font-${e.font})` : 'auto'}`);
    }
    const f = fonts[e.font];
    const ls = (num(e.ls) ?? 0) + (num(f?.ls) ?? 0);
    list.push(`--lh-${role}: ${num(e.lh) ?? 'normal'}`);
    list.push(`--ls-${role}: ${r4(ls)}em`);
    if (e.weight != null) list.push(`--fw-${role}: ${e.weight}`);
    if (e.font) list.push(`--ff-${role}: var(--font-${e.font})`);
    list.push(`--tt-${role}: ${e.tt || 'none'}`);
    if (anyStyle) list.push(`--fst-${role}: ${e.style || 'normal'}`);
    if (e.font && e.weight != null && !weightCovered(e.font, e.weight)) {
      warnings.push(`role ${role} uses weight ${e.weight} but tokens.fonts slot "${e.font}" loads ${JSON.stringify(fonts[e.font].weights)}`);
    }
    if (e.font && !fonts[e.font]) warnings.push(`role ${role} uses font slot "${e.font}" that tokens.fonts does not define`);
  };

  blocks.base.push(`--fs-${role}: ${fsBase}`); props(per[390], blocks.base);
  blocks.tablet.push(`--fs-${role}: ${fsTab}`); props(per[768], blocks.tablet);
  if (fsDesk) blocks.desktop.push(`--fs-${role}: ${fsDesk}`);
  props(per[1440], blocks.desktop);

  const hasFont = VPS.some((v) => per[v]?.font);
  classes.push(`.t-${role} { ${hasFont ? `font-family: var(--ff-${role}); ` : ''}font-size: var(--fs-${role}); line-height: var(--lh-${role}); letter-spacing: var(--ls-${role}); font-weight: var(--fw-${role}); text-transform: var(--tt-${role});${anyStyle ? ` font-style: var(--fst-${role});` : ''}${anyAxes ? ` font-variation-settings: var(--fvs-${role}); font-optical-sizing: var(--fos-${role});` : ''} }`);
}

// Fontmatch size factor a role's px carries: tokens.fonts[slot].match[role].sizeAdjust (as applied) for the
// role's slot at 1440 (else 768, 390). A role without its own fontmatch entry (no sample run for it, e.g.
// h2 when display and h3 were matched) carries the factor of the nearest role by 1440 px in the same slot
// that has one (the family's factor, font-substitutes §procedure 6); 1 when the slot has none.
const ownFactor = (role) => {
  for (const vp of [1440, 768, 390]) {
    const e = T[String(vp)]?.[role];
    const sa = num(e && e.font ? fonts[e.font]?.match?.[role]?.sizeAdjust : null);
    if (sa != null && sa > 0.5 && sa < 2) return sa;
  }
  return null;
};
const slotOf = (role) => { for (const vp of [1440, 768, 390]) { const e = T[String(vp)]?.[role]; if (e && e.font) return e.font; } return null; };
const pxOf = (role) => { for (const vp of [1440, 768, 390]) { const p = num(T[String(vp)]?.[role]?.px); if (p != null) return p; } return null; };
const sizeFactor = (role) => {
  const own = ownFactor(role);
  if (own != null) return own;
  const slot = slotOf(role), p = pxOf(role);
  if (!slot || p == null) return 1;
  const near = roles.filter((r) => r !== role && slotOf(r) === slot && ownFactor(r) != null && pxOf(r) != null)
    .sort((a, c) => Math.abs(Math.log(pxOf(a) / p)) - Math.abs(Math.log(pxOf(c) / p)))[0];
  return near ? ownFactor(near) : 1;
};
// heading roles a band heading can follow; `cta` = the CTA band's headline when it is no h1-h3 tier
const HEAD_ROLES = ['display', 'h1', 'h2', 'h3', 'h4', 'cta'];
const r2 = (n) => Math.round(n * 100) / 100;

// Per-band main heading sizes.
const bandNotes = [];
let bandCount = 0;
for (const b of spec.bands || []) {
  if (!b || b.headPx == null) continue;
  const id = String(b.i ?? '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!id) continue;
  // a headRole naming a tokens.type role says the band has a real heading set in that role, whatever the
  // band's role (a logo-row band that ends in a CTA headline); a headRole of figure/quote/wordmark/label
  // says the band's largest text is not a heading (a decorative quote mark, a stat): no band size from it
  const namedRole = b.headRole && roleInfo[b.headRole] ? b.headRole : null;
  if (!namedRole && NOT_HEADING_BANDS.test(`${b.role || ''} ${b.refRole || ''}`)) { bandNotes.push(`band ${id} (${b.role}) skipped: not a heading band (name its heading's role in headRole to size it)`); continue; }
  if (!namedRole && NOT_HEADING_HEAD.test(String(b.headRole || ''))) { bandNotes.push(`band ${id} skipped: its largest text is a ${b.headRole}, not a heading (set the heading in a role class)`); continue; }
  const hp = {};
  for (const vp of VPS) {
    const own = num(b.headPx[String(vp)]);
    if (own != null) { hp[vp] = own; continue; }
    const n = NEAREST[vp].find((x) => num(b.headPx[String(x)]) != null);
    if (n != null) { hp[vp] = num(b.headPx[String(n)]); carried.push(`band${id}@${vp} <- ${n}`); }
  }
  if (hp[390] == null) continue;
  const body = bodyPx[1440] || 16;
  if (Math.max(hp[390], hp[768], hp[1440]) < 1.2 * body) { bandNotes.push(`band ${id} skipped: headPx ${hp[1440]} is not larger than body text`); continue; }
  // roles in reference px (role px / its size factor): an exact match is the same px at 390, 768 and 1440
  // (within rounding when the role carries a factor)
  const refPx = (r, v) => { const p = num(T[String(v)]?.[r]?.px); return p == null ? null : p / sizeFactor(r); };
  const match = roles.find((r) => VPS.every((v) => { const p = refPx(r, v); return p != null && (sizeFactor(r) === 1 ? p === hp[v] : Math.abs(p - hp[v]) <= 0.51); }));
  // the heading role this band heading is set in: the exact match, else the nearest heading role by size
  // (summed |log ratio| at 390/768/1440, in reference px); the band steps wherever that role steps
  const dist = (r) => VPS.reduce((s, v) => s + Math.abs(Math.log(hp[v] / (roleInfo[r].px[v] / sizeFactor(r)))), 0);
  const heads = HEAD_ROLES.filter((r) => roleInfo[r]);
  // headRole naming a tokens.type role (h4, lead, ...): the band heading is set in that role (confirmed by
  // the builder), so it follows it and is never warned about
  const named = b.headRole && roleInfo[b.headRole] ? b.headRole : null;
  const follow = (match && roleInfo[match] ? match : null) || named || heads.slice().sort((a, c) => dist(a) - dist(c))[0] || null;
  // a heading far from every heading tier (> 15% at some viewport) is probably not set in any role
  const f0 = (r) => (r ? sizeFactor(r) : 1);
  if (heads.length && !named && (!b.headRole || b.headRole === 'heading')) {
    const far = VPS.map((v) => { const n = heads.map((r) => ({ r, p: roleInfo[r].px[v] / sizeFactor(r) })).sort((a, c) => Math.abs(hp[v] / a.p - 1) - Math.abs(hp[v] / c.p - 1))[0]; return { v, n, d: Math.abs(hp[v] / n.p - 1) }; }).filter((x) => x.d > 0.15);
    if (far.length) {
      const w = `band ${id} heading ${far.map((x) => `${hp[x.v]}px@${x.v}`).join(', ')} is ${far.map((x) => `${Math.round(x.d * 100)}%`).join('/')} off the nearest heading role (${far.map((x) => `${x.n.r} ${r2(x.n.p)}px`).join(', ')}): --fs-band${id} uses its own headPx${f0(follow) !== 1 ? ` x ${follow}'s font factor ${f0(follow)}` : ''}, which is right if the band heading is a size of its own. To silence this, change the spec: a heading set in an existing role -> bands[${id}].headRole = that role (the band then takes the role's px); a tier between two heading roles -> add a role for it to tokens.type (its px per viewport, the nearest tier's font, weight, lh, ls) and name it in headRole (never borrow cta or another role of another size); not a heading -> headRole figure/quote/wordmark/label`;
      warnings.push(w);
      process.stderr.write(`type-scale: warning: ${w}\n`);
    }
  }
  // the band heading gets its role's size factor (reference px x factor); an exact match takes the role's px
  const f = follow ? sizeFactor(follow) : 1;
  const sz = {};
  // per viewport, a band heading at the reference px of the followed role (else of any heading role) takes
  // that role's px, factor included (a band at h2's size is exactly h2); other sizes are reference px x factor
  const same = (r, v) => { const p = refPx(r, v); return p != null && (sizeFactor(r) === 1 ? p === hp[v] : Math.abs(p - hp[v]) <= 0.51); };
  // a band whose headRole names a role is set in that role: its px at every viewport (the measured headPx
  // may be a decorative glyph, a quote mark or a numeral tile, larger than the heading)
  for (const v of VPS) {
    const at = follow && same(follow, v) ? follow : heads.find((r) => same(r, v));
    sz[v] = match && roleInfo[match] ? roleInfo[match].px[v] : named ? roleInfo[named].px[v] : at ? roleInfo[at].px[v] : f === 1 ? hp[v] : r2(hp[v] * f);
  }
  if (named && !match) {
    const off = VPS.filter((v) => Math.abs(hp[v] / (roleInfo[named].px[v] / sizeFactor(named)) - 1) > 0.15);
    if (off.length) bandNotes.push(`band ${id} is set in its headRole ${named}: --fs-band${id} = ${named}'s px at every viewport (as intended when the measured headPx is a decorative glyph, figure or quote mark); its headPx differs at ${off.map((v) => `${v} (${hp[v]}px vs ${named} ${r2(roleInfo[named].px[v] / sizeFactor(named))}px)`).join(', ')}. Only if the band heading really is that size there: give it a role of its own in tokens.type and name that in headRole`);
  }
  const lo = { px: sz[390] }, mid = { px: sz[768] }, hi = { px: sz[1440] };
  const own = forceStep.has(`band${id}`), fr = follow ? roleInfo[follow] : null;
  const m1 = segMode('band', lo, mid, own || !!(fr && fr.step1)), m2 = segMode('band', mid, hi, own || !!(fr && fr.step2));
  const as = own ? 'typeStep' : `as ${follow || 'own size'}`;
  if (m1 === 'step') stepped.push(`band${id} 390-768 (${hp[768] < hp[390] ? 'shrinks' : as})`);
  if (m2 === 'step') stepped.push(`band${id} 768-1440 (${hp[1440] < hp[768] ? 'shrinks' : as})`);
  const tag = `${match ? ` /* = ${match} */` : follow ? ` /* ${named ? 'set in' : 'follows'} ${follow}${f !== 1 ? `, x ${f}` : ''} */` : ''}${b.headRole && b.headRole !== 'heading' && !named ? ` /* largest text is a ${b.headRole} */` : ''}`;
  const seg1End = Math.min(768, bp.tablet);
  blocks.base.push(`--fs-band${id}: ${m1 === 'fluid' ? fluid(390, sz[390], seg1End, sz[768]) : `${sz[390]}px`}${tag}`);
  blocks.tablet.push(`--fs-band${id}: ${m2 === 'fluid' ? fluid(768, sz[768], 1440, sz[1440]) : `${sz[768]}px`}`);
  if (m2 === 'step') blocks.desktop.push(`--fs-band${id}: ${sz[1440]}px`);
  bandCount++;
}

const fmt = (list, ind) => list.map((x) => {
  const c = x.indexOf(' /*');
  return c > 0 ? `${ind}${x.slice(0, c)};${x.slice(c)}` : `${ind}${x};`;
}).join('\n');
// Slot-level axis variables, first in the base block: --fvs-font-<slot> / --fos-font-<slot>
// (named after --font-<slot>, so a role called like a slot cannot reference itself).
const slotVars = Object.entries(slotAxes).flatMap(([slot, a]) => [
  `--fvs-font-${slot}: ${a.fvs || 'normal'}`,
  `--fos-font-${slot}: ${a.fos || 'auto'}`,
]);
blocks.base.unshift(...slotVars);

const css = [
  ...(fontsUrl ? [`/* fonts: ${fontsUrl} */`] : []),
  `/* type scale generated by type-scale.mjs from ${specPath.replace(/\\/g, '/').split('/').slice(-2).join('/')} */`,
  `/* breakpoints: base = 390 layout, min-width ${bp.tablet}px = 768 layout, min-width ${bp.desktop}px = 1440 layout */`,
  `:root {\n${fmt(blocks.base, '  ')}\n}`,
  `@media (min-width: ${bp.tablet}px) {\n  :root {\n${fmt(blocks.tablet, '    ')}\n  }\n}`,
  `@media (min-width: ${bp.desktop}px) {\n  :root {\n${fmt(blocks.desktop, '    ')}\n  }\n}`,
  classes.join('\n'),
  '',
].join('\n');

const summary = { ok: true, roles: classes.length, bands: bandCount, breakpoints: bp, fontsUrl, ...(fontCatalogue ? { catalogue: fontCatalogue.source } : {}), axes: slotAxes, stepped, carried, warnings: [...new Set(warnings)], skipped: bandNotes };
if (outFile) {
  fs.writeFileSync(outFile, css, 'utf8');
  summary.out = outFile;
  process.stdout.write(`${JSON.stringify(summary)}\n`);
} else {
  process.stdout.write(css);
  process.stderr.write(`${JSON.stringify(summary)}\n`);
}
