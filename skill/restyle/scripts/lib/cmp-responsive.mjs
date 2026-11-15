// Responsive area (15): layout/type checks repeated at 768 and 390, each viewport's band sequence
// aligned on its own (bands are segmented independently per viewport), hidden bands, plus hard
// penalties for horizontal overflow and console errors in the build.
import { RESPONSIVE as RS, LAYOUT as L, NARROW_VPS, VP_HEIGHT, PRIMARY_VP } from './cmp-constants.mjs';
import { Area, combine, lin, relErr, logRatio, isNum, r2, px } from './cmp-util.mjs';
import { normBands, alignBands, pairChecks, coarsePos, contentCol, buildCol, textEdgeItem, mergeBands } from './cmp-layout.mjs';
import { rolesAt, pairRoles, inkOnBoth, sizeItems, weightItems, inkItems, lineHeightItems } from './cmp-type.mjs';

/**
 * Mobile-only alternates: a narrow-viewport band not linked to any primary band (`link: null`) that sits
 * where hidden primary bands were (between the narrow bands of the primary bands before and after them)
 * stands for one of them. With several hidden candidates in the gap, the one the same alternate (same id)
 * replaces unambiguously at another width wins, then a role match, then the last candidate.
 * Returns {vp: Set(primary band index)}.
 */
const ALT_CACHE = new WeakMap();
export function alternatesOf(cap) {
  if (ALT_CACHE.has(cap)) return ALT_CACHE.get(cap);
  const out = {};
  const prim = (cap.sections || []).filter((b) => b && b.role !== 'nav' && isNum(b.i));
  const found = []; // {vp, id, role, cands}
  for (const [vp, listAll] of Object.entries(cap.sectionsByViewport || {})) {
    out[vp] = new Set();
    const list = (listAll || []).filter((b) => b && b.role !== 'nav' && b.role !== 'ad' && !b.thirdParty);
    const linkOf = (b) => (isNum(b.link) ? b.link : null);
    for (let k = 0; k < list.length; k++) {
      if (!('link' in list[k]) || list[k].link !== null) continue;
      let prev = -Infinity, next = Infinity;
      for (let q = k - 1; q >= 0; q--) if (linkOf(list[q]) != null) { prev = linkOf(list[q]); break; }
      for (let q = k + 1; q < list.length; q++) if (linkOf(list[q]) != null) { next = linkOf(list[q]); break; }
      const cands = prim.filter((b) => b.i > prev && b.i < next && b.collapse && b.collapse[vp] === null);
      if (cands.length) found.push({ vp, id: list[k].id ?? null, role: list[k].role, cands });
    }
  }
  const byId = {};
  for (const f of found) if (f.cands.length === 1) { out[f.vp].add(f.cands[0].i); if (f.id) byId[f.id] = f.cands[0].i; }
  for (const f of found) {
    if (f.cands.length === 1) continue;
    const free = f.cands.filter((b) => !out[f.vp].has(b.i));
    if (!free.length) continue;
    const pick = free.find((b) => f.id && byId[f.id] === b.i) || (free.filter((b) => b.role === f.role).length === 1 ? free.find((b) => b.role === f.role) : null) || free[free.length - 1];
    out[f.vp].add(pick.i);
  }
  ALT_CACHE.set(cap, out);
  return out;
}
export const hasAlternate = (cap, i, vp) => !!alternatesOf(cap)[vp]?.has(Number(String(i).split('-')[0]));
/** Whether a (possibly merged) primary band is not rendered at vp: every member collapsed to null and
 *  without a same-position mobile alternate. null when the capture does not say. */
export function hiddenAt(cap, band, vp) {
  const members = band.members || [band];
  if (!members.every((m) => m.collapse && vp in m.collapse)) return null;
  return members.every((m) => m.collapse[vp] === null && !hasAlternate(cap, m.i, vp));
}

/**
 * Narrow-band pairs linked through the primary (1440) alignment, so a band that re-segments at a narrow
 * width (one 1440 band shown as three bands at 390) is compared as one unit with its counterpart:
 * each aligned primary pair stands with the narrow bands linked to its members (`sectionsByViewport[vp][]
 * .link`, plus `sections[i].collapse[vp].bands`); pairs whose narrow sets overlap form one group; each side's
 * narrow bands of a group are merged (summed height, outer paddings, the tallest member's background,
 * columns, cards, alignment, media). Narrow bands left over (mobile-only bands, bands of unaligned
 * primary bands) are aligned with each other the usual way. Returns null when a capture carries no links
 * (older captures): the caller then aligns the narrow sequences on their own.
 */
export function linkedPairs(R, B, refCap, buildCap, primaryPairs, vp, alignPairs = null) {
  const hasLinks = (list) => list.length > 0 && list.some((x) => x.link !== undefined);
  if (!primaryPairs || !hasLinks(R) || !hasLinks(B)) return null;
  // a narrow band with the same id as a primary band is that band's element (ids hash the DOM signature,
  // equal at every width): this wins over `link`, which follows the first matching element of the band
  const primOf = (cap, list) => {
    const byId = new Map((cap.sections || []).filter((q) => q.id && q.role !== 'nav').map((q) => [q.id, q.i]));
    return new Map(list.map((x) => [x.i, x.id && byId.has(x.id) ? byId.get(x.id) : x.link]));
  };
  const linkA = primOf(refCap, R), linkB = primOf(buildCap, B);
  // narrow bands linked to one primary band (link, or its collapse[vp].bands)
  const linkedTo = (cap, list, links, pi) => {
    const sec = (cap.sections || []).find((q) => q.i === pi);
    return list.filter((x) => links.get(x.i) === pi || (sec?.collapse?.[vp]?.bands || []).includes(x.i));
  };
  // a primary band rendered at vp but linked to no narrow band (`collapse[vp].unlinked`: its rows were
  // regrouped into a container of another band, e.g. stacked listing rows in one wrapper) lives in the
  // narrow band of the nearest linked primary band before or after it whose page span (fraction of its
  // page height) contains the primary band's middle
  const homeOf = (cap, list, links, pi) => {
    const prim = (cap.sections || []).filter((q) => q && q.role !== 'nav' && isNum(q.i));
    const sec = prim.find((q) => q.i === pi), pH = cap.meta?.pageHeight?.[PRIMARY_VP];
    if (!sec || !isNum(sec.y) || !isNum(sec.h) || !isNum(pH) || pH <= 0) return null;
    let prev = null, next = null;
    for (const q of prim) {
      if (q.i === pi) continue;
      const nb = linkedTo(cap, list, links, q.i);
      if (!nb.length) continue;
      if (q.i < pi) prev = nb[nb.length - 1]; else if (!next) next = nb[0];
    }
    const mid = (sec.y + sec.h / 2) / pH;
    return [prev, next].find((x) => x && isNum(x.yTop) && isNum(x.yBot) && x.yTop <= mid && mid <= x.yBot) || null;
  };
  const narrowSet = (cap, list, band, links) => {
    const s = new Set();
    const idTaken = new Set(list.filter((x) => x.id && links.get(x.i) !== x.link).map((x) => x.i));
    for (const m of band.members || [band]) {
      const pi = Number(String(m.i).split('-')[0]);
      const before = s.size;
      for (const x of list) if (links.get(x.i) === pi) s.add(x.i);
      const sec = (cap.sections || []).find((q) => q.i === pi);
      for (const k of sec?.collapse?.[vp]?.bands || []) if (list.some((x) => x.i === k) && !(idTaken.has(k) && links.get(k) !== pi)) s.add(k);
      if (s.size === before && sec?.collapse?.[vp]?.unlinked) { const h = homeOf(cap, list, links, pi); if (h) s.add(h.i); }
    }
    return s;
  };
  const groups = [];
  for (const p of primaryPairs) {
    if (!p.A || !p.B) continue;
    const g = { a: narrowSet(refCap, R, p.A, linkA), b: narrowSet(buildCap, B, p.B, linkB) };
    if (!g.a.size && !g.b.size) continue;
    // merge with every earlier group sharing a narrow band on either side
    for (let k = groups.length - 1; k >= 0; k--) {
      const o = groups[k];
      if ([...g.a].some((x) => o.a.has(x)) || [...g.b].some((x) => o.b.has(x))) { for (const x of o.a) g.a.add(x); for (const x of o.b) g.b.add(x); groups.splice(k, 1); }
    }
    groups.push(g);
  }
  // unlinked narrow bands that this width's own alignment merged into a linked group's run (a run that
  // covers the same span and content, LAYOUT.merge: e.g. a footer strip with no DOM link cut off the band
  // it belongs to) join that group
  if (alignPairs) {
    const inGroup = (side, i) => groups.some((g) => g[side].has(i));
    for (const p of alignPairs) {
      if (!p.A || !p.B) continue;
      const ma = (p.A.members || [p.A]).map((x) => x.i), mb = (p.B.members || [p.B]).map((x) => x.i);
      if (ma.length < 2 && mb.length < 2) continue;
      const hit = groups.filter((g) => g.a.size && g.b.size && ma.some((i) => g.a.has(i)) && mb.some((i) => g.b.has(i)));
      if (hit.length !== 1) continue;
      for (const i of ma) if (!inGroup('a', i)) hit[0].a.add(i);
      for (const i of mb) if (!inGroup('b', i)) hit[0].b.add(i);
    }
  }
  const out = [], usedA = new Set(), usedB = new Set();
  const unit = (list, set) => { const run = list.filter((x) => set.has(x.i)); return run.length > 1 ? mergeBands(run) : run[0]; };
  for (const g of groups) {
    if (!g.a.size || !g.b.size) continue;
    for (const x of g.a) usedA.add(x);
    for (const x of g.b) usedB.add(x);
    const A = unit(R, g.a), Bb = unit(B, g.b);
    out.push({ A, B: Bb, linked: true, split: (A.members?.length || 1) !== (Bb.members?.length || 1) });
  }
  const restA = R.filter((x) => !usedA.has(x.i)), restB = B.filter((x) => !usedB.has(x.i));
  if (restA.length && restB.length) for (const p of alignBands(restA, restB)) if (p.A && p.B) out.push({ A: p.A, B: p.B, linked: false });
  return out;
}

export function scoreResponsive(ref, build, primaryPairs) {
  const area = new Area('responsive', 15);
  const W = RS.weights;
  const vps = NARROW_VPS.filter((vp) => (ref.meta?.viewports || []).map(String).includes(vp) || ref.sectionsByViewport?.[vp]);
  const buildVps = NARROW_VPS.filter((vp) => (build.meta?.viewports || []).map(String).includes(vp) || build.sectionsByViewport?.[vp]);
  if (build.meta?.fast && !buildVps.length) {
    area.notes.push('build capture is --fast (largest viewport only): responsive not scored; run a full capture for the final verify');
    return { area, partial: true };
  }
  const share = vps.length ? 1 / vps.length : 1;

  for (const vp of vps) {
    const R = normBands(ref.sectionsByViewport?.[vp], vp, ref.meta?.pageHeight?.[vp]);
    const B = normBands(build.sectionsByViewport?.[vp], vp, build.meta?.pageHeight?.[vp]);
    if (!R.length) { for (const k of ['heights', 'columns', 'padding', 'sequence', 'align', 'spacing']) area.add(`${vp} ${k}`, W[k] * share, null); }
    else {
      const pairs = alignBands(R, B);
      const m = pairs.filter((p) => p.A && p.B);
      // per-band checks: narrow bands linked back to their aligned 1440 bands (a band that re-segments at
      // this width is one unit), else (older captures) the narrow sequences aligned on their own
      const lp = linkedPairs(R, B, ref, build, primaryPairs?.pairs, vp, pairs);
      const cmpPairs = lp || m;
      if (lp && lp.some((p) => p.split)) area.notes.push(`${vp}: bands that re-segment at this width compared as one unit with their 1440 counterpart (${lp.filter((p) => p.split).map((p) => `reference #${p.A.i} = build #${p.B.i}`).join(', ')})`);
      const per = (fn) => combine(cmpPairs.map((p) => fn(p.A, p.B)));
      const hc = per((a, b) => pairChecks.height(a, b, vp, RS.heightLog));
      area.add(`${vp} heights`, W.heights * share, B.length ? hc.s : 0, { detail: 'band heights in viewport heights', items: hc.items });
      const cc = per((a, b) => {
        const c1 = pairChecks.cols(a, b, vp), c2 = (a.cards || b.cards) ? pairChecks.cards({ ...a, cards: a.cards && { ...a.cards, n: null, like: null } }, { ...b, cards: b.cards && { ...b.cards, n: null, like: null } }, vp) : null;
        const pk = pairChecks.peek(a, b, vp);
        const parts = [c1, c2].filter((x) => x && isNum(x.s));
        if (!parts.length && !pk) return null;
        let s = parts.length ? parts.reduce((acc, x) => acc + x.s, 0) / parts.length : 1;
        if (pk) s = (1 - RS.peekPart) * s + RS.peekPart * pk.s;
        const worst = [...parts, pk].filter(Boolean).sort((x, y) => x.s - y.s)[0];
        return { ...worst, s, w: (c1 || c2 || pk).w };
      });
      area.add(`${vp} columns`, W.columns * share, B.length ? cc.s : 0, { detail: 'columns, card columns and overflowing rows per band (collapse pattern, carousel peek)', items: cc.items });
      const pc = per((a, b) => pairChecks.pad(a, b, vp));
      area.add(`${vp} padding`, W.padding * share, B.length ? pc.s : 0, { detail: 'band top/bottom inner space', items: pc.items });
      const ac = per((a, b) => pairChecks.align(a, b, vp));
      area.add(`${vp} align`, W.align * share, B.length ? ac.s : 0, { detail: 'text alignment per band (centred vs left at this width)', items: ac.items });
      const gc = per((a, b) => {
        const ga = a.cards?.gap, gb = b.cards?.gap;
        if (!isNum(ga) || !a.analysed) return null;
        if (!isNum(gb)) return null;
        return { s: lin(Math.abs(ga - gb) / Math.max(ga, 8), L.spacingRel), w: 1, what: `band #${a.i} card gap at ${vp}`, ref: px(ga), build: px(gb),
          fix: `Cards in band #${a.i} (${a.role}) sit ${px(gb)} apart at ${vp} (build band #${b.i}); reference uses ${px(ga)}. Set the grid gap to ${px(ga)} at ${vp}.` };
      });
      area.add(`${vp} spacing`, W.spacing * share, gc.s, { detail: 'card grid gaps per band', items: gc.items });
      // a run of bands aligned with one band (composite band segmented differently) counts once; with links,
      // the units are the linked groups (same content by DOM signature, aligned at 1440) plus the bands left
      // over, so a band cut into row strips on one side only is never charged as missing/extra bands
      let seq, firstMiss, nAligned, merged;
      if (lp) {
        const used = (side) => new Set(lp.flatMap((p) => (p[side].members || [p[side]]).map((x) => x.i)));
        const uA = used('A'), uB = used('B');
        const leftA = R.filter((x) => !uA.has(x.i)), leftB = B.filter((x) => !uB.has(x.i));
        seq = lp.reduce((acc, p) => acc + coarsePos(p.A, p.B), 0) / Math.max(lp.length + leftA.length, lp.length + leftB.length, 1);
        firstMiss = leftA.length ? { A: leftA[0] } : leftB.length ? { B: leftB[0] } : null;
        nAligned = lp.length; merged = lp.some((p) => (p.A.members?.length || 1) > 1 || (p.B.members?.length || 1) > 1);
      } else {
        const unitsA = pairs.filter((p) => p.A).length, unitsB = pairs.filter((p) => p.B).length;
        seq = m.reduce((acc, p) => acc + coarsePos(p.A, p.B), 0) / Math.max(unitsA, unitsB || 1);
        firstMiss = pairs.filter((p) => !p.A !== !p.B)[0];
        nAligned = m.length; merged = m.some((p) => p.aRun.length > 1 || p.bRun.length > 1);
      }
      area.add(`${vp} sequence`, W.sequence * share, seq, { detail: `${R.length} vs ${B.length} bands, ${nAligned} aligned${merged ? ' (composite runs merged)' : ''}${lp ? ' (linked units)' : ''}`,
        finding: { what: `band sequence at ${vp}`, ref: `${R.length} bands`, build: `${B.length} bands`, fix: firstMiss ? (firstMiss.A ? `At ${vp} reference band #${firstMiss.A.i} (${r2(firstMiss.A.vh)} vh, ${firstMiss.A.tone || ''} ${firstMiss.A.bgColor || ''}) has no counterpart in the build; reference shows ${R.length} bands, the build ${B.length}. Show the same bands at ${vp} (including bands that only exist at this width).` : `At ${vp} build band #${firstMiss.B.i} has no counterpart in the reference (${R.length} bands vs ${B.length}). Hide it at ${vp} or merge it.`) : `At ${vp} the build shows ${B.length} bands; reference shows ${R.length}.` } });
    }

    // type at this viewport: size, rendered weight and line-height per role, same tolerances as 1440
    const TA = rolesAt(ref, vp), TB = pairRoles(TA, rolesAt(build, vp)).RB;
    if (Object.keys(TA).length) {
      // heaviness: ink where it is measured on both sides, the rendered weight otherwise (never both)
      const ink = inkItems(TA, TB, vp, build).filter((x) => x.role && inkOnBoth(TA[x.role], TB[x.role]));
      const items = [...sizeItems(TA, TB, vp).map((x) => ({ ...x, w: x.w * 0.55 })), ...weightItems(TA, TB, vp).map((x) => ({ ...x, w: x.w * 0.3 })), ...ink.map((x) => ({ ...x, w: x.w * 0.3 })), ...lineHeightItems(TA, TB, vp).map((x) => ({ ...x, w: x.w * 0.15 }))];
      const c = combine(items);
      area.add(`${vp} type`, W.type * share, c.s ?? 0, { detail: 'font size, heaviness (ink, else rendered weight) and line-height per role', items: c.items });
    } else area.add(`${vp} type`, W.type * share, null);

    // container: painted content column
    // left edge: running text (centred text columns compared by width, see textEdgeItem); width: rail
    // against rail, text extent against text extent
    const refC = ref.spacing?.container?.[vp], buildC = build.spacing?.container?.[vp];
    const rc = contentCol(refC), bc = buildCol(rc, buildC);
    const cont = [];
    const te = textEdgeItem(refC, buildC, vp, RS.gutterPx, 0.6);
    if (te) cont.push(te);
    if (isNum(rc.width)) cont.push({ s: isNum(bc.width) ? lin(relErr(rc.width, bc.width), RS.contentRel) : 0, w: 0.4, what: `content width at ${vp}`, ref: px(rc.width), build: bc.width == null ? 'n/a' : px(bc.width),
      fix: `${rc.rail ? 'Content' : 'Running text'} spans ${bc.width == null ? '?' : px(bc.width)} at ${vp}; reference spans ${px(rc.width)}. Adjust container padding/max-width at ${vp}.` });
    const cc2 = combine(cont);
    area.add(`${vp} container`, W.container * share, cc2.s, { detail: 'content left edge and width', items: cc2.items });

    // nav: position, height and scrolled state
    const rn = ref.spacing?.nav?.byViewport?.[vp], bn = build.spacing?.nav?.byViewport?.[vp];
    if (rn) {
      const parts = [];
      if (rn.pos) parts.push({ s: bn?.pos === rn.pos ? 1 : 0, w: 0.35, what: `nav position at ${vp}`, ref: rn.pos, build: bn?.pos ?? 'n/a', fix: `At ${vp} the nav is ${bn?.pos ?? 'missing'}; reference is ${rn.pos}. Set position: ${rn.pos} at ${vp}.` });
      if (isNum(rn.h)) parts.push({ s: isNum(bn?.h) ? lin(relErr(rn.h, bn.h), L.navHeightRel) : 0, w: 0.35, what: `nav height at ${vp}`, ref: px(rn.h), build: bn?.h != null ? px(bn.h) : 'n/a', fix: `At ${vp} the nav is ${bn?.h != null ? px(bn.h) : '?'} tall; reference is ${px(rn.h)}. Set the header height to ${px(rn.h)} at ${vp}.` });
      if (rn.scrolled) parts.push({ s: !!rn.scrolled.pinned === !!bn?.scrolled?.pinned ? 1 : 0, w: 0.3, what: `nav after scrolling at ${vp}`, ref: rn.scrolled.pinned ? 'pinned' : 'scrolled away', build: bn?.scrolled?.pinned ? 'pinned' : 'scrolled away',
        fix: rn.scrolled.pinned ? `At ${vp} the reference header stays pinned after scrolling (${rn.scrolled.h}px); the build's scrolls away. Keep it sticky at ${vp}.` : `At ${vp} the reference header scrolls away; the build's stays pinned. Make it static at ${vp}.` });
      const c = combine(parts);
      area.add(`${vp} nav`, W.nav * share, c.s, { detail: 'nav position, height and scrolled state', items: c.items });
    } else area.add(`${vp} nav`, W.nav * share, null);

    // marquees at this width (motion.marqueesByViewport, sampled in both captures): a strip that keeps moving
    // on one side only; scored only when a side has one (never lifts pages without marquees)
    const ma = ref.motion?.marqueesByViewport?.[vp], mb = build.motion?.marqueesByViewport?.[vp];
    if (Array.isArray(ma) && Array.isArray(mb) && (ma.length || mb.length)) {
      const s = ma.length && mb.length ? 1 : 0;
      area.add(`${vp} marquee`, W.marquee * share, s, { detail: `marquee strips at ${vp}: ${ma.length} vs ${mb.length}`,
        finding: { what: `marquee at ${vp}`, ref: ma.length ? `${ma.length} moving (${ma[0].pxPerSec ?? '?'}px/s ${ma[0].dir || ''})` : 'none moving', build: mb.length ? `${mb.length} moving` : 'none moving',
          fix: ma.length ? `At ${vp} the reference keeps ${ma.length} strip(s) scrolling (e.g. ${ma[0].el}, ${ma[0].pxPerSec ?? '?'}px/s); the build's strip is still at ${vp}. Keep the marquee running at this width.` : `At ${vp} the build runs a marquee (${mb[0].el}); the reference's strips are still at ${vp}. Stop it at this width (static row or wrap).` } });
    } else area.add(`${vp} marquee`, W.marquee * share, null);

    // page length
    const rh = ref.meta?.pageHeight?.[vp], bh = build.meta?.pageHeight?.[vp], vh = VP_HEIGHT[vp];
    if (isNum(rh) && rh > 0) area.add(`${vp} pageLength`, W.pageLength * share, isNum(bh) && bh > 0 ? lin(logRatio(rh, bh), L.pageLengthLog) : 0, { detail: `${r2(rh / vh)} vs ${isNum(bh) ? r2(bh / vh) : 'n/a'} vh`,
      finding: { what: `page length at ${vp}`, ref: `${rh}px`, build: isNum(bh) ? `${bh}px` : 'n/a', fix: `Page is ${bh ?? '?'}px tall at ${vp}; reference is ${rh}px. ${bh < rh ? 'Stack columns and keep band paddings' : 'Tighten stacked bands and paddings'} to approach ${rh}px.` } });
    else area.add(`${vp} pageLength`, W.pageLength * share, null);
  }

  // hidden bands: aligned primary pairs whose band is not rendered at a narrow viewport on one side only
  // (absent on both sides costs nothing)
  {
    const items = [];
    for (const p of primaryPairs?.pairs || []) {
      if (!p.A || !p.B) continue;
      const a = p.A, b = p.B;
      for (const vp of vps) {
        const ha = hiddenAt(ref, a, vp), hb = hiddenAt(build, b, vp);
        if (ha == null || hb == null || ha === hb) continue;
        items.push({ s: 0, w: 1, what: `band #${a.i} (${a.role}) visibility at ${vp}`, ref: ha ? 'hidden' : 'shown', build: hb ? 'hidden' : 'shown',
          fix: ha ? `Reference hides band #${a.i} (${a.role}) at ${vp}; the build still shows it (band #${b.i}). Hide it with display: none at ${vp}.` : `Build band #${b.i} (${b.role}) disappears at ${vp}; reference band #${a.i} stays visible. Keep it visible at ${vp}.` });
      }
    }
    const c = combine(items.length ? items : [{ s: 1, w: 1 }]);
    area.add('hidden bands', W.hidden, items.length ? c.s : 1, { absent: !items.length, detail: `${items.length} band(s) hidden on one side only`, items: c.items });
  }

  // penalties
  // text cut at the viewport edge that counts: right-edge cuts outside a row that also runs past the left edge
  // (a centred carousel or ticker bleeding both ways is designed; captures since round 8 already drop these)
  const cutText = (o) => {
    const all = Array.isArray(o?.clipped) ? o.clipped : [];
    const head = (s) => String(s || '').split('>')[0].trim();
    const leftRows = new Set(all.filter((x) => x.side === 'left').map((x) => head(x.sel)));
    return all.filter((x) => x.kind === 'text' && x.side !== 'left' && !leftRows.has(head(x.sel)));
  };
  for (const vp of Object.keys(build.meta?.overflowX || {})) {
    const o = build.meta.overflowX[vp], ro = ref.meta?.overflowX?.[vp];
    if (o && o.overflow && !(ro && ro.overflow)) {
      const off = (o.offenders || [])[0];
      area.penalty(`horizontal overflow at ${vp}`, RS.overflowPenalty,
        { what: `horizontal overflow at ${vp}`, ref: 'none', build: `${o.by}px wider than the viewport${off ? ` (widest: ${off.sel}, right edge ${off.right}px)` : ''}`, fix: `The build scrolls sideways at ${vp} (content is ${o.scrollWidth}px in a ${o.vw}px viewport)${off ? `; the widest offender is ${off.sel} (${off.w}px wide, right edge at ${off.right}px${isNum(off.band) && off.band >= 0 ? `, band #${off.band}` : ''})` : ''}. Constrain it (max-width: 100%, or overflow: hidden on its carousel/marquee wrapper).` });
    } else if (o && Array.isArray(o.clipped) && cutText(o).length && ro && Array.isArray(ro.clipped) && !cutText(ro).length) {
      // text cut at the viewport edge (overflow hidden/clip hides it instead of scrolling); judged only when
      // the reference capture ran the same check and found no text clipped at this width. Media running past
      // an edge (a bleeding tile row, a mock-up window) is reported by the capture but never charged: it is
      // usually a designed bleed the detector cannot tell from a defect. Half the overflow penalty.
      const tx = cutText(o), c = tx[0], n = tx.length;
      area.penalty(`clipped text at ${vp}`, RS.clippedPenalty ?? RS.overflowPenalty / 2,
        { what: `text clipped past the viewport edge at ${vp}`, ref: 'none', build: `${n} text element(s) cut at the ${c.side} edge (largest: ${c.sel}, ${c.cut}px hidden)`, fix: `At ${vp} the build cuts ${n} visible text element(s) off at the ${c.side} viewport edge (e.g. ${c.sel}, ${c.cut}px of ${c.w}px hidden, clipped by ${c.by}${isNum(c.band) && c.band >= 0 ? `, band #${c.band}` : ''}); overflow hidden/clip hides it, so the page does not scroll but the text is lost. Let that row wrap or reflow to fit the viewport (fewer columns, flex-wrap, minmax(0, 1fr)); only a designed carousel/marquee may run past the edge.` });
    }
  }
  const sumErr = (cap) => Object.values(cap.meta?.consoleErrors || {}).reduce((a, v) => a + (isNum(v) ? v : 0), 0);
  const ea = sumErr(ref), eb = sumErr(build);
  const allowed = ea === 0 ? 0 : 2 * ea + 2;
  if (eb > allowed) {
    const pts = eb - allowed >= 3 ? RS.consoleErrorPenaltyMany : RS.consoleErrorPenalty;
    area.penalty('console errors', pts, { what: 'console errors in the build', ref: ea, build: eb, fix: `The build logs ${eb} console error(s) across viewports${(build.meta?.consoleSample || [])[0] ? ` (e.g. "${String(build.meta.consoleSample[0]).slice(0, 100)}")` : ''}. Fix the script/resource errors.` });
  }
  return { area };
}
