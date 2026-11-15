#!/usr/bin/env node
// Asserts motion detection and motion scoring on harness/fixtures/motion (known values in expected.json):
// a composite illustration of small CSS-keyframe pieces is moving hero media (kind 'art'), never a marquee /
// loop / auto-advance, and its drifting and gradient layers are never scroll-linked, parallax or palette
// gradients; a slow auto-advance (3.5 s) and a cross-fade (2.5 s) are found with their periods
// and are not scroll reveals; a real marquee strip stays a marquee; reveal-recipe transitions that never
// change are no-ops; load group starts are the animations' real starts; the page tint's trigger and
// duration. Then synthetic checks (no browser): a keyframe-animated art box scores the same as
// frame-detected moving media (heroMedia, ambient); layout shift is not parallax; cross-fades, loops and
// page-tall layers are not reveals; load starts come from startTime + delay; reveal trigger provenance
// (crossed while scrolling vs rest position after the scroll stopped); reveal strip content (in place vs fading).
// Media part (harness/fixtures/motion-media, captured into runs/dev/motion/media, and `inspect.mjs activity` on
// the same served page): an HTML UI mock-up and a cycling card stack are media boxes; level = rateLevel(rate)
// everywhere; capture and inspect agree; the mock-up's state fade is no load group and does not delay the
// settle time; a track sliding inside a box is lateral media motion, not a marquee; a cursor hopping in a
// static mock-up reads low (intermittent); a word swap, step chips and a data feed are auto-advance. Then
// synthetic frames drawn in Chrome: media kind (in-place / lateral / cut / drift), a page-wide layout shift
// does not inflate the rate, mediaEntry / mediaRate rules, and compare's kind-mismatch charge.
//   node harness/check-motion.mjs                serve the fixtures, capture them (1440) into runs/dev/motion/{fixture,media}, check
//   node harness/check-motion.mjs <captureDir>   check an existing capture of the motion fixture (the media fixture is captured)
//   node harness/check-motion.mjs [<captureDir>] --media <mediaCapDir>   reuse a media fixture capture (inspect still runs)
// Prints one line per assertion, then one JSON summary line; exits 1 if any assertion fails.
import fs from 'node:fs';
import path from 'node:path';
import { differenceEuclidean } from 'culori';
import { ROOT, SCRIPTS, startServer, runNode, lastJson } from './lib/run.mjs';
import { compareCaptures } from '../skill/restyle/scripts/lib/cmp-core.mjs';
import { analyzeLayoutMotion, analyzeReveals, analyzeLoad } from '../skill/restyle/scripts/lib/motion.mjs';
import { stripContent } from '../skill/restyle/scripts/lib/frames.mjs';
import { boxActivity, mediaEntry, mediaRate, rateLevel, boxLevel, loadEntrance } from '../skill/restyle/scripts/lib/frames.mjs';
import { launchChrome } from '../skill/restyle/scripts/lib/browser.mjs';

const fixtureDir = path.join(ROOT, 'harness', 'fixtures', 'motion');
const E = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'expected.json'), 'utf8'));
const dist = differenceEuclidean('oklab');
const results = [];
const check = (name, ok, got, want) => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  got=${JSON.stringify(got)}  want=${JSON.stringify(want)}`); };
const near = (a, b, tol) => typeof a === 'number' && Math.abs(a - b) <= tol;
const copy = (x) => JSON.parse(JSON.stringify(x));

async function captureFixture() {
  const out = path.join(ROOT, 'runs', 'dev', 'motion', 'fixture');
  const srv = await startServer(fixtureDir);
  try {
    const r = await runNode(path.join(SCRIPTS, 'capture.mjs'), [srv.url, out, '--viewports', '1440'], { timeoutMs: 400000 });
    const j = lastJson(r.stdout);
    if (!j || !j.ok) throw new Error('capture did not report ok');
  } finally { await srv.stop(); }
  return out;
}

function captureChecks(c) {
  const m = c.motion || {};
  // composite illustration of keyframe pieces = moving hero media of kind 'art'
  const media = (m.load && m.load.media) || [];
  const art = media.find((x) => x.kind === E.art.kind);
  check('art box: composite illustration is hero media (kind art)', art && (art.pieces || 0) >= E.art.minPieces, art && { el: art.el, pieces: art.pieces, box: art.box }, `kind art, >= ${E.art.minPieces} pieces`);
  check('art box moves (frame-differenced, keyframe pieces absorbed)', art && art.moving && E.art.activity.includes(art.activity), art && [art.activity, art.when, art.keyframes], E.art.activity);
  const pc = E.art.pieceClass;
  const leaks = [...(m.marquees || []).map((x) => `marquee ${x.el}`), ...(m.loops || []).map((x) => `loop ${x.el}`),
    ...((m.carousels && m.carousels.autoAdvanceCandidates) || []).map((x) => `auto-advance ${x.el}`),
    ...((m.ambient && m.ambient.items) || []).filter((x) => x.kind !== 'media').map((x) => `${x.kind} ${x.el}`)].filter((s) => s.includes(pc));
  check('keyframe pieces are never marquee / loop / auto-advance', leaks.length === 0, leaks, []);
  check('art box is an ambient media item', ((m.ambient && m.ambient.items) || []).some((x) => x.kind === 'media' && x.media === 'art'), ((m.ambient && m.ambient.items) || []).map((x) => `${x.kind}:${x.media || x.el}`), 'media:art');
  // stand-in internals (a drifting layer, a gradient layer inside the art box) are the box's media activity:
  // never scroll-linked or parallax, never a palette gradient; the art box itself still moves
  const SI = E.standIn;
  const inArt = [...((m.reveals && m.reveals.scrollLinked) || []).map((x) => `scrollLinked ${x.el}`), ...(m.parallax || []).map((x) => `parallax ${x.el}`), ...(m.horizontal || []).filter((x) => x.kind === 'scroll-driven').map((x) => `horizontal ${x.el}`)].filter((s) => s.includes(pc));
  check('stand-in layers never scroll-linked / parallax', inArt.length === 0, inArt, []);
  const gLeak = ((c.colors && c.colors.gradients) || []).filter((g) => (g.css || '').includes(SI.gradientStop)).map((g) => g.css.slice(0, 80));
  check('stand-in gradient layer not in colors.gradients', gLeak.length === 0, gLeak, `no gradient with ${SI.gradientStop}`);
  check('art box with the stand-in layers is still moving hero media', art && art.moving && (art.pieces || 0) >= E.art.minPieces + 2, art && [art.activity, art.pieces], `moving, >= ${E.art.minPieces + 2} pieces`);
  // real marquee strips stay marquees (a horizontal logo strip; a vertical ticker windowed by a mask inside
  // a page wrapper with overflow-x hidden)
  for (const w of E.marquees) {
    const mq = (m.marquees || []).find((x) => (x.el || '').includes(w.el));
    check(`${w.el} is a marquee (speed, direction)`, mq && Math.abs(mq.pxPerSec - w.pxPerSec) <= w.pxPerSec * w.tolPct / 100 && mq.dir === w.dir, mq && [mq.el, mq.pxPerSec, mq.dir], w);
  }
  check('no other marquees', (m.marquees || []).length === E.marquees.length, (m.marquees || []).map((x) => x.el), E.marquees.map((x) => x.el));
  // slow auto-advance and cross-fade, with periods
  const aa = (m.carousels && m.carousels.autoAdvance) || [];
  for (const w of E.autoAdvance) {
    const it = aa.find((x) => (x.el || '').includes(w.el));
    check(`auto-advance ${w.el}: detected with its period`, it && near(it.periodMs, w.periodMs, w.tolMs) && it.how === w.how, it && [it.el, it.periodMs, it.how, it.steps], w);
  }
  check('auto-advance items in the ambient inventory with periods', ((m.ambient && m.ambient.items) || []).filter((x) => x.kind === 'auto-advance' && typeof x.periodMs === 'number').length >= E.autoAdvance.length, ((m.ambient && m.ambient.items) || []).filter((x) => x.kind === 'auto-advance').map((x) => [x.el, x.periodMs]), `${E.autoAdvance.length} with periodMs`);
  // reveals: the paragraphs and cards, never the cross-fading slides
  const rg = (m.reveals && m.reveals.groups) || [];
  check('reveals: opacity reveals found, cross-fading slides not among them', rg.reduce((s, g) => s + g.n, 0) === E.reveals.elements && !rg.some((g) => (g.el || '').includes(E.reveals.notIn)), rg.map((g) => [g.el, g.n]), E.reveals);
  // transitions that never change on the revealed elements are no-ops; the reveal's own transition carries it
  const T = (key) => (m.transitions || []).find((t) => `${t.prop}|${t.ms}` === key && (t.n || 0) >= 3);
  for (const [key, w] of Object.entries(E.transitions)) {
    const t = T(key);
    const ok = t && (w.n === undefined || t.n === w.n) && (w.noop === undefined || (t.noop || 0) === w.noop) && (w.rvMin === undefined || (t.rv || 0) >= w.rvMin);
    check(`transition ${key}: no-op / reveal counts`, ok, t && { n: t.n, noop: t.noop, rv: t.rv }, w);
  }
  check('transitions observed per element (motion.transitionsObserved)', typeof m.transitionsObserved === 'number' && m.transitionsObserved > 0, m.transitionsObserved, '> 0');
  // load: group starts are the animations' real starts (startTime + delay)
  const lg = (m.load && m.load.groups) || [];
  const order = (m.load && m.load.summary && m.load.summary.staging && m.load.summary.staging.order) || [];
  check('load order', E.load.order.every((k, i) => (order[i] || '').split('+').includes(k)), order, E.load.order);
  const gH = lg.find((g) => g.kind === E.load.order[0]), gT = lg.find((g) => g.kind === E.load.order[1]);
  check('load starts from the animations (t0How)', gH && gT && gH.t0How === E.load.t0How && gT.t0How === E.load.t0How, lg.map((g) => [g.kind, g.t0, g.t0How]), E.load.t0How);
  check('load start difference = CSS delay difference', gH && gT && near(gT.t0 - gH.t0, E.load.startDiffMs, E.load.tolMs), gH && gT && gT.t0 - gH.t0, E.load.startDiffMs);
  // page tint: where it starts and how long it takes
  const tc = ((m.scrollTint && m.scrollTint.colors) || []).find((x) => x.color && dist(x.color, E.tint.color) <= E.tint.maxDistance);
  check('scroll tint detected', !!tc, m.scrollTint && m.scrollTint.colors, E.tint.color);
  check('scroll tint trigger (band top as viewport fraction)', tc && near(tc.bandTop, E.tint.bandTop, E.tint.bandTopTol), tc && [tc.triggerAt, tc.bandTop], E.tint.bandTop);
  check('scroll tint duration (ms)', tc && typeof tc.ms === 'number' && tc.ms >= E.tint.msMin && tc.ms <= E.tint.msMax, tc && tc.ms, [E.tint.msMin, E.tint.msMax]);
  const th = (c.sections || []).find((s) => s.bg && s.bg.scrollTheme && typeof s.bg.scrollTheme.bandTop === 'number');
  check('band scroll theme carries trigger and duration', th && near(th.bg.scrollTheme.bandTop, E.tint.bandTop, E.tint.bandTopTol) && typeof th.bg.scrollTheme.ms === 'number', th && th.bg.scrollTheme, 'bandTop + ms');
}

function syntheticChecks(c) {
  const sub = (d, name) => d.areas.motion.subs.find((s) => s.name === name) || null;
  // 1. a keyframe-animated art box vs frame-detected moving media (a video) of the same activity: match
  {
    const build = copy(c);
    const ref = copy(c);
    const art = ref.motion.load.media.find((x) => x.kind === 'art');
    Object.assign(art, { kind: 'video', el: 'video.hero', activity: 'medium', moving: true, when: 'continuous', keyframes: undefined, pieces: undefined, playing: true });
    for (const it of ref.motion.ambient.items) if (it.kind === 'media') Object.assign(it, { media: 'video', el: 'video.hero', activity: 'medium', keyframes: undefined });
    const d = compareCaptures(ref, build);
    check('syn: keyframe art box vs frame-detected video -> heroMedia 10', sub(d, 'heroMedia') && sub(d, 'heroMedia').score === 10, sub(d, 'heroMedia') && sub(d, 'heroMedia').detail, 10);
    check('syn: ... and ambient 10', sub(d, 'ambient') && sub(d, 'ambient').score === 10, sub(d, 'ambient') && sub(d, 'ambient').detail, 10);
    // the old classification (pieces as marquees / auto-advance next to the media) is a real loss
    const old = copy(build);
    const band = old.motion.load.media.find((x) => x.kind === 'art').band;
    old.motion.ambient.items.push({ kind: 'marquee', band, el: 'div.pc.pc-4', src: 'css' }, { kind: 'auto-advance', band, el: 'div.pc.pc-5', src: 'js' });
    old.motion.ambient.count += 2; old.motion.ambient.kinds.marquee = (old.motion.ambient.kinds.marquee || 0) + 1; old.motion.ambient.kinds['auto-advance'] = (old.motion.ambient.kinds['auto-advance'] || 0) + 1;
    const d2 = compareCaptures(ref, old);
    check('syn: pieces read as marquee / auto-advance (old) -> ambient < 10', sub(d2, 'ambient') && sub(d2, 'ambient').score < 10, sub(d2, 'ambient') && sub(d2, 'ambient').detail, '< 10');
  }
  // 1b. transitions that never change (a reveal recipe's transform/filter on opacity-only reveals) cost nothing
  {
    const ref = copy(c);
    ref.motion.transitions = ref.motion.transitions.filter((t) => !(t.prop === 'filter' && t.ms === 800)).map((t) => (t.prop === 'transform' && t.ms === 800 ? { ...t, n: t.n - (t.noop || 0), noop: undefined } : t));
    const b = copy(c);
    for (let k = 0; k < 4; k++) b.motion.transitions.push({ prop: 'transform', ms: 1200, easing: 'ease', delay: 0, n: 40, noop: 40, family: 'ease-in-out' });
    const s = sub(compareCaptures(ref, b), 'transitions');
    check('syn: no-op transitions (reveal recipe) do not change the transitions score', s && s.score === sub(compareCaptures(ref, copy(ref)), 'transitions').score, s && [s.score, s.detail], 'same as self');
    const b2 = copy(b); delete b2.motion.transitionsObserved; for (const t of b2.motion.transitions) { delete t.noop; delete t.rv; }
    const s2 = sub(compareCaptures(ref, b2), 'transitions');
    check('syn: ... the same transitions without per-element observation do cost', s2 && s2.score < s.score, s2 && [s2.score, s2.detail], `< ${s && s.score}`);
  }
  // 2. auto-advance period compared on both sides
  {
    const ref = copy(c), b = copy(c);
    check('syn: same auto-advance period -> autoAdvance 10', sub(compareCaptures(ref, b), 'autoAdvance')?.score === 10, sub(compareCaptures(ref, b), 'autoAdvance')?.detail, 10);
    for (const a of b.motion.carousels.autoAdvance) a.periodMs = Math.round(a.periodMs * 2);
    const s = sub(compareCaptures(ref, b), 'autoAdvance');
    check('syn: period twice as long -> autoAdvance < 5', s && s.score < 5, s && [s.score, s.detail], '< 5');
  }
  // 3. scroll tint timing compared on both sides
  {
    const ref = copy(c), b = copy(c);
    check('syn: same tint timing -> scrollTint 10', sub(compareCaptures(ref, b), 'scrollTint')?.score === 10, sub(compareCaptures(ref, b), 'scrollTint')?.detail, 10);
    for (const x of b.motion.scrollTint.colors) { x.bandTop = (x.bandTop ?? 0.6) - 0.4; x.ms = (x.ms ?? 300) + 900; }
    const s = sub(compareCaptures(ref, b), 'scrollTint');
    check('syn: tint starts 40% of the viewport later and 900 ms slower -> scrollTint <= 7.5', s && s.score <= 7.5, s && [s.score, s.detail], '<= 7.5');
  }
  // 4. layout shift (an ad slot collapsing, scroll anchoring) is not parallax; a real 0.7 rate still is
  {
    const vh = 900, ds = 675;
    // four tall in-flow columns (always in view) and an image; at rests 2 and 3 the page loses 220 px above
    // the viewport each time (an ad slot collapsing; scroll anchoring makes scrollY grow by 455, while the
    // content in view moves the full 675 px): before the fix the image read as parallax at rate ~1.48
    const run = (shifts, blob, media) => {
      const info = [['div.c1', 'static', '', 'c1', -1], ['div.c2', 'static', '', 'c2', -1], ['div.c3', 'static', '', 'c3', -1], ['div.c4', 'static', '', 'c4', -1], ['img.photo', 'static', '', 'p', -1]];
      if (blob) info.push(['div.blob', 'absolute', '', 'b', -1, media]);
      const rests = [];
      let sy = 0, docH = 9000, acc = 0;
      for (let k = 0; k < 5; k++) {
        const sh = shifts[k] || 0;
        if (k) { sy += ds + sh; docH += sh; acc += sh; }
        const flow = (t, h, w) => [t - sy + acc, 100, h, w];
        const L = [flow(100, 6000, 300), flow(200, 6000, 300), flow(300, 6000, 300), flow(400, 6000, 300), flow(1400, 500, 600)];
        if (blob) L.push([Math.round(600 - sy * 0.7), 100, 3000, 200]);
        rests.push({ sy, vs: sy, docH, L, rv: L.map(() => false) });
      }
      return analyzeLayoutMotion(rests, info, vh, 1440, () => 0).parallax;
    };
    const a = run({ 2: -220, 3: -220 }, false);
    check('syn: layout shift during scroll (ad collapse + scroll anchoring) is not parallax', a.length === 0, a.map((p) => [p.el, p.rate]), []);
    const b = run({}, true);
    check('syn: ... a real 0.7-rate element still is parallax', b.length === 1 && b[0].el === 'div.blob' && near(b[0].rate, 0.7, 0.05), b.map((p) => [p.el, p.rate]), 'div.blob 0.7');
    const bm = run({}, true, true);
    check('syn: ... the same element as a piece of a media box (layoutInfo media flag) is not parallax', bm.length === 0, bm.map((p) => [p.el, p.rate]), []);
  }
  // 5. not reveals: a stacked cross-fading slide, a change driven by an infinite loop, a page-tall layer fade
  {
    const st = (o) => ({ o, tx: 0, ty: 0, s: 1, r: 0, c: 1, b: 0, v: 1 });
    const ch = (i, top, css) => ({ i, from: st(0), to: st(1), dom: 'o', net: true, t0: 10, dur: 400, pp: null, top, css: css || null });
    const info = new Map([
      [1, { i: 1, desc: 'div.slide', y: 2000, h: 300, w: 800, area: 240000, init: st(0), steps: [3], parentDesc: 'div.fades', parent: 'x', stacked: true, vh: 900 }],
      [2, { i: 2, desc: 'span.glow', y: 2600, h: 100, w: 100, area: 10000, init: st(0), steps: [4], parentDesc: 'div', parent: 'y', vh: 900 }],
      [3, { i: 3, desc: 'div.layer', y: 0, h: 3600, w: 1440, area: 5184000, init: st(0), steps: [4], parentDesc: 'div', parent: 'z', vh: 900 }],
      [4, { i: 4, desc: 'p.text', y: 3000, h: 80, w: 600, area: 48000, init: st(0), steps: [4], parentDesc: 'section', parent: 'w', vh: 900 }],
    ]);
    const steps = [{ k: 3, changes: [ch(1, 0.4)] }, { k: 4, changes: [ch(2, 0.5, [{ type: 'animation', name: 'glow', dur: 2000, delay: 0, iter: 'infinite' }]), ch(3, -2), ch(4, 0.85)] }];
    const rv = analyzeReveals(steps, info, null);
    check('syn: only the entering paragraph is a reveal (slide, loop, layer are not)', rv.summary && rv.summary.elements === 1 && rv.groups[0].el === 'p.text' && rv.crossFades === 1 && rv.layers === 1, rv.summary && { els: rv.summary.elements, groups: rv.groups.map((g) => g.el), crossFades: rv.crossFades, layers: rv.layers }, 'p.text only');
  }
  // 5b. a stand-in piece changing at 3 steps (media) is not scroll-linked; the same element outside a media box
  //     is; a small fixed button fading in (fixedUi) is not a reveal
  {
    const st = (o, tx) => ({ o, tx: tx || 0, ty: 0, s: 1, r: 0, c: 1, b: 0, v: 1 });
    const ch = (i, top, from, to) => ({ i, from, to, dom: from.o !== to.o ? 'o' : 'tx', net: true, t0: 10, dur: 400, pp: null, top, css: null });
    const mk = (media, fixedUi) => new Map([
      [1, { i: 1, desc: 'div.layer', y: 400, h: 120, w: 200, area: 24000, init: st(1, 10), steps: [1, 2, 3], parentDesc: 'div.hero__media', parent: 'm', vh: 900, media }],
      [2, { i: 2, desc: 'a.to-top', y: 3000, h: 48, w: 48, area: 2304, init: st(0), steps: [1], parentDesc: 'body', parent: 'b', vh: 900, fixedUi }],
    ]);
    const steps = [1, 2, 3].map((k) => ({ k, changes: [ch(1, 0.4, st(1, 10 * k), st(1, 10 * k + 10))].concat(k === 1 ? [ch(2, 0.9, st(0), st(1))] : []) }));
    const a = analyzeReveals(steps, mk(true, true), null), b = analyzeReveals(steps, mk(undefined, undefined), null);
    check('syn: stand-in piece moving at 3 steps is not scroll-linked; fixed back-to-top fade is not a reveal', a.scrollLinkedTotal === 0 && a.mediaPieces === 1 && !a.summary && a.fixedUi === 1, { scrollLinked: a.scrollLinkedTotal, mediaPieces: a.mediaPieces, reveals: a.summary && a.summary.elements, fixedUi: a.fixedUi }, { scrollLinked: 0, mediaPieces: 1, reveals: 0, fixedUi: 1 });
    check('syn: ... without the flags they read as scroll-linked and a reveal', b.scrollLinkedTotal === 1 && b.summary && b.summary.elements === 1, { scrollLinked: b.scrollLinkedTotal, reveals: b.summary && b.summary.elements }, { scrollLinked: 1, reveals: 1 });
  }
  // 6. load group starts = animation startTime + delay when the frame-sampled start came late
  {
    const st = (o, ty) => ({ o, tx: 0, ty, s: 1, r: 0, c: 1, b: 0, v: 1 });
    const mk = (desc, kind, t0, start, delay) => ({ desc, kind, parent: 'body>main', area: 60000, from: st(0, 20), to: st(1, 0), dom: 'o', net: true, t0, dur: 700, pp: null, css: [{ type: 'animation', name: 'ld', prop: 'opacity,transform', dur: 700, delay, easing: 'ease-out', iter: 1, start }] });
    // sampled starts bunched by a long frame (both seen at 1740); real starts 1480 and 1702
    const L = analyzeLoad({ dcl: 150, fcp: 260, tracked: 10, frames: 300, frameMs: 8, events: 0, snaps: 0, continuous: 0, areaShare: 0.5, changes: [mk('h1 span', 'headline', 1740, 200, 1280), mk('p.lead', 'text', 1740, 200, 1502)] });
    const g = Object.fromEntries((L.groups || []).map((x) => [x.kind, x]));
    check('syn: load starts from startTime + delay (not the bunched samples)', g.headline && g.text && g.headline.t0 === 1480 && g.text.t0 === 1702 && L.summary.staging.order.join('>') === 'headline>text', g.headline && g.text && [g.headline.t0, g.text.t0, L.summary.staging.order], [1480, 1702, 'headline>text']);
  }
  // 7. reveal trigger provenance: a change that began while the step scrolled = the crossed line; one that
  //    began 480 ms after the scroll stopped = rest position (offscreen when below the viewport); ys kept
  {
    const st = (o) => ({ o, tx: 0, ty: 0, s: 1, r: 0, c: 1, b: 0, v: 1 });
    const ch = (i, top, top0, t0) => ({ i, from: st(0), to: st(1), dom: 'o', net: true, t0, dur: 500, pp: null, top, top0, css: null });
    const info = new Map([
      [1, { i: 1, desc: 'div.card', y: 1400, h: 300, w: 400, area: 120000, init: st(0), steps: [1], parentDesc: 'div.grid', parent: 'g', vh: 900 }],
      [2, { i: 2, desc: 'img.pic', y: 2500, h: 300, w: 400, area: 120000, init: st(0), steps: [2], parentDesc: 'div.grid2', parent: 'h', vh: 900 }],
    ]);
    const steps = [{ k: 1, scrollEndMs: 110, changes: [ch(1, 0.85, 1.6, 60)] }, { k: 2, scrollEndMs: 100, changes: [ch(2, 1.19, 1.94, 584)] }];
    const rv = analyzeReveals(steps, info, null);
    const gc = rv.groups.find((g) => g.el === 'div.card'), gr = rv.groups.find((g) => g.el === 'img.pic');
    check('syn: reveal during the scroll -> triggerHow crossed, trigger 0.85, topBefore 1.6, ys [1400]', gc && gc.triggerHow === 'crossed' && gc.trigger === 0.85 && gc.topBefore === 1.6 && !gc.afterScrollMs && gc.ys.join() === '1400', gc && [gc.triggerHow, gc.trigger, gc.topBefore, gc.ys], ['crossed', 0.85, 1.6, [1400]]);
    check('syn: reveal 484 ms after the scroll stopped below the viewport -> triggerHow rest, offscreen', gr && gr.triggerHow === 'rest' && gr.afterScrollMs === 484 && gr.offscreen === true, gr && [gr.triggerHow, gr.afterScrollMs, gr.offscreen], ['rest', 484, true]);
  }
  // 8. reveal strip content (frames.mjs stripContent) on synthetic luma grids, 19 frames at 12 fps: frame 0 =
  //    before the scroll, frame 1 mid-scroll, scroll stops at 106 ms (frame 2). A: content in place at frame 2
  //    with a looping region (masked); B: a 10% block fading over frames 2-6.
  {
    const W = 120, H = 75, N = W * H;
    const base = () => Array.from({ length: N }, (_, j) => ((j * 37) % 200) + 20);
    const mk = (fade) => Array.from({ length: 19 }, (_, k) => {
      const g = base();
      if (k === 0) return g.map((v) => 255 - v);
      if (k === 1) return g.map((v, j) => (j % 3 ? 255 - v : v));
      for (let j = 0; j < 600; j++) g[j] = (k * 50) % 255;                          // loop: changes every frame
      if (fade) { const a = Math.min(1, Math.max(0, (k - 2) / 5)); for (let j = 3000; j < 3900; j++) g[j] = Math.round(255 + (g[j] - 255) * a); }
      return g;
    });
    const A = stripContent(mk(false), { scrollSettleMs: 106 }), B = stripContent(mk(true), { scrollSettleMs: 106 });
    check('syn: strip content, A in place when the scroll stops (loop masked)', A && A.inPlace === true && A.lagMs === 0 && A.movingShare > 0, A && [A.inPlace, A.lagMs, A.movingShare], [true, 0, '> 0']);
    check('syn: strip content, B fading 10% of the view for ~400 ms after the scroll stops', B && B.inPlace === false && B.lagMs >= 250 && B.lagMs <= 420 && B.changed >= 0.08, B && [B.inPlace, B.lagMs, B.changed], [false, '250-420', '>= 0.08']);
  }
}

// ---------------------------------------------------------------- media part (first-screen media motion)
const mediaFixtureDir = path.join(ROOT, 'harness', 'fixtures', 'motion-media');
// serve the media fixture, capture it (unless reuseDir) and run inspect.mjs activity on the same page
async function mediaRun(reuseDir) {
  const out = reuseDir || path.join(ROOT, 'runs', 'dev', 'motion', 'media');
  const srv = await startServer(mediaFixtureDir);
  let insp = null;
  try {
    if (!reuseDir) {
      const r = await runNode(path.join(SCRIPTS, 'capture.mjs'), [srv.url, out, '--viewports', '1440'], { timeoutMs: 400000 });
      const j = lastJson(r.stdout);
      if (!j || !j.ok) throw new Error('media fixture capture did not report ok');
    }
    const r = await runNode(path.join(SCRIPTS, 'inspect.mjs'), ['activity', srv.url], { timeoutMs: 120000 });
    insp = lastJson(r.stdout);
  } finally { await srv.stop(); }
  return { dir: out, c: JSON.parse(fs.readFileSync(path.join(out, 'capture.json'), 'utf8')), insp };
}
function mediaCaptureChecks(c, insp) {
  const m = c.motion || {};
  const media = (m.load && m.load.media) || [];
  const byEl = (s) => media.find((x) => (x.el || '').includes(s));
  const win = byEl('mk-win'), stack = byEl('mk-stack'), art = byEl('mk-art'), cur = byEl('mk-cur');
  // f: media boxes whatever they are made of; level = rateLevel(rate) on every entry
  check('media: HTML UI mock-up window is a moving media box (kind panel)', win && win.kind === 'panel' && win.moving, win && [win.kind, win.activity, win.rate], 'panel, moving');
  check('media: cycling card stack is a moving media box', stack && stack.moving, stack && [stack.kind, stack.activity, stack.rate], 'moving');
  check('media: activity = rateLevel(rate) on every entry (one function, rate only)', media.length >= 4 && media.every((x) => typeof x.rate !== 'number' || x.activity === rateLevel(x.rate)), media.map((x) => [x.el, x.activity, x.rate]), 'activity === rateLevel(rate)');
  // capture and inspect.mjs activity: the same code path on the same page
  const ib = (insp && insp.boxes) || [];
  const pairs = media.map((x) => ({ x, y: ib.find((b) => b.el === x.el) })).filter((p) => p.y);
  check('media: inspect activity finds the same media boxes', pairs.length === media.length && media.length > 0, ib.map((b) => b.el), media.map((x) => x.el));
  check('media: inspect activity = rateLevel(rate) for every box', ib.length > 0 && ib.every((b) => typeof b.rate !== 'number' || b.activity === rateLevel(b.rate)), ib.map((b) => [b.el, b.activity, b.rate]), 'activity === rateLevel(rate)');
  const ratio = (p) => Math.abs(Math.log(Math.max(p.x.rateCont ?? 0, 0.001) / Math.max(p.y.rate ?? 0, 0.001)));
  const steady = pairs.filter((p) => p.x.el.includes('mk-art') || p.x.el.includes('mk-win'));
  check('media: capture and inspect agree (same level; steady boxes within |ln| 0.5 of the rate)', pairs.length > 0 && pairs.every((p) => p.y.activity === rateLevel(p.x.rateCont)) && steady.every((p) => ratio(p) <= 0.5), pairs.map((p) => [p.x.el, p.x.rateCont, p.y.rate]), 'same level, steady |ln| <= 0.5');
  // the mock-up's state fade (a CSS transition inside the box) is media activity: no load group, no settle delay
  const lg = (m.load && m.load.groups) || [];
  const inner = lg.filter((g) => /mk-state|mk-card|mk-pointer|mk-track/.test(`${g.el} ${g.parent || ''}`));
  check('media: CSS animation inside a media box is not a load group (skipped as media)', inner.length === 0 && ((m.load && m.load.skipped && m.load.skipped.media) || 0) >= 1, { inner: inner.map((g) => [g.kind, g.el, g.t0]), skipped: m.load && m.load.skipped }, 'no load group from mk-state/mk-card/mk-pointer/mk-track, skipped.media >= 1');
  // a repeating word swap / chips / feed never extends the load timeline; the headline holding the swapping
  // word is still a load group (its own fade), and the staged load ends with the stack's entrance (~1.1 s)
  {
    const lg = (m.load && m.load.groups) || [];
    const rep = lg.filter((g) => /mk-swap|mk-chips|mk-feed/.test(g.el || ''));
    const tot = m.load && m.load.summary && m.load.summary.staging ? m.load.summary.staging.totalMs : null;
    check('media: repeating word swap / chips / feed are no load groups and do not extend the load', !rep.length && lg.some((g) => /^h1/.test(g.el || '')) && typeof tot === 'number' && tot <= 1500,
      { rep: rep.map((g) => g.el), h1: lg.some((g) => /^h1/.test(g.el || '')), totalMs: tot, repeating: m.load && m.load.skipped && m.load.skipped.repeating }, 'none, h1 kept, total <= 1500 ms');
  }
  const fl = (m.frames && m.frames.load) || {};
  check('media: moving media never delays the load settle time (settle <= 1600 ms; boxes cycle every 1.5-2 s)', typeof fl.settleMs === 'number' && fl.settleMs <= 1600, [fl.settleMs, fl.settleHow], '<= 1600');
  // a translating track inside the hero box: lateral media motion, never a marquee
  const mq = (m.marquees || []).filter((x) => /mk-track|mk-art/.test(x.el || ''));
  check('media: a track sliding inside a media box is not a marquee', mq.length === 0, mq.map((x) => x.el), []);
  check('media: ... it is lateral travel of that box (left)', art && art.motion === 'lateral' && art.dir === 'left', art && [art.kind, art.motion, art.dir, art.pxPerSec], 'lateral left');
  // a small hopping cursor inside a static mock-up: low (intermittent), never static
  check('media: small intermittent motion in a mock-up reads low (intermittent)', cur && cur.activity === 'low' && cur.intermittent === true, cur && [cur.activity, cur.intermittent, cur.rate, cur.active], 'low, intermittent');
  // the card stack fades in with the load staging; the track box is painted from first paint
  check('media: card stack arrives with the load staging, the track box from first paint', stack && stack.withLoad === true && art && art.withLoad === false, [stack && stack.appearsMs, stack && stack.withLoad, art && art.appearsMs, art && art.withLoad], 'stack withLoad, art not');
  // nothing inside the media boxes leaks into the ambient inventory or the carousels
  const leaks = [...((m.carousels && m.carousels.autoAdvance) || []).map((x) => `auto-advance ${x.el}`), ...((m.ambient && m.ambient.items) || []).filter((x) => x.kind !== 'media').map((x) => `${x.kind} ${x.el}`)].filter((s) => /mk-(state|card|pointer|track|win|stack|cur|art)/.test(s));
  check('media: motion inside the boxes is never an ambient item or auto-advance', leaks.length === 0, leaks, []);
  // j: state changes that move nothing, outside the media: word swap, step chips, data feed
  const aa = (m.carousels && m.carousels.autoAdvance) || [];
  for (const [k, per] of [['mk-swap', 2000], ['mk-chips', 1500], ['mk-feed', 1700]]) {
    const it = aa.find((x) => (x.el || '').includes(k));
    check(`media: ${k} found as auto-advance by the slow watch (period ~${per} ms)`, it && near(it.periodMs, per, 300), it && [it.el, it.periodMs, it.how, it.steps], `${k} ${per} ms`);
  }
}
// synthetic first screens (640 x 400 JPEG frames drawn in a page) with one media box SYN_BOX: kind lateral /
// in-place / cut / drift / static; shift = px the whole page drops at frame 6 (a bar inserted above)
const SYN_BOX = [80, 60, 480, 280];
async function synthFrames(ctx, kind, { n = 25, fps = 6, shift = 0 } = {}) {
  const p = await ctx.newPage();
  try {
    return await p.evaluate(({ kind, n, fps, shift, box }) => {
      const c = document.createElement('canvas'); c.width = 640; c.height = 400;
      const x = c.getContext('2d');
      let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      const tex = []; for (let i = 0; i < 160 * 100; i++) tex.push(Math.floor(rnd() * 200) + 30);
      const COL = ['#ff7a45', '#2f9e44', '#1c7ed6', '#ae3ec9'];
      const out = [];
      for (let k = 0; k < n; k++) {
        const t = k / fps, dy = shift && k >= 6 ? shift : 0;
        x.fillStyle = '#ffffff'; x.fillRect(0, 0, 640, 400);
        if (dy) { x.fillStyle = '#20304a'; x.fillRect(0, 0, 640, dy); }
        x.save(); x.translate(0, dy);
        x.fillStyle = '#9aa3b5';   // page text lines around the box
        for (let y = 8; y < 400; y += 18) for (let xx = 10; xx < 640; xx += 70) if (!(xx > box[0] - 10 && xx < box[0] + box[2] && y > box[1] - 10 && y < box[1] + box[3])) x.fillRect(xx, y, 50 + ((xx + y) % 13), 8);
        x.beginPath(); x.rect(box[0], box[1], box[2], box[3]); x.clip();
        x.fillStyle = '#f2f4f8'; x.fillRect(box[0], box[1], box[2], box[3]);
        if (kind === 'lateral') { const off = (t * 120) % 160; for (let i = -1; i < 6; i++) { x.fillStyle = COL[(i + 4) % 4]; x.fillRect(box[0] + i * 160 - off + 40, box[1] + 90, 120, 100); } }
        else if (kind === 'in-place') { for (let i = 0; i < 4; i++) { x.save(); x.translate(box[0] + 70 + i * 113, box[1] + 140); x.rotate(t * Math.PI * (i % 2 ? 0.6 : -0.6)); x.fillStyle = COL[i]; x.fillRect(-40, -22, 80, 44); x.restore(); } }
        else if (kind === 'cut') {
          if (Math.floor(t / 1.5) % 2) { x.fillStyle = '#e2672c'; x.fillRect(box[0] + 30, box[1] + 30, 200, 220); x.fillStyle = '#ffd43b'; x.fillRect(box[0] + 260, box[1] + 60, 180, 160); }
          else { x.fillStyle = '#3d6cff'; x.beginPath(); x.arc(box[0] + 240, box[1] + 140, 120, 0, 7); x.fill(); x.fillStyle = '#12a37a'; x.fillRect(box[0] + 20, box[1] + 200, 440, 50); }
        } else if (kind === 'drift') { const off = t * 15; for (let by = 0; by < 40; by++) for (let bx = 0; bx < 72; bx++) { const v = tex[(by * 160 + bx) % tex.length]; x.fillStyle = `rgb(${v},${(v * 3) % 255},${255 - v})`; x.fillRect(box[0] + bx * 8 - off, box[1] + by * 8, 8, 8); } }
        x.restore();
        out.push(c.toDataURL('image/jpeg', 0.85).split(',')[1]);
      }
      return out;
    }, { kind, n, fps, shift, box: SYN_BOX });
  } finally { await p.close().catch(() => {}); }
}
async function mediaSyntheticChecks(c) {
  const b = await launchChrome();
  try {
    const ctx = await b.newContext();
    const act = async (kind, o) => (await boxActivity(ctx, await synthFrames(ctx, kind, o), [SYN_BOX], { fps: (o && o.fps) || 6 }))[0];
    // h: how the media moves
    const want = { lateral: 'lateral', 'in-place': 'in-place', cut: 'cut', drift: 'drift' };
    const got = {};
    for (const k of Object.keys(want)) got[k] = await act(k);
    for (const [k, w] of Object.entries(want)) check(`syn media kind: ${k} frames -> motion ${w}`, got[k] && got[k].motion === w, got[k] && [got[k].motion, got[k].dir, got[k].pxPerSec, got[k].motionWhy], w);
    check('syn media kind: lateral travel left at ~120 px/s (+-35%)', got.lateral && got.lateral.dir === 'left' && near(got.lateral.pxPerSec, 120, 42), got.lateral && [got.lateral.dir, got.lateral.pxPerSec], 'left ~120');
    const st = await act('static');
    check('syn media kind: still box -> motion null, static', st && st.motion === null && boxLevel(st) === 'static', st && [st.motion, st.rate], 'null, static');
    // b: a page-wide layout shift (a bar pushing the page down) is compensated, never media activity
    const sh = await act('static', { shift: 40 }), lat = got.lateral, latS = await act('lateral', { shift: 40 });
    check('syn media: whole-page shift on a still box -> static (shifted pairs compensated)', sh && boxLevel(sh) === 'static' && (sh.shifted || 0) > 0, sh && [sh.rate, sh.shifted], 'static, shifted > 0');
    check('syn media: whole-page shift does not inflate a moving box\'s rate (within 10%)', latS && lat && Math.abs(latS.rate - lat.rate) <= 0.1 * lat.rate && latS.motion === 'lateral', latS && lat && [lat.rate, latS.rate, latS.motion], 'same rate, lateral');
    const sh12 = await act('static', { shift: 40, n: 19, fps: 12 });
    check('syn media: ... also in the 12 fps load-phase frames', sh12 && boxLevel(sh12) === 'static', sh12 && [sh12.rate, sh12.shifted], 'static');
  } finally { await b.close().catch(() => {}); }
  // f / i: one level rule (rate only) and like-with-like rates
  const box = { kind: 'art', desc: 'div.x', box: [0, 100, 800, 500], band: 's-1' };
  const e1 = mediaEntry({ ...box, continuous: { rate: 0.0707, active: 0.13, diff: 0.004, motion: 'in-place' }, keyframes: 1 }, { rate: 0.976, active: 0.11, diff: 0.2 });
  check('syn mediaEntry: rate 0.0707 in bursts -> medium (intermittent), continuous; a one-off load pop-in does not count', e1.activity === 'medium' && e1.intermittent === true && e1.rate === 0.0707 && e1.when === 'continuous', [e1.activity, e1.intermittent, e1.rate, e1.when], ['medium', true, 0.0707, 'continuous']);
  const e2 = mediaEntry({ ...box, continuous: { rate: 0.012, active: 0.28, diff: 0.002 } }, null);
  check('syn mediaEntry: rate 0.012 changing now and then -> low (intermittent), never static', e2.activity === 'low' && e2.intermittent === true, [e2.activity, e2.intermittent], ['low', true]);
  const e3 = mediaEntry({ ...box, continuous: { rate: 0.001, active: 0.05, diff: 0 }, keyframes: 4 }, null);
  check('syn mediaEntry: pieces seen moving (keyframes) never raise the level of a still box', e3.activity === 'static' && !e3.moving, [e3.activity, e3.moving], ['static', false]);
  const e4 = mediaEntry({ ...box, continuous: { rate: 0, active: 0, diff: 0 } }, { rate: 0.3, active: 0.9, diff: 0.1, motion: 'in-place' });
  check('syn mediaEntry: changing during the load only (an image fading in) -> static after the load, rate = settled rate', e4.activity === 'static' && !e4.moving && e4.rate === 0 && e4.rateLoad === 0.3, [e4.activity, e4.moving, e4.rate, e4.rateLoad], ['static', false, 0, 0.3]);
  const e5 = mediaEntry({ ...box, continuous: null }, { rate: 0.3, active: 0.9, diff: 0.1, motion: 'in-place' });
  check('syn mediaEntry: settled page not sampled -> load-phase rate, when load', e5.activity === 'medium' && e5.when === 'load' && e5.rate === 0.3, [e5.activity, e5.when, e5.rate], ['medium', 'load', 0.3]);
  const lo = mediaRate({ activity: 'high', rate: 0.948, rateLoad: 0.948, rateCont: 0.0001, when: 'load' });
  check('syn mediaRate: an older capture with a load-only fade (rateCont 0.0001) -> static', lo.level === 'static' && lo.rate === 0.0001, [lo.level, lo.rate], 'static');
  const old = mediaRate({ activity: 'high', rate: 0.4001, rateLoad: 0.4001, rateCont: 0.3246, when: 'both' }), nl = mediaRate({ activity: 'medium', rate: 0.3125, rateLoad: null, rateCont: 0.3125, when: 'continuous' });
  check('syn mediaRate: an older capture (rate = max of phases) vs one without a load phase compare continuous vs continuous', old.rate === 0.3246 && old.level === 'medium' && nl.level === 'medium', [old, nl], 'both continuous, medium');
  // h: compare charges a kind mismatch (in-place in the reference, a sideways track in the build)
  const sub = (d, name) => d.areas.motion.subs.find((s) => s.name === name) || null;
  const withKind = (cap, motion) => { const x = copy(cap); const a = x.motion.load.media.find((y) => y.kind === 'art'); Object.assign(a, { motion, rate: 0.2, rateCont: 0.2, activity: 'medium', moving: true, when: 'continuous' }); for (const it of x.motion.ambient.items) if (it.kind === 'media') Object.assign(it, { rate: 0.2, activity: 'medium' }); return x; };
  const rIn = withKind(c, 'in-place'), bSame = withKind(c, 'in-place'), bLat = withKind(c, 'lateral');
  const s0 = sub(compareCaptures(rIn, bSame), 'heroMedia'), dk = compareCaptures(rIn, bLat), s1 = sub(dk, 'heroMedia');
  const fk = dk.findings.find((f) => f.what === 'first-screen media activity');
  check('syn compare: same rate, same kind -> heroMedia 10', s0 && s0.score === 10, s0 && s0.score, 10);
  check('syn compare: same rate, in-place vs lateral -> heroMedia charged (<= 6.5) with a kind fix', s1 && s1.score <= 6.5 && !!fk && /kind of motion/.test(fk.fix) && /lateral/.test(fk.fix), s1 && [s1.score, fk && fk.fix.slice(0, 140)], '<= 6.5, fix names the kinds');
  const bNone = withKind(c, undefined);
  check('syn compare: a capture without a measured kind is not charged for it', sub(compareCaptures(rIn, bNone), 'heroMedia').score === 10, sub(compareCaptures(rIn, bNone), 'heroMedia').score, 10);
  // cross-fade: cut (300 ms fade, changes in 15% of the frame pairs) vs in-place (900 ms fade, 45%) is not
  // charged; a clear cut vs continuous in-place change (90%) still is
  const withAct = (cap, motion, active) => { const x = withKind(cap, motion); Object.assign(x.motion.load.media.find((y) => y.kind === 'art'), { active }); return x; };
  const sCut = sub(compareCaptures(withAct(c, 'cut', 0.15), withAct(c, 'in-place', 0.45)), 'heroMedia');
  const sClear = sub(compareCaptures(withAct(c, 'in-place', 0.9), withAct(c, 'cut', 0.15)), 'heroMedia');
  check('syn compare: cross-fade at 300 ms (cut) vs 900 ms (in-place, active 0.45) -> heroMedia not charged', sCut && sCut.score === 10, sCut && sCut.score, 10);
  check('syn compare: continuous in-place (active 0.9) vs clear cuts (0.15) -> kind charged', sClear && sClear.score < 10, sClear && sClear.score, '< 10');
  loadEntranceChecks(c);
}
// Load entrance (frames.mjs loadEntrance, compare loadState): repeating changes, the strip winning over sampled
// timing, a media box entrance on either side, one step at one moment = not designed.
function loadEntranceChecks(c) {
  const sub = (d, name) => d.areas.motion.subs.find((s) => s.name === name) || null;
  const G = (o) => ({ phase: 'load', n: 1, family: 'ease-out', prop: 'o', ...o });
  const withLoad = (cap, groups, extra = {}) => {
    const x = copy(cap);
    x.motion.load = { ...x.motion.load, fcpMs: 200, groups, summary: groups.length ? { groups: groups.length, firstStartMs: 300, lastEndMs: 900, ms: 400, family: 'ease-out', from: { opacity: 0 }, staging: { firstContentMs: 200, delayMs: 100, order: ['headline'], steps: 1, totalMs: 600 }, areaShare: 0.6, textShare: 0.6, staged: true } : null, ...extra };
    if (x.motion.frames && x.motion.frames.load && x.motion.frames.load.visual) x.motion.frames.load.visual.designed = false;
    return x;
  };
  const head = G({ kind: 'headline', el: 'h1.t', t0: 400, ms: 500, area: 300000, box: [100, 200, 1000, 300], from: { opacity: 0, y: 24 } });
  // a word swap that repeats (auto-advance element) never extends the load timeline
  const swap = G({ kind: 'text', el: 'span.words', t0: 2600, ms: 600, area: 40000, box: [400, 520, 300, 120], from: { y: 60 } });
  const capRep = withLoad(c, [head, swap]); capRep.motion.carousels = { ...(capRep.motion.carousels || {}), autoAdvance: [{ el: 'span.words', band: 's-1', periodMs: 3000 }] };
  const eRep = loadEntrance(capRep.motion);
  check('syn load: a repeating word swap (auto-advance element) is left out and does not extend the load', eRep.skipped.repeating === 1 && eRep.summary && eRep.summary.staging.totalMs === 500, eRep.summary && [eRep.skipped, eRep.summary.staging.totalMs], 'repeating 1, total 500');
  // the strip wins: a group sampled as a 900 ms slide that the strip shows appearing in one step
  const stepped = withLoad(c, [{ ...head, ms: 900, appear: { kind: 'step', atMs: 1000, ms: 83, steps: 1 } }]);
  const eStep = loadEntrance(stepped.motion);
  check('syn load: strip step wins over the sampled 900 ms slide (start 1000, no from-state)', eStep.groups[0] && eStep.groups[0].start === 1000 && eStep.groups[0].ms === 83 && Object.keys(eStep.groups[0].from).length === 0, eStep.groups[0] && [eStep.groups[0].start, eStep.groups[0].ms, eStep.groups[0].from], [1000, 83, {}]);
  // one step at one moment (skeleton then content) is not a designed entrance: not charged against a static build
  const stat = withLoad(c, []);
  const dOne = compareCaptures(stepped, stat), lOne = sub(dOne, 'load');
  check('syn load: the first screen arriving in one step at one moment -> not designed, not charged', !eStep.designed && lOne && lOne.score === 10, lOne && [eStep.designed, lOne.score, lOne.weight], 'not designed, 10');
  // a media box's load entrance on either side: the reference fades its canvas, the build fades a wrapper
  // filling its art box (both kind media, the strip shows both arriving with the load)
  const mbox = [180, 88, 1080, 720];
  const medRef = withLoad(c, [G({ kind: 'media', el: 'canvas', t0: 1300, ms: 1200, area: 777600, box: mbox, from: { opacity: 0 } })], { media: [{ kind: 'canvas', el: 'canvas', box: mbox, activity: 'static', rate: 0, rateCont: 0, appearsMs: 2300, withLoad: true }] });
  const medBuild = withLoad(c, [G({ kind: 'media', el: 'div.art', t0: 1250, ms: 1200, area: 777600, box: mbox, from: { opacity: 0 } })], { media: [{ kind: 'art', el: 'div.stage', box: mbox, activity: 'static', rate: 0, rateCont: 0, appearsMs: 2250, withLoad: true }] });
  for (const x of [medRef, medBuild]) x.motion.load.summary.textShare = 0;
  const lMed = sub(compareCaptures(medRef, medBuild), 'load');
  check('syn load: canvas fade vs a box-filling wrapper fade -> both staged, matched (>= 9)', lMed && lMed.score >= 9 && lMed.weight > 9, lMed && [lMed.score, lMed.weight, lMed.detail], '>= 9, staged');
  // ... and when the strip shows the box painted from first paint on both sides, neither is charged
  const flat = (x) => { const y = copy(x); y.motion.load.media[0].withLoad = false; y.motion.load.media[0].appearsMs = 0; return y; };
  const lFlat = sub(compareCaptures(flat(medRef), withLoad(c, [])), 'load');
  check('syn load: a media fade the strip shows painted from first paint vs no load -> not charged', lFlat && lFlat.score === 10, lFlat && [lFlat.score, lFlat.detail], 10);
}

async function main() {
  const args = process.argv.slice(2);
  const mi = args.indexOf('--media');
  const mediaReuse = mi >= 0 && args[mi + 1] ? path.resolve(args[mi + 1]) : null;
  const pos = args.filter((a, i) => !a.startsWith('--') && !(mi >= 0 && i === mi + 1))[0];
  const dir = pos ? path.resolve(pos) : await captureFixture();
  const c = JSON.parse(fs.readFileSync(path.join(dir, 'capture.json'), 'utf8'));
  captureChecks(c);
  syntheticChecks(c);
  const mr = await mediaRun(mediaReuse);
  mediaCaptureChecks(mr.c, mr.insp);
  await mediaSyntheticChecks(c);
  const failed = results.filter((r) => !r.ok).map((r) => r.name);
  console.log(JSON.stringify({ ok: failed.length === 0, checks: results.length, failed, captureDir: dir, mediaDir: mr.dir }));
  process.exit(failed.length ? 1 : 0);
}

// ---------------------------------------------------------------- --only steps (runs alone)
// One-step appearance vs fade / slide, header from scrolled evidence, hover print and visible change.
//   node harness/check-motion.mjs --only steps [--reuse] [--out <dir>]
// Captures harness/fixtures/step-fade three times at 1440 into runs/dev/motion-steps/<variant> (--out: into
// <dir>/<variant>; fade first, then step and slide --frames-like the fade capture so their reveal strips
// replay the same wheel step; --reuse keeps captures already there) and asserts: the load strip and the
// reveal strip classify as step / fade / slide (frames.load.appear, frames.reveals[].content.appear, per load
// group appear) with visible durations near 600 ms for the eased variants; the step variant's cards are a
// reveal in one step (appear 'step'); compare charges a build that eases in where the reference steps (load
// strip and reveal strip) and not an equal pair, charges a sliding build against a fading reference on the
// from-state (not fade vs fade), and charges a step build against a fading reference on duration; then
// synthetic checks: appearOf series, nav stickiness and the line under the bar from screenshots
// (motion.navShots / applyNavShots), the digest's hover lines (no "[object Object]", the visible change from
// the crop pair), compare charging a missing visible hover change and skipping an invalid sample, step reveal
// grouping (header toggles and zero-size boxes are not reveals) and strip linking (trigger from the strip at a
// rest position, --frames-like strips link nothing, a step change with nothing arriving is skipped).
async function stepsMain() {
  const { Area } = await import('../skill/restyle/scripts/lib/cmp-util.mjs');
  const { revealTimingCheck } = await import('../skill/restyle/scripts/lib/cmp-motion.mjs');
  const { appearOf } = await import('../skill/restyle/scripts/lib/frames.mjs');
  const { navShots, applyNavShots } = await import('../skill/restyle/scripts/lib/motion.mjs');
  const { buildSummary } = await import('../skill/restyle/scripts/lib/summary.mjs');
  const { PNG } = await import('pngjs');
  const reuse = process.argv.includes('--reuse');
  // --out <dir>: capture into <dir>/<variant> instead (a worker's own scratch dir)
  const outArg = process.argv.indexOf('--out');
  const base = outArg >= 0 && process.argv[outArg + 1] ? path.resolve(ROOT, process.argv[outArg + 1]) : path.join(ROOT, 'runs', 'dev', 'motion-steps');
  const fx = path.join(ROOT, 'harness', 'fixtures', 'step-fade');
  const dirs = { fade: path.join(base, 'fade'), step: path.join(base, 'step'), slide: path.join(base, 'slide') };
  const have = (d) => fs.existsSync(path.join(d, 'capture.json'));
  if (!reuse || !Object.values(dirs).every(have)) {
    const srv = await startServer(fx);
    try {
      for (const v of ['fade', 'step', 'slide']) {
        if (reuse && have(dirs[v])) continue;
        const args = [`${srv.url}/?v=${v}`, dirs[v], '--viewports', '1440'].concat(v === 'fade' ? [] : ['--frames-like', dirs.fade]);
        const r = await runNode(path.join(SCRIPTS, 'capture.mjs'), args, { timeoutMs: 400000 });
        const j = lastJson(r.stdout);
        if (!j || !j.ok) throw new Error(`capture of the ${v} variant did not report ok`);
      }
    } finally { await srv.stop(); }
  }
  const C = Object.fromEntries(Object.entries(dirs).map(([k, d]) => [k, JSON.parse(fs.readFileSync(path.join(d, 'capture.json'), 'utf8'))]));
  const inR = (v, lo, hi) => typeof v === 'number' && v >= lo && v <= hi;
  // ---- capture: load strip and reveal strip appearance
  const la = (c) => c.motion?.frames?.load?.appear || null;
  const ra = (c) => (c.motion?.frames?.reveals || []).map((r) => r?.content?.appear).find((a) => a && a.kind !== 'none') || null;
  {
    const f = la(C.fade), s = la(C.step), l = la(C.slide);
    check('steps: load strip, step variant appears in one step', s && s.kind === 'step', s, 'step');
    check('steps: load strip, step variant arrives ~700 ms after first paint', s && inR(s.atMs, 450, 1150), s && s.atMs, '450-1150');
    check('steps: load strip, fade variant fades in over ~600 ms', f && f.kind === 'fade' && inR(f.ms, 400, 850), f && [f.kind, f.ms], ['fade', '400-850']);
    check('steps: load strip, slide variant slides in (rises) over ~600 ms', l && l.kind === 'slide' && (l.y || 0) > 0 && inR(l.ms, 400, 850), l && [l.kind, l.y, l.ms], ['slide', '> 0', '400-850']);
    const gf = (C.fade.motion?.load?.groups || []).map((g) => g.appear).filter(Boolean);
    check('steps: load groups of the fade variant carry their own appearance (fade)', gf.length > 0 && gf.every((a) => a.kind === 'fade' || a.kind === 'slide'), gf.map((a) => a.kind), 'fade');
    const rf = ra(C.fade), rs = ra(C.step), rl = ra(C.slide);
    check('steps: reveal strip, step variant appears in one step after the scroll stops', rs && rs.kind === 'step', rs, 'step');
    check('steps: reveal strip, fade variant fades in over ~600 ms', rf && rf.kind === 'fade' && inR(rf.ms, 400, 850), rf && [rf.kind, rf.ms], ['fade', '400-850']);
    check('steps: reveal strip, slide variant slides in (rises) over ~600 ms', rl && rl.kind === 'slide' && (rl.y || 0) > 0 && inR(rl.ms, 400, 850), rl && [rl.kind, rl.y, rl.ms], ['slide', '> 0', '400-850']);
    const sum = buildSummary(C.step, { dir: dirs.step });
    check('steps: digest states the load appearance (one step, no transition)', /load appearance: first screen appears in one step/.test(sum), (sum.match(/- load appearance.*$/m) || [''])[0].slice(0, 120), 'appears in one step');
    // the step variant's lower-band cards (an instant class switch, no transition) are a scroll reveal: present,
    // appearance step (motion.mjs analyzeReveals: content switching from hidden to shown at once)
    const sg = (C.step.motion?.reveals?.groups || []).filter((g) => !g.skip && /card/.test(g.el || ''));
    const ss = C.step.motion?.reveals?.summary;
    check('steps: step variant, the lower band\'s cards are a reveal in one step', sg.length > 0 && sg.every((g) => g.appear === 'step') && sg.reduce((t, g) => t + g.n, 0) >= 3 && ss && ss.elements >= 3, sg.map((g) => [g.el, g.n, g.appear, g.ms]).concat([ss && [ss.elements, ss.appear]]), 'card groups, appear step, >= 3 elements');
    const sumS = buildSummary(C.step, { dir: dirs.step });
    check('steps: digest says the step variant\'s reveals appear in one step', /reveals: .*in one step/.test(sumS) && /rv rv-step/.test(sumS), (sumS.match(/^- reveals:.*$/m) || [''])[0].slice(0, 140), 'one step, rv rv-step');
  }
  // ---- compare: step / fade / slide reveals (real captures)
  {
    const sub = (d, n) => (d.areas.motion.subs || []).find((x) => x.name === n);
    const dFS = compareCaptures(C.fade, C.slide, { refDir: dirs.fade, buildDir: dirs.slide }), dFF = compareCaptures(C.fade, C.fade, { refDir: dirs.fade, buildDir: dirs.fade });
    const fFS = sub(dFS, 'revealFrom'), fFF = sub(dFF, 'revealFrom');
    check('steps: compare, fade reference vs sliding build charges the reveal from-state', fFS && fFS.score != null && fFS.score <= 5 && dFS.findings.some((f) => /from-state/.test(f.what)), fFS && [fFS.score, fFS.detail], '<= 5 with a from-state finding');
    check('steps: compare, fade vs fade: from-state not charged', fFF && fFF.score === 10, fFF && fFF.score, 10);
    const dFSt = compareCaptures(C.fade, C.step, { refDir: dirs.fade, buildDir: dirs.step });
    const pS = sub(dFSt, 'revealPresence'), uS = sub(dFSt, 'revealDuration');
    check('steps: compare, fade reference vs step build: reveals present on both, the step charged on duration', pS && pS.score >= 9 && uS && uS.score != null && uS.score <= 3, [pS && pS.score, uS && uS.score, uS && uS.detail], ['>= 9', '<= 3']);
  }
  // ---- compare: a build that eases in where the reference steps (real captures, then synthetic)
  {
    const sub = (d, n) => (d.areas.motion.subs || []).find((x) => x.name === n);
    const dSF = compareCaptures(C.step, C.slide, { refDir: dirs.step, buildDir: dirs.slide });
    const dSS = compareCaptures(C.step, C.step, { refDir: dirs.step, buildDir: dirs.step });
    const tSF = sub(dSF, 'revealTiming'), tSS = sub(dSS, 'revealTiming');
    check('steps: compare, step reference vs sliding build charges revealTiming', tSF && tSF.score != null && tSF.score <= 5, tSF && tSF.score, '<= 5');
    check('steps: compare, the finding says the reference appears in one step', dSF.findings.some((f) => f.area === 'motion' && /one step/.test(`${f.ref} ${f.fix}`)), dSF.findings.filter((f) => f.area === 'motion').map((f) => f.what).slice(0, 4), 'a finding naming the one-step appearance');
    check('steps: compare, equal pair (step vs step) is not charged', tSS && tSS.score === 10, tSS && tSS.score, 10);
    const mk = (load, rev, like) => ({ motion: { frames: { load: load ? { appear: load } : null, reveals: rev ? [Object.assign({ content: { lagMs: 500, inPlace: false, changed: 0.3, appear: rev } }, like ? { like: { ref: 1 } } : {})] : [] } } });
    const step = { kind: 'step', atMs: 700, ms: 83 }, fade = { kind: 'fade', atMs: 650, ms: 600 }, quick = { kind: 'fade', atMs: 650, ms: 180 };
    const run = (a, b) => { const A = new Area('motion', 20); revealTimingCheck(A, a, b); return A.checks.find((x) => x.name === 'revealTiming'); };
    const loadEase = run(mk(step), mk(fade)), loadEq = run(mk(step), mk(step)), loadFF = run(mk(fade), mk(fade)), loadQuick = run(mk(step), mk(quick));
    check('steps: syn load strip, reference steps / build fades 600 ms -> 0', loadEase && loadEase.s === 0 && /load strip/.test(loadEase.finding?.what || ''), loadEase && [loadEase.s, loadEase.finding?.what], [0, 'first screen appearance (load strip)']);
    check('steps: syn load strip, equal pairs (step/step, fade/fade) -> 1', loadEq && loadEq.s === 1 && loadFF && loadFF.s === 1, [loadEq && loadEq.s, loadFF && loadFF.s], [1, 1]);
    check('steps: syn load strip, a fade under 200 ms counts as a step', loadQuick && loadQuick.s === 1, loadQuick && loadQuick.s, 1);
    const revEase = run(mk(null, step), mk(null, fade, true)), revEq = run(mk(null, step), mk(null, step, true));
    check('steps: syn reveal strip, reference steps / build fades 600 ms -> 0', revEase && revEase.s === 0 && /one step/.test(revEase.finding?.fix || ''), revEase && [revEase.s, (revEase.finding?.fix || '').slice(0, 80)], [0, 'one step']);
    check('steps: syn reveal strip, equal pair -> 1', revEq && revEq.s === 1, revEq && revEq.s, 1);
  }
  // ---- appearOf on synthetic distance-to-final series (12 fps)
  {
    const fm = 1000 / 12, flat = (v, n) => new Array(n).fill(v);
    const stepS = flat(40, 9).concat(flat(0, 20));
    const linS = flat(40, 6).concat([...Array(8)].map((_, i) => 40 * (1 - (i + 1) / 8)), flat(0, 15));
    const outS = flat(40, 6).concat([...Array(9)].map((_, i) => 40 * Math.pow(1 - (i + 1) / 9, 3)), flat(0, 15));
    const creep = flat(40, 12).concat([3, 2.6, 2.2, 1.8, 1.4, 1, 0.6, 0.3], flat(0, 20));
    const staged = flat(40, 6).concat(flat(22, 8), flat(0, 15));
    const a1 = appearOf(stepS, fm), a2 = appearOf(linS, fm), a3 = appearOf(outS, fm), a4 = appearOf(creep, fm), a5 = appearOf(staged, fm);
    check('steps: syn appearOf, a one-frame jump is a step at its frame', a1 && a1.kind === 'step' && a1.atMs === Math.round(9 * fm), a1, { kind: 'step', atMs: Math.round(9 * fm) });
    check('steps: syn appearOf, a linear 8-frame fade is a fade of ~600 ms', a2 && a2.kind === 'fade' && inR(a2.ms, 500, 700), a2 && [a2.kind, a2.ms], ['fade', '500-700']);
    check('steps: syn appearOf, an ease-out 9-frame fade is a fade', a3 && a3.kind === 'fade', a3 && a3.kind, 'fade');
    check('steps: syn appearOf, a jump followed by a small creep is a step', a4 && a4.kind === 'step', a4 && a4.kind, 'step');
    check('steps: syn appearOf, two separate jumps are a step arrival in 2 jumps', a5 && a5.kind === 'step' && a5.steps === 2, a5 && [a5.kind, a5.steps], ['step', 2]);
    check('steps: syn appearOf, nothing arriving is none', (appearOf(flat(10, 20), fm) || {}).kind === 'none', appearOf(flat(10, 20), fm), 'none');
  }
  // ---- header from the screenshots (synthetic PNGs)
  {
    const W = 400, H = 300, hdr = 60;
    const png = (paint) => { const p = new PNG({ width: W, height: H }); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const v = paint(x, y); const i = (y * W + x) * 4; p.data[i] = p.data[i + 1] = p.data[i + 2] = v; p.data[i + 3] = 255; } return p; };
    const bar = (x, y) => (y < hdr && y >= 20 && y < 40 && ((x >= 20 && x < 70) || (x >= 110 && x < 160) || (x >= 300 && x < 380)) ? 20 : 255);
    const content = (off) => (x, y) => ((Math.floor((y + off) / 14) % 3 === 0) && x > 30 && x < 370 ? 90 : 240);
    const fold = png((x, y) => (y < hdr ? bar(x, y) : y < 80 ? 255 : content(0)(x, y)));
    const pinned = png((x, y) => (y < hdr ? bar(x, y) : y === hdr ? 200 : y < 80 ? 255 : content(37)(x, y)));
    const gone = png((x, y) => content(5)(x, y));
    const e1 = navShots(fold, pinned, hdr), e2 = navShots(fold, gone, hdr);
    check('steps: syn nav, the bar still at the top of the scrolled shot is pinned', e1 && e1.pinned === true, e1 && [e1.pinned, e1.match], [true, '>= 0.6']);
    check('steps: syn nav, content at the top of the scrolled shot is not pinned', e2 && e2.pinned === false, e2 && [e2.pinned, e2.match], [false, '<= 0.25']);
    check('steps: syn nav, a 1 px line under the bar only in the scrolled shot', e1 && e1.fold && e1.scrolled && !e1.fold.edge && e1.scrolled.line, e1 && [e1.fold?.edge, e1.scrolled?.line], [false, true]);
    const nav = { pos: 'relative', h: hdr, onScroll: { changes: null, staysInView: false, scrolled: { visible: false } } };
    applyNavShots(nav, e1, null);
    check('steps: syn nav, a relative wrapper whose bar stays at the top reads as pinned', nav.pos === 'sticky' && nav.posCss === 'relative' && nav.onScroll.staysInView === true, [nav.pos, nav.posCss, nav.onScroll.staysInView], ['sticky', 'relative', true]);
    check('steps: syn nav, the line under the bar is an on-scroll change', nav.onScroll.changes && Array.isArray(nav.onScroll.changes.line) && nav.onScroll.changes.line[1] === true, nav.onScroll.changes, { line: [false, true] });
    // compare: a line seen in the scrolled shot and a box-shadow from the DOM are the same kind of change
    const withNav = (c, changes) => { const x = copy(c); x.spacing.nav = Object.assign({}, x.spacing.nav || { pos: 'sticky', h: 64 }, { pos: 'sticky', onScroll: { changes, staysInView: true, scrolled: { visible: true, h: 64, bg: '#f4f1ea' } } }); return x; };
    const nsub = (a, b) => (compareCaptures(a, b, {}).areas.motion.subs || []).find((x) => x.name === 'navScroll');
    const n1 = nsub(withNav(C.fade, { line: [false, true] }), withNav(C.fade, { shadow: [false, true] })), n2 = nsub(withNav(C.fade, { line: [false, true] }), withNav(C.fade, null));
    check('steps: syn nav compare, line (shot) vs shadow (DOM) on scroll is the same change', n1 && n1.score === 10, n1 && n1.score, 10);
    check('steps: syn nav compare, a missing line on scroll is charged', n2 && n2.score < 10, n2 && n2.score, '< 10');
  }
  // ---- hover: the digest prints transform deltas and the visible change; compare charges a missing one
  {
    const withHover = (c, visual, self) => {
      const x = copy(c);
      x.hover = [{ kind: 'primary-button', desc: 'a.cta', self, before: null, after: null, kids: [{ desc: 'span.label', kind: 'text', delta: { transform: [{ tx: 0, ty: 0, s: 1, r: 0 }, { tx: -16, ty: 0, s: 1, r: 0 }] } }], transition: 'background 180ms ease-out', pair: 'motion/frames/hover-primary-button' }];
      x.motion.frames.hover = [{ kind: 'primary-button', dir: 'motion/frames/hover-primary-button', n: 2, visual }];
      return x;
    };
    const ref = withHover(C.fade, { changed: 0.28, mean: 0.03, look: 'lightens' }, { backgroundColor: ['#1d1b16', '#4a463c'] });
    const sum = buildSummary(ref, {});
    const line = (sum.match(/^- hover primary-button.*$/m) || [''])[0];
    check('steps: syn digest, hover deltas never print [object Object]', !/\[object Object\]/.test(sum) && /x -16/.test(line), line.slice(0, 160), 'no [object Object]; transform "x -16"');
    check('steps: syn digest, hover line states the visible change from the crop pair', /visible on hover: lightens/.test(line), line.slice(0, 200), 'visible on hover: lightens');
    const quiet = withHover(C.fade, { changed: 0.0, mean: 0, look: 'none' }, { backgroundColor: ['#1d1b16', '#1e1c17'] });
    const none = copy(C.fade); none.hover = []; none.motion.frames.hover = [];
    const hsub = (d) => (d.areas.motion.subs || []).find((x) => x.name === 'hover');
    const dQ = compareCaptures(ref, quiet, {}), dN = compareCaptures(ref, none, {}), dE = compareCaptures(ref, ref, {});
    check('steps: syn hover compare, reference visibly changes, build crop shows nothing -> charged', hsub(dQ) && hsub(dQ).score < 5 && dQ.findings.some((f) => /hover/.test(f.what) && /visibl/.test(f.fix)), hsub(dQ) && hsub(dQ).score, '< 5 with a finding');
    check('steps: syn hover compare, build has no element of that kind -> charged', hsub(dN) && hsub(dN).score < 5, hsub(dN) && hsub(dN).score, '< 5');
    check('steps: syn hover compare, equal pair -> 10', hsub(dE) && hsub(dE).score === 10, hsub(dE) && hsub(dE).score, 10);
    // a sample marked invalid (it moves with the pointer away, or is not shown) is never compared: the kind is skipped
    const inval = withHover(C.fade, { changed: 0.4, mean: 0.1, look: 'recolours or moves' }, null); inval.hover[0].invalid = 'moves without hover';
    const dI = compareCaptures(ref, inval, {});
    check('steps: syn hover compare, an invalid build sample is skipped, not charged', hsub(dI) && !/primary-button/.test(hsub(dI).detail.split(';')[0]) && /skipped/.test(hsub(dI).detail), hsub(dI) && [hsub(dI).score, hsub(dI).detail], 'kind skipped');
  }
  // ---- reveal grouping and strip linking (synthetic, no browser)
  {
    const { analyzeReveals, linkRevealStrips } = await import('../skill/restyle/scripts/lib/motion.mjs');
    const st = (o, v = 1) => ({ o, tx: 0, ty: 0, s: 1, r: 0, c: 1, b: 0, v });
    const chg = (i, from, to, dur, top) => ({ i, from, to, dom: 'o', net: true, t0: 120, dur, pp: null, top, top0: top + 0.75, css: null });
    const info = new Map([
      [1, { i: 1, desc: 'div.card', y: 1720, h: 420, w: 420, area: 176400, init: st(0), steps: [2], parentDesc: 'div.cards', parent: 'c', vh: 900 }],
      [2, { i: 2, desc: 'div.card', y: 1720, h: 420, w: 420, area: 176400, init: st(0), steps: [2], parentDesc: 'div.cards', parent: 'c', vh: 900 }],
      [3, { i: 3, desc: 'div.menu', y: 0, h: 40, w: 300, area: 12000, init: st(1, 0), steps: [1], parentDesc: 'header', parent: 'h', hdr: true, vh: 900 }],
      [4, { i: 4, desc: 'div', y: 0, h: 0, w: 0, area: 0, init: st(1, 0), steps: [1], parentDesc: 'div.wrap', parent: 'w', vh: 900 }],
    ]);
    const steps = [{ k: 1, scrollEndMs: 20, changes: [chg(3, st(1, 0), st(1, 1), 99, 0), chg(4, st(1, 0), st(1, 1), 99, 0)] }, { k: 2, scrollEndMs: 20, changes: [chg(1, st(0), st(1), 17, 0.91), chg(2, st(0), st(1), 17, 0.91)] }];
    const rv = analyzeReveals(steps, info, null);
    const g = (rv.groups || [])[0];
    check('steps: syn reveals, an instant hidden-to-shown switch is a step reveal group', rv.groups.length === 1 && g && g.appear === 'step' && g.n === 2 && g.ms === 0 && rv.summary && rv.summary.appear === 'step' && rv.summary.ms === null, rv.groups.map((x) => [x.el, x.n, x.appear, x.ms]), [['div.card', 2, 'step', 0]]);
    check('steps: syn reveals, a header toggle and a zero-size box are not reveals', rv.header === 1 && rv.tiny === 1, { header: rv.header, tiny: rv.tiny }, { header: 1, tiny: 1 });
    // trigger from the strip: a rest-position group that its strip shows arriving after the scroll stopped
    const R = { groups: [{ phase: 'step6', n: 1, area: 190000, trigger: 0.63, triggerHow: 'rest', afterScrollMs: 281, ys: [4589], ms: 500, from: { opacity: 0, y: 24 } }], summary: null };
    const strips = [{ step: 6, scrollFrom: 3240, scrollTo: 3915, scroll: { px: 675, settleMs: 16 }, content: { inPlace: false, lagMs: 417, appear: { kind: 'slide', atMs: 166, ms: 333, y: 12 } } }];
    linkRevealStrips(R, strips, 1440, 900);
    check('steps: syn strip trigger, a rest position the strip shows firing lower wins', R.groups[0].trigger === 0.75 && R.groups[0].triggerHow === 'strip' && R.groups[0].triggerSampled === 0.63 && R.summary && R.summary.trigger === 0.75, [R.groups[0].trigger, R.groups[0].triggerHow, R.summary && R.summary.trigger], [0.75, 'strip', 0.75]);
    const R2 = { groups: [{ phase: 'step2', n: 1, area: 190000, trigger: 0.63, triggerHow: 'rest', ys: [4589], ms: 500 }] };
    linkRevealStrips(R2, [Object.assign({}, strips[0], { step: 2, like: { ref: 1 } })], 1440, 900);
    check('steps: syn strip linking, a --frames-like strip links no groups', R2.groups[0].strip === undefined && R2.groups[0].trigger === 0.63, [R2.groups[0].strip, R2.groups[0].trigger], [undefined, 0.63]);
    const R3 = { groups: [{ phase: 'step1', n: 1, area: 9000, trigger: 0, triggerHow: 'crossed', ys: [0], ms: 0, appear: 'step', from: { visibility: 'hidden' } }] };
    linkRevealStrips(R3, [{ step: 1, scrollFrom: 0, scrollTo: 187, scroll: { px: 187, settleMs: 18 }, content: { inPlace: true, lagMs: 0, appear: { kind: 'none', drop: 0 } } }], 1440, 900);
    check('steps: syn strip linking, a step change its strip shows nothing arriving for is skipped', !!R3.groups[0].skip && R3.summary === null, [R3.groups[0].skip, R3.summary], ['skip', null]);
  }
  const failed = results.filter((r) => !r.ok).map((r) => r.name);
  console.log(JSON.stringify({ ok: failed.length === 0, only: 'steps', checks: results.length, failed, captureDirs: dirs }));
  process.exit(failed.length ? 1 : 0);
}

const onlyArg = process.argv.indexOf('--only');
(onlyArg >= 0 && process.argv[onlyArg + 1] === 'steps' ? stepsMain() : main()).catch((e) => { console.error(`check-motion: ${e.message}`); process.exit(1); });
