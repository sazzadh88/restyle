// Layout area (25): band sequence alignment, per-band geometry/backgrounds, container, nav, shape.
// Bands are aligned mainly by order, height, background, columns and media placement; role labels are a
// weak tie-breaker and only the coarse class (hero / content / footer) is scored, so rewording copy or
// renaming classes never changes the score of a visually identical page.
import { LAYOUT as L, ROLE_CLOSE, ROLE_DEFAULT, COARSE, COARSE_CLOSE, VP_HEIGHT, PRIMARY_VP } from './cmp-constants.mjs';
import { Area, alignRuns, combine, lin, relErr, logRatio, stepScore, dE, col, tone, isNum, clamp, r2, px, presence } from './cmp-util.mjs';

export function roleSim(a, b) {
  if (a === b) return 1;
  return ROLE_CLOSE[[a, b].sort().join('|')] ?? ROLE_DEFAULT;
}
export function coarseSim(a, b) {
  const ca = COARSE(a), cb = COARSE(b);
  if (ca === cb) return 1;
  return COARSE_CLOSE[[ca, cb].sort().join('|')] ?? 0;
}
/** Coarse class of two normalised bands, by position before labels: the first content band of both
 *  sides is the hero position and the last is the footer position whatever their labels say (a hero or
 *  footer label comes from landmark tags and the h1, which differ between markups of one design), so
 *  hero~content on both first bands and footer~content on both last bands count as the same class. */
export function coarsePos(a, b) {
  const s = coarseSim(a.role, b.role);
  if (s >= 1 || !a.edge || a.edge !== b.edge) return s;
  const pair = [a.coarse, b.coarse].sort().join('|');
  return (a.edge === 'first' && pair === 'content|hero') || (a.edge === 'last' && pair === 'content|footer') ? 1 : s;
}
// a row / card group of text-free media pieces of uneven size or overlapping (a collage) is one media
// object, never columns or cards (page-analyze layout.collage / cards.collage; narrow bands: collage)
const collageOf = (b) => {
  const c = b.collage;
  return { row: !!(b.layout?.collage || c === 'row' || c === 'both'), cards: !!((b.cards && typeof b.cards === 'object' && b.cards.collage) || c === 'cards' || c === 'both') };
};
const bgCat = (t) => (t === 'color' ? 'color' : t === 'gradient' ? 'gradient' : t ? 'media' : null);
const MEDIA_SIM = { 'background|full-bleed': 0.6, 'below|full-bleed': 0.6, 'above|full-bleed': 0.6, 'left|right': 0.5, 'above|below': 0.5, 'below|center': 0.5, 'above|center': 0.5, 'background|center': 0.4, 'center|full-bleed': 0.4 };
export const mediaSim = (a, b) => (a === b ? 1 : MEDIA_SIM[[a || 'none', b || 'none'].sort().join('|')] ?? 0);

/** Normalised band: same shape for primary sections and narrow-viewport bands. Third-party (ad) bands
 *  and the nav are left out; bands that were not analysed keep geometry but skip content checks. */
export function normBands(list, vp, pageH) {
  const vh = VP_HEIGHT[vp] || 900;
  const out = (list || []).filter((b) => b && b.role !== 'nav' && b.role !== 'ad' && !b.thirdParty).map((b) => {
    const h = isNum(b.h) ? b.h : null;
    const bg = b.bg || {};
    const cat = bgCat(bg.type);
    const toneColor = cat === 'media' ? (bg.sampled || bg.color) : (cat === 'gradient' && bg.sampledShare > 0.3 ? bg.sampled : (bg.color || bg.sampled));
    const coll = collageOf(b);
    return {
      i: b.i, id: b.id ?? null, role: b.role || 'other', coarse: COARSE(b.role || 'other'), el: b.el || null, analysed: b.analysed !== false,
      h, vh: h != null ? h / vh : (isNum(b.vh) ? b.vh : null),
      yMid: isNum(b.y) && h != null && pageH ? (b.y + h / 2) / pageH : (isNum(b.yFrac) ? b.yFrac + (b.hFrac || 0) / 2 : null),
      yTop: isNum(b.y) && h != null && pageH ? b.y / pageH : null, yBot: isNum(b.y) && h != null && pageH ? (b.y + h) / pageH : null,
      bgType: bg.type || null, bgCat: cat, bgColor: bg.color || null, bgSampled: bg.sampled || null, tone: tone(toneColor),
      cols: coll.row ? 1 : b.layout ? b.layout.cols : b.cols ?? null, ratios: coll.row ? [1] : b.layout ? b.layout.ratios : b.ratios ?? null,
      // main row height / band height (page-analyze layout.rowCover; null in older captures)
      rowCover: isNum(b.layout?.rowCover) ? b.layout.rowCover : isNum(b.rowCover) ? b.rowCover : null,
      collage: coll.row || coll.cards || undefined,
      cards: coll.cards ? null : b.cards && typeof b.cards === 'object' ? { n: b.cards.n, cols: b.cards.cols, like: b.cards.like, gap: b.cards.gap }
        : (isNum(b.cardCols) ? { n: b.cards || null, cols: b.cardCols, like: null, gap: b.cardGap ?? null } : null),
      peek: !!(b.peek || (b.cards && typeof b.cards === 'object' && b.cards.peek) || (b.layout && b.layout.overflow)),
      align: b.align ?? null, media: typeof b.media === 'string' ? b.media : b.media?.place ?? null,
      mediaFrac: isNum(b.media?.frac) ? b.media.frac : null,
      // content counts (primary bands only): headings, media, buttons; used to check that a merged run holds
      // the same content as the band it stands for
      counts: b.counts && typeof b.counts === 'object' ? { headings: b.counts.headings ?? 0, media: b.counts.media ?? 0, buttons: b.counts.buttons ?? 0 } : null,
      pad: Array.isArray(b.pad) ? b.pad : null, headPx: isNum(b.headPx) ? b.headPx : null, collapse: b.collapse || null,
      // capture: share of the band's rows its full shot showed only in view (content mounted or painted while in
      // view, e.g. a video panel), and share of its text still blank in the shot
      inView: isNum(b.shot?.inView) && b.shot.inView >= 0.2 ? b.shot.inView : undefined, shotBlank: isNum(b.shot?.blank) && b.shot.blank >= 0.3 ? b.shot.blank : undefined,
      // narrow-viewport bands: index of the primary band they are linked to (null = mobile-only band)
      link: isNum(b.link) ? b.link : b.link === null ? null : undefined,
    };
  });
  // page position of the first / last content band (coarsePos); one band is the first
  // the first band at least 0.3 viewports tall (the capture's hero size rule): a thin bar above it (an
  // app banner, an announcement strip) does not take the hero position
  if (out.length) { out[out.length - 1].edge = 'last'; (out.find((x) => isNum(x.vh) && x.vh >= 0.3) || out[0]).edge = 'first'; }
  return out;
}

export function bandSim(a, b) {
  const W = L.align;
  const hs = isNum(a.vh) && isNum(b.vh) && a.vh > 0 && b.vh > 0 ? Math.exp(-Math.abs(Math.log(b.vh / a.vh))) : 0.5;
  let bs = a.tone && b.tone ? (a.tone === b.tone ? 0.7 : 0) : 0.35;
  if (a.bgCat === 'color' && b.bgCat === 'color') { const d = dE(a.bgColor, b.bgColor); bs += d == null ? 0.15 : 0.3 * lin(d, L.bgDeltaE); } else bs += a.bgCat && a.bgCat === b.bgCat ? 0.3 : 0.1;
  const cs = isNum(a.cols) && isNum(b.cols) ? stepScore(b.cols - a.cols, [1, 0.5, 0]) : 0.5;
  const ms = a.media || b.media ? mediaSim(a.media, b.media) : 1;
  const ps = isNum(a.yMid) && isNum(b.yMid) ? clamp(1 - Math.abs(a.yMid - b.yMid) * 2, 0, 1) : 0.5;
  return W.wCoarse * coarsePos(a, b) + W.wRole * roleSim(a.role, b.role) + W.wHeight * hs + W.wBg * bs + W.wCols * cs + W.wMedia * ms + W.wPos * ps;
}

/** One band standing for a run of adjacent bands (a composite band segmented into 2-3 pieces on one
 *  side): summed height, outer paddings and extent, the tallest member's background, columns, cards,
 *  alignment and media; hidden at a width only when every member is. */
export function mergeBands(list0) {
  // a unit that is itself merged (a linked group extended by the alignment) contributes its members
  const list = list0.flatMap((x) => x.members || [x]);
  const dom = list.reduce((m, x) => ((x.vh ?? 0) > (m.vh ?? 0) ? x : m), list[0]);
  const first = list[0], last = list[list.length - 1];
  const sum = (k) => (list.every((x) => isNum(x[k])) ? list.reduce((a, x) => a + x[k], 0) : null);
  // outer paddings: members with no measured content (pad null, e.g. an empty strip under the nav) at
  // either end are space before the first / after the last content
  let pad = null;
  const withPad = list.map((x, k) => (Array.isArray(x.pad) ? k : -1)).filter((k) => k >= 0);
  if (withPad.length && list.every((x) => isNum(x.h))) {
    const k0 = withPad[0], k1 = withPad[withPad.length - 1];
    const lead = list.slice(0, k0).reduce((a, x) => a + x.h, 0), trail = list.slice(k1 + 1).reduce((a, x) => a + x.h, 0);
    pad = [Math.round(lead + list[k0].pad[0]), Math.round(list[k1].pad[1] + trail)];
  } else pad = first.pad && last.pad ? [first.pad[0], last.pad[1]] : dom.pad;
  const counts = list.every((x) => x.counts) ? Object.fromEntries(Object.keys(list[0].counts).map((k) => [k, list.reduce((a, x) => a + (x.counts[k] || 0), 0)])) : null;
  // structure of the unit: the value that covers the most of the run's height among members that have one
  // (multi-column rows, card grids, media other than none), so a run of equal shelves is read as a shelf,
  // not as its tallest odd member; members without it fall back to the tallest member's value
  const mode = (keyOf) => {
    const g = new Map();
    for (const x of list) { const k = keyOf(x); if (k == null) continue; const e = g.get(k) || { w: 0, xs: [] }; e.w += isNum(x.vh) ? x.vh : 0; e.xs.push(x); g.set(k, e); }
    let best = null; for (const e of g.values()) if (!best || e.w > best.w) best = e;
    return best ? best.xs : null;
  };
  const colsM = mode((x) => (isNum(x.cols) && x.cols > 1 ? x.cols : null));
  const colRep = colsM ? colsM.reduce((m, x) => ((x.vh ?? 0) > (m.vh ?? 0) ? x : m), colsM[0]) : dom;
  const cardsM = mode((x) => (x.cards && isNum(x.cards.cols) ? x.cards.cols : null));
  const cards = cardsM ? { ...cardsM[0].cards, n: cardsM.every((x) => isNum(x.cards.n)) ? cardsM.reduce((a, x) => a + x.cards.n, 0) : cardsM[0].cards.n } : (dom.cards || list.find((x) => x.cards)?.cards || null);
  const mediaM = mode((x) => (x.media && x.media !== 'none' ? x.media : null));
  const alignM = mode((x) => x.align || null);
  const yTop = first.yTop, yBot = last.yBot;
  const role = list.some((x) => x.coarse === 'hero') ? 'hero' : list.some((x) => x.coarse === 'footer') ? 'footer' : dom.role;
  let collapse = null;
  if (list.every((x) => x.collapse)) {
    collapse = {};
    for (const vp of new Set(list.flatMap((x) => Object.keys(x.collapse)))) {
      const shown = list.map((x) => x.collapse[vp]).filter((c) => c !== null && c !== undefined);
      collapse[vp] = list.every((x) => vp in x.collapse && x.collapse[vp] === null) ? null : shown[0] ?? null;
    }
  }
  return {
    ...dom, i: `${first.i}-${last.i}`, role, coarse: COARSE(role), members: list,
    h: sum('h'), vh: sum('vh'), yTop, yBot,
    yMid: isNum(yTop) && isNum(yBot) ? (yTop + yBot) / 2 : (list.every((x) => isNum(x.yMid)) ? list.reduce((a, x) => a + x.yMid, 0) / list.length : null),
    analysed: list.every((x) => x.analysed),
    cols: colRep.cols, ratios: colRep.ratios, cards,
    media: mediaM ? mediaM[0].media : dom.media || null, mediaFrac: mediaM ? mediaM[0].mediaFrac : dom.mediaFrac,
    align: alignM ? alignM[0].align : dom.align,
    peek: list.some((x) => x.peek),
    pad, counts,
    headPx: list.reduce((m, x) => (isNum(x.headPx) && x.headPx > (m ?? -1) ? x.headPx : m), null),
    collapse,
    edge: list.some((x) => x.edge === 'first') ? 'first' : list.some((x) => x.edge === 'last') ? 'last' : undefined,
    rowCover: colRep.rowCover != null && isNum(colRep.vh) && isNum(sum('vh')) && sum('vh') > 0 ? r2(colRep.rowCover * colRep.vh / sum('vh')) : null,
  };
}
/** Content distance of two count sets {headings, media, buttons}: mean |ln((a+1)/(b+1))|; null if either
 *  side has no counts. */
export function contentDist(a, b) {
  if (!a || !b) return null;
  const ks = Object.keys(a).filter((k) => isNum(a[k]) && isNum(b[k]));
  if (!ks.length) return null;
  return ks.reduce((s, k) => s + Math.abs(Math.log((a[k] + 1) / (b[k] + 1))), 0) / ks.length;
}
const tallest = (run) => run.reduce((m, x) => ((x.vh ?? 0) > (m.vh ?? 0) ? x : m), run[0]);
/** Tone rule of a run against the band `other` stands for: the tallest member has its light/dark tone (and,
 *  both solid, a colour within merge.bgDeltaE: CSS colour or the colour seen in the shot, either side, so a
 *  black wrapper whose painted panels show the run's grey matches), members of the other tone cover
 *  <= merge.offTone. */
function runTone(run, other) {
  const M = L.merge;
  const { tone } = other;
  const dom = tallest(run);
  if (tone && dom.tone && dom.tone !== tone) return false;
  if (other.bgCat === 'color' && dom.bgCat === 'color') {
    const ds = [other.bgColor, other.bgSampled].filter(Boolean).flatMap((p) => [dom.bgColor, dom.bgSampled].filter(Boolean).map((q) => dE(p, q))).filter((d) => d != null);
    if (!ds.length || Math.min(...ds) > M.bgDeltaE) return false;
  }
  const tot = run.reduce((a, x) => a + (isNum(x.vh) ? x.vh : 0), 0);
  const off = run.reduce((a, x) => a + (tone && x.tone && x.tone !== tone && isNum(x.vh) ? x.vh : 0), 0);
  return tot > 0 && off <= M.offTone * tot;
}
/** A run may stand for one band of the other side when it covers the same page span and content
 *  (LAYOUT.merge): summed height within heightLog and better than the tallest member alone, tone rule,
 *  page position, and content counts no worse than the tallest member's. */
export function runMatches(single, run, merged) {
  const M = L.merge;
  if (!isNum(single.vh) || !isNum(merged.vh) || single.vh <= 0 || merged.vh <= 0) return false;
  const fit = logRatio(single.vh, merged.vh);
  if (fit > M.heightLog) return false;
  const dom = tallest(run);
  const domFit = isNum(dom.vh) && dom.vh > 0 ? logRatio(single.vh, dom.vh) : Infinity;
  // the members besides the tallest are a sliver (a thin bar cut off the band: <= sliver.share of the run
  // and <= sliver.vh viewport heights): within heightLog is enough
  const rest = merged.vh - (isNum(dom.vh) ? dom.vh : 0);
  const sliver = rest <= M.sliver.share * merged.vh && rest <= M.sliver.vh;
  if (!sliver && !(fit + M.gain <= domFit || (fit <= M.tight && fit < domFit))) return false;
  if (!runTone(run, single)) return false;
  if (isNum(single.yMid) && isNum(merged.yMid) && Math.abs(single.yMid - merged.yMid) > M.posFrac) return false;
  const cm = contentDist(single.counts, merged.counts), cd = contentDist(single.counts, dom.counts);
  if (cm != null && cd != null && cm > cd + M.content) return false;
  return true;
}
/** n:m unit: two runs cut at different places over the same span (LAYOUT.merge): same summed height and
 *  outer edges, tone rule on each side, counts within contentAbs, inner cuts that do not line up. */
export function runsMatch(runA, mA, runB, mB) {
  const M = L.merge;
  if (!isNum(mA.vh) || !isNum(mB.vh) || mA.vh <= 0 || mB.vh <= 0) return false;
  if (logRatio(mA.vh, mB.vh) > M.heightLog) return false;
  if (!isNum(mA.yTop) || !isNum(mB.yTop) || !isNum(mA.yBot) || !isNum(mB.yBot)) return false;
  if (Math.abs(mA.yTop - mB.yTop) > M.posFrac || Math.abs(mA.yBot - mB.yBot) > M.posFrac) return false;
  const dA = tallest(runA), dB = tallest(runB);
  if (!runTone(runA, dB) || !runTone(runB, dA)) return false;
  const c = contentDist(mA.counts, mB.counts);
  if (c != null && c > M.contentAbs) return false;
  const cuts = (run, tot) => { let acc = 0; return run.slice(0, -1).map((x) => (acc += x.vh) / tot); };
  if (!runA.every((x) => isNum(x.vh)) || !runB.every((x) => isNum(x.vh))) return false;
  const ca = cuts(runA, mA.vh), cb = cuts(runB, mB.vh);
  return ca.every((p) => cb.every((q) => Math.abs(p - q) >= M.cutOff));
}

export function alignBands(R, B) {
  const merge = (side, start, len, single) => {
    const run = (side === 'a' ? R : B).slice(start, start + len);
    if (run.length !== len) return null;
    const m = mergeBands(run);
    return runMatches(single, run, m) ? m : null;
  };
  const mergeBoth = (sa, la, sb, lb) => {
    const ra = R.slice(sa, sa + la), rb = B.slice(sb, sb + lb);
    if (ra.length !== la || rb.length !== lb) return null;
    const ma = mergeBands(ra), mb = mergeBands(rb);
    return runsMatch(ra, ma, rb, mb) ? [ma, mb] : null;
  };
  return alignRuns(R, B, bandSim, { pairOffset: L.align.pairOffset, gap: L.align.gap, maxRun: L.merge.maxRun, merge, mergeBoth, maxBoth: L.merge.maxBoth });
}

const bandName = (b) => `band #${b.i} (${b.role}${b.el ? `, ${b.el}` : ''})`;
/** Pad measured from text, not the box (LAYOUT.padWeak): top + bottom pad leave < cover of the band for
 *  content while the band carries large non-background media. */
export function padWeak(x) {
  const P = L.padWeak;
  if (!x || !Array.isArray(x.pad) || !isNum(x.h) || x.h <= 0) return false;
  if (!x.media || x.media === 'none' || x.media === 'background') return false;
  if (isNum(x.mediaFrac) && x.mediaFrac < P.frac) return false;
  return x.h - x.pad[0] - x.pad[1] < P.cover * x.h;
}
const pairW = (a) => clamp(isNum(a.vh) ? a.vh : 1, L.pairWeight.min, L.pairWeight.max);
const describeBand = (a) => `${r2(a.vh)} vh, ${a.tone || '?'} ${a.bgCat === 'color' ? a.bgColor : a.bgCat || ''} background, ${a.cols ?? 1} column${a.cols === 1 ? '' : 's'}${a.cards ? `, ${a.cards.cols}-up card grid` : ''}, media ${a.media || 'none'}`;

/** Per-pair item builders, shared with responsive. vp = viewport key for wording. */
export const pairChecks = {
  height(a, b, vp, tol = L.heightLog) {
    if (!isNum(a.vh) || a.vh <= 0) return null;
    if (!isNum(b.vh) || b.vh <= 0) return { s: 0, w: pairW(a) };
    const s = lin(logRatio(a.vh, b.vh), tol);
    const target = Math.round(a.vh * (VP_HEIGHT[vp] || 900));
    return {
      s, w: pairW(a), what: `${bandName(a)} height at ${vp}`, ref: `${r2(a.vh)} vh`, build: `${r2(b.vh)} vh (build band #${b.i})`,
      fix: `${cap(bandName(a))} is ${r2(b.vh)} viewport heights in the build (band #${b.i}); reference is ${r2(a.vh)}. ${b.vh < a.vh ? 'Increase' : 'Reduce'} its min-height/padding to about ${target}px at ${vp}.`,
    };
  },
  cols(a, b, vp) {
    if (!isNum(a.cols) || !a.analysed) return null;
    if (!isNum(b.cols)) return { s: 0, w: pairW(a) };
    let s = stepScore(b.cols - a.cols, L.colsDiff);
    if (a.cols === b.cols && a.cols > 1 && Array.isArray(a.ratios) && Array.isArray(b.ratios) && a.ratios.length === b.ratios.length) {
      const l1 = a.ratios.reduce((acc, r, k) => acc + Math.abs(r - b.ratios[k]), 0) / 2;
      s = 0.6 + 0.4 * lin(l1, L.ratiosL1);
    }
    // a side's row is weak in a band >= colsTall.vh viewports tall when it covers < colsTall.cover of it
    // (cover not measured, older captures: weak at the primary width only, where bands are not stacked):
    // it is only the largest of many rows. The item is weak when every side that has a row has a weak one
    const T = L.colsTall;
    const weakRow = (x) => x.cols > 1 && isNum(x.vh) && x.vh >= T.vh && (isNum(x.rowCover) ? x.rowCover < T.cover : vp === PRIMARY_VP);
    const okSide = (x) => weakRow(x) || !(x.cols > 1);
    const weak = okSide(a) && okSide(b) && (weakRow(a) || weakRow(b));
    const w = weak ? pairW(a) * T.w : pairW(a);
    if (s >= 0.999) return { s, w };
    const fix = a.cols !== b.cols
      ? `${cap(bandName(a))} main row has ${b.cols} column${b.cols === 1 ? '' : 's'} at ${vp} (build band #${b.i}); reference has ${a.cols}. Lay it out as ${a.cols} side-by-side column${a.cols === 1 ? '' : 's'}${a.ratios && a.cols > 1 ? ` (${a.ratios.map((r) => Math.round(r * 100) + '%').join(' / ')})` : ''}.`
      : `${cap(bandName(a))} columns are ${b.ratios.map((r) => Math.round(r * 100) + '%').join(' / ')} wide at ${vp} (build band #${b.i}); reference is ${a.ratios.map((r) => Math.round(r * 100) + '%').join(' / ')}. Set the grid to these proportions.`;
    return { s, w, what: `${bandName(a)} columns at ${vp}${weak ? ' (largest row of a multi-screen band, reduced weight)' : ''}`, ref: `${a.cols} [${(a.ratios || []).join(', ')}]`, build: `${b.cols} [${(b.ratios || []).join(', ')}]`, fix };
  },
  cards(a, b, vp) {
    if (!a.analysed) return null;
    const ac = a.cards, bc = b.cards;
    if (!ac && !bc) return null;
    if (ac && !bc) return { s: 0, w: pairW(a), what: `${bandName(a)} card grid at ${vp}`, ref: `${ac.n ?? '?'} items, ${ac.cols} per row`, build: 'no card grid',
      fix: `${cap(bandName(a))} has no repeated card grid in the build (band #${b.i}); reference shows ${ac.n ?? 'several'} similar items, ${ac.cols} per row at ${vp}. Build it as a grid of equal cards, ${ac.cols} columns.` };
    if (!ac && bc) return { s: L.cardsOnlyInBuild, w: pairW(a), what: `${bandName(a)} card grid at ${vp}`, ref: 'no card grid', build: `${bc.n ?? '?'} items, ${bc.cols} per row`,
      fix: `Build band #${b.i} shows a grid of ${bc.cols} cards per row at ${vp} where reference ${bandName(a)} has no repeated cards. Replace the card grid with the reference's free layout (${a.cols ?? 1} column${a.cols === 1 ? '' : 's'}, media ${a.media || 'none'}).` };
    const P = L.cardParts;
    const sc = isNum(ac.cols) && isNum(bc.cols) ? stepScore(bc.cols - ac.cols, L.cardColsDiff) : 0.5;
    let sn = 1;
    if (isNum(ac.n) && isNum(bc.n)) {
      const d = Math.abs(ac.n - bc.n), allow = Math.max(ac.cols || 1, 1); // one row of slack: content differs
      sn = d <= allow ? 1 : clamp(1 - (d - allow) / Math.max(ac.n, 1), 0, 1);
    }
    const sl = ac.like == null || bc.like == null ? 1 : ac.like === bc.like ? 1 : 0;
    const s = P.cols * sc + P.count * sn + P.like * sl;
    if (s >= 0.999) return { s, w: pairW(a) };
    let fix;
    if (sc < 1) fix = `${cap(bandName(a))} card grid has ${bc.cols} cards per row at ${vp} (build band #${b.i}); reference has ${ac.cols}. Set grid-template-columns to repeat(${ac.cols}, 1fr) at ${vp}.`;
    else if (sn < 1) fix = `${cap(bandName(a))} has ${bc.n} cards in the build (band #${b.i}); reference has ${ac.n} (${ac.cols} per row). Use ${ac.n} cards (within one row of it).`;
    else fix = `${cap(bandName(a))} cards ${ac.like ? 'are separate surfaces (own background, border, shadow or rounded image)' : 'have no own surface'} in the reference; make the build's cards (band #${b.i}) match (${ac.like ? 'give each card a background/border and radius' : 'remove card backgrounds/borders'}).`;
    return { s, w: pairW(a), what: `${bandName(a)} card grid at ${vp}`, ref: `${ac.n} items, ${ac.cols}/row${ac.like ? ', card surfaces' : ''}`, build: `${bc.n} items, ${bc.cols}/row${bc.like ? ', card surfaces' : ''}`, fix };
  },
  pad(a, b, vp, tol = L.padRel) {
    if (!a.pad || !a.analysed) return null;
    if (!b.pad) return { s: 0.5, w: pairW(a) };
    const st = lin(Math.abs(a.pad[0] - b.pad[0]) / Math.max(a.pad[0], L.padFloor), tol);
    const sb = lin(Math.abs(a.pad[1] - b.pad[1]) / Math.max(a.pad[1], L.padFloor), tol);
    const s = (st + sb) / 2;
    const weak = padWeak(a) || padWeak(b);
    return {
      s, w: weak ? pairW(a) * L.padWeak.w : pairW(a), what: `${bandName(a)} padding at ${vp}${weak ? ' (pad measured past large media on one side: reduced weight)' : ''}`, ref: `${a.pad[0]} / ${a.pad[1]}px`, build: `${b.pad[0]} / ${b.pad[1]}px (build band #${b.i})`,
      fix: `${cap(bandName(a))} space above/below its content is ${b.pad[0]}/${b.pad[1]}px at ${vp} (build band #${b.i}); reference is ${a.pad[0]}/${a.pad[1]}px (half of the gap to each neighbour on the same background). Adjust that band's padding/margins to match at ${vp}.`,
    };
  },
  align(a, b, vp) {
    if (!a.align || !a.analysed) return null;
    if (!b.align) return { s: 0.5, w: pairW(a) };
    const s = a.align === b.align ? 1 : (a.align === 'mixed' || b.align === 'mixed') ? 0.5 : 0;
    return { s, w: pairW(a), what: `${bandName(a)} text alignment at ${vp}`, ref: a.align, build: b.align,
      fix: `${cap(bandName(a))} text is ${b.align}-aligned in the build at ${vp} (band #${b.i}); reference is ${a.align}. Set text-align: ${a.align === 'mixed' ? 'left for body text and center for the heading block' : a.align} in that band${vp === PRIMARY_VP ? '' : ` at ${vp}`}.` };
  },
  media(a, b, vp) {
    if (!a.media || !a.analysed) return null;
    // the reference band's panels exist only while it is in view (mounted when scrolled to): its DOM at analysis
    // time has no media there, so "none" is not evidence against the build's media
    if ((a.inView || a.shotBlank) && a.media === 'none') return null;
    const bm = b.media || 'none';
    const s = mediaSim(a.media, bm);
    const where = (m) => (m === 'none' ? 'no large media' : m === 'background' ? 'media as the band background' : m === 'full-bleed' ? 'full-bleed media' : `media ${m} of the text`);
    return { s, w: pairW(a), what: `${bandName(a)} media placement at ${vp}`, ref: a.media, build: bm,
      fix: `${cap(bandName(a))} has ${where(bm)} in the build (band #${b.i}); reference has ${where(a.media)}. ${a.media === 'none' ? 'Remove the large image/illustration from this band.' : `Place a large image/illustration (any kind: img, svg, CSS art) ${a.media === 'background' ? 'behind the heading, covering the band' : a.media === 'full-bleed' ? 'edge to edge across the band' : `${a.media} of the text block`}.`}` };
  },
  peek(a, b, vp) {
    if (!a.analysed || (!a.peek && !b.peek)) return null;
    const s = a.peek === b.peek ? 1 : 0;
    return { s, w: pairW(a), what: `${bandName(a)} overflowing row at ${vp}`, ref: a.peek ? 'row overflows (next item peeks in)' : 'fits the viewport', build: b.peek ? 'overflows' : 'fits',
      fix: a.peek ? `${cap(bandName(a))} shows a horizontally overflowing row at ${vp} with the next card partly visible (carousel peek); the build's band #${b.i} fits every item. Let the row scroll horizontally with a fixed card width so the next card peeks in.` : `Build band #${b.i} overflows horizontally at ${vp}; reference ${bandName(a)} fits its row. Make the row wrap or fit.` };
  },
};

function bgItem(a, b) {
  const P = L.bgParts;
  const st = a.bgCat && b.bgCat ? (a.bgCat === b.bgCat ? 1 : 0) : 0.5;
  let sc = 1;
  if (a.bgCat === 'color' && b.bgCat === 'color') { const d = dE(a.bgColor, b.bgColor); sc = d == null ? 0.5 : lin(d, L.bgDeltaE); }
  else if (a.bgCat === 'color' || b.bgCat === 'color') sc = 0.5;
  const sto = a.tone && b.tone ? (a.tone === b.tone ? 1 : 0) : 0.5;
  const s = P.type * st + P.color * sc + P.tone * sto;
  const desc = (x) => `${x.bgType}${x.bgColor ? ' ' + x.bgColor : ''} (${x.tone || '?'})`;
  let fix;
  if (sto < 1) fix = `${cap(bandName(a))} is ${b.tone} in the build (band #${b.i}) but ${a.tone} in the reference; keep the reference's light/dark band rhythm: set its background to ${a.bgCat === 'color' ? a.bgColor : `a ${a.tone} ${a.bgCat === 'media' ? 'image/video' : 'gradient'} background`}.`;
  else if (st < 1) fix = `${cap(bandName(a))} background is ${b.bgType} in the build (band #${b.i}); reference is ${a.bgType}${a.bgColor ? ` (${a.bgColor})` : ''}. Use a ${a.bgCat === 'color' ? `solid ${a.bgColor}` : a.bgCat === 'gradient' ? 'gradient' : 'full-band image/video'} background.`;
  else fix = `${cap(bandName(a))} background is ${b.bgColor} in the build (band #${b.i}); reference is ${a.bgColor}. Set it to ${a.bgColor}.`;
  return { s, w: pairW(a), what: `${bandName(a)} background`, ref: desc(a), build: desc(b), fix };
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

const isPinned = (pos) => pos === 'fixed' || pos === 'sticky';
/** Content column: width from the rail (modal edges of cards/media/rules), left edge from running text
 *  (`textLeft`); older captures fall back to the blended content edges and container fields.
 *  prefer = 'text': measure the width from the running-text edges when they exist, so a side whose
 *  reference value is a text extent (no rails) is compared like with like, never text against rail. */
export function contentCol(c, prefer = 'rail') {
  if (!c) return { left: null, width: null };
  const left = c.textLeft ?? c.contentLeft ?? c.gutter ?? null;
  if (prefer === 'text' && isNum(c.textLeft) && isNum(c.textRight) && c.textRight > c.textLeft) {
    return { left, width: c.textRight - c.textLeft, railLeft: c.textLeft, right: c.textRight, rail: false, text: true };
  }
  const rail = isNum(c.railLeft) && isNum(c.railRight) && c.railRight > c.railLeft;
  const width = rail ? c.railRight - c.railLeft : c.contentWidth ?? c.centredWidth ?? c.maxWidthCss ?? null;
  const railLeft = rail ? c.railLeft : c.contentLeft ?? left;
  return { left, width, railLeft, right: rail ? c.railRight : c.contentRight ?? (isNum(railLeft) && isNum(width) ? railLeft + width : null), rail, text: isNum(c.textLeft) };
}
/** The width the build is measured at for a reference column: rail against rail, text against text. */
export const buildCol = (rc, c) => contentCol(c, rc.rail ? 'rail' : 'text');

/** Running-text column at a viewport width: {left, right, width, centred}. centred = the text edges are
 *  symmetric about the viewport centre and inset from the rail on both sides (no rail: narrower than
 *  LAYOUT.centredText.maxShare of the viewport), i.e. a centred text column whose left edge follows from
 *  its width, not from the container's side padding. null without textLeft. */
export function textCol(c, vw) {
  if (!c || !isNum(c.textLeft)) return null;
  const left = c.textLeft, right = isNum(c.textRight) && c.textRight > c.textLeft ? c.textRight : null;
  if (right == null) return { left, right: null, width: null, centred: false };
  const T = L.centredText;
  const sym = Math.abs(left - (vw - right)) <= Math.max(T.symPx, vw * 0.01);
  const rail = isNum(c.railLeft) && isNum(c.railRight) && c.railRight > c.railLeft;
  const inset = rail ? left - c.railLeft >= T.insetPx && c.railRight - right >= T.insetPx : right - left <= vw * T.maxShare;
  return { left, right, width: right - left, centred: sym && inset };
}

/** Running-text left edge item at a viewport (layout gutter, responsive container). Two centred text
 *  columns are compared by half their width difference (the left-edge shift it causes, same tolerance);
 *  a centred column on one side only is compared by its left edge, and the fix says which side centres
 *  its text instead of calling it container padding. */
export function textEdgeItem(refC, buildC, vp, tol, w = 1) {
  const vw = Number(vp) || 1440;
  const rc = contentCol(refC), bc = contentCol(buildC);
  if (!isNum(rc.left)) return null;
  const rt = textCol(refC, vw), bt = textCol(buildC, vw);
  const at = vp === PRIMARY_VP ? 'at 1440' : `at ${vp}`;
  const word = rc.text ? 'Running text' : 'Content';
  // a running-text edge measured from <= 1 band on either side is weak evidence (LAYOUT.textWeak)
  const weakSide = (c) => !!c && isNum(c.textLeft) && isNum(c.textBands) && c.textBands <= 1;
  if (rc.text && (weakSide(refC) || weakSide(buildC))) w *= L.textWeak;
  if (rt && rt.centred && bt && bt.centred) {
    const s = lin(Math.abs(rt.width - bt.width) / 2, tol);
    return { s, w, what: `centred text column ${at}`, ref: `${px(rt.width)} centred (${rt.left}..${rt.right}px)`, build: `${px(bt.width)} centred (${bt.left}..${bt.right}px)`,
      fix: `Running text sits in a centred column ${px(bt.width)} wide ${at} (${bt.left}..${bt.right}px); reference centres a ${px(rt.width)} column (${rt.left}..${rt.right}px). Set that text column's max-width to ${px(rt.width)} (centred); the container padding is not what differs.` };
  }
  const s = isNum(bc.left) ? lin(Math.abs(rc.left - bc.left), tol) : 0;
  const bl = bc.left == null ? '?' : px(bc.left);
  let fix;
  if (rt && rt.centred) fix = `Reference centres its running text in a ${px(rt.width)} column (${rt.left}..${rt.right}px ${at}); the build's text starts ${bl} from the left edge${bt && bt.right ? ` and ends at ${bt.right}px` : ''}. Centre the text column with max-width ${px(rt.width)}.`;
  else if (bt && bt.centred) fix = `The build centres its running text in a ${px(bt.width)} column (${bt.left}..${bt.right}px ${at}); reference text starts ${px(rc.left)} from the left edge, aligned to the container. Align the text column to the container's left edge (${px(rc.left)}).`;
  else fix = vp === PRIMARY_VP ? `${word} starts ${bl} from the left edge at 1440; reference starts at ${px(rc.left)}.`
    : `Content starts ${bl} from the edge at ${vp}; reference starts at ${px(rc.left)}. Set the container side padding to ${px(rc.left)} at ${vp}.`;
  return { s, w, what: `${rc.text ? 'running text' : 'content'} left edge ${at}`, ref: px(rc.left) + (rt && rt.centred ? ` (centred ${px(rt.width)} column)` : ''), build: (bc.left == null ? 'n/a' : px(bc.left)) + (bt && bt.centred ? ` (centred ${px(bt.width)} column)` : ''), fix };
}

export function scoreLayout(ref, build) {
  const area = new Area('layout', 25);
  const W = L.weights;
  const vp = PRIMARY_VP;
  const R = normBands(ref.sections, vp, ref.meta?.pageHeight?.[vp]);
  const B = normBands(build.sections, vp, build.meta?.pageHeight?.[vp]);
  const pairs = alignBands(R, B);
  const matched = pairs.filter((p) => p.A && p.B);
  const unanalysed = R.filter((x) => !x.analysed).length;
  if (unanalysed) area.notes.push(`${unanalysed} reference band(s) were not analysed (element cap); only their height and background are scored`);
  const runs = matched.filter((p) => p.aRun.length > 1 || p.bRun.length > 1);
  if (runs.length) area.notes.push(`composite bands aligned as one: ${runs.map((p) => `reference #${p.A.i} = build #${p.B.i}`).join(', ')}`);

  // sequence: coarse role classes only (hero / content / footer); a run aligned with one band counts once
  if (R.length) {
    const sum = matched.reduce((a, p) => a + coarsePos(p.A, p.B), 0);
    const unitsA = pairs.filter((p) => p.A).length, unitsB = pairs.filter((p) => p.B).length;
    const s = sum / Math.max(unitsA, unitsB);
    const items = [];
    const prevBuild = (k) => { for (let q = k; q >= 0; q--) if (pairs[q].B) return pairs[q].B.i; return null; };
    pairs.forEach((p, k) => {
      if (p.A && !p.B) {
        const a = p.A, after = prevBuild(k);
        items.push({ s: 0, w: 1, what: `reference ${bandName(a)} has no counterpart`, ref: describeBand(a), build: 'missing',
          fix: `Add a band like reference band #${a.i} (${describeBand(a)}), about ${Math.round(a.vh * 900)}px tall, ${after != null ? `after build band #${after}` : 'at the top of the page'}.` });
      } else if (!p.A && p.B) {
        const b = p.B;
        items.push({ s: 0, w: 1, what: `build band #${b.i} has no counterpart in the reference`, ref: 'none', build: describeBand(b),
          fix: `Build band #${b.i} (${describeBand(b)}) has no counterpart in the reference band sequence; remove it or merge its content into a neighbouring band.` });
      } else if (p.A) {
        const a = p.A, b = p.B, rs = coarsePos(a, b);
        if (rs < 1) items.push({ s: rs, w: 1, what: `${bandName(a)} position in the page`, ref: a.coarse, build: `${b.coarse} (build band #${b.i})`,
          fix: a.coarse === 'hero' ? `Reference band #${a.i} is the hero (first content band holding the page title, >= 30% of the viewport tall); build band #${b.i} is not. Put the page title (h1) and the hero media in the first content band.` : a.coarse === 'footer' ? `Reference band #${a.i} is the footer; build band #${b.i} is not. End the page with a <footer> band.` : `Build band #${b.i} reads as the ${b.coarse} but reference band #${a.i} is a content band; restructure it.` });
      }
    });
    area.add('sequence', W.sequence, s, { detail: `ref ${R.length} bands [${R.map((x) => x.coarse[0]).join('')}], build ${B.length} [${B.map((x) => x.coarse[0]).join('')}] (h hero, c content, f footer), ${matched.length} aligned${runs.length ? ` (${runs.length} as composite runs)` : ''}`, items: combine(items.length ? items : [{ s: 1, w: 1 }]).items });
  } else area.add('sequence', W.sequence, null, { detail: 'reference has no bands' });

  // per-pair attributes (a composite run is checked as one merged band)
  const per = (fn) => combine(matched.map((p) => fn(p.A, p.B)));
  const add = (name, w, c, detail) => area.add(name, w, c.s, { detail, items: c.items });
  add('bandHeight', W.bandHeight, per((a, b) => pairChecks.height(a, b, vp)), 'band height in viewport heights, aligned pairs');
  add('bandBg', W.bandBg, per((a, b) => bgItem(a, b)), 'background type, colour and light/dark rhythm per band');
  add('columns', W.columns, per((a, b) => pairChecks.cols(a, b, vp)), 'main row column count and width ratios');
  add('cards', W.cards, per((a, b) => pairChecks.cards(a, b, vp)), 'card grid columns, count (one row slack), card surfaces');
  add('align', W.align, per((a, b) => pairChecks.align(a, b, vp)), 'text alignment per band');
  add('media', W.media, per((a, b) => pairChecks.media(a, b, vp)), 'largest media placement per band (img, svg, background image and CSS art are equivalent)');
  add('padding', W.padding, per((a, b) => pairChecks.pad(a, b, vp)), 'band top/bottom inner space (gaps on a shared background split evenly)');

  // container: the painted content column
  // width: rail against rail; a reference measured from its running text only (no rails) is compared
  // with the build's running-text extent, never with the build's rail
  const refC = ref.spacing?.container?.[vp], buildC = build.spacing?.container?.[vp];
  const rc = contentCol(refC), bc = buildCol(rc, buildC);
  if (isNum(rc.width)) {
    const s = isNum(bc.width) ? lin(relErr(rc.width, bc.width), L.containerRel) : 0;
    const what = rc.rail ? 'Cards, media and rules' : rc.text ? 'Running text' : 'Text and media';
    area.add('container', W.container, s, { detail: `content ${rc.rail ? 'rail (cards, media, rules)' : 'column (running text, no rails)'} ${rc.width} vs ${bc.width ?? 'n/a'} px wide`,
      finding: { what: 'content column width at 1440', ref: px(rc.width), build: bc.width == null ? 'n/a' : px(bc.width), fix: `${what} span ${bc.width == null ? '?' : px(bc.width)} at 1440 (from ${bc.railLeft ?? '?'} to ${bc.right ?? '?'}px); reference ${rc.rail ? 'rail' : 'content'} spans ${px(rc.width)} (from ${rc.railLeft}px to ${rc.right}px). Set the container so its inner content box is ${px(rc.width)} wide.` } });
  } else area.add('container', W.container, null, { detail: 'reference container not measured' });
  const te = textEdgeItem(refC, buildC, vp, L.gutterPx);
  if (te) {
    const tr = textCol(refC, 1440), tb = textCol(buildC, 1440);
    area.add('gutter', W.gutter * (te.w ?? 1), te.s, { detail: (te.w < 1 ? 'text edge from <= 1 band on a side (reduced weight); ' : '') + (tr && tr.centred && tb && tb.centred ? `centred text columns ${tr.width} vs ${tb.width} px wide (half the difference scored as the edge shift)` : `${rc.text ? 'running text' : 'content'} left edge ${rc.left} vs ${bc.left ?? contentCol(buildC).left ?? 'n/a'}`), finding: te });
  } else area.add('gutter', W.gutter, null);

  // nav (position, height, transparency, blur; the scrolled state is scored in motion)
  const rn = ref.spacing?.nav, bn = build.spacing?.nav;
  if (rn && rn.pos) {
    let s = 0;
    if (bn && bn.pos) s = rn.pos === bn.pos ? 1 : isPinned(rn.pos) && isPinned(bn.pos) ? 0.8 : !isPinned(rn.pos) && !isPinned(bn.pos) ? 0.8 : 0;
    area.add('navPosition', W.navPosition, s, { detail: `nav position ${rn.pos} vs ${bn?.pos ?? 'none'}`,
      finding: { what: 'nav position', ref: rn.pos, build: bn?.pos ?? 'no nav found', fix: bn?.pos
        ? `Nav is position: ${bn.pos}; reference is ${rn.pos}${isPinned(rn.pos) ? ' (stays pinned at the top while scrolling)' : ' (scrolls away with the page)'}. Set the header to position: ${rn.pos}${isPinned(rn.pos) ? '; top: 0' : ''}.`
        : `No header/nav was detected in the build; reference has a ${rn.pos} nav ${rn.h}px tall. Add a <header> with a <nav> of ${rn.linkCount ?? 'several'} links.` } });
    const parts = [];
    if (isNum(rn.h)) parts.push({ s: bn && isNum(bn.h) ? lin(relErr(rn.h, bn.h), L.navHeightRel) : 0, w: 0.5, what: 'nav height', ref: px(rn.h), build: bn?.h != null ? px(bn.h) : 'n/a', fix: `Nav is ${bn?.h != null ? px(bn.h) : '?'} tall; reference is ${px(rn.h)}. Set the header height to ${px(rn.h)}.` });
    // a transparent nav over a page of the solid side's nav colour looks solid: the colour seen in the
    // transparent side's nav band (sections[].bg.sampled, sampledShare >= navSeen.share) within
    // navSeen.deltaE of the other side's opaque nav background, and not over hero media, is a match
    let navSame = false;
    if (bn && rn.transparent !== bn.transparent && bn.transparent != null) {
      const [t, sd, tCap] = rn.transparent ? [rn, bn, ref] : [bn, rn, build];
      const nb = (tCap.sections || []).find((x) => x && x.role === 'nav')?.bg;
      const solid = col(sd.bg);
      navSame = !t.overHero && !!nb && isNum(nb.sampledShare) && nb.sampledShare >= L.navSeen.share && !!solid && solid.alpha >= 0.9
        && (dE(nb.sampled, solid.hex) ?? 1) <= L.navSeen.deltaE;
    }
    if (rn.transparent != null) parts.push({ s: bn && (bn.transparent === rn.transparent || navSame) ? 1 : 0, w: 0.3, what: 'nav background', ref: rn.transparent ? `transparent${navSame ? ' (over the same colour)' : ''}` : `solid ${rn.bg ?? ''}`, build: bn ? (bn.transparent ? `transparent${navSame ? ' (over the same colour)' : ''}` : `solid ${bn.bg ?? ''}`) : 'n/a',
      fix: rn.transparent ? `Nav has a solid background in the build; reference nav is transparent over the content${rn.blur ? ` with backdrop-filter: ${rn.blur}` : ''}. Remove its background colour.` : `Nav is transparent in the build; reference nav has a solid ${rn.bg ?? ''} background. Give the header background: ${rn.bg ?? 'the page colour'}.` });
    parts.push({ s: !!rn.blur === !!bn?.blur ? 1 : 0, w: 0.2, what: 'nav backdrop blur', ref: rn.blur || 'none', build: bn?.blur || 'none',
      fix: rn.blur ? `Add backdrop-filter: ${rn.blur} to the nav, as the reference does.` : `Remove the nav's backdrop-filter (${bn?.blur}); the reference nav has none.` });
    const c = combine(parts);
    area.add('navStyle', W.navStyle, c.s, { detail: 'nav height, transparency, blur', items: c.items });
  } else { area.add('navPosition', W.navPosition, null); area.add('navStyle', W.navStyle, null); }

  // page length
  const rh = ref.meta?.pageHeight?.[vp], bh = build.meta?.pageHeight?.[vp];
  if (isNum(rh) && rh > 0) {
    const s = isNum(bh) && bh > 0 ? lin(logRatio(rh, bh), L.pageLengthLog) : 0;
    area.add('pageLength', W.pageLength, s, { detail: `${r2(rh / 900)} vs ${isNum(bh) ? r2(bh / 900) : 'n/a'} viewport heights`,
      finding: { what: 'page length at 1440', ref: `${r2(rh / 900)} vh (${rh}px)`, build: isNum(bh) ? `${r2(bh / 900)} vh (${bh}px)` : 'n/a', fix: `Page is ${isNum(bh) ? bh : '?'}px tall at 1440; reference is ${rh}px. ${bh < rh ? 'Add bands or make existing bands taller' : 'Remove bands or tighten band heights'} to reach about ${rh}px.` } });
  } else area.add('pageLength', W.pageLength, null);

  // shape: radii and button size
  const rr = ref.spacing?.radius || {}, br = build.spacing?.radius || {};
  const rad = (k, w, label) => {
    const a = rr[k], b = br[k];
    if (a == null) return null;
    let s;
    if (b == null) s = 0.5;
    else if (a === 'pill' || b === 'pill') s = a === b ? 1 : 0;
    else s = lin(Math.abs(a - b) / Math.max(a, b, 4), L.radiusRel);
    return { s, w, what: `${label} corner radius`, ref: a === 'pill' ? 'pill' : px(a), build: b == null ? 'n/a' : b === 'pill' ? 'pill' : px(b),
      fix: `${cap(label)} corner radius is ${b == null ? 'not measured' : b === 'pill' ? 'pill' : px(b)}; reference is ${a === 'pill' ? 'fully rounded (pill)' : px(a)}. Set border-radius: ${a === 'pill' ? '999px' : px(a)} on ${label}s.` };
  };
  const shape = [rad('button', 0.4, 'button'), rad('card', 0.3, 'card')];
  const rpb = ref.components?.primaryButton, bpb = build.components?.primaryButton;
  if (rpb && isNum(rpb.h)) shape.push({ s: bpb && isNum(bpb.h) ? lin(relErr(rpb.h, bpb.h), L.buttonHeightRel) : 0.5, w: 0.3, what: 'primary button height', ref: px(rpb.h), build: bpb?.h != null ? px(bpb.h) : 'n/a',
    fix: `Primary button (${bpb?.desc || 'not found'}) is ${bpb?.h != null ? px(bpb.h) : '?'} tall; reference (${rpb.desc}) is ${px(rpb.h)} (padding ${(rpb.pad || []).join(' ')}px). Set its padding/line-height to reach ${px(rpb.h)}.` });
  if (Array.isArray(ref.spacing?.shadows)) {
    const na = ref.spacing.shadows.reduce((a, x) => a + (x.n || 1), 0), nb = (build.spacing?.shadows || []).reduce((a, x) => a + (x.n || 1), 0);
    const q = presence(na > 0, nb > 0);
    shape.push({ s: q.s, w: q.absent ? 0.1 : 0.2, what: 'box shadows', ref: na ? `${na} elements (e.g. ${ref.spacing.shadows[0].css} on ${ref.spacing.shadows[0].on})` : 'none', build: nb ? `${nb} elements` : 'none',
      fix: q.kind === 'missing' ? `Reference uses box-shadow on ${na} elements (e.g. ${ref.spacing.shadows[0].css} on ${ref.spacing.shadows[0].on}); the build uses none. Add that shadow to the same components.` : `The build uses box-shadow on ${nb} elements (e.g. ${build.spacing?.shadows?.[0]?.css} on ${build.spacing?.shadows?.[0]?.on}); the reference uses none. Remove the shadows (use borders/flat surfaces as the reference does).` });
  }
  const sc = combine(shape);
  area.add('shape', W.shape, sc.s, { detail: 'button/card radius, primary button height, shadow use', items: sc.items });

  // spacing rhythm: modal grid/flex gap and heading->text distance
  const sp = [];
  const ga = ref.spacing?.gaps?.[vp]?.[0]?.px, gb = build.spacing?.gaps?.[vp]?.[0]?.px;
  if (isNum(ga)) sp.push({ s: isNum(gb) ? lin(Math.abs(ga - gb) / Math.max(ga, 8), L.spacingRel) : 0.5, w: 0.5, what: 'most common grid/flex gap', ref: px(ga), build: isNum(gb) ? px(gb) : 'n/a',
    fix: `The most common grid/flex gap is ${isNum(gb) ? px(gb) : 'not set'}; reference uses ${px(ga)}. Use gap: ${px(ga)} for card grids and button rows.` });
  const sa = ref.spacing?.stack?.[vp], sb = build.spacing?.stack?.[vp];
  const ha = sa?.headingToText, hb = sb?.headingToText;
  const at = (x, side) => (x ? ` (${side}: e.g. ${x.el} in band #${x.band})` : '');
  // a distance below stackMinPx (heading box overlapping its text) is not a visible gap: not scored
  if (isNum(ha) && ha >= L.stackMinPx && !(isNum(hb) && hb < L.stackMinPx)) sp.push({ s: isNum(hb) ? lin(Math.abs(ha - hb) / Math.max(ha, 8), L.spacingRel) : 0.5, w: 0.5, what: 'heading-to-text spacing', ref: px(ha) + at(sa.headingToTextAt, 'ref'), build: isNum(hb) ? px(hb) + at(sb.headingToTextAt, 'build') : 'n/a',
    fix: `Space between a heading and the text below it is ${isNum(hb) ? px(hb) : '?'}${at(sb?.headingToTextAt, 'most often')}; reference is ${px(ha)}${at(sa.headingToTextAt, 'e.g.')}. Set the heading margin-bottom so the gap is ${px(ha)}.` });
  const spc = combine(sp);
  area.add('spacing', W.spacing, spc.s, { detail: 'modal gap, heading-to-text distance', items: spc.items });

  return { area, pairs, R, B };
}
