// Motion area (20): inventory match. Reveals, load animation (documented skip rules), hero media motion,
// transitions (only categories that visibly change), hover deltas, sticky/pinned, parallax, marquee,
// smooth scroll, scroll-linked animation, ambient loops, page tint on scroll.
// Motion the reference does not have counts against the build (motion noise is a design difference).
import path from 'node:path';
import { MOTION as M } from './cmp-constants.mjs';
import { Area, combine, lin, logRatio, isNum, r2, clamp, presence, fmtList, dE } from './cmp-util.mjs';
import { pairDelta, pairLook, PAIR_CHANGED_MIN } from './images.mjs';
import { mediaRate, motionKindText, loadEntrance } from './frames.mjs';

const parseMaybe = (v) => { if (typeof v !== 'string') return v || {}; try { return JSON.parse(v); } catch { return {}; } };

export function fromKinds(f) {
  f = parseMaybe(f);
  const k = new Set();
  if (isNum(f.opacity) && f.opacity < 0.95) k.add('fade');
  if (isNum(f.y) && Math.abs(f.y) >= 2) k.add(f.y > 0 ? 'slide-up' : 'slide-down');
  if (isNum(f.x) && Math.abs(f.x) >= 2) k.add(f.x > 0 ? 'slide-left' : 'slide-right');
  if (isNum(f.scale) && Math.abs(f.scale - 1) >= 0.02) k.add('scale');
  if (isNum(f.rotate) && Math.abs(f.rotate) >= 1) k.add('rotate');
  if (isNum(f.clipVisible) && f.clipVisible < 0.95) k.add('clip');
  if (isNum(f.blur) && f.blur > 0.5) k.add('blur');
  // visibility hidden -> visible shows the same as opacity 0 -> 1 at once (a step reveal): a fade kind
  if (f.visibility === 'hidden') k.add('fade');
  return k;
}
const opacityOf = (f) => (isNum(f.opacity) ? f.opacity : f.visibility === 'hidden' ? 0 : 1);
export function describeFrom(f) {
  f = parseMaybe(f);
  const p = [];
  if (isNum(f.opacity) && f.opacity < 0.95) p.push(`opacity ${f.opacity}`);
  if (isNum(f.y) && Math.abs(f.y) >= 2) p.push(`translateY(${f.y}px)`);
  if (isNum(f.x) && Math.abs(f.x) >= 2) p.push(`translateX(${f.x}px)`);
  if (isNum(f.scale) && Math.abs(f.scale - 1) >= 0.02) p.push(`scale(${f.scale})`);
  if (isNum(f.rotate) && Math.abs(f.rotate) >= 1) p.push(`rotate(${f.rotate}deg)`);
  if (isNum(f.clipVisible) && f.clipVisible < 0.95) p.push(`clip-path ${Math.round(f.clipVisible * 100)}% visible`);
  if (isNum(f.blur) && f.blur > 0.5) p.push(`blur(${f.blur}px)`);
  if (f.visibility === 'hidden' && !p.length) p.push('visibility hidden');
  return p.join(' + ') || 'no visible from-state';
}
function fromScore(fa, fb) {
  fa = parseMaybe(fa); fb = parseMaybe(fb);
  const ka = fromKinds(fa), kb = fromKinds(fb);
  const uni = new Set([...ka, ...kb]);
  const jac = uni.size ? [...ka].filter((x) => kb.has(x)).length / uni.size : 1;
  const mags = [];
  if (ka.has('fade') && kb.has('fade')) mags.push(lin(Math.abs(opacityOf(fa) - opacityOf(fb)), M.opacityAbs));
  if (isNum(fa.y) && isNum(fb.y) && Math.sign(fa.y) === Math.sign(fb.y) && Math.abs(fa.y) >= 2) mags.push(lin(Math.abs(fa.y - fb.y) / Math.max(Math.abs(fa.y), 8), M.translateRel));
  if (isNum(fa.x) && isNum(fb.x) && Math.sign(fa.x) === Math.sign(fb.x) && Math.abs(fa.x) >= 2) mags.push(lin(Math.abs(fa.x - fb.x) / Math.max(Math.abs(fa.x), 8), M.translateRel));
  if (ka.has('scale') && kb.has('scale')) mags.push(lin(Math.abs(fa.scale - fb.scale), M.scaleAbs));
  const mag = mags.length ? mags.reduce((a, b) => a + b, 0) / mags.length : 1;
  return 0.6 * jac + 0.4 * (jac > 0 ? mag : 0);
}
export function easingSim(a, b) {
  if (!a || !b) return 0.5;
  if (a === b) return 1;
  return M.easingSim[[a, b].sort().join('|')] ?? 0;
}

const TCAT = (prop) => {
  if (/^(color|background|background-color|background-image|border.*|fill|stroke|outline.*|text-decoration.*|caret-color|all)$/.test(prop)) return 'colour';
  if (/^(transform|translate|scale|rotate)$/.test(prop)) return 'transform';
  if (/^(opacity|visibility)$/.test(prop)) return 'opacity';
  if (/^(filter|box-shadow|backdrop-filter|text-shadow)$/.test(prop)) return 'effects';
  if (/^(width|height|max-height|max-width|min-height|padding.*|margin.*|left|right|top|bottom|inset.*|flex.*|gap|grid.*)$/.test(prop)) return 'layout';
  return null;
};
// Captures with per-element observation (motion.transitionsObserved) give, per transition group, the
// elements on which it is a no-op (`noop`: the element was seen animating and the property never changed
// and no state rule changes it) and those on which it carries the observed reveal / load animation (`rv`,
// timed by the reveal / load checks): both are left out. Older captures fall back to dropping opacity /
// transform transitions within 12% of the reveal duration.
function transitionCats(cap) {
  const revMs = cap.motion?.reveals?.summary?.ms;
  const observed = isNum(cap.motion?.transitionsObserved);
  const cats = {};
  for (const t0 of cap.motion?.transitions || []) {
    if (!t0 || !isNum(t0.ms) || t0.ms <= 0) continue;
    const c = TCAT(t0.prop);
    if (!c) continue;
    const n = (t0.n || 1) - (t0.noop || 0) - (t0.rv || 0);
    if (n <= 0) continue;
    const t = n === (t0.n || 1) ? t0 : { ...t0, n };
    if (!observed && isNum(revMs) && (c === 'opacity' || c === 'transform') && Math.abs(t.ms - revMs) <= revMs * M.revealTransitionMatch) continue;
    (cats[c] ||= []).push(t);
  }
  const out = {};
  let total = 0;
  for (const [c, list] of Object.entries(cats)) {
    const n = list.reduce((a, t) => a + (t.n || 1), 0);
    total += n;
    const sorted = list.flatMap((t) => Array(Math.min(t.n || 1, 200)).fill(t.ms)).sort((a, b) => a - b);
    const fam = {};
    for (const t of list) fam[t.family || 'unknown'] = (fam[t.family || 'unknown'] || 0) + (t.n || 1);
    const famTop = Object.entries(fam).sort((a, b) => b[1] - a[1])[0][0];
    const easing = list.slice().sort((a, b) => (b.n || 1) - (a.n || 1))[0].easing;
    out[c] = { n, ms: sorted[Math.floor(sorted.length / 2)], family: famTop, easing };
  }
  for (const c of Object.values(out)) c.share = total ? c.n / total : 0;
  return out;
}

// Hover class -> weight for one hovered element. Changes on the element itself (and image/icon
// transforms of its children) weigh 1; other child changes weigh 0.5 (seen less reliably).
function hoverClasses(h) {
  const k = new Map();
  const put = (c, w) => k.set(c, Math.max(k.get(c) || 0, w));
  const addProps = (obj, w) => {
    for (const [p, v] of Object.entries(obj || {})) {
      if (/^background/.test(p)) put('background', w);
      else if (p === 'color') put('colour', w);
      else if (/^border/.test(p)) put('border', w);
      else if (p === 'boxShadow') put('shadow', w);
      else if (p === 'opacity') put('opacity', w);
      else if (/^textDecoration/.test(p)) put('underline', w);
      else if (p === 'filter') put('filter', w);
      else if (/^outline/.test(p)) put('outline', w);
      else if (p === 'letterSpacing') put('tracking', w);
      else if (p === 'transform') {
        const t = Array.isArray(v) ? v[1] : v;
        if (t && isNum(t.s) && Math.abs(t.s - 1) >= 0.01) put('scale', w);
        else if (t && isNum(t.ty) && t.ty < -0.5) put('lift', w);
        else put('move', w);
      } else if (/width|content/i.test(p)) put('pseudo', w);
    }
  };
  addProps(h.self, 1);
  if (h.before && Object.keys(h.before).length) put('pseudo', 1);
  if (h.after && Object.keys(h.after).length) put('pseudo', 1);
  for (const kid of h.kids || []) {
    const d = kid.delta || {};
    if (kid.kind === 'image' && d.transform) put('image-scale', 1);
    else if (kid.kind === 'icon' && d.transform) put('icon-move', 1);
    else addProps(d, 0.5);
  }
  return k;
}
/** kind -> {f: Map(class -> mean weight over the hovered elements of that kind), transition, n} */
function hoverByKind(cap) {
  const m = {};
  for (const h of cap.hover || []) {
    // `invalid` = not a valid sample of its kind (it moves without the pointer, or is not shown): left out
    if (!h || h.skipped || !h.kind || h.invalid) continue;
    const e = (m[h.kind] ||= { list: [], transition: null, n: 0 });
    e.list.push(hoverClasses(h));
    if (!e.transition && h.transition) e.transition = h.transition;
    e.n++;
  }
  for (const e of Object.values(m)) {
    e.f = new Map();
    for (const cls of e.list) for (const [c, w] of cls) e.f.set(c, (e.f.get(c) || 0) + w / e.list.length);
    e.set = new Set([...e.f].filter(([, w]) => w >= 0.5).map(([c]) => c));
  }
  return m;
}
/** kind -> before/after crop difference of its hover pair {changed, mean, visible}; computed from the PNG pair
 *  in the capture dir when the capture has no `visual` (older captures). */
function hoverCrops(cap, dir) {
  const out = {};
  for (const f of cap.motion?.frames?.hover || []) {
    if (!f || !f.kind || out[f.kind]) continue;
    if ((cap.hover || []).some((h) => h && h.pair === f.dir && h.invalid)) continue; // shot on an invalid sample

    const v = f.visual || (dir && f.dir ? pairDelta(path.join(dir, f.dir, 'f-00.png'), path.join(dir, f.dir, 'f-01.png')) : null);
    // look = what the pair visibly does (lightens / darkens / recolours or moves); older captures: from the PNGs
    const lk = v && !v.look && dir && f.dir ? pairLook(path.join(dir, f.dir, 'f-00.png'), path.join(dir, f.dir, 'f-01.png')) : null;
    if (v && isNum(v.changed)) out[f.kind] = { ...v, look: v.look || (lk && lk.look) || undefined, visible: v.changed >= PAIR_CHANGED_MIN };
  }
  return out;
}
/** The hover entry the kind's crop pair was shot on (`pair`; older captures: the first measured one). */
function pairedHover(cap, kind) {
  const list = (cap.hover || []).filter((h) => h && !h.skipped && !h.invalid && h.kind === kind);
  return list.find((h) => h.pair) || list[0] || null;
}
/** 1 - sum |fa - fb| / max(1, number of classes that are clearly present on either side) */
export function hoverSim(fa, fb) {
  const cls = new Set([...fa.keys(), ...fb.keys()]);
  let diff = 0, strong = 0;
  for (const c of cls) { const a = fa.get(c) || 0, b = fb.get(c) || 0; diff += Math.abs(a - b); if (Math.max(a, b) >= 0.5) strong++; }
  return Math.max(0, 1 - diff / Math.max(1, strong));
}

const VP_AREA = 1440 * 900;
const groupShare = (g) => ((g.area || 0) * (g.n || 1)) / VP_AREA;
/** Why a load group is not part of a designed staged load (older captures; newer ones pre-filter). */
function loadSkip(g) {
  const to = parseMaybe(g.to), from = parseMaybe(g.from);
  if (isNum(to.opacity) && (to.opacity <= M.load.fadeOutOpacity || (isNum(from.opacity) && to.opacity < from.opacity - M.load.fadeOutDrop))) return 'fadeOut';
  if (M.load.overlayRe.test(`${g.el || ''} ${g.parent || ''}`)) return 'overlay';
  if (groupShare(g) < M.load.tinyShare) return 'tiny';
  return null;
}
/**
 * The load staging of one capture as the load strip shows it (frames.mjs loadEntrance, the same decision the
 * digest prints): { staged, groups (kept, strip timing where measured), summary (for the kept groups), share,
 * raw (number of groups the sampler reported), skipped {reason: n}, entrance {designed, why} }. Older
 * captures (no summary.staged) are first re-filtered with the documented skip rules (fade-outs, overlays).
 */
export function loadState(cap) {
  const L = cap.motion?.load || {};
  const raw = (L.groups || []).filter(Boolean);
  const sum = L.summary || null;
  const pre = {};
  const groups = sum && typeof sum.staged === 'boolean' ? raw : raw.filter((g) => { const why = loadSkip(g); if (why && why !== 'tiny') { pre[why] = (pre[why] || 0) + 1; return false; } return true; });
  const E = loadEntrance({ ...cap.motion, load: { ...L, groups } });
  const skipped = { ...(L.skipped || {}) };
  for (const [k, n] of [...Object.entries(pre), ...Object.entries(E.skipped)]) skipped[k] = (skipped[k] || 0) + n;
  return { staged: E.staged, groups: E.staged ? E.groups : [], summary: E.staged ? E.summary : null, share: E.staged ? E.share : 0, raw: raw.length, skipped, entrance: E };
}
// How much the load animation weighs (0.35-1): number of groups and animated share of the first screen.
function loadSignificance(state) {
  if (!state.staged) return 0;
  return clamp(0.35 + 0.15 * Math.min(4, state.summary?.groups || state.groups.length || 0) + 3 * state.share, 0, 1);
}

// ------------------------------------------------------------------ hero media
const ACTIVITY = { static: 0, low: 1, medium: 2, high: 3 };
const ACT_NAME = ['static', 'low', 'medium', 'high'];
const visShare = (box) => {
  if (!Array.isArray(box) || box.length < 4) return 0;
  const [x, y, w, h] = box;
  const vw = Math.max(0, Math.min(x + w, 1440) - Math.max(x, 0)), vh = Math.max(0, Math.min(y + h, 900) - Math.max(y, 0));
  return clamp((vw * vh) / VP_AREA, 0, 1);
};
/** Hero media of the first viewport (motion.load.media) and whether it moves; null when not measured. */
export function heroMediaOf(cap) {
  const L = cap.motion?.load;
  if (!L || !Array.isArray(L.media)) return null;
  // one rate per entry, compared like with like whatever the capture version (frames.mjs mediaRate: the
  // continuous rate whenever it was measured, the load-phase rate only for media that moved during the load
  // only); the level comes from that rate alone
  const norm = (m) => {
    const mr = mediaRate(m);
    const lvl = ACTIVITY[mr.level] ?? 0;
    return { kind: m.kind || 'other', el: m.el || null, box: m.box || null, band: m.band || null, lvl, moving: lvl >= 1, when: m.when || null, share: visShare(m.box), rate: isNum(mr.rate) ? mr.rate : null,
      intermittent: !!m.intermittent, motion: m.motion || null, active: isNum(m.active) ? m.active : null, withLoad: typeof m.withLoad === 'boolean' ? m.withLoad : null, appearsMs: isNum(m.appearsMs) ? m.appearsMs : null };
  };
  const items = L.media.filter(Boolean).map(norm);
  // a moving stand-in that the ambient pass saw inside the first viewport (frame differencing) also counts
  for (const a of cap.motion?.ambient?.items || []) {
    if (a && a.kind === 'media' && visShare(a.box) > 0 && !items.some((m) => m.el && m.el === a.el)) items.push(norm({ ...a, kind: a.media || 'media', moving: true }));
  }
  const moving = items.filter((m) => m.moving).sort((a, b) => b.share - a.share);
  const largest = items.slice().sort((a, b) => b.share - a.share)[0] || null;
  return { items, moving, top: moving[0] || null, largest };
}
const overlaps = (a, b) => {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  const w = Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]), h = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]);
  return w > 0 && h > 0 && w * h >= 0.5 * Math.min(a[2] * a[3], b[2] * b[3]);
};

// ------------------------------------------------------------------ transitions that visibly do something
const camelKebab = (p) => String(p).replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
const NAV_CHANGE_CAT = { h: 'layout', bg: 'colour', border: 'colour', color: 'colour', transparent: 'colour', shadow: 'effects', blur: 'effects', extra: 'opacity', line: 'effects' };
const FROM_CAT = { fade: 'opacity', 'slide-up': 'transform', 'slide-down': 'transform', 'slide-left': 'transform', 'slide-right': 'transform', scale: 'transform', rotate: 'transform', blur: 'effects' };
/**
 * Transition categories whose properties visibly change in something the capture observed: hover deltas
 * (self, ::before/::after, children), reveal and load from-states, the header's scrolled-state changes.
 * null when the capture has no hover pass (then nothing is filtered).
 */
export function observedCats(cap) {
  if (!Array.isArray(cap.hover) || !cap.hover.length) return null;
  const s = new Set();
  const prop = (p) => { const c = TCAT(camelKebab(p)); if (c) s.add(c); };
  for (const h of cap.hover) {
    if (!h || h.skipped) continue;
    for (const o of [h.self, h.before, h.after]) for (const p of Object.keys(o || {})) prop(p);
    for (const k of h.kids || []) for (const p of Object.keys(k?.delta || {})) prop(p);
  }
  const froms = [cap.motion?.reveals?.summary?.from, ...(cap.motion?.reveals?.groups || []).map((g) => g?.from), ...loadState(cap).groups.map((g) => g.from)];
  for (const f of froms) for (const k of fromKinds(f)) if (FROM_CAT[k]) s.add(FROM_CAT[k]);
  const o = cap.spacing?.nav?.onScroll || {};
  for (const k of Object.keys(o.changes || {})) if (NAV_CHANGE_CAT[k]) s.add(NAV_CHANGE_CAT[k]);
  if (o.hidesOnScroll) s.add('transform');
  return s;
}
// similarity of two arrival orders (['headline', 'text+cta', 'media']): longest common subsequence / longer
function orderSim(a, b) {
  const A = (a || []).flatMap((x) => String(x).split('+')), B = (b || []).flatMap((x) => String(x).split('+'));
  if (!A.length && !B.length) return 1;
  if (!A.length || !B.length) return 0.3;
  const dp = Array.from({ length: A.length + 1 }, () => new Array(B.length + 1).fill(0));
  for (let i = 1; i <= A.length; i++) for (let j = 1; j <= B.length; j++) dp[i][j] = A[i - 1] === B[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  return dp[A.length][B.length] / Math.max(A.length, B.length);
}
function navScrollState(cap) {
  const n = cap.spacing?.nav;
  if (!n) return null;
  const o = n.onScroll || {};
  const pinned = typeof o.staysInView === 'boolean' ? o.staysInView : (n.pos === 'fixed' || n.pos === 'sticky');
  // a border, a shadow or a line the scrolled shot shows under the bar (`line`) look alike: one kind, `edge`
  const kinds = new Set(Object.keys(o.changes || {}).filter((k) => k !== 'color' && k !== 'pos').map((k) => (k === 'border' || k === 'shadow' || k === 'line' ? 'edge' : k)));
  if (o.hidesOnScroll) kinds.add('hides');
  return { pinned, kinds, h: o.scrolled?.visible ? o.scrolled.h : null, scrolled: o.scrolled || null, hides: !!o.hidesOnScroll };
}
/** Continuous motion inventory. With `hero` (heroMediaOf of the same capture, when the hero-media check is
 *  scored) the hero media's own motion is left out here so it is not counted twice. */
const ambientOf = (cap, hero = null) => {
  const a = cap.motion?.ambient;
  if (a && typeof a.count === 'number' && hero && hero.items.length && Array.isArray(a.items)) {
    // the hero media's own motion: an ambient item on the same element (any kind: a drift animation on the
    // hero image is that image's motion), or a media-like item over the same box / in the same band
    const isHero = (x) => !!x && hero.items.some((m) => (m.el && x.el && m.el === x.el) ||
      ((x.kind === 'media' || /^(video|canvas|lottie)$/.test(x.kind || '')) && (overlaps(m.box, x.box) || (m.moving && m.band && x.band === m.band && !x.box))));
    const items = a.items.filter((x) => !isHero(x));
    if (items.length === a.items.length) return a;
    const removed = a.items.length - items.length;
    const kinds = {}; for (const x of items) kinds[x.kind] = (kinds[x.kind] || 0) + (x.n || 1);
    const bands = (a.bands || []).filter((b) => items.some((x) => x.band === b));
    const bandShare = a.bands && a.bands.length ? (a.bandShare || 0) * (bands.length / a.bands.length) : a.bandShare || 0;
    return { ...a, count: Math.max(0, a.count - removed), kinds, bands, bandShare, items };
  }
  if (a && typeof a.count === 'number') return a;
  // capture/1 fallback: loops + infinite CSS animations + marquees + auto-advance
  const items = [...(cap.motion?.marquees || []).map(() => 'marquee'), ...(cap.motion?.loops || []).map((l) => l.kind), ...(cap.motion?.carousels?.autoAdvanceCandidates || []).map(() => 'auto-advance')];
  const kinds = {}; for (const k of items) kinds[k] = (kinds[k] || 0) + 1;
  return { count: items.length, kinds, bandShare: 0, bands: [] };
};
const navIsPinned = (cap) => {
  const n = cap.spacing?.nav;
  if (!n) return false;
  if (n.onScroll && typeof n.onScroll.staysInView === 'boolean') return n.onScroll.staysInView;
  return n.pos === 'fixed' || n.pos === 'sticky';
};
function otherSticky(cap) {
  const navBand = (cap.sections || []).find((s) => s.role === 'nav')?.id;
  const navH = cap.spacing?.nav?.h;
  return (cap.motion?.sticky || []).filter((x) => x && (x.kind === 'pinned' || x.kind === 'sticky') && (x.h || 0) >= 60 &&
    !(navBand && (x.band === navBand || x.id === navBand)) && !(isNum(navH) && Math.abs((x.h || 0) - navH) <= 6 && (x.top || 0) <= 4));
}
const parallaxList = (cap) => (cap.motion?.parallax || []).filter((p) => p && (isNum(p.rate) || /fixed|attachment/i.test(p.kind || '')));
// scroll-driven animations on the header are its scrolled state (navScroll), never scroll-scrubbed content:
// newer captures leave them out of scrollDrivenAnimations (scrollTimeline.nav); older ones are recognised by
// getAnimations[] entries on the nav element or named like a nav / header
const navDrivenOld = (cap) => {
  const st = cap.motion?.scrollTimeline;
  if (!st || isNum(st.nav) || 'nav' in st) return 0;
  const el = String(cap.spacing?.nav?.onScroll?.scrolled?.el || '');
  return (cap.motion?.getAnimations || []).filter((g) => g && g.scrollTimeline && g.visual !== false && (/nav|header|topbar|masthead/i.test(`${g.name || ''} ${g.on || ''}`) || (el && g.on && el.includes(String(g.on).split('.')[0]) && /^(nav|header)/i.test(String(g.on))))).reduce((t, g) => t + (g.n || 1), 0);
};
const scrollLinkedN = (cap) => (cap.motion?.reveals?.scrollLinked?.length || 0) + Math.max(0, (cap.motion?.scrollTimeline?.scrollDrivenAnimations || 0) - navDrivenOld(cap))
  + (cap.motion?.horizontal || []).filter((h) => h && h.kind !== 'overflow-x scroller').length;
function loopsN(cap) {
  const mq = (cap.motion?.marquees || []).map((m) => String(m.css || '')).join(' ');
  const infinite = (cap.motion?.cssAnimations || []).filter((a) => a && String(a.iter) === 'infinite' && !(a.name && mq.includes(a.name)));
  return infinite.length + (cap.motion?.loops || []).length + (cap.motion?.carousels?.autoAdvanceCandidates || []).length;
}
const median = (arr) => { const a = arr.filter(isNum).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : null; };

// Strips side by side: when and how content arrives. Reveal strips (build captured with --frames-like:
// motion.frames.reveals[].like.ref = the reference strip it replays; both strips carry `content`, frames.mjs
// stripContent): when the content in view is visibly in place after the scroll stopped. Per pair: the build
// visibly later by more than lateMs[0] (lin over lateMs), and where the reference's strip is in place
// (nothing animates) while the build's content keeps changing, lin(build lag, staticLagMs). Appearance
// (`content.appear`, frames.mjs stripAppear; for the load strip motion.frames.load.appear, loadAppear): where
// the reference's content arrives in one step and the build's eases in (fade / slide), lin(build ms,
// easedMs). The load strip is one more pair (appearance only) weighing loadPairWeight reveal pairs. Weighted
// mean over pairs; no pairs = not scored.
const appearTxt = (x) => (!x ? 'not measured' : x.kind === 'step' ? `appears in one step (~${x.atMs} ms)` : x.kind === 'none' ? 'nothing arrives' : `${x.kind === 'slide' ? 'slides' : 'fades'} in over ~${x.ms} ms (from ~${x.atMs} ms)`);
const easedKind = (x) => !!x && (x.kind === 'fade' || x.kind === 'slide');
// rev (reveal strips only): also the reverse, the reference eases in (visible ms) and the build appears in one step
const stepVsEase = (pa, pb, T, rev = false) => (pa && pb && pa.kind === 'step' && easedKind(pb) && isNum(pb.ms) ? lin(pb.ms, T.easedMs)
  : rev && pa && pb && pb.kind === 'step' && easedKind(pa) && isNum(pa.ms) ? lin(pa.ms, T.easedMs) : 1);
// how content arrives in a strip, in words: "fades in place" / "slides in (x -36 px half-way)"
const fromTxt = (x) => (x.kind === 'slide' ? `slides in (${[isNum(x.x) ? `x ${x.x}` : '', isNum(x.y) ? `y ${x.y}` : ''].filter(Boolean).join(', ')} px half-way)` : 'fades in place');
/** From-state per strip pair (build captured --frames-like): where both strips ease their content in (fade /
 *  slide), the distance between their half-way offsets (x, y; 0 for a fade in place) lin over
 *  M.revealFromStripPx: a fade against a slide, another axis or direction, or a much longer slide is charged. */
export function stripFromPairs(ref, build) {
  const RS = ref.motion?.frames?.reveals || [], BS = build.motion?.frames?.reveals || [];
  const out = [];
  BS.forEach((b, bi) => {
    const ai = b && b.like && isNum(b.like.ref) ? b.like.ref - 1 : null;
    const pa = ai !== null ? RS[ai]?.content?.appear : null, pb = b?.content?.appear;
    if (!easedKind(pa) || !easedKind(pb)) return;
    const off = (x) => (x.kind === 'slide' ? [isNum(x.x) ? x.x : 0, isNum(x.y) ? x.y : 0] : [0, 0]);
    const [ax, ay] = off(pa), [bx, by] = off(pb);
    const d = Math.hypot(ax - bx, ay - by);
    out.push({ s: lin(d, M.revealFromStripPx), ai, bi, pa, pb, d: Math.round(d), band: RS[ai]?.band || null });
  });
  return out;
}
// What a capture's reveal strips show: 'step' when most strips in which content arrives show it in one step,
// else 'eased' with the median visible ms of the fades / slides; null without such strips.
function stripLook(cap) {
  const ap = (cap.motion?.frames?.reveals || []).map((s) => s?.content?.appear).filter((a) => a && (a.kind === 'step' || easedKind(a)));
  if (!ap.length) return null;
  const eased = ap.filter(easedKind);
  return ap.length - eased.length > eased.length ? { look: 'step' } : { look: 'eased', ms: median(eased.map((a) => a.ms)) };
}
export function revealTimingCheck(area, ref, build) {
  const RS = ref.motion?.frames?.reveals || [], BS = build.motion?.frames?.reveals || [];
  const T = M.revealTiming, pairs = [];
  BS.forEach((b, bi) => {
    const ai = b && b.like && isNum(b.like.ref) ? b.like.ref - 1 : null;
    const a = ai !== null ? RS[ai] : null;
    const ca = a && a.content, cb = b && b.content;
    if (!ca || !cb || !isNum(ca.lagMs) || !isNum(cb.lagMs)) return;
    const late = cb.lagMs - ca.lagMs;
    let s = late > T.lateMs[0] ? lin(late, T.lateMs) : 1;
    const aStill = ca.inPlace === true, bMoves = cb.inPlace === false;
    if (aStill && bMoves) s = Math.min(s, lin(cb.lagMs, T.staticLagMs));
    const sStep = stepVsEase(ca.appear, cb.appear, T, true);
    const eased = sStep < 1;
    const rev = eased && cb.appear && cb.appear.kind === 'step';
    s = Math.min(s, sStep);
    pairs.push({ s, w: 1, a, b, ai, bi, ca, cb, late, aStill, bMoves, eased, rev, sStep });
  });
  const la = ref.motion?.frames?.load?.appear, lb = build.motion?.frames?.load?.appear;
  if (la && lb) { const s = stepVsEase(la, lb, T); pairs.push({ s, w: T.loadPairWeight, load: true, la, lb, eased: s < 1 }); }
  if (!pairs.length) { area.add('revealTiming', M.weights.revealTiming, null); return; }
  const s = pairs.reduce((t, p) => t + p.s * p.w, 0) / pairs.reduce((t, p) => t + p.w, 0);
  const w = pairs.slice().sort((x, y) => x.s - y.s || (y.load ? 1 : 0) - (x.load ? 1 : 0))[0];
  const detail = pairs.map((p) => (p.load ? `load strip: ref ${appearTxt(p.la)}, build ${appearTxt(p.lb)}` : `strip ${p.ai + 1}: in place ${p.ca.lagMs} vs ${p.cb.lagMs} ms after the scroll stops${p.ca.appear || p.cb.appear ? ` (ref ${appearTxt(p.ca.appear)}, build ${appearTxt(p.cb.appear)})` : ''}`)).join('; ');
  if (w.load) {
    const fix = `First screen: the reference's content appears in one step (complete within one or two frames, ~${w.la.atMs} ms after first paint); the build eases it in over ~${w.lb.ms} ms. Build a step appearance with no transition at all: drop the ld class (or its animation) from what the reference shows in one step, and let it appear at its time (motion-patterns §load).`;
    area.add('revealTiming', M.weights.revealTiming, s, { detail, finding: { what: 'first screen appearance (load strip)', ref: appearTxt(w.la), build: appearTxt(w.lb), fix } });
    return;
  }
  const band = w.a.band ? ` (band ${w.a.band})` : '';
  const pct = (v) => `${Math.round((v || 0) * 1000) / 10}%`;
  const fix = w.rev && w.sStep <= w.s + 1e-9
    ? `Reveal strip ${w.ai + 1}${band}: the reference's content ${w.ca.appear.kind === 'slide' ? 'slides' : 'fades'} in over ~${w.ca.appear.ms} ms after the wheel input; the build's appears in one step (no transition). Give that group the reference's transition (.rv without rv-step, its group's ms and easing; motion-patterns §reveal).`
    : w.eased && w.sStep <= w.s + 1e-9
    ?`Reveal strip ${w.ai + 1}${band}: the reference's content arrives in one step (complete within one or two frames, ~${w.ca.appear.atMs} ms after the wheel input); the build's ${w.cb.appear.kind === 'slide' ? 'slides' : 'fades'} in over ~${w.cb.appear.ms} ms. Build that group with no transition at all: it appears at once when its trigger fires (no .rv transition, no from-state; motion-patterns §reveal).`
    : w.aStill
      ? `Reveal strip ${w.ai + 1}${band}: the reference's content is already in place when the scroll stops; the build's keeps fading/moving for ${w.cb.lagMs} ms after it (${pct(w.cb.changed)} of the view). Nothing in view at the end of that wheel step may start a reveal there: drop .rv from content the reference shows in place (reveal only the motion.reveals groups at their page positions \`ys\`, skip groups marked \`skip\`), or fire it before it enters (data-trigger above 1, motion-patterns §reveal).`
      : `Reveal strip ${w.ai + 1}${band}: the build's content settles ${w.late} ms later than the reference's (${w.cb.lagMs} vs ${w.ca.lagMs} ms after the scroll stops). Start the reveal earlier (its group's trigger as data-trigger, no delay) or shorten it to the group's ms.`;
  const refTxt = `${w.aStill ? `in place when the scroll stops (${w.ca.lagMs} ms)` : `in place ${w.ca.lagMs} ms after the scroll stops`}${w.ca.appear ? `; ${appearTxt(w.ca.appear)}` : ''}`;
  const buildTxt = `in place ${w.cb.lagMs} ms after the scroll stops${w.bMoves ? ' (animates in view)' : ''}${w.cb.appear ? `; ${appearTxt(w.cb.appear)}` : ''}`;
  area.add('revealTiming', M.weights.revealTiming, s, { detail, finding: { what: `reveal strip ${w.ai + 1} timing`, ref: refTxt, build: buildTxt, fix } });
}

export function scoreMotion(ref, build, dirs = {}) {
  const area = new Area('motion', 20);
  const W = M.weights;
  if (!ref.motion) { for (const k of Object.keys(W)) area.add(k, W[k], null); area.notes.push('reference has no motion block'); return { area }; }
  if (!build.motion) {
    const unmeasured = { revealTiming: true, heroMedia: !Array.isArray(ref.motion.load?.media), scrollTint: !ref.motion.scrollTint, autoAdvance: !(ref.motion.carousels?.autoAdvance || []).some((a) => a && isNum(a.periodMs)) };
    for (const k of Object.keys(W)) area.add(k, W[k], unmeasured[k] ? null : 0, { detail: 'build capture has no motion block' });
    area.checks[0].finding = { what: 'motion data', ref: 'present', build: 'missing', fix: 'The build capture has no motion data; recapture the build with capture.mjs (and check the page loads without errors).' };
    return { area };
  }
  const bm = build.motion;

  // reveals. A step change of a small box (all its elements < 0.5% of the first screen: a carousel arrow or a
  // control turning visible when its widget starts) is UI state, not a scroll reveal: not counted (M.minorStepShare)
  const ra = ref.motion.reveals?.summary, rb = bm.reveals?.summary;
  const minorStep = (g) => !!g && !g.skip && (g.appear === 'step' || /^step/.test(g.source || '')) && (g.area || 0) * (g.n || 1) < (M.minorStepShare ?? 0.005) * 1440 * 900;
  const effEls = (rv) => Math.max(0, (rv?.summary?.elements || 0) - (rv?.groups || []).filter(minorStep).reduce((t, g) => t + (g.n || 1), 0));
  const na = effEls(ref.motion.reveals), nb = effEls(bm.reveals);
  const p = presence(na > 0, nb > 0);
  {
    const s = p.kind === 'both' ? lin(logRatio(na + 1, nb + 1), M.countLog) : p.s;
    const fix = p.kind === 'missing' ? `The build has no scroll reveals; reference reveals ${na} elements in ${ra.groups} groups (from ${describeFrom(ra.from)}, ${ra.ms}ms ${ra.family}${ra.stagger ? `, ${ra.stagger}ms stagger` : ''}). Add IntersectionObserver reveals on the same kinds of elements.`
      : p.kind === 'extra' ? `The build reveals ${nb} elements on scroll; the reference has no scroll reveals. Remove the reveal animations (render content in its final state).`
      : `The build reveals ${nb} elements on scroll; reference reveals ${na}. ${nb < na ? 'Apply reveals to more elements (headings, cards, media)' : 'Apply reveals to fewer elements'} to get near ${na}.`;
    area.add('revealPresence', W.revealPresence, s, { absent: p.absent, detail: `reveal elements ${na} vs ${nb}`, finding: { what: 'scroll reveal count', ref: na, build: nb, fix } });
  }
  if (p.kind === 'both') {
    // from-state: the summaries' modal from-states, and where both strips of a pair ease in, what the strips
    // show (fade in place vs slide, axis, distance): the lower of the two counts (the strips are what is seen)
    const sf = fromScore(ra.from, rb.from), fp = stripFromPairs(ref, build);
    const fsS = fp.length ? fp.reduce((t, x) => t + x.s, 0) / fp.length : null;
    const fw = fp.slice().sort((x, y) => x.s - y.s)[0];
    const byStrip = isNum(fsS) && fsS < sf;
    const fpTxt = fp.length ? `; strips: ${fp.map((x) => `${x.ai + 1} ref ${fromTxt(x.pa)}, build ${fromTxt(x.pb)}`).join('; ')}` : '';
    area.add('revealFrom', W.revealFrom, byStrip ? fsS : sf, { detail: `${describeFrom(ra.from)} vs ${describeFrom(rb.from)}${fpTxt}`,
      finding: byStrip
        ? { what: `reveal from-state (strip ${fw.ai + 1})`, ref: fromTxt(fw.pa), build: fromTxt(fw.pb), fix: `Reveal strip ${fw.ai + 1}${fw.band ? ` (band ${fw.band})` : ''}: the reference's content ${fromTxt(fw.pa)}; the build's ${fromTxt(fw.pb)}. ${fw.pa.kind === 'slide' ? `Start that group translated as the reference's (the half-way offset is about half of the from distance), on the same axis and side` : 'Start that group from opacity only: no translate or scale (the strip wins over a sampled translate)'} (motion-patterns §reveal).` }
        : { what: 'reveal from-state', ref: describeFrom(ra.from), build: describeFrom(rb.from), fix: `Reveals start from ${describeFrom(rb.from)} in the build; reference starts from ${describeFrom(ra.from)}. Animate reveals from ${JSON.stringify(parseMaybe(ra.from))} to rest.` } });
    // duration / easing: step groups (appear 'step', no transition) have none. Both sides step-only: equal.
    // One side step-only: what the eased side's strips show decides (mostly one step = equal; else its visible
    // ms, or its sampled ms without strips, lin over revealTiming.easedMs); easing is not scored then
    const stepA = ra.appear === 'step', stepB = rb.appear === 'step';
    if (stepA || stepB) {
      const T = M.revealTiming;
      const E = stepA ? rb : ra, look = stripLook(stepA ? build : ref);
      const vis = stepA && stepB ? 0 : look ? (look.look === 'step' ? 0 : look.ms) : E.ms;
      const s = lin(vis, T.easedMs);
      const txt = (x, stepOnly) => (stepOnly ? 'one step (no transition)' : `${x.ms}ms ${x.family || ''}`.trim());
      area.add('revealDuration', W.revealDuration, s, { detail: `${txt(ra, stepA)} vs ${txt(rb, stepB)}${look && !(stepA && stepB) ? ` (${stepA ? 'build' : 'ref'} strips: ${look.look === 'step' ? 'mostly one step' : `ease in ~${look.ms} ms`})` : ''}`,
        finding: { what: 'reveal duration', ref: txt(ra, stepA), build: txt(rb, stepB), fix: stepB && !stepA ? `The build's reveals appear in one step (no transition); the reference's ease in over ~${vis}ms. Give them the reference's transition (.rv without rv-step: ${ra.ms}ms${ra.easing ? ` ${ra.easing}` : ''}; motion-patterns §reveal).` : `The reference's reveals appear in one step (hidden, then there at once); the build's ease in over ~${vis}ms. Build them as \`rv rv-step\` (no transition; motion-patterns §reveal).` } });
      area.add('revealEasing', W.revealEasing, null, { detail: 'not scored: reveals appear in one step on a side' });
    } else {
      if (isNum(ra.ms)) area.add('revealDuration', W.revealDuration, isNum(rb.ms) ? lin(logRatio(ra.ms, rb.ms), M.durationLog) : 0, { detail: `${ra.ms} vs ${rb.ms ?? 'n/a'} ms`,
        finding: { what: 'reveal duration', ref: `${ra.ms}ms`, build: `${rb.ms ?? '?'}ms`, fix: `Reveal duration is ${rb.ms ?? '?'}ms; reference is ${ra.ms}ms. Set the reveal transition/tween duration to ${ra.ms}ms${ra.easing ? ` (${ra.easing})` : ''}.` } });
      else area.add('revealDuration', W.revealDuration, null);
      if (ra.family) area.add('revealEasing', W.revealEasing, easingSim(ra.family, rb.family), { detail: `${ra.family} vs ${rb.family ?? 'n/a'}`,
        finding: { what: 'reveal easing', ref: ra.easing || ra.family, build: rb.easing || rb.family || 'n/a', fix: `Reveal easing is ${rb.family ?? 'unknown'}${rb.easing ? ` (${rb.easing})` : ''}; reference is ${ra.family}${ra.easing ? ` (${ra.easing})` : ''}. Use ${ra.easing || ra.family} for reveals.` } });
      else area.add('revealEasing', W.revealEasing, null);
    }
    // staggers under staggerMinMs are sampling jitter, not a designed stagger
    const stg = (v) => (isNum(v) && v >= M.staggerMinMs ? v : null);
    const sa = stg(ra.stagger), sb = stg(rb.stagger);
    const ss = !isNum(sa) && !isNum(sb) ? 1 : isNum(sa) && isNum(sb) ? lin(logRatio(sa, sb), M.staggerLog) : M.staggerOneSided;
    area.add('revealStagger', W.revealStagger, ss, { absent: !isNum(sa) && !isNum(sb), detail: `${sa ?? 'none'} vs ${sb ?? 'none'} ms`,
      finding: { what: 'reveal stagger', ref: sa ? `${sa}ms` : 'none', build: sb ? `${sb}ms` : 'none', fix: isNum(sa) ? `Reveal stagger is ${sb ? `${sb}ms` : 'absent'}; reference staggers siblings by ${sa}ms. Delay each sibling by ${sa}ms (transition-delay: calc(var(--i) * ${sa}ms)).` : `Build staggers reveals by ${sb}ms; the reference reveals siblings together. Remove the stagger.` } });
  }
  revealTimingCheck(area, ref, build);

  // load staging: how the first screen is built (present/absent, start delay, total duration, order of
  // arrival, from-state). Weighted by how much of the first screen moves, so a signature hero sequence
  // costs ~1.6 area points when missing and a tiny load flourish costs little.
  {
    // the documented skip rules: fade-outs, popups, tiny flourishes and digit rolls are not a staged load
    const LA = loadState(ref), LB = loadState(build);
    const la = LA.summary, lb = LB.summary;
    // visual build-up in the load frames (content appearing in steps), whatever drives it; counts when the
    // animation sampler saw no load animation at all on that side (when it saw groups that the skip rules
    // dropped, the frames show those same popups/fade-outs), and only when it is design: it repeats on
    // the warm-cache load (`designed`); a build-up that vanished with a warm cache is network timing.
    // Captures without `designed` (older ones) fall back to staged && !live.
    const va = ref.motion.frames?.load?.visual, vb = bm.frames?.load?.visual;
    // a build-up whose content also disappears again (a shrink step in fg: toast, carousel, video cut) or
    // that is read from less than half of the first screen (moving hero media masked out) is not staging
    const shrinks = (v) => { const fg = v.fg || []; const fin = Math.max(0, ...fg.slice(-3)); for (let k = 1; k < fg.length; k++) if (fg[k - 1] - fg[k] >= Math.max(0.005, fin * 0.15)) return true; return false; };
    const isDesigned = (v) => !!v && (typeof v.designed === 'boolean' ? v.designed : v.staged && !v.live) && !shrinks(v) && !((v.masked || 0) >= 0.5);
    const vsig = (v, st) => (isDesigned(v) && !st.raw ? M.load.visualSignificance : 0);
    let sa = loadSignificance(LA), sb = loadSignificance(LB);
    const visA = !sa && vsig(va, LA) > 0, visB = !sb && vsig(vb, LB) > 0;
    if (visA) sa = vsig(va, LA);
    if (visB) sb = vsig(vb, LB);
    const ha = sa > 0, hb = sb > 0;
    const q = presence(ha, hb);
    const P = M.load.parts;
    const st = (x) => x?.staging || {};
    let s = q.s;
    if (q.kind === 'both' && (visA || visB)) {
      // compare build-up in the frames: duration of the build-up and number of steps
      const dur = (v, sum) => (isDesigned(v) ? Math.max(80, v.lastGrowMs - v.firstContentMs) : Math.max(80, st(sum).totalMs ?? sum?.ms ?? 80));
      const stepsOf = (v, sum) => (isDesigned(v) ? v.growSteps : (sum?.groups || 1));
      s = 0.5 * lin(logRatio(dur(va, la), dur(vb, lb)), M.loadDurationLog) + 0.5 * lin(logRatio(stepsOf(va, la) + 1, stepsOf(vb, lb) + 1), M.ambient.countLog);
    } else if (q.kind === 'both') {
      const tA = st(la).totalMs ?? la.ms, tB = st(lb).totalMs ?? lb.ms;
      const sd = isNum(tA) && isNum(tB) ? lin(logRatio(Math.max(tA, 50), Math.max(tB, 50)), M.loadDurationLog) : 0.5;
      const dl = isNum(st(la).delayMs) && isNum(st(lb).delayMs) ? lin(Math.abs(st(la).delayMs - st(lb).delayMs), M.load.delayMs) : (!isNum(st(la).delayMs) && !isNum(st(lb).delayMs) ? 1 : 0.5);
      s = P.duration * sd + P.delay * dl + P.order * orderSim(st(la).order, st(lb).order) + P.from * fromScore(la.from, lb.from);
    }
    const sig = Math.max(M.load.minSignificance, q.kind === 'extra' ? sb : sa);
    const vdesc = (v) => `content builds up in ${v.growSteps} visible steps over ${v.lastGrowMs - v.firstContentMs}ms after first paint (load frames)`;
    const desc0 = (x) => (x ? `${x.groups} group(s), ${(st(x).order || []).join(' > ') || '?'}, ${st(x).totalMs ?? x.ms}ms total from ${describeFrom(x.from)}${isNum(st(x).delayMs) ? `, starts ${st(x).delayMs}ms after first paint` : ''}` : 'none');
    // a side without a staged load: what its strip shows instead (frames.mjs loadEntrance why), so the finding
    // never calls a page with load animations "static" without saying why they do not count
    const noneTxt = (S) => (S.entrance && (S.raw || S.entrance.groups.length) ? `none staged: ${S.entrance.why}` : 'none');
    const descA = visA ? vdesc(va) : la ? desc0(la) : noneTxt(LA), descB = visB ? vdesc(vb) : lb ? desc0(lb) : noneTxt(LB);
    const fix = q.kind === 'missing' ? `Reference builds its first screen on load: ${descA}; the build ${LB.raw ? `has no staged load (${descB})` : 'shows it statically'}. Stage the hero in that order with that from-state and duration (motion-patterns: load sequence).`
      : q.kind === 'extra' ? `The build animates its first screen on load (${descB}); the reference ${LA.raw ? `has no staged load (${descA})` : 'shows it statically'}. Remove the build's load animation (or keep it to what the reference's load strip shows).`
      : `Load sequence differs: build ${descB}; reference ${descA}. Match the order, start delay, total duration and from-state.`;
    const skipped = (st) => (Object.keys(st.skipped || {}).length ? ` [not staged: ${Object.entries(st.skipped).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(', ')}]` : '');
    area.add('load', W.load * (q.absent ? 1 : sig), s, { absent: q.absent, detail: `ref ${descA} (moves ${Math.round(sa * 100)}%)${skipped(LA)}; build ${descB}${skipped(LB)}`, finding: { what: 'load sequence', ref: descA, build: descB, fix } });
  }

  // hero media in the first viewport: reference media that moves (video, canvas, Lottie, animated image)
  // needs a moving stand-in of a similar activity level, whatever its kind. Not scored on older captures.
  const heroA = heroMediaOf(ref), heroB = heroMediaOf(build);
  {
    const H = M.heroMedia;
    if (!heroA) area.add('heroMedia', W.heroMedia, null, { detail: 'reference capture has no hero-media measurement' });
    else if (!heroB && build.meta?.fast) area.add('heroMedia', W.heroMedia, null, { detail: 'build capture is --fast (no hero-media sample)' });
    else {
      const a = heroA.top;
      // the build's box matched to the reference's moving box (overlapping it), else its most visible moving box
      const b = heroB ? ((a && heroB.moving.find((m) => overlaps(m.box, a.box))) || heroB.top) : null;
      const q = presence(!!a, !!b);
      let s = q.s, ratio = null, kindDiff = false;
      if (q.kind === 'both') {
        // level part: within the level 1; build livelier by 2+ levels loses as before; build calmer by one
        // level loses clearly, two levels most of the check
        const d = b.lvl - a.lvl;
        const lvlS = d >= 2 ? (d === 2 ? H.twoLevels : H.threeLevels) : d >= 0 ? 1 : H.lower[Math.min(3, -d)];
        // continuous part (captures with rate = share of the box changing per second): how much less of the
        // build's box changes per second, |ln(ra / rb)| when the build is calmer
        if (isNum(a.rate) && isNum(b.rate)) ratio = Math.log(Math.max(a.rate, H.rateFloor) / Math.max(b.rate, H.rateFloor));
        const rateS = ratio !== null && ratio > 0 ? lin(ratio, H.rateLog) : 1;
        s = Math.min(lvlS, rateS);
        // kind of motion (both captures measured it: in-place / lateral / cut / drift): moving another way
        // (a sideways track for items turning in place) costs kindMismatch of the check
        // cut vs in-place is told apart by how much of the time the box changes (frames.mjs MOTION_KIND
        // cutActive), so a cross-fade flips between them with its duration: those two count as different only
        // when clear on both sides (the in-place side changes in >= cutClear[1] of the frame pairs, the cut side
        // in <= cutClear[0])
        const cutVsInPlace = (x, y) => x.motion === 'cut' && y.motion === 'in-place';
        const clear = (c, i) => isNum(c.active) && isNum(i.active) && c.active <= H.cutClear[0] && i.active >= H.cutClear[1];
        kindDiff = !!(a.motion && b.motion && a.motion !== b.motion) &&
          !((cutVsInPlace(a, b) && !clear(a, b)) || (cutVsInPlace(b, a) && !clear(b, a)));
        if (kindDiff) s *= H.kindMismatch;
      }
      const sigOf = (m) => clamp(H.base + H.perArea * (m ? m.share : 0), H.base, 1);
      const sig = q.kind === 'extra' ? sigOf(b) : sigOf(a || heroA.largest);
      const pct = (r) => `${Math.round(r * 1000) / 10}%`;
      const rateTxt = (m) => (isNum(m.rate) ? `, ${pct(m.rate)} of its box changes per second` : '');
      const d = (m, h) => (m ? `${m.kind} ${m.el || ''} moving (${ACT_NAME[m.lvl]} activity${m.intermittent ? ' (intermittent)' : ''}${rateTxt(m)}${m.motion ? `, ${m.motion}` : ''}${m.when ? `, ${m.when}` : ''}${m.withLoad ? ', arrives with the load' : m.withLoad === false ? ', from first paint' : ''}, ${Math.round(m.share * 100)}% of the first screen)` : h && h.largest ? `static ${h.largest.kind} ${h.largest.el || ''}` : 'no hero media');
      const HOW = 'large areas changing luminance, hue or position every frame (several big shapes travelling across the whole box on 6-12 s loops, a flowing canvas field, cross-fading scenes for footage); a subtle drift, an opacity shimmer or small moving pieces barely register. Measure between captures with inspect.mjs activity';
      const calmer = q.kind === 'both' && (b.lvl < a.lvl || (ratio !== null && ratio > H.rateLog[0]));
      const kindFix = kindDiff ? `The reference's media moves by ${motionKindText(a.motion)}${a.withLoad ? ', arriving with the load staging' : ''}; the build's by ${motionKindText(b.motion)}${b.withLoad === false && a.withLoad ? ', painted from first paint' : ''}. Match the kind of motion first, then the rate (motion-patterns §media). ` : '';
      const fix = q.kind === 'missing' ? `The reference's hero media moves: ${d(a)}; the build's stand-in ${heroB && heroB.largest ? `(${d(null, heroB)}) is still` : 'is missing'}. Give the hero media motion of ${ACT_NAME[a.lvl]} activity${isNum(a.rate) ? ` (about ${pct(a.rate)} of the box changing per second)` : ''}${a.motion ? ` by ${motionKindText(a.motion)}` : ''}: ${HOW}.`
        : q.kind === 'extra' ? `The build's hero media moves (${d(b)}); the reference's ${heroA.largest ? `(${d(null, heroA)}) is still` : 'first screen has no hero media'}. Make it static.`
        : calmer ? `${kindFix}First-screen media is calmer in the build: ${isNum(b.rate) ? `${pct(b.rate)} of the box changes per second (${ACT_NAME[b.lvl]} activity)` : `${ACT_NAME[b.lvl]} activity`} against the reference's ${isNum(a.rate) ? `${pct(a.rate)} (${ACT_NAME[a.lvl]})` : ACT_NAME[a.lvl]} (${d(a)}). Raise how much of the box changes per second to about ${isNum(a.rate) ? pct(a.rate) : `${ACT_NAME[a.lvl]} activity`}: ${HOW}.`
        : kindDiff ? `${kindFix}Rate: build ${ACT_NAME[b.lvl]}${isNum(b.rate) ? ` ${pct(b.rate)}` : ''}, reference ${ACT_NAME[a.lvl]}${isNum(a.rate) ? ` ${pct(a.rate)}` : ''} (${d(a)}).`
        : q.kind === 'both' ? `Hero media moves at ${ACT_NAME[b.lvl]} activity in the build; reference moves at ${ACT_NAME[a.lvl]} (${d(a)}). ${b.lvl > a.lvl ? 'Calm the motion down' : 'Keep it'} to about ${ACT_NAME[a.lvl]} activity.`
        : 'Hero media is still on both sides.';
      area.add('heroMedia', W.heroMedia * (q.absent ? H.absentShare : sig), s, { absent: q.absent, detail: `ref ${d(a, heroA)}; build ${d(b, heroB)}`, finding: { what: 'first-screen media activity', ref: d(a, heroA), build: d(b, heroB), fix } });
    }
  }

  // header on scroll: pinned or not, what changes in its scrolled state (background, height, shadow,
  // extra CTA, hides), scrolled height
  {
    const na = navScrollState(ref), nb = navScrollState(build);
    if (na) {
      const P = M.navScroll.parts;
      const kb = nb ? nb.kinds : new Set();
      const uni = new Set([...na.kinds, ...kb]);
      const jac = uni.size ? [...na.kinds].filter((k) => kb.has(k)).length / uni.size : 1;
      const sp = nb ? (na.pinned === nb.pinned ? 1 : 0) : 0;
      const sh = na.pinned && nb && nb.pinned && isNum(na.h) && isNum(nb.h) ? lin(Math.abs(na.h - nb.h) / Math.max(na.h, 1), [0.08, 0.4]) : (na.pinned === (nb && nb.pinned) ? 1 : 0);
      // a header pinned on one side only means the whole scrolled state differs (one bar shown, the other gone)
      const s = sp < 1 ? 0 : P.pinned * sp + P.changes * jac + P.height * sh;
      const absent = !na.pinned && !na.kinds.size && nb && !nb.pinned && !nb.kinds.size;
      const d = (x) => (x ? `${x.pinned ? 'stays pinned' : 'scrolls away'}${x.kinds.size ? `, on scroll: ${[...x.kinds].join(', ')}` : ', no change'}${x.scrolled && x.scrolled.visible ? ` (scrolled bar ${x.scrolled.h}px, ${x.scrolled.transparent ? 'transparent' : x.scrolled.bg}${x.scrolled.extra ? `, ${x.scrolled.extra.length} extra button(s)` : ''})` : ''}` : 'no nav');
      const add = [...na.kinds].filter((k) => !kb.has(k)), drop = [...kb].filter((k) => !na.kinds.has(k));
      const fix = sp < 1 ? (na.pinned ? `The reference header stays pinned at the top while scrolling (${d(na)}); the build's ${nb && nb.hides ? 'hides' : 'scrolls away'}. Make it position: sticky/fixed and reproduce its scrolled state.` : `The reference header scrolls away with the page; the build keeps it pinned. Make it position: relative.`)
        : `Header scrolled state differs: build ${d(nb)}; reference ${d(na)}.${add.length ? ` Add on scroll: ${add.join(', ')}${add.includes('extra') && na.scrolled?.extra ? ` (a ${na.scrolled.extra[0].bg || 'outlined'} button appears in the bar)` : ''}.` : ''}${drop.length ? ` Remove: ${drop.join(', ')}.` : ''}`;
      area.add('navScroll', W.navScroll, s, { absent, detail: `ref ${d(na)}; build ${d(nb)}`, finding: { what: 'header on scroll', ref: d(na), build: d(nb), fix } });
    } else area.add('navScroll', W.navScroll, null, { detail: 'reference has no nav' });
  }

  // ambient / continuous motion: one inventory (marquees, loops, infinite visible animations, videos,
  // auto-advancing carousels) compared by count, share of bands with motion, and kinds
  {
    const aa = ambientOf(ref, heroA), ab = ambientOf(build, heroA ? heroB : null);
    const q = presence(aa.count > 0, ab.count > 0);
    const P = M.ambient.parts;
    let s = q.s;
    const ka = Object.keys(aa.kinds || {}), kb = Object.keys(ab.kinds || {});
    if (q.kind === 'both') {
      const uni = new Set([...ka, ...kb]);
      const jac = uni.size ? ka.filter((k) => kb.includes(k)).length / uni.size : 1;
      s = P.count * lin(logRatio(aa.count + 1, ab.count + 1), M.ambient.countLog) + P.bands * lin(Math.abs((aa.bandShare || 0) - (ab.bandShare || 0)), M.ambient.bandShareAbs) + P.kinds * jac;
    }
    const sig = q.kind === 'extra' ? clamp(0.3 + 0.35 * ab.count + (ab.bandShare || 0), 0.3, 1) : clamp(0.3 + 0.35 * aa.count + (aa.bandShare || 0), 0.3, 1);
    const d = (x) => (x.count ? `${x.count} item(s) (${Object.entries(x.kinds || {}).map(([k, n]) => `${n} ${k}`).join(', ')}) in ${Math.round((x.bandShare || 0) * 100)}% of bands` : 'none');
    const ex = (aa.items || []).slice(0, 2).map((x) => `${x.kind} ${x.el}`).join('; ');
    const fix = q.kind === 'missing' ? `Reference keeps the page alive with continuous motion: ${d(aa)} (e.g. ${ex}); the build is still. Add the matching looping animations (CSS @keyframes infinite) in the same bands.`
      : q.kind === 'extra' ? `The build runs continuous motion (${d(ab)}); the reference has none. Remove the loops.`
      : `Continuous motion differs: build ${d(ab)}; reference ${d(aa)}${ex ? ` (e.g. ${ex})` : ''}. Match the count, kinds and where it runs.`;
    area.add('ambient', W.ambient * (q.absent ? 1 : sig), s, { absent: q.absent, detail: `ref ${d(aa)}; build ${d(ab)}`, finding: { what: 'ambient motion', ref: d(aa), build: d(ab), fix } });
  }

  // transitions
  {
    // a category counts only when its properties visibly change in something the capture observed
    // (hover deltas, reveal/load from-states, the header's scrolled state): transitions on properties that
    // never change are no-ops a builder could only match by adding no-op transitions
    const keep = (cats, obs) => (obs ? Object.fromEntries(Object.entries(cats).filter(([c]) => obs.has(c))) : cats);
    const taAll = transitionCats(ref), tbAll = transitionCats(build);
    const ta = keep(taAll, observedCats(ref)), tbObs = keep(tbAll, observedCats(build));
    const tb = tbAll; // timings of a matched category are compared whatever the build's elements do
    const dropped = Object.keys(taAll).filter((c) => !ta[c]);
    const items = [];
    for (const [c, a] of Object.entries(ta)) {
      const b = tb[c];
      if (!b) { items.push({ s: 0, w: Math.sqrt(a.share), what: `${c} transitions`, ref: `${a.ms}ms ${a.family} on ${a.n} elements`, build: 'none', fix: `Reference transitions ${c} properties (${a.ms}ms ${a.easing || a.family}) on ${a.n} elements; the build has no ${c} transitions. Add transition: ${c === 'colour' ? 'color, background-color, border-color' : c === 'effects' ? 'box-shadow, filter' : c} ${a.ms}ms ${a.easing || a.family} to interactive elements.` }); continue; }
      const s = 0.6 * lin(logRatio(a.ms, b.ms), M.transitionDurationLog) + 0.4 * easingSim(a.family, b.family);
      items.push({ s, w: Math.sqrt(a.share), what: `${c} transition timing`, ref: `${a.ms}ms ${a.family}`, build: `${b.ms}ms ${b.family}`, fix: `${c} transitions run ${b.ms}ms ${b.family}; reference runs ${a.ms}ms ${a.easing || a.family}. Set them to ${a.ms}ms ${a.easing || a.family}.` });
    }
    for (const [c, b] of Object.entries(tbObs)) if (!ta[c] && b.share >= M.extraCategoryShare) items.push({ s: 0, w: Math.sqrt(b.share) * 0.5, what: `${c} transitions not in the reference`, ref: 'none', build: `${b.ms}ms on ${b.n} elements`, fix: `The build transitions ${c} properties on ${b.n} elements; the reference does not. Remove those ${c} transitions.` });
    const c = combine(items);
    const none = !Object.keys(ta).length && !Object.keys(tbObs).length;
    area.add('transitions', W.transitions, none ? 1 : !Object.keys(ta).length ? (c.s ?? 1) : c.s, { absent: none, detail: `ref ${Object.entries(ta).map(([k, v]) => `${k} ${v.ms}ms ${v.family}`).join(', ') || 'none'}${dropped.length ? ` (not scored, no visible change observed: ${dropped.join(', ')})` : ''}; build ${Object.entries(tb).map(([k, v]) => `${k} ${v.ms}ms ${v.family}`).join(', ') || 'none'}`, items: c.items });
  }

  // hover (not scored against a --fast build capture, which skips the hover pass)
  if (build.meta?.fast) area.add('hover', W.hover, null, { detail: 'build capture is --fast (no hover pass)' });
  else {
    const ha = hoverByKind(ref), hb = hoverByKind(build);
    const cropA = hoverCrops(ref, dirs.refDir), cropB = hoverCrops(build, dirs.buildDir);
    const items = [];
    const pcs = (c) => `${Math.round(c.changed * 1000) / 10}%`;
    const lookTxt = (c) => (c.look && c.look !== 'none' ? `${c.look}, ` : '');
    // kinds sampled only on invalid elements (moving without the pointer, not shown) on a side: skipped, never
    // compared against the other side's valid sample
    const invalidOnly = (cap, valid) => new Set((cap.hover || []).filter((h) => h && h.kind && h.invalid && !valid[h.kind]).map((h) => h.kind));
    const invA = invalidOnly(ref, ha), invB = invalidOnly(build, hb);
    const skippedKinds = [...new Set([...invA, ...invB])];
    for (const [kind, a] of Object.entries(ha)) {
      const b = hb[kind];
      if (!b && invB.has(kind)) continue;
      if (!b) {
        // the reference's crop pair shows a visible change but the build has no element of that kind the
        // hover pass reached: the visible hover change is missing
        const ca0 = cropA[kind];
        if (ca0 && ca0.visible && !cropB[kind]) items.push({ s: 0, w: M.hoverKindWeights[kind] || 1, what: `${kind} hover`, ref: `visible change (${lookTxt(ca0)}crops differ on ${pcs(ca0)})`, build: `no ${kind} hovered`,
          fix: `The reference's ${kind} visibly changes on hover (${lookTxt(ca0)}crops differ on ${pcs(ca0)}); the build has no ${kind} the hover pass reached. Give the matching ${kind} the reference's hover change (motion-patterns §hover).` });
        continue;
      }
      let s = hoverSim(a.f, b.f);
      // classes with weight < 0.5 are child-only or seen on some of the sampled elements
      const desc = (e) => (e.f.size ? [...e.f].map(([c, w]) => (w >= 0.5 ? c : `${c} (weak)`)).join(', ') : 'nothing');
      const add = [...a.set].filter((c) => !b.set.has(c)), drop = [...b.f.keys()].filter((c) => !a.f.has(c));
      let fix = `${kind} hover changes ${desc(b)} in the build; reference changes ${desc(a)}${a.transition ? ` (${String(a.transition).slice(0, 90)})` : ''}.${add.length ? ` Add a hover change of ${add.join(', ')}.` : ''}${drop.length ? ` Remove the hover change of ${drop.join(', ')}.` : ''}${!add.length && !drop.length ? ` Match how strongly each property changes.` : ''}`;
      // hover data vs the before/after crops of the same element: when they disagree on either side the data
      // is WEAK and the kind is judged on the crops (both change visibly, by a similar share of the crop, or
      // both stay the same), so a build that matches what the crops show is never charged for it
      const ca = cropA[kind], cb = cropB[kind];
      const dis = (cap, c, kindName) => { const e = pairedHover(cap, kindName); return !!(c && e) && (hoverClasses(e).size > 0) !== c.visible; };
      const disA = dis(ref, ca, kind), disB = dis(build, cb, kind);
      let refDesc = desc(a), buildDesc = desc(b);
      if ((disA || disB) && ca && cb) {
        s = ca.visible !== cb.visible ? 0 : !ca.visible ? 1 : lin(Math.abs(Math.log((ca.changed + 0.01) / (cb.changed + 0.01))), M.hoverCropLog);
        const pc = (c) => `${Math.round(c.changed * 1000) / 10}%`;
        refDesc = `${desc(a)}${disA ? ' (WEAK: the crops disagree)' : ''}; crops differ on ${pc(ca)}`;
        buildDesc = `${desc(b)}${disB ? ' (WEAK: the crops disagree)' : ''}; crops differ on ${pc(cb)}`;
        fix = `${kind} hover: the hover data and the before/after crops disagree on ${disA && disB ? 'both sides' : disA ? 'the reference' : 'the build'}, so it is judged on the crops (states sheet): reference crops differ on ${pc(ca)}, build on ${pc(cb)}. ${ca.visible && !cb.visible ? 'Give the build a hover change as visible as the reference crop shows.' : !ca.visible && cb.visible ? "Remove the build's visible hover change; the reference crop shows none." : 'Match how strongly the crop changes.'}`;
      } else if (ca && cb && ca.visible && !cb.visible) {
        // the data agree with the crops on both sides, yet only the reference's change is visible (a change
        // too faint to see, or on another element): the visible hover change is missing
        s = 0;
        refDesc = `${desc(a)}; visible (${lookTxt(ca)}crops differ on ${pcs(ca)})`;
        buildDesc = `${desc(b)}; no visible change (crops differ on ${pcs(cb)})`;
        fix = `${kind} hover: the reference's crop pair visibly ${ca.look && ca.look !== 'none' && ca.look !== 'recolours or moves' ? ca.look : 'changes'} (crops differ on ${pcs(ca)}); the build's shows no visible change (${pcs(cb)}). Make the build's hover change as visible as the reference's (states sheet; motion-patterns §hover).`;
      }
      items.push({ s, w: M.hoverKindWeights[kind] || 1, what: `${kind} hover`, ref: refDesc, build: buildDesc, fix });
    }
    const c = combine(items);
    area.add('hover', W.hover, c.s, { detail: `kinds compared: ${items.map((i) => i.what.replace(' hover', '')).join(', ') || 'none'}${skippedKinds.length ? `; skipped (no valid sample on one side): ${skippedKinds.join(', ')}` : ''}`, items: c.items });
  }

  // sticky / pinned elements besides the header
  {
    const oa = otherSticky(ref), ob = otherSticky(build);
    const so = oa.length || ob.length ? (oa.length && ob.length ? lin(logRatio(oa.length + 1, ob.length + 1), M.countLog) : 0) : 1;
    area.add('sticky', W.sticky, so, { absent: !oa.length && !ob.length, detail: `other sticky ${oa.length} vs ${ob.length}`,
      finding: { what: 'sticky/pinned elements (besides the nav)', ref: `${oa.length}${oa[0] ? ` (e.g. ${oa[0]?.el}, ${oa[0]?.h}px)` : ''}`, build: `${ob.length}${ob[0] ? ` (e.g. ${ob[0].el})` : ''}`,
        fix: oa.length > ob.length ? `Reference keeps ${oa.length} element(s) sticky/pinned while scrolling (e.g. ${oa[0]?.el}, ${oa[0]?.h}px, kind ${oa[0]?.kind}); the build has ${ob.length}. Pin the matching element with position: sticky.` : `The build pins ${ob.length} element(s) besides the nav (e.g. ${ob[0]?.el}); the reference pins ${oa.length}. Remove the extra sticky positioning.` } });
  }

  // parallax
  {
    const xa = parallaxList(ref), xb = parallaxList(build);
    const q = presence(xa.length > 0, xb.length > 0);
    let s = q.s;
    const rA = median(xa.map((x) => x.rate)), rB = median(xb.map((x) => x.rate));
    if (q.kind === 'both' && isNum(rA) && isNum(rB)) s = lin(Math.abs(rA - rB), M.parallaxRate);
    area.add('parallax', W.parallax, s, { absent: q.absent, detail: `${xa.length} (rate ${rA ?? '-'}) vs ${xb.length} (rate ${rB ?? '-'})`,
      finding: { what: 'parallax', ref: xa.length ? `${xa.length} element(s), rate ${rA}` : 'none', build: xb.length ? `${xb.length} element(s), rate ${rB}` : 'none',
        fix: q.kind === 'missing' ? `Reference moves ${xa.length} element(s) at ${rA} of scroll speed (parallax, e.g. ${xa[0]?.el}); the build has none. Translate a decorative/media element by ${r2(1 - rA)} x scrollY.` : q.kind === 'extra' ? `The build has parallax motion (rate ${rB}); the reference has none. Remove it.` : `Parallax rate is ${rB}; reference is ${rA}. Translate by ${r2(1 - rA)} x scrollY.` } });
  }

  // marquee
  {
    const ma = ref.motion.marquees || [], mb = bm.marquees || [];
    const q = presence(ma.length > 0, mb.length > 0);
    let s = q.kind === 'both' ? 1 : null;
    const va = median(ma.map((x) => x.pxPerSec)), vb = median(mb.map((x) => x.pxPerSec));
    if (q.kind === 'both') s = 0.6 * (isNum(va) && isNum(vb) ? lin(logRatio(va, vb), M.marqueeSpeedLog) : 0.5) + 0.4 * (ma[0]?.dir === mb[0]?.dir ? 1 : 0);
    area.add('marquee', W.marquee, s, { detail: `${ma.length} (${va ?? '-'}px/s ${ma[0]?.dir ?? ''}) vs ${mb.length} (${vb ?? '-'}px/s ${mb[0]?.dir ?? ''})`,
      finding: { what: 'marquee', ref: ma.length ? `${va}px/s ${ma[0]?.dir}` : 'none', build: mb.length ? `${vb}px/s ${mb[0]?.dir}` : 'none',
        fix: q.kind === 'missing' ? `Reference has a continuously scrolling marquee (${va}px/s, ${ma[0]?.dir}); the build has none. Add a CSS marquee moving ${ma[0]?.dir} at ${va}px/s.` : q.kind === 'extra' ? `The build has a marquee (${vb}px/s); the reference has none. Make that row static.` : `Marquee moves ${vb}px/s ${mb[0]?.dir}; reference moves ${va}px/s ${ma[0]?.dir}. Set the animation duration so it moves ${va}px/s ${ma[0]?.dir}.` } });
  }

  // auto-advance period (presence is part of ambient): the slow watch's median interval between steps
  {
    const per = (cap) => (cap.motion?.carousels?.autoAdvance || []).map((a) => a && a.periodMs).filter(isNum);
    const pa = per(ref), pb = per(build);
    const va = median(pa), vb = median(pb);
    const s = isNum(va) && isNum(vb) ? lin(logRatio(va, vb), M.autoAdvancePeriodLog) : null;
    area.add('autoAdvance', W.autoAdvance, s, { detail: `period ${va ?? '-'} vs ${vb ?? '-'} ms`,
      finding: { what: 'auto-advance period', ref: isNum(va) ? `${va}ms` : 'none', build: isNum(vb) ? `${vb}ms` : 'none', fix: `The build's carousel advances every ${vb}ms; the reference every ${va}ms. Set the auto-advance interval to ${va}ms.` } });
  }

  // smooth scroll
  {
    const sa = !!ref.motion.smoothScroll?.detected, sb = !!bm.smoothScroll?.detected;
    const q = presence(sa, sb);
    area.add('smoothScroll', W.smoothScroll, q.s, { absent: q.absent, detail: `${sa} vs ${sb}`,
      finding: { what: 'smooth scroll', ref: sa ? `yes (${ref.motion.smoothScroll.library || 'custom'})` : 'native', build: sb ? 'yes' : 'native',
        fix: sa ? `Reference smooths wheel scrolling (${ref.motion.smoothScroll.library || 'custom'}, ~${ref.motion.smoothScroll.t90Ms}ms to settle); the build scrolls natively. Add Lenis (cdnjs) with a similar duration.` : `The build smooths wheel scrolling; the reference scrolls natively. Remove the smooth-scroll library.` } });
  }

  // scroll-linked
  {
    const ca = scrollLinkedN(ref), cb = scrollLinkedN(build);
    const q = presence(ca > 0, cb > 0);
    const s = q.kind === 'both' ? lin(logRatio(ca + 1, cb + 1), M.countLog) : q.s;
    area.add('scrollLinked', W.scrollLinked, s, { absent: q.absent, detail: `${ca} vs ${cb}`,
      finding: { what: 'scroll-linked (scrubbed) animation', ref: ca, build: cb,
        fix: q.kind === 'missing' ? `Reference scrubs ${ca} animation(s) with scroll position (ScrollTrigger scrub / scroll timelines); the build has none. Add a scroll-scrubbed animation in the matching band.` : q.kind === 'extra' ? `The build scrubs ${cb} animation(s) with scroll; the reference has none. Remove them.` : `The build has ${cb} scroll-scrubbed animations; reference has ${ca}. Match the count.` } });
  }

  // page tint on scroll: the screenshot-level page background at scroll rests, so a body-background
  // change, a fixed colour layer and a pseudo-element paint read the same. Not scored on older captures.
  {
    // a change below M.tintMinDe from the colour before it (white to a 1% off-white) is not a visible tint:
    // dropped on both sides before scoring
    const visTint = (t) => {
      if (!t || typeof t !== 'object') return t;
      const cols = (t.colors || []).filter((x) => !(x && x.color && x.rest && (dE(x.color, x.rest) ?? 1) < (M.tintMinDe ?? 0.02)));
      const dropped = (t.colors || []).length - cols.length;
      return dropped ? { ...t, colors: cols, changes: Math.max(0, (t.changes || 0) - dropped) } : t;
    };
    const ta = visTint(ref.motion.scrollTint), tb = visTint(bm.scrollTint);
    if (!ta || typeof ta !== 'object') area.add('scrollTint', W.scrollTint, null, { detail: 'reference capture has no scroll-tint measurement' });
    else {
      const P = M.scrollTint.parts;
      const na = ta.changes || 0, nb = tb?.changes || 0;
      const q = presence(na > 0, nb > 0);
      let s = q.s;
      const ca = (ta.colors || []).map((x) => x && x.color).filter(Boolean), cb = (tb?.colors || []).map((x) => x && x.color).filter(Boolean);
      const near = (from, to) => (from.length && to.length ? from.reduce((acc, c) => acc + Math.min(...to.map((t) => dE(c, t) ?? 1)), 0) / from.length : null);
      // where each change starts (the band's top as a viewport fraction) and how long it takes, for the
      // reference changes whose nearest-colour build change has both measured
      const T = M.scrollTint.timing;
      const timing = [];
      if (q.kind === 'both') {
        for (const a of ta.colors || []) {
          if (!a || !a.color || !isNum(a.bandTop)) continue;
          const b = (tb.colors || []).filter((x) => x && x.color && isNum(x.bandTop)).sort((x, y) => (dE(a.color, x.color) ?? 1) - (dE(a.color, y.color) ?? 1))[0];
          if (!b) continue;
          const st = lin(Math.abs(a.bandTop - b.bandTop), T.bandTopAbs);
          const sm = isNum(a.ms) && isNum(b.ms) ? lin(Math.abs(a.ms - b.ms), T.msAbs) : (!!a.scrub === !!b.scrub ? 1 : 0);
          timing.push({ s: T.parts.trigger * st + T.parts.ms * sm, a, b });
        }
      }
      if (q.kind === 'both') {
        const dAB = near(ca, cb), dBA = near(cb, ca);
        const sc = isNum(dAB) && isNum(dBA) ? lin((dAB + dBA) / 2, M.scrollTint.colorDeltaE) : 0.5;
        const sCount = lin(logRatio(na + 1, nb + 1), M.scrollTint.countLog);
        s = timing.length ? (1 - T.part) * (P.count * sCount + P.color * sc) + T.part * (timing.reduce((x, t) => x + t.s, 0) / timing.length) : P.count * sCount + P.color * sc;
      }
      const tm = (x) => (isNum(x.bandTop) ? ` starting with its band's top at ${Math.round(x.bandTop * 100)}% of the viewport${isNum(x.ms) ? `, ${x.ms}ms` : x.scrub ? `, following the scroll over ${x.rangePx}px` : ''}` : '');
      const d = (t, n) => (n ? `${n} background change(s) while scrolling (${(t.colors || []).map((x) => `${x.color} at ${x.at}px${tm(x)}`).slice(0, 5).join(', ')})` : 'one background colour throughout');
      const fix = q.kind === 'missing' ? `The reference page changes its background colour as it scrolls: ${d(ta, na)}; the build keeps one colour. Recolour the page background (body, a fixed layer or the bands) at those scroll positions.`
        : q.kind === 'extra' ? `The build changes its page background while scrolling (${d(tb, nb)}); the reference keeps one colour. Remove the scroll tint.`
        : `Page tint on scroll differs: build ${d(tb, nb)}; reference ${d(ta, na)}. Match the colours and where they change.${timing.filter((t) => t.s < 0.95).slice(0, 2).map((t) => ` Start the change to ${t.a.color} when its band's top reaches ${Math.round(t.a.bandTop * 100)}% of the viewport${isNum(t.a.ms) ? ` and let it take ${t.a.ms}ms` : ''}.`).join('')}`;
      area.add('scrollTint', W.scrollTint, s, { absent: q.absent, detail: `ref ${d(ta, na)}; build ${tb ? d(tb, nb) : 'not measured'}`, finding: { what: 'page tint on scroll', ref: d(ta, na), build: tb ? d(tb, nb) : 'not measured', fix } });
    }
  }

  return { area };
}
