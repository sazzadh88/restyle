// Node-side motion analysis for capture.mjs: easing classification, reveal grouping,
// sticky / parallax / horizontal-scroll detection from rest-state rects, nav changes, smooth scroll.

const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;
const median = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const modeOf = (arr) => { const m = new Map(); for (const a of arr) m.set(a, (m.get(a) || 0) + 1); let b = null, n = -1; for (const [k, v] of m) if (v > n) { n = v; b = k; } return b; };

// ---------- easing ----------
function bezier(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const X = (s) => ((ax * s + bx) * s + cx) * s, Y = (s) => ((ay * s + by) * s + cy) * s, dX = (s) => (3 * ax * s + 2 * bx) * s + cx;
  return (t) => {
    let s = t;
    for (let i = 0; i < 8; i++) { const x = X(s) - t, d = dX(s); if (Math.abs(x) < 1e-5) break; if (Math.abs(d) < 1e-6) break; s -= x / d; }
    if (s < 0 || s > 1 || Math.abs(X(s) - t) > 1e-3) { let lo = 0, hi = 1; s = t; for (let i = 0; i < 30; i++) { const x = X(s); if (Math.abs(x - t) < 1e-5) break; if (x < t) lo = s; else hi = s; s = (lo + hi) / 2; } }
    return Y(s);
  };
}
const REF = {
  linear: [0, 0, 1, 1], ease: [0.25, 0.1, 0.25, 1], 'ease-in': [0.42, 0, 1, 1], 'ease-out': [0, 0, 0.58, 1], 'ease-in-out': [0.42, 0, 0.58, 1],
  'out-quad': [0.25, 0.46, 0.45, 0.94], 'out-cubic': [0.215, 0.61, 0.355, 1], 'out-quart': [0.165, 0.84, 0.44, 1], 'out-expo': [0.19, 1, 0.22, 1],
  'in-cubic': [0.55, 0.055, 0.675, 0.19], 'in-out-cubic': [0.645, 0.045, 0.355, 1], 'in-out-quart': [0.77, 0, 0.175, 1],
};
const REFC = Object.fromEntries(Object.entries(REF).map(([k, v]) => { const f = bezier(...v); return [k, [1, 2, 3, 4, 5, 6, 7, 8, 9].map((q) => f(q / 10))]; }));
function family(c) {
  // c: progress at 10%..90%
  const p25 = (c[1] + c[2]) / 2, p50 = c[4], p75 = (c[6] + c[7]) / 2;
  if (p50 >= 0.62) return 'ease-out';
  if (p50 <= 0.38) return 'ease-in';
  if (p25 < 0.2 && p75 > 0.8) return 'ease-in-out';
  if (Math.abs(p25 - 0.25) < 0.08 && Math.abs(p75 - 0.75) < 0.08) return 'linear';
  return p25 + p75 > 1 ? 'ease-out' : 'ease-in';
}
export function classifyCurve(curve, over = 0) {
  if (!curve) return null;
  if (over > 0.03) return { family: 'spring-like', nearest: null, overshoot: r2(over) };
  let best = null, be = Infinity;
  for (const [k, ref] of Object.entries(REFC)) { const e = Math.sqrt(ref.reduce((s, v, i) => s + (v - curve[i]) ** 2, 0) / 9); if (e < be) { be = e; best = k; } }
  return { family: family(curve), nearest: best, rmse: r2(be) };
}
const REFF = Object.fromEntries(Object.entries(REF).map(([k, v]) => [k, bezier(...v)]));
// Fit sampled progress points [[ms since start, progress]] to the reference curves, searching the
// duration too (the last few % of an ease-out are below the sampling threshold, so the raw
// "settled" time underestimates the real duration).
export function fitProgress(pp, over = 0) {
  if (!pp || pp.length < 4) return null;
  const T = pp[pp.length - 1][0];
  if (!(T > 0)) return null;
  if (over > 0.03) return { family: 'spring-like', nearest: null, ms: Math.round(T), overshoot: r2(over) };
  let best = null;
  for (const [name, f] of Object.entries(REFF)) {
    for (let D = T * 0.7; D <= T * 3.5; D *= 1.03) {
      let e = 0;
      for (const [t, p] of pp) e += (f(Math.min(1, t / D)) - p) ** 2;
      e = Math.sqrt(e / pp.length);
      if (!best || e < best.e - 1e-9) best = { name, D, e };
    }
  }
  return { family: family(REFC[best.name]), nearest: best.name, ms: Math.round(best.D), rmse: r2(best.e) };
}
export function classifyEasingString(s) {
  if (!s) return null;
  s = s.trim();
  if (/^steps|step-start|step-end/.test(s)) return { family: 'steps', nearest: null };
  if (s.startsWith('linear(')) {
    const nums = (s.match(/-?[\d.]+(?![\d.]*%)/g) || []).map(Number);
    if (nums.some((v) => v > 1.01 || v < -0.01)) return { family: 'spring-like', nearest: null };
    return { family: 'custom-linear', nearest: null };
  }
  let p = REF[s];
  const m = s.match(/cubic-bezier\(([^)]+)\)/);
  if (m) p = m[1].split(',').map(Number);
  if (!p) return null;
  if (p[1] > 1.02 || p[3] > 1.02 || p[1] < -0.02 || p[3] < -0.02) return { family: 'spring-like', nearest: null, bezier: p };
  const f = bezier(...p);
  const curve = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((q) => f(q / 10));
  const c = classifyCurve(curve, 0);
  return { family: c.family, nearest: REF[s] ? s : c.nearest };
}

// ---------- reveal / animation grouping ----------
const PROP_OF = { o: /opacity|^all$/, ty: /transform|translate|^all$/, tx: /transform|translate|^all$/, s: /transform|scale|^all$/, r: /transform|rotate|^all$/, c: /clip-path|^all$/, b: /filter|^all$/ };
function cssSource(ch) {
  const re = PROP_OF[ch.dom] || /x^/;
  if (ch.css && ch.css.length) {
    const a = ch.css.find((x) => re.test(x.prop || '') || (x.type === 'animation') || (x.type === 'waapi' && (!x.prop || re.test(x.prop)))) || null;
    if (a && a.dur) return { source: a.type === 'transition' ? 'css-transition' : a.type === 'animation' ? 'css-animation' : 'waapi', ms: a.dur, delay: a.delay || 0, easing: a.easing, name: a.name || undefined, start: typeof a.start === 'number' ? a.start : null };
  }
  if (ch.tp) {
    const [props, durs, fns, dls] = ch.tp;
    const split = (s) => { const out = []; let d = 0, cur = ''; for (const c of s) { if (c === '(') d++; if (c === ')') d--; if (c === ',' && !d) { out.push(cur.trim()); cur = ''; } else cur += c; } out.push(cur.trim()); return out; };
    const P = split(props), D = split(durs), F = split(fns), L = split(dls);
    const toMs = (x) => (x || '').endsWith('ms') ? parseFloat(x) : parseFloat(x) * 1000;
    for (let i = 0; i < P.length; i++) {
      if (re.test(P[i]) && toMs(D[i % D.length]) > 0) return { source: 'css-transition', ms: Math.round(toMs(D[i % D.length])), delay: Math.round(toMs(L[i % L.length]) || 0), easing: F[i % F.length] };
    }
  }
  return null;
}
const revealLike = (f, t) => (t.o - f.o >= 0.2) || ((Math.abs(f.ty) >= 4 || Math.abs(f.tx) >= 4) && Math.abs(t.ty) + Math.abs(t.tx) <= (Math.abs(f.ty) + Math.abs(f.tx)) * 0.5) ||
  (Math.abs(f.s - 1) >= 0.02 && Math.abs(t.s - 1) <= Math.abs(f.s - 1) * 0.5) || (t.c - f.c >= 0.15) || (f.b - t.b >= 1) || (f.v === 0 && t.v === 1) || (Math.abs(f.r) >= 2 && Math.abs(t.r) <= Math.abs(f.r) * 0.5);
// a step reveal: content switching from hidden to shown at once (a class toggle with no transition, content
// arriving in one frame): opacity from <= 0.2 to >= 0.8, visibility hidden to visible, or clip from <= 20%
// to whole. A visibility toggle with nothing else changing is discrete, so it is a step whatever its span.
const stepAppears = (f, t) => (f.o <= 0.2 && t.o >= 0.8) || (f.v === 0 && t.v === 1 && t.o >= 0.8) || (f.c <= 0.2 && t.c >= 0.95);
const visOnly = (f, t) => f.v === 0 && t.v === 1 && f.o >= 0.95 && Math.abs(f.ty) < 4 && Math.abs(f.tx) < 4 && Math.abs(f.s - 1) < 0.02 && f.c > 0.95 && f.b < 1;
const fromKey = (f) => `${Math.round(f.o * 10)}|${Math.round(f.ty / 4)}|${Math.round(f.tx / 4)}|${Math.round(f.s * 50)}|${Math.round(f.c * 10)}|${Math.round(f.b)}`;
// from-state with translation, scale and rotation relative to where the element rests (`to`): an element
// centred with translate(-50%, -50%) rests at a large offset, which is layout, not a slide
const relFrom = (ch) => {
  const f = ch.from, t = ch.to;
  if (!f || !t) return f;
  const n = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  return Object.assign({}, f, { tx: n(f.tx, 0) - n(t.tx, 0), ty: n(f.ty, 0) - n(t.ty, 0), s: n(t.s, 1) ? n(f.s, 1) / n(t.s, 1) : n(f.s, 1), r: n(f.r, 0) - n(t.r, 0) });
};
const fromOut = (f) => { const o = {}; if (f.o < 0.99) o.opacity = r2(f.o); if (Math.abs(f.ty) >= 1) o.y = Math.round(f.ty); if (Math.abs(f.tx) >= 1) o.x = Math.round(f.tx); if (Math.abs(f.s - 1) >= 0.005) o.scale = r2(f.s); if (Math.abs(f.r) >= 0.5) o.rotate = r1(f.r); if (f.c < 0.99) o.clipVisible = r2(f.c); if (f.b >= 0.2) o.blur = r1(f.b); if (f.v === 0) o.visibility = 'hidden'; return o; };

function groupChanges(items, sectionOf) {
  // items: [{ ch, info, phase }]
  const groups = new Map();
  for (const it of items) {
    // same phase, same band, same kind (load only) and same from-state = one reveal pattern. Class names
    // are not part of the key: visual siblings in a row or grid (cards with per-item classes, a heading
    // and its paragraph) group together, and the stagger is measured per visual row below.
    const band = sectionOf ? sectionOf(it.info.y) : '';
    const k = `${it.phase}|${band}|${it.info.kind || ''}|${fromKey(relFrom(it.ch))}|${it.step ? 'step' : ''}`;
    const g = groups.get(k) || { phase: it.phase, kind: it.info.kind, members: [] };
    g.members.push(it); groups.set(k, g);
  }
  const out = [];
  // load (absolute clock): a member's start is its CSS/WAAPI animation's real start (startTime + delay)
  // when known and plausible (not later than the first sampled visible change + 150 ms, not more than
  // 1.5 s before it); else the sampled start. Frame drops during load delay the sampled start, so groups
  // whose real starts differ by their CSS delays could otherwise read as starting together.
  for (const g of groups.values()) for (const m of g.members) {
    const s = g.phase === 'load' ? cssSource(m.ch) : null;
    const rt = s && typeof s.start === 'number' ? s.start + Math.max(0, s.delay || 0) : null;
    m.t0r = rt !== null && rt <= m.ch.t0 + 150 && rt >= m.ch.t0 - 1500 ? rt : m.ch.t0;
    m.real = rt !== null && m.t0r === rt;
  }
  for (const g of groups.values()) {
    const M = g.members.sort((a, b) => a.t0r - b.t0r);
    const ch0 = M[0].ch, info0 = M[0].info;
    const srcs = M.map((m) => cssSource(m.ch));
    let css = srcs.find(Boolean) || null;
    const durs = M.map((m) => m.ch.dur);
    let stagger = 0, staggerHow = null;
    if (M.length >= 2) {
      const delays = srcs.map((s) => s && s.delay);
      if (srcs.every(Boolean) && new Set(delays).size > 1) {
        const ds = [...new Set(delays)].sort((a, b) => a - b); const diffs = []; for (let i = 1; i < ds.length; i++) diffs.push(ds[i] - ds[i - 1]);
        stagger = Math.round(median(diffs)); staggerHow = 'css transition/animation delays';
      } else {
        // within each visual row (grid reveals restart the stagger per row), distinct start times
        const rows = new Map();
        for (const m of M) { const k = Math.round((m.info.y || 0) / 24); const a = rows.get(k) || []; a.push(m.t0r); rows.set(k, a); }
        const diffs = [];
        for (const ts of rows.values()) {
          const u = []; for (const t of ts.slice().sort((a, b) => a - b)) if (!u.length || t - u[u.length - 1] > 8) u.push(t);
          for (let i = 1; i < u.length; i++) diffs.push(u[i] - u[i - 1]);
        }
        if (!diffs.length) { const u = M.map((m) => m.t0r).sort((a, b) => a - b); for (let i = 1; i < u.length; i++) if (u[i] - u[i - 1] > 8) diffs.push(u[i] - u[i - 1]); }
        const md = median(diffs); if (md !== null && md >= 20) { stagger = Math.round(md); staggerHow = 'sampled start times (per row)'; }
      }
    }
    // curves that were already running when sampling began are truncated: not used for timing
    const fits = M.filter((m) => m.ch.t0 > 0).map((m) => fitProgress(m.ch.pp, m.ch.over || 0)).filter(Boolean);
    let sampled = fits.length ? { family: modeOf(fits.map((f) => f.family)), nearest: modeOf(fits.map((f) => f.nearest)), ms: Math.round(median(fits.map((f) => f.ms))) } : null;
    let fromE = classifyEasingString(css && css.easing);
    const fromMed = {}, toMed = {};
    for (const k of ['o', 'ty', 'tx', 's', 'r', 'c', 'b', 'v']) { fromMed[k] = median(M.map((m) => relFrom(m.ch)[k])); toMed[k] = median(M.map((m) => m.ch.to[k])); }
    // `to` = an end state that is not at rest (opacity, clip, blur, visibility); translation, scale and
    // rotation are measured from the rest position, so they never appear here
    const toO = fromOut(Object.assign({}, toMed, { tx: 0, ty: 0, s: 1, r: 0 }));
    // load groups: the members' final first-screen rects (union), which the load strip is measured in
    const bxs = M.map((m) => m.info.box).filter((b) => Array.isArray(b) && b.length === 4);
    const box = bxs.length ? (() => { const x0 = Math.min(...bxs.map((b) => b[0])), y0 = Math.min(...bxs.map((b) => b[1])); return [x0, y0, Math.max(...bxs.map((b) => b[0] + b[2])) - x0, Math.max(...bxs.map((b) => b[1] + b[3])) - y0]; })() : undefined;
    // where the reveal starts: trigger = the members' top (viewport fraction) when their first change was
    // seen. When that change began while the step was still scrolling, the top is the observer line it
    // crossed (triggerHow 'crossed'). When its earliest member began >= 120 ms after the scroll had stopped, less its CSS delay (afterScrollMs:
    // load-driven fades, JS delays), the element was already at rest: the top is where it rested, the line
    // was crossed somewhere between topBefore (its top before the step) and there (triggerHow 'rest').
    // offscreen: began after the scroll stopped with the element below the viewport (never seen animating).
    const isN = (v) => typeof v === 'number' && Number.isFinite(v);
    const trig = median(M.map((m) => m.ch.top).filter(isN));
    const top0 = median(M.map((m) => m.ch.top0).filter(isN));
    // the earliest member's start after the scroll stopped, less its own CSS delay (a stagger delays the
    // others on purpose); IntersectionObserver + first painted change take 2-4 frames, so >= 120 ms = at rest
    const afts = g.phase === 'load' ? [] : M.map((m, i) => (isN(m.ch.scrollEnd) ? m.ch.t0 - m.ch.scrollEnd - ((srcs[i] && srcs[i].delay) || 0) : null)).filter(isN);
    const aft = afts.length ? Math.min(...afts) : null;
    const atRest = isN(aft) && aft >= 120;
    // step group (every member switched from hidden to shown at once): no duration, easing or transition
    const step = M.every((m) => m.step);
    if (step) { css = null; sampled = null; fromE = null; }
    out.push({
      phase: g.phase, kind: g.kind || undefined, band: sectionOf ? sectionOf(info0.y) : null, parent: info0.parentDesc, el: info0.desc, n: M.length,
      from: fromOut(fromMed), to: Object.keys(toO).length ? toO : undefined, prop: ch0.dom,
      appear: step ? 'step' : undefined, ms: step ? 0 : css ? css.ms : (sampled ? sampled.ms : Math.round(median(durs))), sampledMs: sampled ? sampled.ms : null, settleMs: Math.round(median(durs)), delay: css ? css.delay : undefined,
      easing: css ? css.easing : null, family: (fromE && fromE.family) || (sampled && sampled.family) || null, nearest: (fromE && fromE.nearest) || (sampled && sampled.nearest) || null,
      sampledFamily: sampled ? sampled.family : null, stagger, staggerHow, source: step ? 'step (no transition)' : css ? css.source : 'js (frame-sampled)',
      trigger: trig, triggerHow: g.phase === 'load' || trig === null ? undefined : atRest ? 'rest' : 'crossed', topBefore: g.phase === 'load' ? undefined : top0,
      afterScrollMs: atRest ? Math.round(aft) : undefined, offscreen: atRest && isN(trig) && trig >= 1 ? true : undefined,
      ys: g.phase === 'load' ? undefined : M.slice(0, 8).map((m) => m.info.y).filter(isN).sort((a, b) => a - b), t0: Math.round(M[0].t0r), t0How: g.phase === 'load' ? (M[0].real ? 'animation start' : 'sampled') : undefined, area: Math.round(median(M.map((m) => m.info.area))), box,
      nested: info0.nestedIn !== null && info0.nestedIn !== undefined ? true : undefined,
    });
  }
  return out;
}

// reveals.summary from the counted groups (groups marked `skip` are left out: capture marks a load-driven
// fade that its reveal strip shows already in place)
export function summarizeReveals(groups) {
  const top = (groups || []).filter((g) => !g.skip);
  if (!top.length) return null;
  // duration and easing come from the eased groups; step groups (appear 'step') have none. stepGroups =
  // how many step groups; appear 'step' = every group is a step (ms, family, easing null)
  const eased = top.filter((g) => g.appear !== 'step');
  const summary = {
    groups: top.length, elements: top.reduce((s, g) => s + g.n, 0),
    from: modeOf(top.map((g) => JSON.stringify(g.from))), ms: eased.length ? Math.round(median(eased.map((g) => g.ms))) : null,
    stepGroups: top.length - eased.length || undefined, appear: eased.length ? undefined : 'step',
    family: modeOf(eased.map((g) => g.family).filter(Boolean)), easing: modeOf(eased.map((g) => g.easing).filter(Boolean)) || null,
    stagger: median(top.filter((g) => g.stagger).map((g) => g.stagger)), trigger: median(top.map((g) => g.trigger).filter((v) => v !== null && v !== undefined)),
    sources: [...new Set(top.map((g) => g.source))],
  };
  summary.from = JSON.parse(summary.from);
  return summary;
}

// Reveal groups of a scroll step that has a strip (normal mode: the strip replays that step on a fresh,
// settled page): strip = the strip number, inStrip = 'in place' / 'animates' (its content measure). Strips
// of a --frames-like capture (`like`) replay the reference's step at the matching page position: their
// `step` is not this page's scroll-pass step, so they link no groups. Per linked group:
//   skip  a group that began only after the scroll had stopped (triggerHow 'rest': load-driven, e.g. a fade
//         when a lazy image arrives), large enough to show (>= 5% of the viewport) and in place in the strip;
//         or a step group (appear 'step') whose strip shows nothing arriving: not a reveal a viewer sees
//   trigger  a rest-position group (triggerHow 'rest') whose strip shows content arriving after the scroll
//         stopped fired there with its members' top at (median ys - the strip's end scroll) / vh; when that
//         rest is lower in the viewport than the pass's, it is the tighter bound on the observer line: trigger
//         = it, triggerHow 'strip', triggerSampled = the pass's value.
// reveals.summary is recomputed when anything changed. Returns true when something changed.
export function linkRevealStrips(R, strips, vw, vh) {
  if (!R || !R.groups || !Array.isArray(strips)) return false;
  const isN = (v) => typeof v === 'number' && Number.isFinite(v);
  let changed = false;
  strips.forEach((st, idx) => {
    if (!st || st.like || !st.step || !st.content || typeof st.content.inPlace !== 'boolean') return;
    const ap = st.content.appear || null, sc = st.scroll || {};
    const endY = isN(sc.px) && sc.px > 0 && isN(st.scrollFrom) ? st.scrollFrom + sc.px : st.scrollTo;
    for (const g of R.groups) {
      if (g.phase !== `step${st.step}`) continue;
      g.strip = idx + 1; g.inStrip = st.content.inPlace ? 'in place' : 'animates';
      if (st.content.inPlace && g.triggerHow === 'rest' && !g.offscreen && (g.n * (g.area || 0)) / (vw * vh) >= 0.05) { g.skip = `in place in reveal strip ${idx + 1} (load-driven: began ${g.afterScrollMs} ms after the scroll stopped)`; changed = true; continue; }
      if (g.appear === 'step' && st.content.inPlace && (!ap || ap.kind === 'none')) { g.skip = `step change with nothing arriving in reveal strip ${idx + 1}`; changed = true; continue; }
      const ys = (g.ys || []).filter(isN);
      if (g.triggerHow === 'rest' && !st.content.inPlace && ap && ap.kind !== 'none' && ys.length && isN(endY) && vh > 0 && (!isN(sc.settleMs) || !isN(ap.atMs) || ap.atMs >= sc.settleMs)) {
        const top = Math.round(((median(ys) - endY) / vh) * 100) / 100;
        if (top > (g.trigger ?? -Infinity) && top < 1) { g.triggerSampled = g.trigger; g.trigger = top; g.triggerHow = 'strip'; changed = true; }
      }
    }
  });
  if (changed) { R.summary = summarizeReveals(R.groups); R.groupsTotal = R.groups.filter((g) => !g.skip).length; }
  return changed;
}

// steps: [{k, changes:[...]}]; info: Map(i -> trackedInfo)
export function analyzeReveals(steps, info, sectionOf) {
  const perEl = new Map();
  for (const s of steps) for (const ch of s.changes) { const a = perEl.get(ch.i) || []; if (typeof s.scrollEndMs === 'number') ch.scrollEnd = s.scrollEndMs; a.push({ k: s.k, ch }); perEl.set(ch.i, a); }
  const reveals = [], scrollLinked = [], other = [], liveCont = [], crossFades = [], layers = [], mediaPieces = [], fixedUi = [], header = [], tiny = [];
  for (const [i, list] of perEl) {
    const inf = info.get(i); if (!inf) continue;
    if (inf.cont) continue;
    // driven by an infinite CSS/WAAPI animation: a loop that ran during the steps (ambient), neither a
    // reveal nor scroll-linked
    if (list.some((l) => (l.ch.css || []).some((a) => a && a.iter === 'infinite'))) { other.push({ i, inf, why: 'loop' }); continue; }
    const ks = [...new Set(list.map((l) => l.k))];
    const liveSteps = list.filter((l) => l.ch.live && (l.ch.dom === 'tx' || l.ch.dom === 'ty') && l.ch.n >= 20).length;
    // a text-free piece of a media / illustration box (inf.media, page-analyze stand-in boxes): its motion is
    // that box's media activity, never scroll-linked or a JS marquee
    if (inf.media && (liveSteps >= 2 || ks.length >= 3)) { mediaPieces.push(i); continue; }
    if (liveSteps >= 2) { liveCont.push({ i, inf, list }); continue; }
    if (ks.length >= 3) { scrollLinked.push({ i, inf, list, ks }); continue; }
    const first = list[0].ch;
    const fromState = inf.init;
    const last = list[list.length - 1].ch;
    // an instant jump is not an animation, unless it is content appearing at once (a step reveal)
    const jump = ks.length === 1 && first.dur <= 40;
    if (jump && !stepAppears(fromState, last.to)) { other.push({ i, inf, ch: first, jump: true }); continue; }
    const ch = Object.assign({}, first, { from: fromState, to: last.to });
    if (!revealLike(fromState, last.to)) { other.push({ i, inf, ch }); continue; }
    // not reveals (besides loops, above): a fade of a slide stacked on a same-tag sibling (cross-fading
    // slides of a carousel), and a fade of
    // a layer taller than 1.5 viewports whose top is already above the viewport (a page-tint/background
    // layer; scroll tints are measured in motion.scrollTint)
    const fadeOnly = fromState.o < 0.95 && Math.abs(fromState.ty) < 4 && Math.abs(fromState.tx) < 4 && Math.abs(fromState.s - 1) < 0.02 && fromState.c > 0.95;
    if (inf.stacked && fadeOnly) { crossFades.push(i); continue; }
    // a small fixed / sticky box (back-to-top button, floating chip) never scrolls into view: its fade-in on
    // scroll is a scroll state, not a reveal
    if (inf.fixedUi) { fixedUi.push(i); continue; }
    if (typeof first.top === 'number' && first.top < -0.25 && inf.h >= 1.5 * (inf.vh || 900)) { layers.push(i); continue; }
    // the header bar's toggles on scroll are its scrolled state (page-core rc.inHeader); a box under 64 px²
    // when measured (a zero-size wrapper toggling visibility) shows nothing: neither is a reveal
    if (inf.hdr) { header.push(i); continue; }
    if (typeof inf.area === 'number' && inf.area < 64) { tiny.push(i); continue; }
    reveals.push({ ch, info: inf, phase: `step${list[0].k}`, step: jump || visOnly(fromState, last.to) || undefined });
  }
  // drop children that only move with their revealing parent (same timing, same property)
  const byI = new Map(reveals.map((r) => [r.info.i, r]));
  const kept = reveals.filter((r) => {
    const p = r.info.nestedIn;
    if (p === null || p === undefined) return true;
    const pr = byI.get(p);
    if (!pr) return true;
    return !(Math.abs(pr.ch.t0 - r.ch.t0) < 50 && pr.ch.dom === r.ch.dom);
  });
  const groups = groupChanges(kept, sectionOf).sort((a, b) => (a.band ?? 0) - (b.band ?? 0) || a.t0 - b.t0);
  // a "reveal" that completes in under 40 ms (a few px of frame-sampled progress) is a jump, not an animation,
  // unless it is a step group (content switching from hidden to shown at once)
  const top = groups.filter((g) => (!g.nested || g.n >= 3) && !(typeof g.ms === 'number' && g.ms < 40 && g.appear !== 'step'));
  const summary = summarizeReveals(top);
  const sl = scrollLinked.slice(0, 12).map(({ inf, list, ks }) => {
    const f = inf.init, t = list[list.length - 1].ch.to;
    return { el: inf.desc, band: sectionOf ? sectionOf(inf.y) : null, steps: ks.length, from: fromOut(f), to: fromOut(t), endsAtRest: Math.abs(t.ty) < 2 && Math.abs(t.tx) < 2 && t.o > 0.95 && Math.abs(t.s - 1) < 0.01 };
  });
  return { summary, groups: top.slice(0, 24), groupsTotal: top.length, scrollLinked: sl, scrollLinkedTotal: scrollLinked.length, otherChanges: other.length,
    crossFades: crossFades.length || undefined, layers: layers.length || undefined, mediaPieces: mediaPieces.length || undefined, fixedUi: fixedUi.length || undefined, header: header.length || undefined, tiny: tiny.length || undefined, jsMarquees: liveCont.slice(0, 6).map(({ inf, list }) => ({ el: inf.desc, band: sectionOf ? sectionOf(inf.y) : null, axis: list[0].ch.dom === 'tx' ? 'x' : 'y', pxPerSec: Math.round(median(list.map((l) => l.ch.speed || 0))) })) };
}

// Load-in animation of the first screen. Staging = how the first screen is built: when content first
// paints (FCP), how long until the first element animates, the order in which the parts arrive
// (nav / headline / text / cta / media / group), and the total duration.
const STAGE_GAP = 60; // groups starting within this many ms of each other arrive together
export function analyzeLoad(load) {
  if (!load || !load.changes) return null;
  const items = load.changes.filter((c) => c.net !== false).map((c) => ({ ch: c, info: { parent: c.parent, parentDesc: c.parent.split('>').pop(), desc: c.desc, y: 0, area: c.area, box: c.box, nestedIn: null, kind: c.kind || 'other' }, phase: 'load' }));
  const groups = groupChanges(items, null).map((g) => { delete g.band; delete g.nested; return g; }).sort((a, b) => a.t0 - b.t0 || b.area - a.area);
  const base = { dclMs: load.dcl, fcpMs: load.fcp ?? null, tracked: load.tracked, frames: load.frames, frameMs: load.frameMs, cssEventsDuringLoad: load.events,
    snapsIgnored: load.snaps || 0, continuousIgnored: load.continuous || 0, skipped: load.skipped || undefined, groups: groups.slice(0, 16), groupsTotal: groups.length };
  if (!groups.length) return Object.assign(base, { summary: null });
  const endOf = (g) => g.t0 + g.ms + (g.stagger || 0) * Math.max(0, g.n - 1);
  const firstStartMs = groups[0].t0, lastEndMs = Math.max(...groups.map(endOf));
  // order of arrival by kind (first group of each kind); kinds that start together share a step
  const firstOf = new Map();
  for (const g of groups) if (g.kind && g.kind !== 'other' && !firstOf.has(g.kind)) firstOf.set(g.kind, g.t0);
  const ordered = [...firstOf.entries()].sort((a, b) => a[1] - b[1]);
  const order = [];
  for (const [k, t] of ordered) { const last = order[order.length - 1]; if (last && t - last.t <= STAGE_GAP) last.kinds.push(k); else order.push({ t, kinds: [k] }); }
  const steps = new Set(groups.map((g) => Math.round(g.t0 / STAGE_GAP))).size;
  // modal from-state (weighted by element area) as an object
  const fw = new Map();
  for (const g of groups) { const k = JSON.stringify(g.from); fw.set(k, (fw.get(k) || 0) + (g.area || 1) * g.n); }
  const fromK = [...fw.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const staging = {
    firstContentMs: load.fcp ?? null,
    delayMs: load.fcp != null ? Math.max(0, Math.round(firstStartMs - load.fcp)) : null,
    order: order.map((o) => o.kinds.join('+')),
    steps,
    totalMs: Math.round(lastEndMs - firstStartMs),
  };
  // a staged load exists only when a meaningful share of the first viewport's content animates in
  // (areaShare: media boxes count as one content box each; textShare: the content outside them)
  const areaShare = typeof load.areaShare === 'number' ? load.areaShare : null;
  const textShare = typeof load.textShare === 'number' ? load.textShare : undefined;
  base.summary = { groups: groups.length, firstStartMs, lastEndMs: Math.round(lastEndMs), ms: Math.round(median(groups.map((g) => g.ms))),
    family: modeOf(groups.map((g) => g.family).filter(Boolean)), from: JSON.parse(fromK), staging,
    areaShare, textShare, staged: areaShare === null ? undefined : areaShare >= STAGED_SHARE || (textShare || 0) >= STAGED_SHARE };
  return base;
}
export const STAGED_SHARE = 0.15;

// ---------- sticky / parallax / horizontal from rest rects ----------
// rests: [{sy, vs, L:[[top,left,h,w]|null], rv:[bool] (revealing flags), nav}], layoutInfo: [[desc,pos,ev,id,parentIdx]]
export function analyzeLayoutMotion(rests, layoutInfo, vh, vw, sectionOf) {
  const sticky = [], parallax = [], horizontal = [];
  const useVs = rests.some((r, i) => i && Math.abs(r.sy - rests[i - 1].sy) < 5 && Math.abs(r.vs - rests[i - 1].vs) > 40);
  const pos = (r) => useVs ? r.vs : r.sy;
  const flagged = new Map();
  // Layout shift between two rests (an ad slot or embed resizing, lazy content arriving, scroll anchoring
  // compensating for it) moves the in-flow content by the same amount: the median deviation of in-flow
  // elements from the scroll distance is the content's own shift, and every element's rate is measured
  // against the distance the content actually moved (ds + shift). A pair in which the page height changed
  // and an element's remaining deviation is about that change (60-100% of it) is a layout shift for that
  // element, not parallax evidence.
  const shift = rests.map(() => 0), docShift = rests.map(() => 0);
  for (let k = 1; k < rests.length; k++) {
    const ds = pos(rests[k]) - pos(rests[k - 1]);
    docShift[k] = (rests[k].docH || 0) - (rests[k - 1].docH || 0);
    if (Math.abs(ds) < 40) continue;
    const dev = [];
    for (let j = 0; j < layoutInfo.length; j++) {
      const cssPos = layoutInfo[j][1];
      if (cssPos === 'fixed' || cssPos === 'sticky' || layoutInfo[j][5]) continue;
      const a = rests[k - 1].L[j], b = rests[k].L[j];
      if (!a || !b || (rests[k].rv && rests[k].rv[j])) continue;
      if (!(a[0] < vh && a[0] + a[2] > 0 && b[0] < vh && b[0] + b[2] > 0)) continue;
      dev.push(-(b[0] - a[0]) - ds);
    }
    const md = median(dev);
    if (dev.length >= 4 && md !== null && Math.abs(md) >= 3) shift[k] = md;
  }
  for (let j = 0; j < layoutInfo.length; j++) {
    // media = a text-free piece of a media / illustration box (capture.mjs sets layoutInfo[j][5] from
    // page-analyze): its movement is that box's media activity, never parallax or horizontal scroll
    const [desc, cssPos, ev, id, parentIdx, media] = layoutInfo[j];
    const pairs = [];
    for (let k = 1; k < rests.length; k++) {
      const a = rests[k - 1].L[j], b = rests[k].L[j];
      if (!a || !b) continue;
      const ds = pos(rests[k]) - pos(rests[k - 1]) + shift[k];
      if (Math.abs(ds) < 40) continue;
      const inA = a[0] < vh * 1.5 && a[0] + a[2] > -vh * 0.5, inB = b[0] < vh * 1.5 && b[0] + b[2] > -vh * 0.5;
      if (!inA && !inB) continue;
      const revealing = rests[k].rv && rests[k].rv[j];
      const dy = -(b[0] - a[0]);
      const devPx = Math.abs(dy - ds), dsh = Math.abs(docShift[k]);
      const layout = dsh >= 8 && devPx <= dsh + 8 && devPx >= 0.6 * dsh - 8;
      pairs.push({ k, ds, rate: dy / ds, rateX: (b[1] - a[1]) / ds, dy, revealing, layout, a, b, inBoth: inA && inB });
    }
    if (!pairs.length) continue;
    const clean = pairs.filter((p) => !p.revealing);
    const stuck = clean.filter((p) => Math.abs(p.rate) < 0.06 && p.inBoth);
    const h = rests[0].L[j] ? rests[0].L[j][2] : (pairs[0].a[2]);
    const y0 = rests[0].L[j] ? rests[0].L[j][0] + pos(rests[0]) : null;
    if (stuck.length >= 1 && (cssPos === 'fixed' || cssPos === 'sticky' || stuck.length >= 2)) {
      const allStuck = stuck.length === clean.filter((p) => p.inBoth).length;
      const kind = cssPos === 'fixed' ? 'fixed' : cssPos === 'sticky' ? 'sticky' : 'pinned';
      const from = Math.min(...stuck.map((p) => pos(rests[p.k - 1]))), to = Math.max(...stuck.map((p) => pos(rests[p.k])));
      flagged.set(j, 'stuck');
      sticky.push({ el: desc, id, kind, h: Math.round(h), hFrac: r2(h / vh), top: Math.round(stuck[0].b[0]), range: [from, to], always: allStuck || undefined, band: sectionOf && y0 !== null ? sectionOf(y0) : null, parentIdx });
      continue;
    }
    if (media) continue;
    if (ev === 'bg-fixed') { flagged.set(j, 'par'); parallax.push({ el: desc, id, kind: 'background-attachment-fixed', rate: 0, evidence: 'css', band: sectionOf && y0 !== null ? sectionOf(y0) : null, parentIdx }); continue; }
    const flow = clean.filter((p) => !p.layout);
    const dev = flow.filter((p) => p.inBoth && Math.abs(p.rate - 1) >= 0.08 && Math.abs(p.dy - p.ds) >= 15);
    const rates = flow.filter((p) => p.inBoth).map((p) => p.rate);
    const mr = median(rates);
    if (dev.length >= 2 && mr !== null && Math.abs(mr - 1) >= 0.08 && dev.every((p) => Math.sign(p.rate - 1) === Math.sign(mr - 1)) && Math.abs(mr) >= 0.06) {
      flagged.set(j, 'par');
      parallax.push({ el: desc, id, kind: 'scroll-linked translate', rate: r2(mr), evidence: ev === 'attr' ? 'data-speed-like attribute + measured' : 'measured', pairs: dev.length, band: sectionOf && y0 !== null ? sectionOf(y0) : null, parentIdx });
      continue;
    }
    const hx = clean.filter((p) => p.inBoth && Math.abs(p.rateX) >= 0.3);
    if (hx.length >= 2 && hx.every((p) => Math.sign(p.rateX) === Math.sign(hx[0].rateX))) {
      flagged.set(j, 'hx');
      horizontal.push({ el: desc, id, kind: 'scroll-driven', rateX: r2(median(hx.map((p) => p.rateX))), distance: Math.round(Math.abs(hx.reduce((s, p) => s + (p.b[1] - p.a[1]), 0))), band: sectionOf && y0 !== null ? sectionOf(y0) : null, parentIdx });
    }
  }
  // keep only outermost of each kind
  const outer = (arr, tag) => arr.filter((x) => { let p = x.parentIdx; let guard = 0; while (p !== null && p !== undefined && p >= 0 && guard++ < 50) { if (flagged.get(p) === tag) return false; p = layoutInfo[p] ? layoutInfo[p][4] : null; } return true; }).map(({ parentIdx, ...rest }) => rest);
  return { sticky: outer(sticky, 'stuck').slice(0, 10), parallax: outer(parallax, 'par').slice(0, 10), horizontal: outer(horizontal, 'hx').slice(0, 6), basis: useVs ? 'visual offset of bands (transform scroller)' : 'window scroll' };
}

// Header behaviour on scroll, from the rest states of the scroll pass. rests[k].nav = state of the nav
// found at the top (the same element at every rest); rests[k].hdr = whichever header is pinned at the top
// of the viewport at that rest (may be a different element that appears on scroll), or null.
const btnMatch = (list, b) => list.some((x) => (x.bg && x.bg === b.bg && Math.abs((x.x || 0) - (b.x || 0)) < 60) || x.desc === b.desc);
export function analyzeNav(rests) {
  if (!rests || rests.length < 2) return null;
  const a = rests[0].nav;
  const later = rests.slice(1);
  const changes = {};
  if (a) {
    const st = later.map((r) => r.nav).filter(Boolean);
    for (const k of ['pos', 'h', 'bg', 'shadow', 'blur', 'border', 'color']) {
      const l = st.find((x) => JSON.stringify(x[k]) !== JSON.stringify(a[k]));
      if (l) changes[k] = [a[k], l[k]];
    }
  }
  const pinned = later.map((r) => r.hdr);
  const nPinned = pinned.filter(Boolean).length;
  // stays in view = pinned at the majority of scrolled rests and at the rest nearest 1.5 viewport heights
  // (a header that steps aside over one band but is there while reading still reads as sticky)
  const near15 = later.reduce((b, r) => (b === null || Math.abs((r.vs || r.sy || 0) - (rests[0].vh || 900) * 1.5) < Math.abs((b.vs || b.sy || 0) - (rests[0].vh || 900) * 1.5) ? r : b), null);
  const staysInView = nPinned > 0 && nPinned >= Math.ceil(pinned.length * 0.5) && !!(near15 && near15.hdr);
  const pos0 = (r) => (r.vs || r.sy || 0);
  const navGone = a ? later.some((r) => !r.nav || r.nav.ty <= -a.h * 0.6 || r.nav.o < 0.1 || r.nav.top <= -a.h * 0.6) : false;
  // 'hides' = a pinned header that slides/fades away on scroll; an in-flow header simply scrolls away
  const pinnedOnce = a ? later.some((r) => r.nav && Math.abs(r.nav.top) < 4 && pos0(r) > a.h * 2) : false;
  const hidesOnScroll = navGone && !staysInView && !!a && (a.pos === 'fixed' || a.pos === 'sticky' || pinnedOnce);
  // representative scrolled state: the pinned header at the rest nearest 1.5 viewport heights down
  const target = (rests[0].vh || 900) * 1.5;
  const pos = (r) => (r.vs || r.sy || 0);
  let s1 = null, best = Infinity;
  for (const r of later) if (r.hdr && Math.abs(pos(r) - target) < best) { best = Math.abs(pos(r) - target); s1 = r.hdr; }
  const top0 = rests[0].hdr || a;
  let scrolled = { visible: false };
  if (s1) {
    const extra = (s1.btns || []).filter((b) => !(top0 && top0.btns && btnMatch(top0.btns, b)));
    const swapped = rests[0].hdr ? rests[0].hdr.id !== s1.id : !!a;
    scrolled = { visible: true, el: s1.el, swapped: swapped || undefined, h: s1.h, bg: s1.bg, transparent: s1.transparent, blur: s1.blur, shadow: s1.shadow, border: s1.border, links: s1.links, buttons: (s1.btns || []).length,
      extra: extra.length ? extra.map((b) => ({ desc: b.desc, bg: b.bg, h: b.h })) : undefined };
    if (top0) for (const k of ['h', 'bg', 'shadow', 'blur', 'border']) if (JSON.stringify(top0[k]) !== JSON.stringify(s1[k]) && !changes[k]) changes[k] = [top0[k], s1[k]];
    if (top0 && top0.transparent !== undefined && !!top0.transparent !== !!s1.transparent) changes.transparent = [!!top0.transparent, !!s1.transparent];
    if (extra.length) changes.extra = [0, extra.length];
  }
  return { changes: Object.keys(changes).length ? changes : null, hidesOnScroll: hidesOnScroll || undefined, staysInView, reappears: navGone && staysInView ? true : undefined, scrolled };
}

// ---------- header evidence from the screenshots ----------
// fold = <vp>-fold.png (scroll 0), scrolled = <vp>-scrolled.png (1.5 viewports down), both decoded PNGs
// ({width, height, data}); h = the nav's height in px. `pinned`: the bar's edges in the fold (luma steps
// > 40 between neighbouring pixels in rows 2..h-2) found again in the scrolled shot within 1 px: `match` >=
// 0.6 = the same bar is still at the top (true), <= 0.25 = something else is there (false), else null (also
// with < 60 edge pixels). `fold` / `scrolled` = the bar's bottom edge in each shot: `line` = a thin line
// (1-3 rows within [h-2, h+1], >= 50% of the width within 10 levels of its median, >= 8 levels off the bar
// colour 5 rows up, not the top of a solid block), `shadow` = 6 uniform rows below the bar darkening toward
// it (>= 6 levels, >= 3 rows darker; a 1 px line is not a shadow), `edge` = either; null when the bar
// itself is not one uniform colour there.
export function navShots(fold, scrolled, h) {
  const H = Math.round(h || 0);
  if (!fold || !scrolled || !(H >= 12) || H + 10 > Math.min(fold.height, scrolled.height)) return null;
  const L = (P, x, y) => { const i = (y * P.width + x) * 4; return 0.299 * P.data[i] + 0.587 * P.data[i + 1] + 0.114 * P.data[i + 2]; };
  const W = Math.min(fold.width, scrolled.width);
  const grad = (P, x, y) => Math.abs(L(P, x + 1, y) - L(P, x - 1, y)) + Math.abs(L(P, x, y + 1) - L(P, x, y - 1));
  let nF = 0, hit = 0;
  for (let y = 2; y < H - 2; y++) for (let x = 2; x < W - 2; x += 2) {
    if (grad(fold, x, y) <= 40) continue;
    nF++;
    let near = false;
    for (let dy = -1; dy <= 1 && !near; dy++) for (let dx = -1; dx <= 1 && !near; dx++) if (grad(scrolled, x + dx, y + dy) > 30) near = true;
    if (near) hit++;
  }
  const match = nF >= 60 ? Math.round((hit / nF) * 100) / 100 : null;
  const pinned = match === null ? null : match >= 0.6 ? true : match <= 0.25 ? false : null;
  const edgeOf = (P) => {
    const st = (y) => { const v = []; for (let x = 0; x < P.width; x += 2) v.push(L(P, x, y)); v.sort((a, b) => a - b); const m = v[v.length >> 1]; return { m, u: v.filter((q) => Math.abs(q - m) <= 10).length / v.length }; };
    const bar = st(H - 5);
    if (bar.u < 0.8) return null;
    let line = null;
    for (let y = H - 2; y <= H + 1; y++) { const s = st(y); if (s.u >= 0.5 && Math.abs(s.m - bar.m) >= 8) { line = { y, luma: Math.round(s.m) }; break; } }
    if (line) { const b = st(line.y + 3); if (b.u >= 0.8 && Math.abs(b.m - line.luma) < 4) line = null; }
    const rows = [0, 1, 2, 3, 4, 5].map((i) => st(H + i));
    const shadow = rows.every((q) => q.u >= 0.8) && rows[0].m <= rows[5].m - 6 && rows.slice(0, 5).filter((q) => q.m <= rows[5].m - 3).length >= 3 && rows.every((q, i) => i === 0 || q.m >= rows[i - 1].m - 1);
    return { line: !!line, lineLuma: line ? line.luma : undefined, shadow, edge: !!line || shadow };
  };
  return { pinned, match, fold: edgeOf(fold), scrolled: edgeOf(scrolled) };
}
// Applies navShots evidence to spacing.nav (and its onScroll / byViewport entry): a bar still at the top
// of the scrolled shot stays in view, so an in-flow `pos` (a fixed header inside a relative wrapper, a
// pinned clone) becomes the pinned element's position (`posCss` keeps the computed one, `posHow` says
// why); a thin line or shadow under the bar that only the scrolled shot shows is an on-scroll change
// (`changes.line`, whatever paints it). `hdrPos` = position of the header pinnedHeader found at the
// scrolled shot (or null). Returns the evidence record written to onScroll.shot.
export function applyNavShots(nav, ev, hdrPos = null) {
  if (!nav || !ev) return null;
  const pinnedPos = (p) => p === 'fixed' || p === 'sticky';
  const rec = { pinned: ev.pinned, match: ev.match, edge: [ev.fold ? ev.fold.edge : null, ev.scrolled ? ev.scrolled.edge : null] };
  if (ev.pinned === true && !pinnedPos(nav.pos)) { nav.posCss = nav.pos; nav.pos = pinnedPos(hdrPos) ? hdrPos : 'sticky'; nav.posHow = 'scrolled shot: the header is still at the top'; }
  const os = nav.onScroll;
  if (os) {
    if (ev.pinned === true && !os.staysInView) { os.staysInView = true; os.hidesOnScroll = undefined; }
    else if (ev.pinned === false && os.staysInView && !hdrPos) os.staysInView = false;
    if (ev.pinned === true && ev.fold && ev.scrolled && ev.fold.edge !== ev.scrolled.edge) {
      os.changes = Object.assign({}, os.changes || {}, { line: [ev.fold.edge, ev.scrolled.edge] });
      if (os.scrolled) os.scrolled.line = ev.scrolled.edge;
    }
    os.shot = rec;
  }
  return rec;
}

export function analyzeSmooth(scroll, libs) {
  const names = (libs || []).map((l) => l.name);
  const lib = names.find((n) => /lenis|locomotive|ScrollSmoother/.test(n)) || null;
  let t90 = null, dist = null, basis = null;
  if (scroll && scroll.length > 3) {
    const useVs = Math.abs(scroll[scroll.length - 1][1] - scroll[0][1]) < 5;
    const idx = useVs ? 2 : 1;
    basis = useVs ? 'visual' : 'window';
    const v0 = scroll[0][idx], v1 = scroll[scroll.length - 1][idx];
    dist = v1 - v0;
    if (Math.abs(dist) > 20) { const hit = scroll.find((p) => Math.abs(p[idx] - v0) >= Math.abs(dist) * 0.9); t90 = hit ? hit[0] : null; }
  }
  return { library: lib, t90Ms: t90, wheelDistance: dist, basis, detected: !!lib || (t90 !== null && t90 > 450) };
}
