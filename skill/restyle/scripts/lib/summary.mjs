#!/usr/bin/env node
/**
 * summary.mjs - capture.json -> summary.md, a compact Markdown digest a model can read instead of
 * the whole capture (target <= 250 lines). Every line names the capture.json path it came from.
 *
 * Library:
 *   import { buildSummary, writeSummary } from './lib/summary.mjs';
 *   buildSummary(capture) -> string (Markdown)
 *   writeSummary(outDir, capture) -> {file, lines}   writes <outDir>/summary.md (UTF-8)
 * CLI (testing):
 *   node lib/summary.mjs <capDir> [out.md]   reads <capDir>/capture.json, writes out.md
 *   (default <capDir>/summary.md) and prints one JSON line {file, lines}. Exits 1 on failure.
 *
 * Old captures lack newer fields (meta.overlays, type.samples, lhr/tags, text/rail edges,
 * bg.scrollTheme, motion.load.media, motion.scrollTint, ...): those lines are simply left out.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readPng } from './images.mjs';
import { settleNote } from './frames.mjs';
import { mediaNote, mediaRate, loadEntrance } from './frames.mjs';
import { sampleVerdict } from './fontmatch.mjs';
import { appearNote } from './frames.mjs';
import { pairLook } from './images.mjs';

const VPS = ['1440', '768', '390'];
const MAX_LINES = 250;

// ---------- small formatters ----------
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const r = (v, d = 0) => (isNum(v) ? String(Math.round(v * 10 ** d) / 10 ** d) : v == null ? '-' : String(v));
const pct = (v) => (isNum(v) ? `${Math.round(v * 1000) / 10}%` : '-');
const trunc = (s, n = 80) => {
  if (s == null) return '';
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const cell = (s) => String(s ?? '').replace(/\|/g, '/');
const isObj = (o) => o && typeof o === 'object' && !Array.isArray(o);
const nonEmpty = (o) => (Array.isArray(o) ? o.length > 0 : isObj(o) ? Object.keys(o).length > 0 : o != null && o !== '');
const get = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);

// Shorten a CSS easing: cubic-bezier(0.25, 0.46, 0.45, 0.94) -> cb(.25,.46,.45,.94)
const ease = (e) => (e == null ? '' : String(e).replace(/cubic-bezier\(([^)]*)\)/g, (_, a) => `cb(${a.split(',').map((x) => x.trim().replace(/^0\./, '.').replace(/^-0\./, '-.')).join(',')})`));

// Split a CSS list on top-level commas.
function splitTop(s) {
  const out = []; let depth = 0, cur = '';
  for (const ch of String(s)) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// "color 100ms ease, background 100ms ease" -> "color,background 100ms ease"
function transShort(t, n = 90) {
  if (!t) return '';
  const groups = new Map();
  for (const part of splitTop(t)) {
    const m = part.match(/^(\S+)\s+(.*)$/);
    if (!m) continue;
    const timing = ease(m[2]);
    if (!groups.has(timing)) groups.set(timing, []);
    groups.get(timing).push(m[1]);
  }
  return trunc([...groups].map(([tm, props]) => `${props.join(',')} ${tm}`).join('; '), n);
}

// Compact one-line rendering of an unknown value (depth-limited, no JSON dumps).
function compact(v, depth = 1, max = 140) {
  const one = (x, d) => {
    if (x == null) return '-';
    if (isNum(x)) return r(x, Math.abs(x) < 10 ? 2 : 0);
    if (typeof x === 'string') return trunc(x, 40);
    if (typeof x === 'boolean') return x ? 'yes' : 'no';
    if (Array.isArray(x)) {
      if (!x.length) return '[]';
      if (d <= 0) return `[${x.length}]`;
      return x.slice(0, 4).map((y) => one(y, d - 1)).join('/') + (x.length > 4 ? `/+${x.length - 4}` : '');
    }
    if (d <= 0) return '{…}';
    return Object.entries(x).filter(([, y]) => y != null && y !== false && !(Array.isArray(y) && !y.length))
      .map(([k, y]) => `${k}=${one(y, d - 1)}`).join(' ');
  };
  return trunc(one(v, depth), max);
}

const kv = (o, f = (x) => x) => (isObj(o) ? Object.entries(o).map(([k, v]) => `${k}:${f(v)}`).join(' ') : '-');
const box = (b) => (Array.isArray(b) ? b.map((x) => r(x)).join(',') : isObj(b) ? [b.x, b.y, b.w, b.h].map((x) => r(x)).join(',') : '');
// {opacity: 0, y: 24} -> "opacity 0, y 24"
const fromStr = (o) => (isObj(o) ? Object.entries(o).map(([k, v]) => `${k} ${r(v, 2)}`).join(', ') : o == null ? '-' : String(o));
// one side of a hover delta: a transform {tx, ty, s, r} -> "x -16 y 0" style, other objects compact
const hoverVal = (x, n = 28) => {
  if (isObj(x) && ('tx' in x || 'ty' in x || 's' in x || 'r' in x)) {
    const p = [];
    if (isNum(x.tx) && Math.abs(x.tx) >= 0.5) p.push(`x ${r(x.tx)}`);
    if (isNum(x.ty) && Math.abs(x.ty) >= 0.5) p.push(`y ${r(x.ty)}`);
    if (isNum(x.s) && Math.abs(x.s - 1) >= 0.005) p.push(`scale ${r(x.s, 3)}`);
    if (isNum(x.r) && Math.abs(x.r) >= 0.5) p.push(`rotate ${r(x.r)}deg`);
    return p.length ? p.join(' ') : 'none';
  }
  return isObj(x) || Array.isArray(x) ? compact(x, 1, n) : trunc(x, n);
};
// what a group's strip shows (frames.mjs appearOf record) next to its sampled timing; when they disagree
// (a step against a sampled fade, or a visible duration under half / over twice the sampled ms) the strip
// wins. startMs = the group's sampled start in the strip's clock (load: ms after first paint), or null.
const stripVsGroup = (a, g, startMs) => {
  if (!a || !a.kind || a.kind === 'none') return '';
  const off = (a.kind === 'step' && isNum(g.ms) && g.ms > 200) || (a.kind !== 'step' && isNum(g.ms) && isNum(a.ms) && (a.ms < g.ms * 0.5 || a.ms > g.ms * 2))
    || (isNum(startMs) && isNum(a.atMs) && Math.abs(a.atMs - startMs) > 250);
  // a sampled slide that the strip shows fading in place (a translate on a box that does not visibly move)
  const f = isObj(g.from) ? g.from : {};
  const offFrom = a.kind === 'fade' && ((isNum(f.x) && Math.abs(f.x) >= 8) || (isNum(f.y) && Math.abs(f.y) >= 8));
  return `; strip: ${appearNote(a, { at: 'ms' })}${off ? ` (DISAGREES with the sampled ${r(g.ms)}ms${isNum(startMs) ? ` from ${r(startMs)}ms` : ''}: the strip wins)` : ''}${offFrom ? ' (DISAGREES with the sampled translate: it fades in place; build it from opacity only, the strip wins)' : ''}`;
};

// ---------- full-page shot vs fold: is the nav drawn in another (scrolled) state? ----------
// Mean absolute RGB difference over the nav rows of two shots, and the share of pixels differing > 24.
function rowDiff(A, B, h) {
  const w = Math.min(A.width, B.width), rows = Math.min(h, A.height, B.height);
  let sum = 0, n = 0, big = 0;
  for (let y = 0; y < rows; y++) for (let x = 0; x < w; x += 2) {
    const i = (y * A.width + x) * 4, j = (y * B.width + x) * 4;
    const d = (Math.abs(A.data[i] - B.data[j]) + Math.abs(A.data[i + 1] - B.data[j + 1]) + Math.abs(A.data[i + 2] - B.data[j + 2])) / 3;
    sum += d; n++; if (d > 24) big++;
  }
  return n ? { mean: sum / n, big: big / n } : null;
}
/** Per viewport: the full shot's nav rows differ from the fold's (taken at scroll 0, the rest state);
 *  `scrolled` when they match the scrolled shot instead. Needs the capture dir; null when unknown. */
export function navShotState(dir, c, vp) {
  const sh = c.shots?.[vp], nav = c.spacing?.nav;
  if (!dir || !sh?.full || !sh?.fold || !nav) return null;
  const h = Math.round((vp === '1440' ? nav.h : nav.byViewport?.[vp]?.h) || nav.h || 0);
  if (!(h >= 8)) return null;
  try {
    const F = readPng(path.join(dir, sh.full)), O = readPng(path.join(dir, sh.fold));
    const dFold = rowDiff(F, O, h);
    if (!dFold || dFold.mean <= 3 || dFold.big <= 0.02) return { differs: false, h };
    let dScr = null;
    if (sh.scrolled && fs.existsSync(path.join(dir, sh.scrolled))) dScr = rowDiff(F, readPng(path.join(dir, sh.scrolled)), h);
    return { differs: true, h, scrolled: !!dScr && dScr.mean < dFold.mean * 0.5, dFold: dFold.mean, dScr: dScr ? dScr.mean : null };
  } catch { return null; }
}

// ---------- builder ----------
export function buildSummary(c, { dir = null } = {}) {
  if (!c || typeof c !== 'object') throw new Error('capture is not an object');
  const L = [];
  const add = (s) => L.push(s);
  const meta = c.meta || {};
  const sections = Array.isArray(c.sections) ? c.sections : [];
  const bandOf = new Map(sections.map((s) => [s.id, s.i]));
  // narrow-viewport band ids (bands that exist only at that width, or re-segmented pieces) -> b<i>@<vp>
  const narrowOf = new Map();
  for (const vp of ['768', '390']) for (const s of c.sectionsByViewport?.[vp] || []) if (s && s.id && !bandOf.has(s.id) && !narrowOf.has(s.id)) narrowOf.set(s.id, `b${s.i}@${vp}`);
  const band = (id) => (id == null ? '' : bandOf.has(id) ? `b${bandOf.get(id)}` : narrowOf.has(id) ? narrowOf.get(id) : String(id));
  const bands = (ids) => (Array.isArray(ids) ? ids.map(band).join(',') : band(ids));

  add(`# Capture digest (schema ${c.schema || '?'}): every line cites its capture.json path in parentheses`);

  // ---- meta ----
  add('## Meta (meta)');
  add(`- url ${meta.url || '-'}${meta.finalUrl && meta.finalUrl !== meta.url ? ` -> ${meta.finalUrl}` : ''}, status ${meta.status ?? '-'} (meta.url, meta.finalUrl, meta.status)`);
  add(`- title "${trunc(meta.title, 90)}", time ${meta.time || '-'}, run ${isNum(meta.runMs) ? `${r(meta.runMs / 1000)} s` : '-'} (meta.title, meta.time, meta.runMs)`);
  add(`- viewports ${(meta.viewports || []).join('/')}; page heights ${kv(meta.pageHeight)} px (meta.viewports, meta.pageHeight)`);
  add(`- libraries ${(meta.libraries || []).map((l) => `${l.name}${l.evidence ? ` (${l.evidence})` : ''}`).join(', ') || 'none'} (meta.libraries)`);
  const bl = meta.blocked || {};
  add(`- blocked ${bl.suspected ? `SUSPECTED: ${(bl.reasons || []).join('; ')}` : 'no'}; consent ${meta.consent?.action || '-'} (meta.blocked, meta.consent.action)`);
  add(`- consoleErrors ${kv(meta.consoleErrors)}${(meta.consoleSample || []).length ? `; first: ${trunc(meta.consoleSample[0]?.text ?? meta.consoleSample[0], 80)}` : ''} (meta.consoleErrors, meta.consoleSample)`);
  if (isObj(meta.overflowX)) {
    const over = Object.entries(meta.overflowX).filter(([, v]) => (isObj(v) ? v.overflow : v));
    if (over.length) add(`- HORIZONTAL OVERFLOW ${over.map(([vp, v]) => `${vp}: by ${r(v?.by)}px (scrollWidth ${r(v?.scrollWidth)})`).join(', ')} (meta.overflowX)`);
    const clip = Object.entries(meta.overflowX).filter(([, v]) => isObj(v) && Array.isArray(v.clipped) && v.clipped.length);
    if (clip.length) add(`- CLIPPED CONTENT (cut at the viewport edge) ${clip.map(([vp, v]) => `${vp}: ${v.clippedN || v.clipped.length} (e.g. ${v.clipped[0].sel}, ${v.clipped[0].cut}px at the ${v.clipped[0].side} edge)`).join(', ')} (meta.overflowX[vp].clipped)`);
  }
  if (isObj(meta.settle)) {
    const bad = Object.entries(meta.settle).filter(([, s]) => s && (s.load === false || s.fonts === false || s.quiet === false));
    add(`- settle ${Object.entries(meta.settle).map(([vp, s]) => `${vp}:${r(s?.ms)}ms`).join(' ')}${bad.length ? `; NOT settled: ${bad.map(([vp, s]) => `${vp} ${['load', 'fonts', 'quiet'].filter((k) => s[k] === false).join('/')}`).join(', ')}` : ''} (meta.settle)`);
  }
  if (isObj(meta.segmentation)) add(`- segmentation cover ${Object.entries(meta.segmentation).map(([vp, s]) => `${vp}:${r(s?.cover, 2)}${s?.capped ? ' CAPPED' : ''}`).join(' ')} (meta.segmentation)`);
  if (isObj(meta.innerScroller) && Object.keys(meta.innerScroller).length) {
    const is = Object.entries(meta.innerScroller).sort((a, b) => +b[0] - +a[0]), u0 = is[0][1] || {};
    add(`- APP SHELL: content scrolls inside ${trunc(u0.el, 40)} (${u0.clientH}px box, ${u0.scrollH}px content), not the document; ${is.every(([, u]) => u && u.ok) ? 'unrolled into the document before measuring' : `NOT unrolled at ${is.filter(([, u]) => !(u && u.ok)).map(([vp]) => vp).join('/')}: bands cover the first screen only`} (document ${is.map(([vp, u]) => `${vp}:${(u.docH || []).join('->')}`).join(' ')}) (meta.innerScroller)`);
  }
  // full-page shots: rendering forced as in view, rows filled from in-view shots, text still blank (loud)
  {
    const sh = isObj(c.shots) ? c.shots : {};
    const vps = Object.keys(sh).filter((k) => /^\d+$/.test(k) && isObj(sh[k]));
    const bits = vps.map((vp) => { const s = sh[vp], b = s.blank || {}, rd = s.render || {}; const p = [];
      if (rd.contentVisibility) p.push(`content-visibility forced on ${rd.contentVisibility}`);
      if (rd.frozen) p.push(`${rd.frozen} scroll-driven anim paused in view`);
      if (b.inView && b.inView.pastedPx) p.push(`${b.inView.pastedPx}px filled from in-view shots`);
      return p.length ? `${vp}: ${p.join(', ')}` : null; }).filter(Boolean);
    if (bits.length) add(`- full shots as seen in view: ${bits.join('; ')} (shots[vp].render, shots[vp].blank)`);
    const tl = vps.filter((vp) => Array.isArray(sh[vp].tails) && sh[vp].tails.length);
    if (tl.length) add(`- full shot capped at ${tl.map((vp) => `${vp}: ${r(sh[vp].fullHeight)}px, tail shot(s) cover rows to ${r(Math.max(...sh[vp].tails.map((t) => t.y + t.h)))}px`).join('; ')} (every band past the cap has its sec-<n> crop from them) (shots[vp].tails)`);
    // every width's share is stated once any width is blank (page height in content bands still flat, text area)
    const blk = vps.filter((vp) => isObj(sh[vp].blank));
    if (blk.some((vp) => (sh[vp].blank.rows || 0) >= 0.1 || (sh[vp].blank.after || 0) >= 0.2)) add(`- WARNING full shot still BLANK: ${blk.map((vp) => { const b = sh[vp].blank; return `${vp}: ${Math.round((b.rows || 0) * 100)}% of the page height${Array.isArray(b.bands) ? ` (bands ${b.bands.join(',')})` : ''}, ${isNum(b.after) ? `${Math.round(b.after * 100)}% of its text` : 'text not comparable'}`; }).join('; ')}: read those bands from the fold, scrolled and reveal frames, not the full shot (shots[vp].blank.rows/after, sections[i].shot)`);
  }
  const unr = meta.stylesheets?.unreadable;
  if (Array.isArray(unr) ? unr.length : unr) add(`- stylesheets ${meta.stylesheets.total} total, unreadable ${Array.isArray(unr) ? unr.slice(0, 3).map((u) => trunc(u, 40)).join(', ') : unr} (meta.stylesheets)`);
  const notes = (c.notes || []).filter((n) => typeof n === 'string' && !/colour custom properties on :root/i.test(n));
  if (notes.length) {
    add('### Notes that matter (notes[])');
    notes.slice(0, 12).forEach((n) => add(`- ${trunc(n, 170)} (notes[${c.notes.indexOf(n)}])`));
    if (notes.length > 12) add(`- … ${notes.length - 12} more (notes[])`);
  }

  // ---- overlays / consent ----
  const ov = Array.isArray(meta.overlays) ? meta.overlays : [];
  if (ov.length || (meta.consent && meta.consent.action && meta.consent.action !== 'none')) {
    add('## Removed overlays (meta.overlays, meta.consent)');
    if (meta.consent && meta.consent.action !== 'none') add(`- consent ${meta.consent.action}${meta.consent.count != null ? ` x${meta.consent.count}` : ''}: ${trunc(meta.consent.detail, 140)} (meta.consent)`);
    ov.slice(0, 8).forEach((o, i) => add(`- ${o.kind || '?'} ${o.action || '?'} ${trunc(o.el, 40)}${o.text ? ` "${trunc(o.text, 50)}"` : ''}${o.why ? ` why: ${trunc(o.why, 50)}` : ''}${o.box ? ` box ${box(o.box)}` : ''} (meta.overlays[${i}])`));
  }

  // ---- colour ----
  const col = c.colors || {};
  add('## Colour (colors)');
  add(`- theme ${col.theme || '-'}; media area ${pct(col.mediaAreaFrac)}${col.imageHeavy ? ', image-heavy' : ''}; ${col.clustersBeforeCap != null ? `${col.clustersBeforeCap} clusters before cap` : ''} (colors.theme, colors.mediaAreaFrac, colors.imageHeavy)`);
  for (const [role, hex] of Object.entries(col.roles || {})) {
    const where = col.roleWhere?.[role], wk = col.weak?.[role];
    add(`- ${role} ${hex ?? '-'}${where ? ` at ${trunc(where, 70)}` : ''}${wk ? ` WEAK (${trunc(wk, 90)}): check the shots before using it` : ''} (colors.roles.${role}, colors.roleWhere.${role}${wk ? `, colors.weak.${role}` : ''})`);
  }
  const minor = col.minor || [];
  if (minor.length) add(`- minor: ${minor.slice(0, 8).map((m) => `${m.hex} ${(m.uses || []).join('/')} x${m.n}${m.band ? ` ${band(m.band)}` : ''}`).join('; ')} (colors.minor)`);
  const brandM = col.brandMarks || [];
  if (brandM.length) add(`- brand-mark colours (logos; never an accent or minor colour, do not copy): ${brandM.slice(0, 6).map((m) => `${m.hex} ${trunc(m.ex, 24)}`).join('; ')} (colors.brandMarks)`);
  const grads = col.gradients || [];
  if (grads.length) {
    add(`- gradients: ${col.gradientsTotal ?? grads.length} total, top ${Math.min(5, grads.length)} by area (colors.gradients)`);
    grads.slice(0, 5).forEach((g, i) => add(`  - ${g.where || '?'} ${pct(g.areaFrac)} x${g.n ?? 1} ${bands(g.bands)}${g.onMedia ? ' (overlay on media: not a band gradient)' : g.thin ? ' (thin strip: not a band gradient)' : ''}: ${trunc(g.css, 110)} (colors.gradients[${i}])`));
  }

  // ---- type ----
  const ty = c.type || {};
  const roles = [...new Set(VPS.flatMap((v) => Object.keys(ty.roles?.[v] || {})))];
  if (roles.length) {
    add('## Type roles (type.roles[vp][role]: px/weight/lh/ls, tt; family, colour, ink, adv, lhr, tags at 1440)');
    add('| role | 1440 | 768 | 390 | family | colour | ink | adv | lhr | tags |');
    add('|---|---|---|---|---|---|---|---|---|---|');
    const cellOf = (e) => (e ? `${r(e.px)}/${r(e.weight)}/${r(e.lh, 2)}/${r(e.ls, 3)}${e.tt ? ` ${e.tt}` : ''}${e.style && e.style !== 'normal' ? ` ${e.style}` : ''}` : '-');
    for (const role of roles) {
      const e = ty.roles['1440']?.[role] || ty.roles['768']?.[role] || ty.roles['390']?.[role] || {};
      const tags = isObj(e.tags) ? Object.entries(e.tags).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k}:${v}`).join(' ') : '';
      add(`| ${role} | ${cellOf(ty.roles['1440']?.[role])} | ${cellOf(ty.roles['768']?.[role])} | ${cellOf(ty.roles['390']?.[role])} | ${cell(trunc(e.family, 22))} | ${e.color || '-'} | ${r(e.ink, 3)} | ${r(e.adv, 3)} | ${e.lhr != null ? r(e.lhr, 2) : '-'} | ${tags || '-'} |`);
    }
    // weak roles: sampled from one element, a single-use size, the footer, or a band of UI mock-ups
    const secOf = new Map(sections.map((s) => [s.i, s]));
    for (const role of roles) {
      const e = ty.roles['1440']?.[role];
      if (!e) continue;
      const why = [];
      const how = String(e.how || '');
      if (role !== 'display' && isNum(e.n) && e.n <= 1) why.push('1 element');
      if (/single use/.test(how)) why.push('single-use size');
      if (/no paragraphs found|only nav buttons|not above a heading/.test(how)) why.push(how.match(/no paragraphs found|only nav buttons found|not above a heading/)[0]);
      const bs = secOf.get(e.band);
      if (bs && bs.role === 'footer' && role !== 'small') why.push('taken from the footer band');
      // (a body whose rule already left mock-up panel text out, or larger than mock-up text, is not flagged)
      if (bs && (role === 'body' || role === 'small') && bs.counts?.composites > 0 && !(role === 'body' && (/mock-up/.test(how) || e.px > 15))) why.push(`b${bs.i} holds ${bs.counts.composites} UI mock-up panel(s): check ${trunc(e.ex, 30)} is not mock-up text`);
      if (why.length) add(`- WEAK ${role}: ${why.join('; ')} (type.roles.1440.${role}.n, .how, .band)`);
    }
    // the hero heading's own size when the h1 tier is taken from another band
    const hero = sections.find((s) => s.role === 'hero');
    const h1 = ty.roles['1440']?.h1;
    if (hero && h1 && isNum(h1.band) && h1.band !== hero.i && isNum(hero.headPx)) add(`- hero heading ${r(hero.headPx)}px in b${hero.i}; the h1 tier (${r(h1.px)}px, ${trunc(h1.ex, 30)}) comes from b${h1.band}: size the hero title from b${hero.i}, not from the h1 tier (sections[${hero.i}].headPx, type.roles.1440.h1.band)`);
  }
  (ty.families || []).forEach((f, i) => add(`- family ${f.family}: ${f.category || '?'}, width ${f.width || '?'}, adv ${r(f.adv, 3)}, xHeight ${r(f.xHeight, 2)}, weights ${(f.weights || []).join('/')}${f.variable ? ', variable' : ''}${f.webfont === false ? ', system' : ''}${f.inCatalogue === true ? ', in the Google Fonts catalogue (may be used)' : f.inCatalogue === false ? ', NOT in the Google Fonts catalogue (never use it)' : ''}, share ${pct(f.share)}, roles ${(f.roles || []).join(',') || '-'} (type.families[${i}])`));
  if (ty.scale?.['1440']) add(`- scale 1440 ${kv(ty.scale['1440'], (v) => r(v, 2))}; body px ${kv(ty.bodyPx)} (type.scale.1440, type.bodyPx)`);
  // stat figures (short numerals at heading size): recorded apart, never a heading tier
  if (isObj(ty.stats)) {
    const st = VPS.filter((v) => isObj(ty.stats[v])).map((v) => { const s = ty.stats[v]; return `${v} ${r(s.px)}/${r(s.weight)} ${trunc(s.family, 20)} x${s.n ?? 1} "${trunc(s.sample, 16)}"${v === '1440' && isNum(s.band) ? ` b${s.band}` : ''}`; });
    if (st.length) add(`- stat figures (not a heading tier): ${st.join('; ')} (type.stats)`);
  }
  // intro paragraphs larger than body: a record on the body role, never a role (spec-schema §type lead)
  const leads = VPS.filter((v) => isObj(ty.roles?.[v]?.body?.lead)).map((v) => { const l = ty.roles[v].body.lead; return `${v} ${r(l.px)}/${r(l.weight)}/${r(l.lh, 2)}/${r(l.ls, 3)} ${trunc(l.family, 20)} x${l.n ?? 1}${v === '1440' && isNum(l.band) ? ` b${l.band} ${trunc(l.ex, 28)}` : ''}`; });
  if (leads.length) add(`- lead paragraphs (not a role): ${leads.join('; ')} (type.roles[vp].body.lead)`);
  if (isObj(ty.samples)) {
    // the band a sample line sits in: the smallest primary section containing the middle of its bbox
    const bandAt = (b) => { if (!Array.isArray(b) || b.length < 4) return null; const y = b[1] + b[3] / 2; return sections.filter((s) => isNum(s.y) && isNum(s.h) && y >= s.y && y < s.y + s.h).sort((a, z) => a.h - z.h)[0] || null; };
    for (const [role, s] of Object.entries(ty.samples).slice(0, 14)) {
      const one = Array.isArray(s) ? s[0] : s;
      if (!one) continue;
      // the verdict fontmatch gives the same crop (one rule, lib/fontmatch.mjs sampleVerdict); the
      // capture's own sampleQuality when the crop is not on disk
      const qv = dir ? sampleVerdict(dir, role, one) : null, q = qv || one.sampleQuality, sb = bandAt(one.bbox);
      add(`- sample ${role}: "${trunc(one.text, 70)}" ${r(one.px)}px/${r(one.weight)}${sb ? ` from b${sb.i} (${sb.role || '?'})` : ''}${q && q.level === 'poor' ? ` POOR (${trunc(q.reason, 70)}): do not trust it for weight, width or tracking` : ''} (type.samples.${role}${sb ? '.bbox' : ''}${q ? `, .sampleQuality${qv ? ' + crop, as fontmatch' : ''}` : ''})`);
    }
  }

  // ---- spacing ----
  const sp = c.spacing || {};
  add('## Spacing (spacing)');
  for (const vp of VPS) {
    const k = sp.container?.[vp];
    if (!k) continue;
    const extra = [k.textLeft != null ? `text ${r(k.textLeft)}..${r(k.textRight)}` : '', k.railLeft != null ? `rail ${r(k.railLeft)}..${r(k.railRight)}` : ''].filter(Boolean).join(', ');
    // weak container: one band, running text only, a centred text column, one column of a two-column page
    const vw = Number(vp), weak = [];
    if (isNum(k.contentBands) && k.contentBands <= 1) weak.push(`from ${k.contentBands} band`);
    if (k.contentHow && /text/.test(k.contentHow)) weak.push('running text only (no rails)');
    if (isNum(k.textLeft) && isNum(k.textRight) && Math.abs(k.textLeft - (vw - k.textRight)) <= Math.max(8, vw * 0.01) && (isNum(k.railLeft) ? k.textLeft - k.railLeft >= 24 : k.textRight - k.textLeft <= vw * 0.6)) weak.push(`text is a centred ${r(k.textRight - k.textLeft)}px column: its left edge is not the container padding`);
    if (vp === '1440' && k.contentHow && /text/.test(k.contentHow)) {
      const multi = sections.find((s) => s.layout?.cols >= 2 && Array.isArray(s.contentX) && isNum(k.contentLeft) && (s.contentX[1] - s.contentX[0]) > (k.contentRight - k.contentLeft) + 40);
      if (multi) weak.push(`one column of the ${multi.layout.cols}-column b${multi.i} (its row spans ${multi.contentX[0]}..${multi.contentX[1]}, sections[${multi.i}].contentX)`);
    }
    add(`- ${vp} container ${r(k.contentLeft)}..${r(k.contentRight)} (w ${r(k.contentWidth)}), maxWidthCss ${r(k.maxWidthCss)}, centred ${r(k.centredWidth)}, gutter ${r(k.gutter)}${extra ? `, ${extra}` : ''}${weak.length ? `; WEAK: ${weak.join('; ')}` : ''} (spacing.container.${vp})`);
  }
  for (const vp of VPS) {
    const p = sp.sectionPad?.[vp];
    if (p) add(`- ${vp} section pad mode ${r(p.modeTop)}/${r(p.modeBottom)}, median ${r(p.medianTop)}/${r(p.medianBottom)} (spacing.sectionPad.${vp})`);
  }
  for (const vp of VPS) {
    const g = sp.gaps?.[vp];
    const st = sp.stack?.[vp];
    if (g || st) add(`- ${vp} gaps ${(g || []).slice(0, 6).map((x) => `${r(x.px)}x${x.n}`).join(' ')}; stack heading->text ${r(st?.headingToText)}, text->button ${r(st?.textToButton)} (spacing.gaps.${vp}, spacing.stack.${vp})`);
  }
  if (sp.radius) add(`- radius button ${sp.radius.button ?? '-'}, card ${sp.radius.card ?? '-'}, input ${sp.radius.input ?? '-'}, image ${sp.radius.image ?? '-'}; top ${(sp.radius.top || []).slice(0, 6).map((t) => `${t.v}x${t.n}`).join(' ')} (spacing.radius)`);
  (sp.shadows || []).slice(0, 4).forEach((s, i) => add(`- shadow x${s.n} on ${s.on || '?'}: ${trunc(s.css, 90)} (spacing.shadows[${i}])`));
  if ((sp.borders || []).length) add(`- borders ${(sp.borders || []).slice(0, 6).map((b) => `${r(b.w)}px ${b.color} ${b.sides} x${b.n}`).join('; ')} (spacing.borders)`);

  // ---- bands ----
  if (sections.length) {
    add('## Bands at 1440 (sections[i]; "768 / 390" from sections[i].collapse[vp], p = pad top/bottom and hd = headPx from sectionsByViewport[vp][].pad/.headPx)');
    add('Band ids anywhere in this digest are written b<i> (this table) or b<i>@<vp> (a band that exists only at that width); the id column maps them back to capture.json.');
    add('| i | id | role | h px (vh) | bg | cols | cards | media | align | pad | headPx | 768 / 390 |');
    add('|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const s of sections) {
      const bg = s.bg || {};
      let bgs = `${bg.type || '?'} ${bg.color || ''}`.trim();
      if (bg.sampled && bg.color && bg.sampled.toLowerCase() !== String(bg.color).toLowerCase()) bgs += ` ~${bg.sampled}`;
      if (bg.scrollTheme) bgs += ` scroll:${typeof bg.scrollTheme === 'string' ? bg.scrollTheme : compact(bg.scrollTheme, 1, 40)}`;
      const lay = s.layout || {};
      const cols = `${lay.cols ?? '-'}${Array.isArray(lay.ratios) && lay.ratios.length > 1 ? ` [${lay.ratios.map((x) => r(x, 2)).join(' ')}]` : ''}`;
      const cd = s.cards;
      const cards = cd ? `${cd.cols}x${cd.rows} n${cd.n}${cd.like ? ' like' : ''}${cd.peek ? ' peek' : ''}${cd.overflow && !cd.peek ? ' overflow' : ''}` : '-';
      const md = s.media || {};
      const media = md.place && md.place !== 'none' ? `${md.place}${md.kind ? ` ${md.kind}` : ''}${md.frac != null ? ` ${r(md.frac, 2)}` : ''}` : '-';
      const pad = Array.isArray(s.pad) ? s.pad.map((x) => r(x)).join('/') : '-';
      const coll = ['768', '390'].map((vp) => {
        const k = s.collapse?.[vp];
        if (s.collapse && vp in s.collapse && k == null) return `${vp} hidden`;
        if (!k) return `${vp} ?`;
        if (k.hidden) return `${vp} hidden`;
        if (k.unlinked) return `${vp} unlinked`;
        const ch = [];
        if (k.cols != null && k.cols !== lay.cols) ch.push(`cols ${k.cols}`);
        if (k.cardCols != null && cd && k.cardCols !== cd.cols) ch.push(`cards ${k.cardCols}`);
        if (Array.isArray(k.bands) && k.bands.length > 1) ch.push(`split ${k.bands.join('+')}`);
        // pads and heading px at this width from the narrow band(s) this band became (sectionsByViewport[vp])
        const nb = (c.sectionsByViewport?.[vp] || []).filter((x) => x && Array.isArray(k.bands) && k.bands.includes(x.i));
        const p0 = nb[0]?.pad, p1 = nb[nb.length - 1]?.pad, hd = nb.find((x) => x.headPx != null);
        const extra = `${Array.isArray(p0) && Array.isArray(p1) ? ` p${r(p0[0])}/${r(p1[1])}` : ''}${hd ? ` hd${r(hd.headPx)}` : ''}`;
        return `${vp} ${ch.length ? ch.join(' ') : 'same'}${k.h != null ? ` h${r(k.h)}` : ''}${extra}`;
      }).join('; ');
      add(`| ${s.i} | #${s.id || '-'} | ${cell(s.role)} | ${r(s.h)} (${r(s.vh, 2)}) | ${cell(bgs)} | ${cols} | ${cards} | ${cell(media)} | ${s.align || '-'} | ${pad} | ${r(s.headPx)} | ${coll} |`);
    }
    for (const vp of ['768', '390']) {
      const list = (c.sectionsByViewport?.[vp] || []).map((s, k) => [s, k]).filter(([s]) => s && s.link == null);
      list.slice(0, 6).forEach(([s, k]) => add(`- ${vp}-only band ${s.i} (b${s.i}@${vp}, #${s.id || '-'}) ${s.role} h${r(s.h)} bg ${s.bg?.color || '-'} cols ${s.cols ?? '-'}${s.cards ? ` cards ${s.cards}` : ''}${s.media ? ` media ${s.media}` : ''}${Array.isArray(s.pad) ? ` p${r(s.pad[0])}/${r(s.pad[1])}` : ''}${s.headPx != null ? ` hd${r(s.headPx)}` : ''}${s.empty ? ' empty' : ''} (sectionsByViewport.${vp}[${k}], link null)`));
      if (list.length > 6) add(`- … ${list.length - 6} more ${vp}-only bands (sectionsByViewport.${vp})`);
    }
  }

  // ---- components ----
  const comps = Object.entries(c.components || {}).filter(([, v]) => v);
  if (comps.length || (c.hover || []).length) {
    add('## Components and hover (components{}, hover[])');
    const delta = (h) => {
      if (!h) return '';
      const parts = [];
      const side = (o, tag) => {
        if (!isObj(o)) return;
        for (const [p, v] of Object.entries(o)) parts.push(`${tag}${p} ${Array.isArray(v) ? v.map((x) => hoverVal(x, 28)).join('->') : compact(v, 0, 30)}`);
      };
      side(h.self, '');
      side(h.before, '::before ');
      side(h.after, '::after ');
      if (Array.isArray(h.kids) && h.kids.length) parts.push(`${h.kids.length} child change(s)${h.kids[0] ? `: ${trunc(h.kids[0].desc, 28)} ${isObj(h.kids[0].delta) ? Object.entries(h.kids[0].delta).map(([p, v]) => `${p} ${Array.isArray(v) ? v.map((x) => hoverVal(x, 24)).join('->') : compact(v, 0, 20)}`).join(', ') : compact(h.kids[0], 1, 50)}` : ''}`);
      return parts.join(', ');
    };
    for (const [name, v] of comps) {
      const f = v.font || {};
      const hv = delta(v.hover);
      add(`- ${name} ${trunc(v.desc, 36)} ${r(v.w)}x${r(v.h)} pad ${Array.isArray(v.pad) ? v.pad.join('/') : '-'} radius ${v.radius ?? '-'} bg ${v.bg || '-'} color ${v.color || '-'}${v.colorWeak ? ` (WEAK: ${v.colorWeak.why}; the box shows ${(v.colorWeak.seen || []).join('/')}; read the colours from ${v.shot || 'its crop'})` : ''}${v.border ? ` border ${trunc(v.border, 30)}` : ''} font ${r(f.px)}/${r(f.weight)}${f.tt ? ` ${f.tt}` : ''}${v.shadow ? ' shadow' : ''}${v.blur ? ` ${v.blur}` : ''}; hover ${hv || 'none'}${v.hover?.transition ? ` [${transShort(v.hover.transition, 60)}]` : ''} (components.${name})`);
    }
    const seen = new Set();
    let shown = 0;
    // the element a hover crop pair was shot on: its data checked against the crops' pixel difference
    const pairs = (c.motion?.frames?.hover || []).filter((f) => f && f.visual && typeof f.visual.changed === 'number');
    const firstOfKind = new Set();
    (c.hover || []).forEach((h, i) => {
      const d = delta(h);
      const fp = h.pair ? pairs.find((f) => f.dir === h.pair) : (!firstOfKind.has(h.kind) && !h.skipped ? pairs.find((f) => f.kind === h.kind) : null);
      if (h.kind && !h.skipped) firstOfKind.add(h.kind);
      const key = `${h.kind}|${d}`;
      if ((seen.has(key) && !fp) || shown >= 10) return;
      seen.add(key); shown++;
      const vis = fp ? fp.visual.changed >= 0.005 : null;
      // what the pair visibly does (capture's visual.look; older captures: from the PNGs)
      const lk = fp ? (fp.visual.look || (dir && fp.dir ? (pairLook(path.join(dir, fp.dir, 'f-00.png'), path.join(dir, fp.dir, 'f-01.png')) || {}).look : null)) : null;
      const seenTxt = fp ? (vis ? `; visible on hover: ${lk && lk !== 'none' ? lk : 'changes'}` : '; no visible change on hover') : '';
      const crop = fp ? `${seenTxt} (crops differ on ${Math.round(fp.visual.changed * 1000) / 10}%)${vis !== !!d ? ` (WEAK: the data says ${d ? 'changed' : 'no change'}, the before/after crops ${vis ? 'differ' : 'do not'}; follow the crops, ${fp.dir})` : ''}` : '';
      add(`- hover ${h.kind || '?'} ${trunc(h.desc, 32)}: ${d || 'no change'}${h.transition ? ` [${transShort(h.transition, 60)}]` : ''}${crop}${h.invalid ? ` (INVALID sample: ${h.invalid}; not compared)` : ''} (hover[${i}])`);
    });
  }

  // ---- nav ----
  const nav = sp.nav;
  if (nav) {
    add('## Nav (spacing.nav)');
    add(`- 1440 rest: ${nav.pos || '?'}${nav.posCss ? ` (computed ${nav.posCss}; ${nav.posHow || 'scrolled shot'})` : ''} h${r(nav.h)} bg ${nav.bg || '-'}${nav.transparent ? ' transparent' : ''}${nav.overHero ? ' over hero' : ''}${nav.blur ? ` ${nav.blur}` : ''}${nav.shadow ? ' shadow' : ''}${nav.border ? ` border ${nav.border}` : ''}, ${nav.linkCount ?? '?'} links (spacing.nav)`);
    // the full-page shot can show the nav in another state than the fold (a page that reacts to the
    // full-page resize); the fold, taken at scroll 0, is the rest state
    for (const vp of VPS) {
      const st = navShotState(dir, c, vp);
      if (st && st.differs) add(`- shots/${vp}-full.png shows the nav in ${st.scrolled ? 'its SCROLLED state (its top rows match the scrolled shot)' : 'another state than the fold'} (rows 0-${st.h}px): read the nav at rest from shots/${vp}-fold.png${st.scrolled ? `, the scrolled state from shots/${vp}-scrolled.png` : ''} (shots.${vp}.full, shots.${vp}.fold)`);
    }
    const os = nav.onScroll;
    if (os) {
      const sc = os.scrolled || {};
      add(`- 1440 scrolled: changes ${os.changes ? compact(os.changes, 2, 110) : 'none'}, ${os.staysInView ? 'stays in view' : 'leaves view'}; ${sc.visible === false ? 'hidden' : `h${r(sc.h)} bg ${sc.bg || '-'}${sc.transparent ? ' transparent' : ''}${sc.blur ? ` ${sc.blur}` : ''}${sc.shadow ? ' shadow' : ''}${sc.border ? ` border ${sc.border}` : ''}${sc.line ? ' line under the bar' : ''}`} (spacing.nav.onScroll)`);
      // screenshot evidence (motion.applyNavShots): the bar still at the top of the scrolled shot, and a line or
      // shadow under it that only the scrolled shot shows; a scroll-driven animation on it is its scrolled state
      if (os.shot) add(`- 1440 scrolled shot: ${os.shot.pinned === true ? 'the header is still at the top (stays in view)' : os.shot.pinned === false ? 'the header is gone from the top' : 'unclear'}${typeof os.shot.match === 'number' ? ` (edge match ${r(os.shot.match, 2)})` : ''}${Array.isArray(os.shot.edge) ? `; line/shadow under the bar: rest ${os.shot.edge[0] ? 'yes' : 'no'}, scrolled ${os.shot.edge[1] ? 'yes' : 'no'}` : ''}${os.scrollDriven ? `; scroll-driven: ${os.scrollDriven.join(', ')}` : ''} (spacing.nav.onScroll.shot)`);
    }
    for (const vp of ['768', '390']) {
      const b = nav.byViewport?.[vp];
      if (!b) continue;
      const sc = b.scrolled || {};
      add(`- ${vp}: ${b.pos || '?'} h${r(b.h)}; scrolled ${sc.pinned ? 'pinned' : 'not pinned'} h${r(sc.h)} bg ${sc.bg || '-'}${sc.transparent ? ' transparent' : ''}${sc.buttons != null ? `, ${sc.buttons} buttons` : ''} (spacing.nav.byViewport.${vp})`);
    }
  }

  // ---- motion ----
  const mo = c.motion || {};
  add('## Motion (motion)');
  const ld = mo.load || {};
  const ls = ld.summary;
  if (ls) {
    const stg = ls.staging || {};
    add(`- load: ${ls.groups} groups ${r(ls.firstStartMs)}..${r(ls.lastEndMs)}ms, from ${fromStr(ls.from)}, ${r(ls.ms)}ms ${ls.family || ''}${ls.areaShare != null ? `, area ${pct(ls.areaShare)}` : ''}${ls.textShare != null ? ` (outside media boxes ${pct(ls.textShare)})` : ''}; sampled, staged or not: see load entrance (motion.load.summary)`);
    if (ls.staging) add(`- load staging: first content ${r(stg.firstContentMs)}ms, delay ${r(stg.delayMs)}ms, order ${(stg.order || []).join('>')}, ${stg.steps} steps over ${r(stg.totalMs)}ms (motion.load.summary.staging)`);
  } else {
    add(`- load: none (summary null; ${ld.groupsTotal ?? 0} groups, ${ld.tracked ?? '?'} tracked, ${ld.frames ?? '?'} frames, run ${ld.run || '?'}) (motion.load)`);
  }
  if (nonEmpty(ld.skipped)) add(`- load skipped: ${compact(ld.skipped, 1, 150)} (motion.load.skipped)`);
  if (ld.cold && ls) add(`- cold run: ${ld.cold.groups} groups ${r(ld.cold.firstStartMs)}..${r(ld.cold.lastEndMs)}ms, ${ld.cold.staging ? `${ld.cold.staging.steps} steps ${r(ld.cold.staging.totalMs)}ms` : 'no staging'} (motion.load.cold)`);
  const vis = mo.frames?.load?.visual;
  if (vis) add(`- load frames: designed ${vis.designed ? 'yes' : 'no'}, network ${vis.network ? 'yes' : 'no'}, growSteps ${vis.growSteps}, staged ${vis.staged ? 'yes' : 'no'}, live ${vis.live ? 'yes' : 'no'}, first content ${r(vis.firstContentMs)}ms, last grow ${r(vis.lastGrowMs)}ms (motion.frames.load.visual)`);
  const lf = mo.frames?.load;
  // the lead-in note only when part of the strip is left out (skippedMs > 0); whether the first screen has a
  // designed entrance is decided once (frames.mjs loadEntrance, the same call compare makes)
  if (lf && (lf.settleMs != null || (lf.leadIn && lf.leadIn.skippedMs > 0) || lf.keepsMoving)) add(`- load strip: ${settleNote(lf)}${lf.settleHow ? ` (${lf.settleHow})` : ''}${lf.leadIn && lf.leadIn.skippedMs > 0 ? `; first ${r(lf.leadIn.skippedMs)}ms not shown on the sheets: ${trunc(lf.leadIn.why, 110)} (network or media arrival, not design; do not copy)` : ''} (motion.frames.load.settleMs, .keepsMoving, .leadIn)`);
  { const en = loadEntrance(mo); if (en.groups.length || (ld.groups || []).length) add(`- load entrance (as the strip shows it; compare scores this): ${en.staged ? 'staged' : en.designed ? 'designed, not staged' : 'none'}: ${trunc(en.why, 150)}${en.summary ? `; ${en.summary.staging.order.join(' > ')} from ~${r(en.summary.staging.delayMs)}ms over ${r(en.summary.staging.totalMs)}ms` : ''} (frames.mjs loadEntrance)`); }
  // how the first screen arrives in the strip (frames.mjs loadAppear): step = no transition at all
  if (lf && lf.appear) add(`- load appearance: first screen ${appearNote(lf.appear, { at: 'ms after first paint' })} (motion.frames.load.appear; the strip wins over sampled timings)`);
  (mo.frames?.reveals || []).slice(0, 4).forEach((x, i) => { if (x && x.scroll) add(`- reveal strip ${i + 1}: wheel ${r(x.scroll.px)}px, scroll starts ${r(x.scroll.startMs)}ms, settled ~${r(x.scroll.settleMs)}ms after the input${x.content && typeof x.content.inPlace === 'boolean' ? (x.content.inPlace ? '; content in view already in place when the scroll stops (nothing animates in view)' : `; content keeps changing ${r(x.content.lagMs)}ms after the scroll stops`) : ''}${x.content && x.content.appear && x.content.appear.kind !== 'none' ? `; content ${appearNote(x.content.appear, { at: 'ms after the input' })}` : ''} (motion.frames.reveals[${i}])`); });
  (ld.groups || []).slice(0, 4).forEach((g, i) => add(`  - load group ${g.kind || '?'} ${trunc(g.el, 34)} x${g.n}: from ${fromStr(g.from)}, ${r(g.ms)}ms${g.delay ? ` +${r(g.delay)}` : ''} ${ease(g.easing) || g.family || ''}${g.stagger ? ` stagger ${r(g.stagger)}` : ''} t0 ${r(g.t0)}${stripVsGroup(g.appear, g, isNum(ld.fcpMs) && isNum(g.t0) ? g.t0 - ld.fcpMs : null)} (motion.load.groups[${i}])`));
  // one wording with the sheets (frames.mjs mediaNote): level of `rate` (intermittent), how it moves
  // (in-place / lateral / cut / drift), whether it arrives with the load staging
  (ld.media || []).slice(0, 6).forEach((m, i) => { const mr = mediaRate(m); add(`- hero media ${m.kind || '?'} ${trunc(m.el, 34)} ${band(m.band)}: ${mediaNote(m)}${mr.rate == null && m.diff != null ? ` (diff ${r(m.diff, 3)})` : ''}${m.when ? `, moves ${m.when === 'both' ? 'on load and after' : m.when === 'load' ? 'during the load only' : 'continuously'}` : ''}${typeof m.rateLoad === 'number' ? `; load-phase rate ${r(m.rateLoad, 3)}` : ''}${m.box ? ` box ${box(m.box)}` : ''} (motion.load.media[${i}].activity, .rate, .motion, .withLoad)`); });

  const rv = mo.reveals || {};
  const rs = rv.summary;
  if (rs) add(`- reveals: ${rs.groups} groups / ${rs.elements} els, from ${fromStr(rs.from)}, ${rs.appear === 'step' ? 'all in one step (no transition)' : `${r(rs.ms)}ms ${ease(rs.easing) || ''} (${rs.family || '?'})${rs.stepGroups ? `, ${rs.stepGroups} group(s) in one step` : ''}`}, stagger ${rs.stagger ?? '-'}, trigger ${r(rs.trigger, 2)}, via ${(rs.sources || []).join('/')} (motion.reveals.summary)`);
  else add(`- reveals: none (${rv.groupsTotal ?? 0} groups) (motion.reveals.summary)`);
  (rv.groups || []).slice(0, 5).forEach((g, i) => add(`  - reveal ${band(g.band)} ${trunc(g.el, 34)} x${g.n}: from ${fromStr(g.from)}${g.to ? ` to ${fromStr(g.to)}` : ''}, ${g.appear === 'step' ? 'one step (no transition: rv rv-step)' : `${r(g.ms)}ms${g.delay ? ` +${r(g.delay)}` : ''} ${ease(g.easing) || g.family || ''}`}${g.stagger ? ` stagger ${r(g.stagger)}` : ''} trigger ${r(g.trigger, 2)}${g.triggerHow === 'rest' ? ` (began ${r(g.afterScrollMs)}ms after the scroll stopped: rest position)` : g.triggerHow === 'strip' ? ` (from strip ${g.strip}: it fired resting there after the scroll stopped; the pass's rest gave ${r(g.triggerSampled, 2)})` : ''}${g.offscreen ? ' offscreen' : ''}${Array.isArray(g.ys) && g.ys.length ? ` at y ${g.ys.slice(0, 4).join('/')}` : ''}${g.inStrip ? `, strip ${g.strip}: ${g.inStrip}` : ''}${g.skip ? ` SKIP (${trunc(String(g.skip), 70)})` : ''}${isNum(g.strip) ? stripVsGroup(mo.frames?.reveals?.[g.strip - 1]?.content?.appear, g, null) : ''} (motion.reveals.groups[${i}])`));
  if (mo.byViewport) add(`- reveal counts ${Object.entries(mo.byViewport).map(([vp, v]) => `${vp}:${v?.revealCount ?? '-'}`).join(' ')} (motion.byViewport)`);

  const amb = mo.ambient;
  if (amb && amb.count) {
    add(`- ambient: ${amb.count} items, kinds ${kv(amb.kinds)}, bands ${bands(amb.bands)}, band share ${pct(amb.bandShare)} (motion.ambient)`);
    (amb.items || []).slice(0, 6).forEach((a, i) => add(`  - ${a.kind} ${band(a.band)} ${trunc(a.el || a.media, 34)}${a.name ? ` ${trunc(a.name, 30)}` : ''}${a.src ? ` via ${a.src}` : ''}${a.activity ? ` activity ${a.activity}${a.intermittent ? ' (intermittent)' : ''}` : ''}${a.motion ? ` ${a.motion}` : ''}${a.periodMs ? ` every ${r(a.periodMs)}ms` : ''}${a.box ? ` box ${box(a.box)}` : ''} (motion.ambient.items[${i}])`));
  } else add('- ambient: none (motion.ambient)');

  (mo.sticky || []).slice(0, 4).forEach((s, i) => add(`- sticky ${s.kind || ''} ${trunc(s.el, 34)} h${r(s.h)} top ${r(s.top)} range ${Array.isArray(s.range) ? s.range.join('..') : '-'}${s.always ? ' always' : ''} ${band(s.band)} (motion.sticky[${i}])`));
  if (!(mo.sticky || []).length) add('- sticky: none (motion.sticky)');
  (mo.parallax || []).slice(0, 4).forEach((p, i) => add(`- parallax ${compact(p, 1, 130)} (motion.parallax[${i}])`));
  if (!(mo.parallax || []).length) add('- parallax: none (motion.parallax)');
  (mo.marquees || []).slice(0, 4).forEach((m, i) => add(`- marquee ${trunc(m.el, 34)} ${band(m.band)} ${m.axis || ''} ${m.dir || ''} ${r(m.pxPerSec)}px/s via ${trunc(m.css, 40)} (motion.marquees[${i}])`));
  (rv.jsMarquees || []).slice(0, 3).forEach((m, i) => add(`- js marquee ${compact(m, 1, 120)} (motion.reveals.jsMarquees[${i}])`));
  if (!(mo.marquees || []).length && !(rv.jsMarquees || []).length) add('- marquees: none (motion.marquees, motion.reveals.jsMarquees)');
  if (isObj(mo.marqueesByViewport)) add(`- marquees at ${Object.entries(mo.marqueesByViewport).map(([vp, l]) => `${vp}: ${(l || []).length ? l.slice(0, 3).map((m) => `${band(m.band) || '?'} ${m.dir || m.axis || ''} ${r(m.pxPerSec)}px/s`).join(', ') : 'none'}`).join('; ')} (motion.marqueesByViewport)`);
  if (mo.smoothScroll) {
    const ss = mo.smoothScroll;
    add(`- smooth scroll ${ss.detected ? `YES${ss.library ? ` (${ss.library})` : ''}` : 'no'}, t90 ${r(ss.t90Ms)}ms, basis ${ss.basis || '-'}; layout basis ${mo.layoutBasis || '-'} (motion.smoothScroll, motion.layoutBasis)`);
  }
  const sl = rv.scrollLinked || [];
  add(`- scroll-linked: ${rv.scrollLinkedTotal ?? sl.length} elements${sl.length ? `; ${sl.slice(0, 2).map((x) => compact(x, 1, 70)).join(' | ')}` : ''} (motion.reveals.scrollLinked)`);
  if (mo.scrollTimeline) add(`- scroll timeline: ${mo.scrollTimeline.scrollDrivenAnimations ?? 0} scroll-driven animations, ${mo.scrollTimeline.elements ?? 0} elements, css hits ${kv(mo.scrollTimeline.cssRuleHits)} (motion.scrollTimeline)`);
  if (mo.scrollTint) add(`- scroll tint: ${mo.scrollTint.changes ?? (mo.scrollTint.colors || []).length} changes ${(mo.scrollTint.colors || []).slice(0, 8).map((x) => `${r(x.at, 2)}:${x.color}${x.band ? ` in ${band(x.band)}` : ''}${isNum(x.bandTop) ? `, starts when ${band(x.triggerBand || x.band)}'s top is ${pct(x.bandTop)} down the viewport, ${x.scrub ? `follows the scroll over ${r(x.rangePx)}px` : `takes ${r(x.ms)}ms`}` : ''}`).join('; ')} (motion.scrollTint)`);
  // per tinted band: its colour before it is scrolled to (full shot), while entering and when centred
  (mo.scrollTint?.colors || []).slice(0, 4).forEach((x, i) => {
    const st = x.states; if (!st) return;
    const parts = [st.before ? `before ${st.before} (full shot, scroll 0)` : null, st.entering ? `entering ${st.entering.color} (top edge ${pct(st.entering.bandTop)} down)` : null, st.centred ? `centred ${st.centred.color}` : null].filter(Boolean);
    add(`  - tint ${band(x.band)}: ${parts.join(' -> ')}${x.shape ? ` = ${x.shape}` : ''}; ${x.scrub ? 'scroll-scrubbed' : 'timed (a transition fired at a scroll position, not a scrub)'} (motion.scrollTint.colors[${i}].states)`);
  });
  const themed = sections.filter((s) => s.bg && s.bg.scrollTheme && typeof s.bg.scrollTheme === 'object');
  if (themed.length) {
    add(`- scroll theme per viewport: ${themed.slice(0, 4).map((s) => `b${s.i} 1440 ${s.bg.scrollTheme.rest}->${s.bg.scrollTheme.centred}${['768', '390'].map((vp) => { const n = (c.sectionsByViewport?.[vp] || []).find((x) => x && x.link === s.i); return n ? `, ${vp} ${n.bg?.sampled || n.bg?.color || '-'}` : ''; }).join('')}`).join('; ')} (sections[i].bg.scrollTheme, sectionsByViewport.<vp>[].bg)`);
    add('- what that means: the 1440 band is read twice, at scroll 0 (rest, left of ->) and centred after settling (right of ->): the band turns to the right colour as it scrolls in, starting where the scroll tint line says. 768/390 bands are read at scroll 0 only, so they show the rest colour (whether the theme also runs at those widths is not measured) (motion.scrollTint)');
  }
  if ((mo.horizontal || []).length) add(`- horizontal scroll ${compact(mo.horizontal[0], 1, 120)} (+${mo.horizontal.length - 1}) (motion.horizontal)`);
  if ((mo.loops || []).length) add(`- loops ${mo.loops.length}: ${compact(mo.loops[0], 1, 110)} (motion.loops)`);
  if ((mo.scrollSnap || []).length) add(`- scroll snap ${compact(mo.scrollSnap[0], 1, 110)} (motion.scrollSnap)`);
  if (mo.carousels && (mo.carousels.autoAdvance || []).length) (mo.carousels.autoAdvance || []).slice(0, 3).forEach((a, i) => add(`- auto-advance ${trunc(a.el, 34)} ${band(a.band)}: ${a.periodMs ? `one step every ~${r(a.periodMs)}ms` : 'period not measured'}${a.steps ? ` (${a.steps} steps seen${a.how ? `, ${a.how}` : ''})` : ''} (motion.carousels.autoAdvance[${i}])`));
  else if (mo.carousels && ((mo.carousels.libraries || []).length || (mo.carousels.autoAdvanceCandidates || []).length)) add(`- carousels ${compact(mo.carousels, 1, 130)} (motion.carousels)`);
  if (mo.cursor && (mo.cursor.cursorNone || (mo.cursor.followers || []).length)) add(`- cursor ${compact(mo.cursor, 1, 100)} (motion.cursor)`);
  (mo.transitions || []).slice(0, 5).forEach((t, i) => add(`- transition ${t.prop} ${r(t.ms)}ms ${ease(t.easing)}${t.delay ? ` +${r(t.delay)}` : ''} x${t.n} (motion.transitions[${i}])`));
  (mo.cssAnimations || []).slice(0, 5).forEach((a, i) => add(`- css animation ${trunc(a.name, 30)} ${isNum(a.ms) ? `${r(a.ms)}ms` : 'scroll-driven (no duration)'} ${ease(a.easing)} iter ${a.iter}${a.delay ? ` +${r(a.delay)}` : ''} x${a.n} on ${trunc(a.on, 30)} (motion.cssAnimations[${i}])`));
  if (mo.getAnimationsTotal != null) add(`- getAnimations total ${mo.getAnimationsTotal}; keyframes kept ${Object.keys(mo.keyframes || {}).length} (motion.getAnimationsTotal, motion.keyframes)`);

  // Band ids (s-xxxxxx) in free-form values -> b<i> (b<i>@<vp> for a band that exists only at a narrow
  // width); ids written #s-xxxxxx (the bands table's id column) are kept.
  for (let i = 0; i < L.length; i++) L[i] = L[i].replace(/(?<![#\w-])(?:nav-)?s-[a-z0-9]{6}\b/g, (id) => (bandOf.has(id) || narrowOf.has(id) ? band(id) : id));
  if (L.length > MAX_LINES) {
    const cut = L.length - (MAX_LINES - 1);
    L.length = MAX_LINES - 1;
    L.push(`- … digest truncated: ${cut} lines dropped; read capture.json for the rest (capture.json)`);
  }
  return `${L.join('\n')}\n`;
}

export function writeSummary(outDir, capture, file = path.join(outDir, 'summary.md')) {
  const md = buildSummary(capture, { dir: outDir });
  fs.writeFileSync(file, md, 'utf8');
  return { file, lines: md.split('\n').length - 1 };
}

// ---------- CLI ----------
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [capDir, out] = process.argv.slice(2);
  if (!capDir) {
    process.stderr.write('usage: node summary.mjs <capDir> [out.md]\n');
    process.exit(1);
  }
  try {
    const cap = JSON.parse(fs.readFileSync(path.join(capDir, 'capture.json'), 'utf8'));
    const res = writeSummary(capDir, cap, out || path.join(capDir, 'summary.md'));
    process.stdout.write(`${JSON.stringify(res)}\n`);
  } catch (e) {
    process.stderr.write(`summary: ${e.message}\n`);
    process.exit(1);
  }
}
