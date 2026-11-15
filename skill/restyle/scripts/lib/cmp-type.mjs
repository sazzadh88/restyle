// Typography area (20): per-role size/weight/line-height/tracking/transform, font category,
// family pairing structure, scale ratios, role coverage (primary viewport).
import fs from 'node:fs';
import { TYPE as T, PRIMARY_VP } from './cmp-constants.mjs';
import { Area, align, combine, lin, relErr, isNum, r2, r3 } from './cmp-util.mjs';

/** Roles at a viewport; display is dropped when it is the same size as h1 (same element). */
export function rolesAt(cap, vp) {
  const r = { ...(cap.type?.roles?.[vp] || {}) };
  for (const k of Object.keys(r)) if (!r[k] || !isNum(r[k].px)) delete r[k];
  if (r.display && r.h1 && Math.abs(r.display.px - r.h1.px) <= 1) delete r.display;
  return r;
}

const HEADING_ROLES = ['display', 'h1', 'h2', 'h3'];
/**
 * Pairs the build's roles with the reference's. Non-heading roles pair by name. Heading roles are
 * visual size tiers: when both sides have the same set of heading roles they pair by name (the usual
 * case, unchanged); otherwise the size-sorted tier lists are aligned (TYPE.tierAlign), so a tier that
 * one side labels by another tag (two h1 elements, an h2 used as the hero title) is compared with its
 * size twin and never reads as a missing role plus an extra one. Tags are never scored.
 * Returns { RB: build roles keyed by the reference role they pair with, extra: [{r, v}] unpaired build
 * roles, renamed: ['h2<-h1', ...] }.
 */
export function pairRoles(RA, RB) {
  const out = {}, extra = [], renamed = [];
  for (const [r, v] of Object.entries(RB)) if (!HEADING_ROLES.includes(r)) { if (RA[r]) out[r] = v; else extra.push({ r, v }); }
  const ha = HEADING_ROLES.filter((r) => RA[r]), hb = HEADING_ROLES.filter((r) => RB[r]);
  if (ha.length === hb.length && ha.every((r) => RB[r])) { for (const r of ha) out[r] = RB[r]; return { RB: out, extra, renamed }; }
  const bySize = (R, list) => list.map((r) => ({ r, px: R[r].px })).sort((x, y) => y.px - x.px);
  const A = bySize(RA, ha), B = bySize(RB, hb);
  const pairs = align(A, B, (a, b) => lin(relErr(a.px, b.px), T.tierSizeRel), T.tierAlign);
  for (const p of pairs) {
    if (p.a != null && p.b != null) { const ra = A[p.a].r, rb = B[p.b].r; out[ra] = RB[rb]; if (ra !== rb) renamed.push(`${ra}<-${rb}`); }
    else if (p.b != null) extra.push({ r: B[p.b].r, v: RB[B[p.b].r] });
  }
  return { RB: out, extra, renamed };
}
/** Ink is measured on both sides for this role: visual heaviness is scored by ink, not by weight. */
export const inkOnBoth = (a, b) => !!a && !!b && isNum(a.ink) && a.ink > 0 && isNum(b.ink);
function familyOf(cap, family) { return (cap.type?.families || []).find((x) => x.family === family) || null; }
function categoryOf(cap, family) { return familyOf(cap, family)?.category || null; }
const WIDTH_ORDER = { condensed: 0, normal: 1, extended: 2 };
const where = (r) => (r && r.ex ? ` (e.g. ${r.ex}${isNum(r.band) ? ` in band #${r.band}` : ''})` : '');
// the weight a role is seen at: the rendered (nearest loaded face) weight, synthesised bold folded in
const ew = (r) => (isNum(r.weight) ? r.weight : null);
const lh = (v) => (isNum(v) ? v : T.normalLineHeight);
const tt = (v) => (v && v !== 'none' ? v : 'none');

/** Size items for the given roles at vp (also used by responsive). */
export function sizeItems(RA, RB, vp) {
  const items = [];
  for (const [role, a] of Object.entries(RA)) {
    const b = RB[role];
    if (!b) continue;
    const s = lin(relErr(a.px, b.px), T.sizeRel);
    items.push({ s, w: T.roleWeights[role] || 1, what: `${role} size at ${vp}`, ref: `${a.px}px${where(a)}`, build: `${b.px}px${where(b)}`,
      fix: `${role} is ${b.px}px at ${vp}${where(b)}; reference ${role} is ${a.px}px. Set ${roleSel(role)} font-size to ${a.px}px at ${vp}${vp === PRIMARY_VP ? '' : ' (media query)'}.` });
  }
  return items;
}
/** Rendered weight items for the given roles at vp (also used by responsive). Only for roles whose ink
 *  is not measured on both sides: ink is the visual heaviness, the weight number is how a builder gets
 *  there, so a weight raised on purpose to match the reference's ink never costs points. */
export function weightItems(RA, RB, vp) {
  const items = [];
  for (const [r, a] of Object.entries(RA)) {
    const b = RB[r];
    if (!b || !isNum(ew(a)) || inkOnBoth(a, b)) continue;
    const s = isNum(ew(b)) ? lin(Math.abs(ew(a) - ew(b)), T.weightSteps) : 0;
    const note = (x) => (x.synth ? ' (synthesised bold)' : x.declared && x.declared !== x.weight ? ` (declared ${x.declared}, rendered ${x.weight})` : '');
    items.push({ s, w: RW(r), what: `${r} weight at ${vp}`, ref: `${ew(a)}${note(a)}`, build: `${ew(b)}${note(b)}${where(b)}`,
      fix: `${r} renders at weight ${ew(b)}${note(b)} at ${vp}${where(b)}; reference renders ${ew(a)}. Use a substitute font that ships a ${ew(a)} face and set ${roleSel(r)} font-weight: ${ew(a)} (a weight the font lacks renders as its nearest face).` });
  }
  return items;
}
/** Ink items: how dark each role renders (stroke heaviness x weight x tracking), independent of the
 *  declared number. A substitute with thinner strokes reads lighter even at the same declared weight. */
export function inkItems(RA, RB, vp, buildCap) {
  const items = [];
  for (const [r, a] of Object.entries(RA)) {
    const b = RB[r];
    if (!b || !isNum(a.ink) || a.ink <= 0) continue;
    if (!isNum(b.ink)) { items.push({ s: 0.5, w: RW(r) }); continue; }
    const rel = (b.ink - a.ink) / a.ink;
    const pct = Math.round(Math.abs(rel) * 100);
    const lighter = rel < 0;
    const wa = ew(a), wb = ew(b);
    const at = isNum(wa) && isNum(wb) && wa === wb ? 'at the same rendered weight' : `at weight ${wb ?? '?'} (reference ${wa ?? '?'})`;
    const step = weightStep(b.family, wb, lighter, pct, buildCap && familyOf(buildCap, b.family), roleSel(r));
    const tail = step.none
      ? `${step.text}: switch to a ${lighter ? 'heavier' : 'lighter'}-stroked substitute (inspect.mjs fontmatch)`
      : `${step.text}, or switch to a ${lighter ? 'heavier' : 'lighter'}-stroked substitute or the family's ${lighter ? 'next heavier' : 'next lighter'} optical weight`;
    items.push({ role: r, s: lin(Math.abs(rel), T.inkRel), w: RW(r), what: `${r} visual heaviness (ink) at ${vp}`, ref: `${a.ink} (${a.family} ${wa})`, build: `${b.ink} (${b.family} ${wb})${where(b)}`,
      fix: `${r} renders ${pct}% ${lighter ? 'lighter' : 'heavier'} than the reference ${at} (ink ${b.ink} vs ${a.ink}; ${b.family} vs ${a.family}): ${tail}, and record the rendered-weight match in judged[]. Never fake weight (no font-synthesis, stroke or shadow).` });
  }
  return items;
}
/** Line-height items (also used by responsive). The rendered line box (`lhr`, line box height / font
 *  size, `normal` resolved to the font's real normal) is compared when both sides have it, so `normal`
 *  in one font and the same number set explicitly in another read the same; older captures fall back to
 *  the declared ratio with normal = 1.2. */
export function lineHeightItems(RA, RB, vp) {
  const items = [];
  for (const [r, a] of Object.entries(RA)) {
    const b = RB[r];
    if (!b) continue;
    const rendered = isNum(a.lhr) && a.lhr > 0 && isNum(b.lhr);
    const va = rendered ? a.lhr : lh(a.lh), vb = rendered ? b.lhr : lh(b.lh);
    const show = (x) => (rendered ? `${r2(x.lhr)} (line-height ${x.lh ?? 'normal'})` : x.lh ?? 'normal');
    const target = rendered ? (isNum(a.lh) ? a.lh : r2(a.lhr)) : a.lh ?? 'normal';
    items.push({ s: lin(Math.abs(va - vb) / va, T.lineHeightRel), w: RW(r), what: `${r} line-height at ${vp}`, ref: show(a), build: show(b),
      fix: `${r} ${rendered ? 'line box' : 'line-height'} is ${show(b)} at ${vp}${where(b)}; reference is ${show(a)}. Set ${roleSel(r)} line-height: ${target}.` });
  }
  return items;
}
/** Tracking item for one role. Letter-spacing sets how wide a line runs, and a substitute face that is
 *  narrower or wider than the reference's needs its own value to run the same width (fontmatch
 *  apply.letterSpacingEm). The difference scored is the smaller of the declared one (em) and the set-width
 *  one: line width per character at the role's px, px x (adv + ls) with adv the role's measured advance per
 *  em at letter-spacing 0, against the reference's, in reference em. Older captures without adv: declared. */
export function trackingItem(r, a, b) {
  const la = a.ls || 0, lb = b.ls || 0;
  const dDecl = Math.abs(la - lb);
  const setW = isNum(a.adv) && a.adv > 0 && isNum(b.adv) && b.adv > 0 && isNum(a.px) && a.px > 0 && isNum(b.px) && b.px > 0;
  const dSet = setW ? Math.abs(b.px * (b.adv + lb) - a.px * (a.adv + la)) / a.px : null;
  const bySet = dSet != null && dSet < dDecl;
  // the letter-spacing that runs the reference's set width in the build's face at the build's px
  const target = setW ? r3((a.px * (a.adv + la)) / b.px - b.adv) : la;
  const sw = (x) => (setW ? ` (set width ${r3(x.adv + (x.ls || 0))} em/char at ${x.px}px)` : '');
  return { s: lin(bySet ? dSet : dDecl, T.letterSpacingEm), w: RW(r), what: `${r} letter-spacing`, ref: `${la}em${sw(a)}`, build: `${lb}em${sw(b)}`,
    fix: setW
      ? `${r} letter-spacing is ${lb}em; reference is ${la}em in its own face. Set ${roleSel(r)} letter-spacing to ${target}em, which runs the reference's line width in this face at ${b.px}px (fontmatch apply.letterSpacingEm), or ${la}em to copy the declared value.`
      : `${r} letter-spacing is ${lb}em; reference is ${la}em. Set ${roleSel(r)} letter-spacing: ${la}em.` };
}
// Available weights of a build family: the bundled Google Fonts list (weights / wght axis) first, else
// the capture's family record (variable range, or the faces seen); null when unknown (system fonts).
let GF = null;
function googleFamily(name) {
  if (!GF) {
    GF = new Map();
    try {
      const j = JSON.parse(fs.readFileSync(new URL('./google-fonts.json', import.meta.url), 'utf8'));
      for (const f of j.families || []) GF.set(String(f.family).toLowerCase(), f);
    } catch { /* no list: fall back to the capture */ }
  }
  return GF.get(String(name || '').toLowerCase()) || null;
}
function weightsOf(family, fam) {
  const g = googleFamily(family);
  if (g) {
    const ax = (g.axes || []).find((x) => x.tag === 'wght');
    if (ax) return { variable: true, lo: ax.min, hi: ax.max, src: 'Google Fonts' };
    if (g.variable && Array.isArray(g.weights) && g.weights.length === 2) return { variable: true, lo: g.weights[0], hi: g.weights[1], src: 'Google Fonts' };
    return { variable: false, list: [...(g.weights || [])].sort((x, y) => x - y), src: 'Google Fonts' };
  }
  if (fam && fam.variable) return { variable: true, lo: 100, hi: 900, src: 'capture', unsure: true };
  return null;
}
/** The weight step an ink finding advises: within the family's real weights (a variable wght range, or
 *  the next static face in the needed direction); none when the family has no heavier/lighter face. */
export function weightStep(family, wb, lighter, pct, fam, sel = 'the role') {
  const av = weightsOf(family, fam);
  const dir = lighter ? 'heavier' : 'lighter';
  if (!isNum(wb)) return { text: `use a ${dir} face of ${family}` };
  if (av && av.variable) {
    const want = wb + (lighter ? 1 : -1) * Math.max(20, Math.min(100, Math.round(pct * 2.5 / 10) * 10));
    const t = Math.max(av.lo, Math.min(av.hi, want));
    if ((lighter && wb >= av.hi) || (!lighter && wb <= av.lo)) return { none: true, text: `${family} has no ${dir} weight (its weight axis is ${av.lo}-${av.hi})` };
    return { text: `${lighter ? 'raise' : 'lower'} ${sel} font-weight in 20-50 unit steps (${family} is variable, ${av.lo}-${av.hi}; try ${t})` };
  }
  if (av && av.list && av.list.length) {
    const next = lighter ? av.list.find((w) => w > wb) : [...av.list].reverse().find((w) => w < wb);
    if (next == null) return { none: true, text: `${family} has no ${dir} face (${av.src}: ${av.list.join('/')} only)` };
    return { text: `use the ${next} face of ${family}` };
  }
  return { text: `use the next ${dir} face of ${family} if it has one` };
}
const RW = (r) => T.roleWeights[r] || 1;
const roleSel = (r) => ({ display: 'the largest display text', body: 'body/paragraph', small: 'small text/captions', nav: 'nav link', button: 'button label', eyebrow: 'eyebrow label' }[r] || r);

export function scoreType(ref, build) {
  const area = new Area('type', 20);
  const vp = PRIMARY_VP;
  const RA = rolesAt(ref, vp);
  const paired = pairRoles(RA, rolesAt(build, vp));
  const RB = paired.RB;
  if (paired.renamed.length) area.notes.push(`heading tiers paired by size: ${paired.renamed.join(', ')} (reference<-build)`);
  const W = T.weights, RWo = T.roleWeights;
  const roles = Object.keys(RA);
  if (!roles.length) {
    for (const k of Object.keys(W)) area.add(k, W[k], null, { detail: 'reference has no type roles' });
    return { area };
  }
  const both = roles.filter((r) => RB[r]);
  const per = (fn) => combine(both.map((r) => fn(r, RA[r], RB[r])).filter(Boolean));
  const add = (name, c, detail) => area.add(name, W[name], c.s, { detail, items: c.items });

  add('size', combine(sizeItems(RA, RB, vp)), 'font size per role, relative error');
  add('weight', combine(weightItems(RA, RB, vp)), 'rendered font weight per role, only for roles whose ink is not measured on both sides');
  add('ink', combine(inkItems(RA, RB, vp, build)), 'visual heaviness per role: ink coverage of a fixed sample drawn in the role\'s exact font, relative error');
  add('lineHeight', combine(lineHeightItems(RA, RB, vp)), 'line-height ratio per role');
  add('letterSpacing', per(trackingItem), 'tracking per role, em: the declared value, or the set width it produces (role adv + ls at its px, against the reference\'s) when that is closer; a substitute face needs its own tracking');
  add('transform', per((r, a, b) => ({ s: tt(a.tt) === tt(b.tt) ? 1 : 0, w: RWo[r] || 1, what: `${r} text-transform`, ref: tt(a.tt), build: tt(b.tt),
    fix: `${r} text-transform is ${tt(b.tt)}; reference is ${tt(a.tt)}. Set ${roleSel(r)} text-transform: ${tt(a.tt)}.` })), 'text-transform per role');
  add('category', per((r, a, b) => {
    const ca = categoryOf(ref, a.family), cb = categoryOf(build, b.family);
    if (!ca) return null;
    const s = !cb ? 0.5 : ca === cb ? 1 : (ca === 'display' && cb === 'sans') || (ca === 'sans' && cb === 'display') ? T.displayCategoryVsSans : 0;
    return { s, w: RWo[r] || 1, what: `${r} font category`, ref: `${ca} (${a.family})`, build: `${cb ?? '?'} (${b.family})`,
      fix: `${r} uses a ${cb ?? 'unknown'} font (${b.family}); reference uses a ${ca} font. Substitute a free ${ca} family for ${roleSel(r)} (see font-substitutes).` };
  }), 'sans/serif/mono per role from family names (display counts as sans at 0.8; families are substituted by design)');
  // measured proportions of each role's family: width class + advance width, and x-height
  add('width', per((r, a, b) => {
    const fa = familyOf(ref, a.family), fb = familyOf(build, b.family);
    if (!fa || !isNum(fa.adv)) return null;
    if (!fb || !isNum(fb.adv)) return { s: 0.5, w: RW(r) };
    const dc = Math.abs((WIDTH_ORDER[fa.width] ?? 1) - (WIDTH_ORDER[fb.width] ?? 1));
    const s = 0.5 * (dc === 0 ? 1 : dc === 1 ? T.widthClassAdjacent : 0) + 0.5 * lin(relErr(fa.adv, fb.adv), T.widthAdvRel);
    return { s, w: RW(r), what: `${r} font width`, ref: `${fa.width} (${fa.adv} em/char, ${a.family})`, build: `${fb.width} (${fb.adv} em/char, ${b.family})`,
      fix: `${r} font ${b.family} is ${fb.width} (${fb.adv} em per character); reference ${a.family} is ${fa.width} (${fa.adv}). Pick a substitute with a ${fa.width} width (advance about ${fa.adv} em per character).` };
  }), 'width class and advance width per em of each role family (measured)');
  add('xHeight', per((r, a, b) => {
    const fa = familyOf(ref, a.family), fb = familyOf(build, b.family);
    if (!fa || !isNum(fa.xHeight) || fa.xHeight <= 0) return null;
    if (!fb || !isNum(fb.xHeight)) return { s: 0.5, w: RW(r) };
    const s = lin(relErr(fa.xHeight, fb.xHeight), T.xHeightRel);
    return { s, w: RW(r), what: `${r} x-height`, ref: `${fa.xHeight} em (${a.family})`, build: `${fb.xHeight} em (${b.family})`,
      fix: `${r} font ${b.family} has an x-height of ${fb.xHeight} em; reference ${a.family} has ${fa.xHeight} em. Pick a substitute with a closer x-height.` };
  }), 'x-height / em of each role family (measured)');

  // pairing: same family for heading and body, or two families
  const hA = RA.h1 || RA.display || RA.h2, bA = RA.body;
  const hB = RB.h1 || RB.display || RB.h2, bB = RB.body;
  if (hA && bA) {
    const sameA = hA.family === bA.family;
    const sameB = hB && bB ? hB.family === bB.family : null;
    const s = sameB == null ? 0 : sameA === sameB ? 1 : 0;
    area.add('pairing', W.pairing, s, { detail: `ref ${sameA ? 'one family' : 'two families'}, build ${sameB == null ? 'n/a' : sameB ? 'one family' : 'two families'}`,
      finding: { what: 'heading/body family pairing', ref: sameA ? `one family (${bA.family})` : `${hA.family} + ${bA.family}`, build: hB && bB ? (sameB ? `one family (${bB.family})` : `${hB.family} + ${bB.family}`) : 'n/a',
        fix: sameA ? `Build uses different families for headings and body; reference uses one family (${bA.family}) for both. Use a single substitute family for headings and body.` : `Build uses one family for headings and body; reference pairs ${categoryOf(ref, hA.family) || ''} ${hA.family} headings with ${categoryOf(ref, bA.family) || ''} ${bA.family} body. Use two substitute families in the same categories.` } });
  } else area.add('pairing', W.pairing, null);

  // scale ratios role/body
  if (RA.body && RB.body) {
    const items = both.filter((r) => r !== 'body').map((r) => {
      const ra = RA[r].px / RA.body.px, rb = RB[r].px / RB.body.px;
      return { s: lin(relErr(ra, rb), T.scaleRel), w: RWo[r] || 1, what: `${r}/body size ratio`, ref: r2(ra), build: r2(rb),
        fix: `${r} is ${r2(rb)}x the body size; reference is ${r2(ra)}x (${RA[r].px}px over ${RA.body.px}px). Keep the reference's type scale: ${r} = ${r2(ra)} x body.` };
    });
    const c = combine(items);
    area.add('scale', W.scale, c.s, { detail: 'role size / body size, relative error', items: c.items });
  } else area.add('scale', W.scale, RA.body ? 0 : null);

  // coverage
  const tot = roles.reduce((a, r) => a + (RWo[r] || 1), 0);
  const missing = roles.filter((r) => !RB[r]);
  // an unpaired build display tier is the largest text and is not counted as an extra role
  const extra = paired.extra.filter((x) => x.r !== 'display');
  const lost = missing.reduce((a, r) => a + (RWo[r] || 1), 0) + T.extraRolePenalty * extra.reduce((a, x) => a + (RWo[x.r] || 1), 0);
  const isHead = (r) => HEADING_ROLES.includes(r);
  const items = [
    ...missing.map((r) => ({ s: 0, w: RWo[r] || 1, what: `${r} role missing`, ref: `${RA[r].px}px/${RA[r].weight}${RA[r].tt ? ' ' + RA[r].tt : ''}`, build: 'absent',
      fix: isHead(r) ? `The build has no heading tier near ${RA[r].px}px; reference ${r} tier is ${RA[r].px}px/${RA[r].weight}${RA[r].tt ? ` ${RA[r].tt}` : ''}${where(RA[r])}. Give headings of that level that size and weight (any tag).`
        : `The build has no ${r} text; reference ${r} is ${RA[r].px}px/${RA[r].weight}${RA[r].tt ? ` ${RA[r].tt}` : ''}${RA[r].ls ? ` tracking ${RA[r].ls}em` : ''}. Add ${r === 'eyebrow' ? 'a short uppercase label above section headings' : `${roleSel(r)} text`} in that style.` })),
    ...extra.map(({ r, v }) => ({ s: 0, w: T.extraRolePenalty * (RWo[r] || 1), what: `${r} role not in the reference`, ref: 'absent', build: `${v.px}px${where(v)}`,
      fix: isHead(r) ? `The build has a heading size tier (${v.px}px${where(v)}) that the reference does not use; resize those headings to one of the reference tiers (${HEADING_ROLES.filter((k) => RA[k]).map((k) => `${RA[k].px}px`).join(', ')}).`
        : `The build has ${r} text (${v.px}px) that the reference does not use; remove it or restyle it as an existing role.` })),
  ];
  area.add('coverage', W.coverage, Math.max(0, 1 - lost / tot), { detail: `missing [${missing.join(' ')}], extra [${extra.map((x) => `${x.r} ${x.v.px}px`).join(', ')}]${paired.renamed.length ? `, tiers paired by size [${paired.renamed.join(' ')}]` : ''}`, items: combine(items).items });
  return { area };
}
