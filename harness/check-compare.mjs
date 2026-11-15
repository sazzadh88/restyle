#!/usr/bin/env node
// Asserts compare.mjs behaviour.
//   node harness/check-compare.mjs [--reuse] [--only self|syn|sens|fix]
// 1. self-compare: linear, stripe and known (runs/dev/<slug>/ref) against themselves score 10.00.
// 2. sensitivity: single-change copies of harness/fixtures/known are served, captured
//    (--no-motion-frames) and compared with the unmodified known capture: the changed area drops
//    the most, the top finding names the change, unrelated areas stay >= 9.5.
// 3. equivalence: visually identical implementations (margin vs padding, <img> vs inline <svg>, with or
//    without third-party chrome) score >= 9.9 total and >= 9.8 in every area.
//    Variants live in runs/dev/_variants/<name>/{build,cap,diff.json}; --reuse skips recapture (and skips
//    variants that have no capture yet).
// 4. synthetic (--only syn): edited copies of runs/dev/known/ref/capture.json, no browser (font health FH* fetches the
//    Google Fonts catalogue: non-catalogue web font = health fail listed first, catalogue / local() faces not): weight vs ink,
//    heading tiers by size, composite band runs, mobile-only alternates, load skip rules, hero media,
//    scroll tint, rendered line box, observed transitions, rail/text container edges, reveal strip timing,
//    tracking by set width, logo colours not required, a sale colour on a few small elements not a required minor
//    colour (MS), page-colour fade / scrim on media / thin strip not band gradients (GR), layout false positives (hero/footer by position,
//    collage, multi-screen band row, transparent nav over the same colour, marquees per narrow width),
//    alignment by content (D2: a 390 band cut into row strips, two same-colour bands merged on one side,
//    a really missing band still charged).
// 5. mock-up body symmetry (--only fix): harness/fixtures/mockup-body/{ref,build}, one type and colour design
//    in two markups, captured into runs/dev/_variants/mockup-body/{ref,build}: same body (the running text),
//    lead, heading tiers, no logo colour in accent/minor colours, type and colour areas unaffected.
// Prints one line per assertion and one JSON summary line; exits 1 on any failure.
import fs from 'node:fs';
import path from 'node:path';
import { converter, formatHex, differenceEuclidean } from 'culori';
import { ROOT, SCRIPTS, startServer, runNode } from './lib/run.mjs';
import { loadCapture, compareCaptures } from '../skill/restyle/scripts/lib/cmp-core.mjs';

const args = process.argv.slice(2);
const reuse = args.includes('--reuse');
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const results = [];
const check = (name, ok, info = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  ${info}` : ''}`); };
const areaLine = (d) => Object.entries(d.areas).map(([k, a]) => `${k} ${a.score}`).join(' | ');

function selfChecks() {
  for (const slug of ['linear', 'stripe', 'known']) {
    const dir = path.join(ROOT, 'runs', 'dev', slug, 'ref');
    if (!fs.existsSync(path.join(dir, 'capture.json'))) { check(`self ${slug}`, false, 'capture missing'); continue; }
    const c = loadCapture(dir);
    const d = compareCaptures(c, JSON.parse(JSON.stringify(c)));
    check(`self ${slug} total 10`, d.total === 10, `total ${d.total} (${areaLine(d)})`);
  }
}

const shiftHue = (hex, deg) => { const c = converter('oklch')(hex); return formatHex(converter('rgb')({ ...c, h: ((c.h || 0) + deg) % 360 })); };
const ACCENT = '#4f46e5';
const VARIANTS = [
  { name: 'accent-hue', edit: (h) => h.split(ACCENT).join(shiftHue(ACCENT, 40)), area: 'color', keep: ['layout', 'type', 'motion', 'responsive'], fixHas: [ACCENT] },
  { name: 'h1-48', edit: (h) => h.replace('h1 { font-size: 64px;', 'h1 { font-size: 48px;'), area: 'type', keep: ['layout', 'color', 'motion'], fixHas: ['h1', '64px'] },
  { name: 'reveal-200', edit: (h) => h.replace('transition: opacity 600ms ease-out, transform 600ms ease-out;', 'transition: opacity 200ms ease-out, transform 200ms ease-out;'), area: 'motion', keep: ['layout', 'color', 'type', 'responsive'], fixHas: ['600ms'] },
  { name: 'band-removed', edit: (h) => h.replace(/<section class="cta"[\s\S]*?<\/section>/, ''), area: 'layout', keep: ['color', 'type', 'motion'], fixHas: ['#4f46e5'] },
  { name: 'grid-2col', edit: (h) => h.replace('grid-template-columns: repeat(3, 1fr); gap: 24px; margin-top: 48px;', 'grid-template-columns: repeat(2, 1fr); gap: 24px; margin-top: 48px;'), area: 'layout', keep: ['color', 'type', 'motion'], fixHas: ['3'], fixAny: ['card', 'column'] },
  { name: 'nav-static', edit: (h) => h.replace('header.nav { position: sticky; top: 0;', 'header.nav { position: relative; top: 0;'), area: ['layout', 'motion'], keep: ['color', 'type'], fixHas: ['sticky'] },
  // a static first screen against a reference that stages its hero must cost >= 1.4 motion points
  { name: 'load-static', edit: (h) => h.replace(/  \.hero (h1|\.lead|\.actions) \{ animation: rise[^\n]*\n/g, ''), area: 'motion', keep: ['layout', 'color', 'type', 'responsive'], fixHas: ['load'], maxScore: 8.6 },
  // rendered weight: h1 700 -> 400 is a visible type change
  { name: 'h1-weight-400', edit: (h) => h.replace('h1 { font-size: 64px; font-weight: 700;', 'h1 { font-size: 64px; font-weight: 400;'), area: 'type', keep: ['layout', 'color', 'motion', 'responsive'], fixHas: ['weight', '700'] },
  // visual heaviness: the same declared weights in a thinner-stroked family (Windows system fonts) must
  // read as a type change through ink, with a fix that says lighter
  { name: 'ink-light', edit: (h) => h.replace('body { font-family: Arial, Helvetica, sans-serif;', 'body { font-family: "Segoe UI Light", "Calibri Light", sans-serif;'), area: 'type', keep: ['layout', 'color', 'motion'], fixHas: ['lighter'], maxScore: 8.8 },
  // equivalences: visually identical implementations must score the same
  { name: 'margin-vs-padding', equiv: true, edit: (h) => h.replace('.features { background: #ffffff; padding: 96px 0; }', '.features { background: #ffffff; padding: 0; margin: 96px 0; }') },
  { name: 'img-vs-svg', equiv: true, edit: (h) => h.replace('.track svg { display: block;', '.track img, .track svg { display: block;').replace(/<svg viewBox="0 0 160 40">([\s\S]*?)<\/svg>/g, (m) => `<img alt="" width="160" height="40" src="data:image/svg+xml,${encodeURIComponent(m.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" '))}">`) },
  { name: 'no-third-party-chrome', equiv: true, edit: (h) => h.replace('<div class="adslot" data-ad-slot="leaderboard"></div>\n', '').replace(/<div id="cookie-banner">[\s\S]*?<\/div>\n/, '').replace('<div class="grecaptcha-badge"></div>\n', '').replace(/<div class="pv-box">[\s\S]*?<\/div>\n/, '').replace('<div id="region-pop"></div>\n', '') },
  // heading roles are visual size tiers: an h2 re-tagged as h1 with identical CSS must score the same
  { name: 'h2-as-h1', equiv: true, edit: (h) => h
    .replace('  h2 { font-size: 40px; font-weight: 700; line-height: 1.2; margin: 0 0 16px; }\n', '  h2 { font-size: 40px; font-weight: 700; line-height: 1.2; margin: 0 0 16px; }\n  h1.as-h2 { font-size: 40px; font-weight: 700; line-height: 1.2; letter-spacing: normal; margin: 0 0 16px; max-width: none; }\n')
    .replace('    h2 { font-size: 30px; }\n', '    h2 { font-size: 30px; }\n    h1.as-h2 { font-size: 30px; }\n')
    .replace('<h2>Everything in its right place</h2>', '<h1 class="as-h2">Everything in its right place</h1>') },
];

async function captureVariant(v, srcHtml) {
  const base = path.join(ROOT, 'runs', 'dev', '_variants', v.name);
  const buildDir = path.join(base, 'build'), capDir = path.join(base, 'cap');
  if (reuse && fs.existsSync(path.join(capDir, 'capture.json'))) return capDir;
  if (reuse) return null; // --reuse never captures: a variant without a capture is skipped
  fs.rmSync(base, { recursive: true, force: true });
  fs.mkdirSync(buildDir, { recursive: true });
  const html = v.edit(srcHtml);
  if (html === srcHtml) throw new Error(`variant ${v.name}: edit did not change the fixture`);
  fs.writeFileSync(path.join(buildDir, 'index.html'), html);
  const srv = await startServer(buildDir);
  try { await runNode(path.join(SCRIPTS, 'capture.mjs'), [srv.url, capDir, '--no-motion-frames']); }
  finally { await srv.stop(); }
  return capDir;
}

async function sensitivity() {
  const refDir = path.join(ROOT, 'runs', 'dev', 'known', 'ref');
  if (!fs.existsSync(path.join(refDir, 'capture.json'))) { check('known reference capture exists', false, 'run node harness/check-capture.mjs first'); return; }
  const ref = loadCapture(refDir);
  const src = fs.readFileSync(path.join(ROOT, 'harness', 'fixtures', 'known', 'index.html'), 'utf8');
  const queue = [...VARIANTS];
  const caps = {};
  const worker = async () => { while (queue.length) { const v = queue.shift(); caps[v.name] = await captureVariant(v, src); } };
  await Promise.all([worker(), worker(), worker()]);
  for (const v of VARIANTS) {
    if (!caps[v.name]) { console.log(`SKIP  ${v.name}: no capture yet (--reuse never captures; run without --reuse)`); continue; }
    const d = compareCaptures(ref, loadCapture(caps[v.name]), { refDir, buildDir: caps[v.name] });
    fs.writeFileSync(path.join(path.dirname(caps[v.name]), 'diff.json'), JSON.stringify(d, null, 1));
    const scores = Object.fromEntries(Object.entries(d.areas).map(([k, a]) => [k, a.score]));
    const top = d.findings[0] || {};
    console.log(`----  ${v.name}: total ${d.total} | ${areaLine(d)}`);
    console.log(`      top: [${top.area}] ${top.fix}`);
    if (v.equiv) {
      check(`${v.name}: equivalent build total >= 9.9`, d.total >= 9.9, `total ${d.total}`);
      for (const [k, sc] of Object.entries(scores)) check(`${v.name}: ${k} >= 9.8`, sc >= 9.8, `${k} ${sc}`);
      continue;
    }
    const want = [].concat(v.area);
    const lowest = Object.entries(scores).sort((a, b) => a[1] - b[1])[0][0];
    if (v.maxScore) check(`${v.name}: ${want.join('/')} <= ${v.maxScore}`, want.some((a) => scores[a] <= v.maxScore), want.map((a) => `${a} ${scores[a]}`).join(', '));
    check(`${v.name}: lowest area is ${want.join('/')}`, want.includes(lowest), `lowest ${lowest} ${scores[lowest]}`);
    check(`${v.name}: ${want.join('/')} dropped below 9.8`, want.some((a) => scores[a] < 9.8), want.map((a) => `${a} ${scores[a]}`).join(', '));
    check(`${v.name}: top finding in ${want.join('/')}`, want.includes(top.area), `[${top.area}] ${top.what}`);
    const fixOk = v.fixHas.every((s) => (top.fix || '').includes(s)) && (!v.fixAny || v.fixAny.some((s) => (top.fix || '').toLowerCase().includes(s)));
    check(`${v.name}: top fix names the change (${v.fixHas.join(', ')})`, fixOk);
    for (const k of v.keep) check(`${v.name}: unrelated ${k} stays >= 9.5`, scores[k] >= 9.5, `${k} ${scores[k]}`);
  }
}

// 4. synthetic: edited copies of the known capture (no browser). Each is an equivalence (a visually
//    identical capture difference must not cost) or a sensitivity (a real difference must).
function synthetic() {
  const refDir = path.join(ROOT, 'runs', 'dev', 'known', 'ref');
  if (!fs.existsSync(path.join(refDir, 'capture.json'))) { check('known reference capture exists', false, 'run node harness/check-capture.mjs first'); return; }
  const K = loadCapture(refDir);
  const copy = (x) => JSON.parse(JSON.stringify(x));
  const cmp = (r, b) => compareCaptures(r, b);
  const area = (d, k) => d.areas[k].score;
  const sub = (d, k, name) => d.areas[k].subs.find((s) => s.name === name) || null;
  const roles = (cap, vp = '1440') => cap.type.roles[vp];
  const allVps = (cap, fn) => { for (const vp of Object.keys(cap.type.roles)) for (const [r, v] of Object.entries(cap.type.roles[vp])) if (v) fn(v, r, vp); };

  // 7. weight vs ink: a weight raised (ink unchanged) costs nothing; a lighter ink still costs
  {
    const b = copy(K); allVps(b, (v) => { v.weight += 100; });
    const d = cmp(K, b);
    check('syn 7: weight +100 with ink unchanged -> type 10', area(d, 'type') === 10, `type ${area(d, 'type')}, responsive ${area(d, 'responsive')}`);
    check('syn 7: ... and responsive 10', area(d, 'responsive') === 10, `responsive ${area(d, 'responsive')}`);
    const b2 = copy(K); allVps(b2, (v) => { if (v.ink) v.ink = +(v.ink * 0.7).toFixed(4); });
    const d2 = cmp(K, b2);
    check('syn 7: ink 30% lighter -> type <= 9', area(d2, 'type') <= 9, `type ${area(d2, 'type')}`);
    check('syn 7: ... top finding says lighter', /lighter/.test(d2.findings[0]?.fix || ''), d2.findings[0]?.what);
    const b3 = copy(K); allVps(b3, (v) => { delete v.ink; v.weight += 100; });
    const r3 = copy(K); allVps(r3, (v) => { delete v.ink; });
    check('syn 7: no ink on either side -> weight is scored', area(cmp(r3, b3), 'type') < 9.8, `type ${area(cmp(r3, b3), 'type')}`);
  }
  // 8. heading tiers paired by size, never by tag
  {
    // reference: tiers 64 / 40 / 22 px labelled h1 / h2 / h3
    const r = copy(K); const R = roles(r);
    const b = copy(K); const B = roles(b);
    // build: the same three tiers labelled display (64) / h1 (40, "the only h1 tag") / h2 (22), no h3
    B.display = { ...R.h1 }; B.h1 = { ...R.h2, how: 'h1 tag' }; B.h2 = { ...R.h3 }; delete B.h3;
    const d = cmp(r, b);
    check('syn 8: same tiers labelled by other tags -> type 10', area(d, 'type') === 10, `type ${area(d, 'type')} ${sub(d, 'type', 'coverage')?.detail}`);
    const b2 = copy(b); delete roles(b2).h2; // the 22 px tier is gone
    const d2 = cmp(r, b2);
    check('syn 8: a tier missing in the build -> coverage < 10', sub(d2, 'type', 'coverage').score < 10, `coverage ${sub(d2, 'type', 'coverage').score} ${sub(d2, 'type', 'coverage').detail}`);
    // duolingo-like: reference h1 64 / h2 48 / h3 32 (second h1 tag); build display 64 / h1 32 / h2 48-tier present
    const r3 = copy(K); const R3 = roles(r3); R3.h2 = { ...R3.h2, px: 48 }; R3.h3 = { ...R3.h3, px: 32 };
    const b3 = copy(r3); const B3 = roles(b3); B3.display = { ...R3.h1 }; B3.h1 = { ...R3.h3 }; B3.h3 = { ...R3.h2 }; delete B3.h2;
    check('syn 8: h2/h3 tiers swapped by tag (duolingo case) -> type 10', area(cmp(r3, b3), 'type') === 10, `type ${area(cmp(r3, b3), 'type')}`);
  }
  // 11a. a band split into 3 adjacent bands (same summed height and background) aligns as one band
  {
    const b = copy(K);
    const k = b.sections.findIndex((s) => s.role === 'features');
    const s = b.sections[k];
    const hs = [Math.round(s.h * 0.2), Math.round(s.h * 0.55)]; hs.push(s.h - hs[0] - hs[1]);
    let y = s.y;
    const pieces = hs.map((h, n) => { const p = { ...copy(s), i: n === 0 ? s.i : 100 + n, y, h, pad: [n === 0 ? s.pad[0] : 0, n === 2 ? s.pad[1] : 0] }; y += h; return p; });
    pieces[0].cards = null; pieces[0].cols = 1; pieces[2].cards = null; pieces[2].cols = 1;
    // the band's content is divided among the pieces (heading on top, buttons at the bottom), never copied
    const home = (key) => (key === 'headings' || key === 'headingLike' ? 0 : key === 'buttons' ? 2 : 1);
    if (s.counts) pieces.forEach((p, n) => { p.counts = Object.fromEntries(Object.entries(s.counts).map(([key, v]) => [key, home(key) === n ? v : 0])); });
    b.sections.splice(k, 1, ...pieces);
    const d = cmp(K, b);
    const unmatched = d.areas.layout.findings.filter((f) => /no counterpart/.test(f.what));
    check('syn 11a: band split into 3 -> layout >= 9.9', area(d, 'layout') >= 9.9, `layout ${area(d, 'layout')} ${(d.areas.layout.notes || []).join('; ')}`);
    check('syn 11a: ... and no unmatched-band finding', unmatched.length === 0, unmatched.map((f) => f.what).join('; '));
    const b2 = copy(K); b2.sections = b2.sections.filter((x) => x.role !== 'cta');
    const d2 = cmp(K, b2);
    check('syn 11a: a genuinely missing band still costs', area(d2, 'layout') < 9.8 && d2.areas.layout.findings.some((f) => /no counterpart/.test(f.what)), `layout ${area(d2, 'layout')}`);
  }
  // 11b. a mobile-only alternate at the same position is one band, not a hidden band
  {
    const r = copy(K);
    const cta = r.sections.find((x) => x.role === 'cta');
    cta.collapse['390'] = null;
    const nb = r.sectionsByViewport['390'].find((x) => x.link === cta.i); nb.link = null;
    const d = cmp(r, K);
    const hid = sub(d, 'responsive', 'hidden bands');
    check('syn 11b: ref swaps band for a mobile-only alternate, build reflows it -> no hidden-band loss', hid.score === 10 && !d.areas.responsive.findings.some((f) => /visibility/.test(f.what)), `hidden bands ${hid.score} (${hid.detail})`);
    const r2 = copy(r); r2.sectionsByViewport['390'] = r2.sectionsByViewport['390'].filter((x) => !(x.role === 'cta'));
    const d2 = cmp(r2, K);
    check('syn 11b: ref hides the band with no alternate -> hidden-band loss', sub(d2, 'responsive', 'hidden bands').score < 10, `hidden bands ${sub(d2, 'responsive', 'hidden bands').score}`);
  }
  // 6. load skip rules and hero media
  {
    const fade = { phase: 'load', kind: 'media', el: 'div.poster', n: 1, from: { opacity: 1 }, to: { opacity: 0 }, prop: 'o', ms: 400, family: 'linear', t0: 900, area: 1440 * 800 };
    const r = copy(K); r.motion.load.groups = [fade]; r.motion.load.summary = { groups: 1, firstStartMs: 900, lastEndMs: 1300, ms: 400, family: 'linear', from: { opacity: 1 }, staging: { delayMs: 800, order: ['media'], steps: 1, totalMs: 400 } };
    if (r.motion.frames?.load?.visual) r.motion.frames.load.visual.designed = false;
    const b = copy(K); b.motion.load.groups = []; b.motion.load.summary = null; if (b.motion.frames?.load?.visual) b.motion.frames.load.visual.designed = false;
    const ld = sub(cmp(r, b), 'motion', 'load');
    check('syn 6: ref load = a fade-out only vs static build -> load agreement (absent)', ld.score === 10 && ld.weight === 9, `load ${ld.score} w ${ld.weight} (${ld.detail})`);
    const r1 = copy(K); r1.motion.load.summary = { ...r1.motion.load.summary, staged: false, areaShare: 0.01, textShare: 0.01 };
    const ld1 = sub(cmp(r1, b), 'motion', 'load');
    check('syn 6: summary.staged false (newer capture) vs static build -> absent', ld1.score === 10 && ld1.weight === 9, `load ${ld1.score} w ${ld1.weight}`);
    const hero = (activity, kind = 'video') => ({ kind, el: `${kind}.hero`, box: [0, 64, 1440, 720], band: 's-hero', activity, diff: activity === 'static' ? 0 : 0.08, moving: activity !== 'static', when: activity === 'static' ? null : 'continuous' });
    // the fixture's own moving hero canvas is taken out of the base (load.media and its ambient media item)
    const K0 = copy(K);
    {
      const a = K0.motion.ambient; const n = (a.items || []).filter((x) => x.kind === 'media').length;
      a.items = (a.items || []).filter((x) => x.kind !== 'media'); a.count -= n; if (a.kinds) delete a.kinds.media;
      const bands = (a.bands || []).filter((b) => a.items.some((x) => x.band === b));
      a.bandShare = a.bands && a.bands.length ? (a.bandShare || 0) * (bands.length / a.bands.length) : a.bandShare; a.bands = bands;
      K0.motion.load.media = [];
    }
    const rh = copy(K0); rh.motion.load.media = [hero('medium')];
    const self = cmp(rh, copy(rh));
    check('syn 6: hero media self-compare -> motion 10', area(self, 'motion') === 10, `motion ${area(self, 'motion')}`);
    const bs = copy(K0); bs.motion.load.media = [hero('static', 'img')];
    const dS = cmp(rh, bs);
    check('syn 6: ref hero media medium vs build static -> motion drops (<= 9.0)', area(dS, 'motion') <= 9.0 && dS.findings[0]?.area === 'motion', `motion ${area(dS, 'motion')} top [${dS.findings[0]?.area}] ${dS.findings[0]?.what}`);
    for (const [act, kind] of [['medium', 'img'], ['high', 'lottie']]) {
      const bm = copy(K0); bm.motion.load.media = [hero(act, kind)];
      check(`syn 6: ref hero media medium vs build ${act} ${kind} moving -> motion 10`, area(cmp(rh, bm), 'motion') === 10, `motion ${area(cmp(rh, bm), 'motion')}`);
    }
    // round 5: a build one level calmer loses clearly; with rates (share of the box changing per second) the
    // continuous number decides within a level and a low-vs-high hero cannot reach motion 9.0
    {
      const bl = copy(K0); bl.motion.load.media = [hero('low', 'canvas')];
      const hm = sub(cmp(rh, bl), 'motion', 'heroMedia');
      check('syn 6: ref medium vs build low (one level calmer, no rates) -> heroMedia <= 5.5', hm.score <= 5.5 && area(cmp(rh, bl), 'motion') < 10, `heroMedia ${hm.score} motion ${area(cmp(rh, bl), 'motion')}`);
      const withRate = (m, rate) => Object.assign(m, { rate });
      const rH = copy(K0); rH.motion.load.media = [withRate(hero('high'), 0.82)];
      const bL = copy(K0); bL.motion.load.media = [withRate(hero('low', 'img'), 0.013)];
      const dHL = cmp(rH, bL);
      const fHL = dHL.findings.find((f) => f.what === 'first-screen media activity');
      check('syn 6 (1a): ref high (82%/s) vs build low (1.3%/s) -> motion < 9.0', area(dHL, 'motion') < 9.0, `motion ${area(dHL, 'motion')} heroMedia ${sub(dHL, 'motion', 'heroMedia').score} w ${sub(dHL, 'motion', 'heroMedia').weight}`);
      check('syn 6 (1a): ... finding states both rates and says to raise how much of the box changes per second', !!fHL && /82%/.test(fHL.fix) && /1\.3%/.test(fHL.fix) && /Raise how much of the box changes per second/.test(fHL.fix), fHL ? fHL.fix.slice(0, 160) : 'no finding');
      const rM = copy(K0); rM.motion.load.media = [withRate(hero('medium', 'canvas'), 0.072)];
      const dML = cmp(rM, bL);
      check('syn 6 (1a): ref medium 7.2%/s vs build low 1.3%/s (ribbon case) -> motion < 9.0', area(dML, 'motion') < 9.0, `motion ${area(dML, 'motion')} heroMedia ${sub(dML, 'motion', 'heroMedia').score}`);
      const rM3 = copy(K0); rM3.motion.load.media = [withRate(hero('medium'), 0.3)];
      const bM1 = copy(K0); bM1.motion.load.media = [withRate(hero('medium', 'img'), 0.1)];
      const hm3 = sub(cmp(rM3, bM1), 'motion', 'heroMedia');
      check('syn 6 (1a): same level, build rate 3x lower -> heroMedia < 10', hm3.score < 10, `heroMedia ${hm3.score}`);
      const bM2 = copy(K0); bM2.motion.load.media = [withRate(hero('medium', 'img'), 0.35)];
      check('syn 6 (1a): same level, build rate higher -> motion 10', area(cmp(rM3, bM2), 'motion') === 10, `motion ${area(cmp(rM3, bM2), 'motion')}`);
    }
    // round 5: hover data vs crops. Reference data says "no change" but its crops differ (a dropdown/box the
    // data missed); a build that changes visibly like the crops is not charged; one that stays still is
    {
      const kind = (K.hover || []).find((h) => h && !h.skipped && h.kind && Object.keys(h.self || {}).length)?.kind;
      if (kind) {
        const setCrop = (cap, changed) => { cap.motion.frames = cap.motion.frames || {}; cap.motion.frames.hover = [{ kind, dir: `motion/frames/hover-${kind}`, n: 2, visual: { changed, mean: changed / 4 } }]; };
        const rW = copy(K); for (const h of rW.hover) if (h && h.kind === kind) { h.self = {}; h.before = {}; h.after = {}; h.kids = []; } setCrop(rW, 0.3);
        const bV = copy(K); setCrop(bV, 0.28);
        const hv = sub(cmp(rW, bV), 'motion', 'hover');
        check('syn 6h: ref hover data "no change" but crops differ; build changes visibly like the crops -> hover 10', hv.score === 10, `hover ${hv.score} ${hv.detail}`);
        const bS = copy(K); for (const h of bS.hover) if (h && h.kind === kind) { h.self = {}; h.before = {}; h.after = {}; h.kids = []; } setCrop(bS, 0);
        const hv2 = sub(cmp(rW, bS), 'motion', 'hover');
        check('syn 6h: ... a build whose crops stay still -> hover < 10', hv2.score < 10, `hover ${hv2.score}`);
      } else check('syn 6h: known capture has a hover kind with data', false, 'none');
    }
    // not double counted: the hero video also listed as ambient media on the reference only
    const rh2 = copy(rh); rh2.motion.ambient = { ...(rh2.motion.ambient || {}), count: (rh2.motion.ambient?.count || 0) + 1, kinds: { ...(rh2.motion.ambient?.kinds || {}), media: 1 }, bands: [...(rh2.motion.ambient?.bands || []), 's-hero'], bandShare: (rh2.motion.ambient?.bandShare || 0) + 0.2, items: [...(rh2.motion.ambient?.items || []), { kind: 'media', media: 'video', band: 's-hero', el: 'video.hero', src: 'frames', box: [0, 64, 1440, 720], activity: 'medium' }] };
    const bm = copy(K0); bm.motion.load.media = [hero('medium', 'canvas')];
    check('syn 6: hero media also listed as ambient on one side -> not counted twice (motion 10)', area(cmp(rh2, bm), 'motion') === 10, `motion ${area(cmp(rh2, bm), 'motion')}`);
    const st1 = copy(K0); st1.motion.load.media = [hero('static', 'img')];
    const dSt = cmp(st1, copy(st1));
    check('syn 6: hero media static on both sides -> scored, motion 10, no area error', area(dSt, 'motion') === 10 && !dSt.errors, `motion ${area(dSt, 'motion')}${dSt.errors ? ' errors ' + JSON.stringify(dSt.errors).slice(0, 120) : ''}`);
  }
  // clipped content at the viewport edge: text cut by the build where the reference cuts none costs
  // RS.clippedPenalty (1.0) on responsive; media running past an edge (a bleeding tile row) is never charged
  {
    const withClip = (cap, items) => { cap.meta.overflowX = cap.meta.overflowX || {}; cap.meta.overflowX['768'] = { ...(cap.meta.overflowX['768'] || { scrollWidth: 768, vw: 768, overflow: false, by: 0 }), overflow: false, clipped: items, clippedN: items.length }; return cap; };
    const txt = { sel: 'div.cols > a', kind: 'text', side: 'right', cut: 60, w: 100, x: 728, by: 'viewport' };
    const med = { sel: 'div.row > img', kind: 'media', side: 'right', cut: 80, w: 260, x: 588, by: 'section.band' };
    const r0 = withClip(copy(K), []);
    const base = area(cmp(r0, withClip(copy(K), [])), 'responsive');
    const dT = cmp(r0, withClip(copy(K), [txt]));
    const dM = cmp(r0, withClip(copy(K), [med]));
    const dR = cmp(withClip(copy(K), [txt]), withClip(copy(K), [txt]));
    check('syn clip: build cuts text at 768, reference none -> responsive -1.0 and a finding', Math.abs((base - area(dT, 'responsive')) - 1) < 0.02 && dT.findings.some((f) => /text clipped past the viewport edge at 768/.test(f.what)), `responsive ${base} -> ${area(dT, 'responsive')}`);
    check('syn clip: build media running past the edge only -> not charged', area(dM, 'responsive') === base, `responsive ${base} -> ${area(dM, 'responsive')}`);
    check('syn clip: both sides cut text at 768 -> not charged', area(dR, 'responsive') === base, `responsive ${area(dR, 'responsive')} vs ${base}`);
    const lft = { sel: 'ul.feed > li > a > span', kind: 'text', side: 'left', cut: 80, w: 140, x: -80, by: 'viewport' }, rgt = { ...lft, side: 'right', x: 700, by: 'section.band' };
    const dB = cmp(r0, withClip(copy(K), [lft, rgt]));
    check('syn clip: a row bleeding past both edges (centred carousel / ticker) -> not charged', area(dB, 'responsive') === base, `responsive ${base} -> ${area(dB, 'responsive')}`);
  }
  // a step change of a small control (a carousel arrow turning visible) is not a scroll reveal; a page tint
  // below M.tintMinDe (white to a 1% off-white) is not a visible tint: neither is charged
  {
    const r = copy(K), b = copy(K);
    const arrow = { phase: 'step1', el: 'button.arrow', n: 1, from: { visibility: 'hidden' }, appear: 'step', source: 'step (no transition)', area: 1200, ms: 0 };
    r.motion.reveals = { summary: { groups: 1, elements: 1, from: { visibility: 'hidden' }, appear: 'step', stepGroups: 1 }, groups: [arrow] };
    b.motion.reveals = { summary: null, groups: [] };
    const rp = sub(cmp(r, b), 'motion', 'revealPresence');
    check('syn minor step: ref only a small control turning visible vs build no reveals -> revealPresence not charged', !rp || rp.score === null || rp.score === 10, `revealPresence ${rp ? rp.score : '-'} (${rp ? rp.detail : ''})`);
    const r2 = copy(K); r2.motion.reveals = { summary: { groups: 1, elements: 6, from: { opacity: 0 }, appear: 'step', stepGroups: 1 }, groups: [{ ...arrow, el: 'div.card', n: 6, area: 120000 }] };
    const rp2 = sub(cmp(r2, b), 'motion', 'revealPresence');
    check('syn minor step: ... six cards stepping in are a reveal (charged when the build has none)', rp2 && rp2.score < 10, `revealPresence ${rp2 ? rp2.score : '-'}`);
    const tr = copy(K), tbd = copy(K);
    tr.motion.scrollTint = { changes: 0, colors: [] };
    tbd.motion.scrollTint = { changes: 1, colors: [{ at: 3000, color: '#fbfcfe', rest: '#ffffff' }] };
    const st = sub(cmp(tr, tbd), 'motion', 'scrollTint');
    check('syn tint: build white -> 1% off-white tint vs reference none -> not charged', st && st.score === 10, `scrollTint ${st ? st.score : '-'} (${st ? st.detail : ''})`);
    tbd.motion.scrollTint = { changes: 1, colors: [{ at: 3000, color: '#1a1a2e', rest: '#ffffff' }] };
    const st2 = sub(cmp(tr, tbd), 'motion', 'scrollTint');
    check('syn tint: ... a white -> dark tint is charged', st2 && st2.score < 10, `scrollTint ${st2 ? st2.score : '-'}`);
  }
  // 9. page tint on scroll
  {
    const tint = (colors) => ({ changes: colors.length - 1, colors: colors.map((c, k) => ({ at: k * 1200, color: c })) });
    const r = copy(K); r.motion.scrollTint = tint(['#ffffff', '#111827', '#ffffff']);
    const b = copy(K); b.motion.scrollTint = tint(['#ffffff', '#121828', '#ffffff']);
    check('syn 9: same scroll tint (body vs fixed layer) -> motion 10', area(cmp(r, b), 'motion') === 10, `motion ${area(cmp(r, b), 'motion')}`);
    const b2 = copy(K); b2.motion.scrollTint = tint(['#ffffff']);
    check('syn 9: build keeps one background -> scrollTint 0', sub(cmp(r, b2), 'motion', 'scrollTint').score === 0, `scrollTint ${sub(cmp(r, b2), 'motion', 'scrollTint').score}`);
  }
  // 10. rendered line box; transitions only where something visibly changes
  {
    const r = copy(K); const b = copy(K);
    for (const [cap, lh] of [[r, null], [b, 1.31]]) for (const v of Object.values(roles(cap))) { v.lh = lh; v.lhr = 1.31; }
    check('syn 10: lh normal vs 1.31 with equal rendered line box -> type 10', area(cmp(r, b), 'type') === 10, `type ${area(cmp(r, b), 'type')}`);
    const b2 = copy(b); for (const v of Object.values(roles(b2))) v.lhr = 1.6;
    check('syn 10: rendered line box 1.31 vs 1.6 -> lineHeight drops', sub(cmp(r, b2), 'type', 'lineHeight').score < 5, `lineHeight ${sub(cmp(r, b2), 'type', 'lineHeight').score}`);
    const rt = copy(K); rt.motion.transitions = [...rt.motion.transitions, { prop: 'box-shadow', ms: 300, easing: 'ease', delay: 0, n: 40, family: 'ease-out' }];
    const dt = cmp(rt, K);
    check('syn 10: ref transition category with no observed change -> not scored', sub(dt, 'motion', 'transitions').score === 10 && area(dt, 'motion') === 10, `transitions ${sub(dt, 'motion', 'transitions').score} (${sub(dt, 'motion', 'transitions').detail})`);
    const bt = copy(K); bt.motion.transitions = [...bt.motion.transitions, { prop: 'box-shadow', ms: 300, easing: 'ease', delay: 0, n: 40, family: 'ease-out' }];
    check('syn 10: build-only no-op category -> not scored', sub(cmp(K, bt), 'motion', 'transitions').score === 10, `transitions ${sub(cmp(K, bt), 'motion', 'transitions').score}`);
    const rt2 = copy(rt); rt2.hover = [...(rt2.hover || []), { kind: 'card', desc: 'div.card', self: { boxShadow: ['none', '0 8px 24px rgba(0,0,0,.12)'] }, before: null, after: null, kids: [], transition: 'box-shadow 300ms ease' }];
    const bt2 = copy(K); bt2.hover = copy(rt2.hover);
    check('syn 10: ref category whose change is observed (hover shadow) -> scored, build without it drops', sub(cmp(rt2, bt2), 'motion', 'transitions').score < 10, `transitions ${sub(cmp(rt2, bt2), 'motion', 'transitions').score}`);
  }
  // container: rail width and running-text left edge
  {
    const r = copy(K); const c = r.spacing.container['1440']; Object.assign(c, { textLeft: 200, railLeft: 160, railRight: 1280, contentLeft: 160, contentRight: 1280, contentWidth: 1120 });
    const b = copy(r);
    check('syn 11d: same rail and text edge -> layout 10', area(cmp(r, b), 'layout') === 10, `layout ${area(cmp(r, b), 'layout')}`);
    const b2 = copy(r); Object.assign(b2.spacing.container['1440'], { textLeft: 260 });
    check('syn 11d: running text 60 px further in -> gutter 0', sub(cmp(r, b2), 'layout', 'gutter').score === 0, `gutter ${sub(cmp(r, b2), 'layout', 'gutter').score}`);
  }
  // B7a: a centred running-text column is not container padding
  {
    const cen = (cap, vp, l, rr) => Object.assign(cap.spacing.container[vp], { textLeft: l, textRight: rr, railLeft: 40, railRight: 728, contentLeft: 40, contentRight: 728, contentWidth: 688 });
    const r = copy(K); cen(r, '768', 148, 620);   // reference centres a 472 px column inside a 40..728 rail
    const b = copy(K); cen(b, '768', 192, 576);   // build centres a 384 px column
    const d = cmp(r, b);
    const f = d.areas.responsive.findings.find((x) => /text column|left edge/.test(x.what)) || {};
    check('syn B7a: centred text columns -> fix names the column width, not container padding', /centred/.test(f.fix || '') && /max-width to 472px/.test(f.fix || '') && !/side padding/.test(f.fix || ''), (f.fix || 'no finding').slice(0, 140));
    check('syn B7a: ... and the narrower column still costs (768 container < 10)', sub(d, 'responsive', '768 container').score < 10, `768 container ${sub(d, 'responsive', '768 container').score}`);
    const b2 = copy(K); cen(b2, '768', 148, 620);
    check('syn B7a: same centred column -> 768 container 10', sub(cmp(r, b2), 'responsive', '768 container').score === 10, `768 container ${sub(cmp(r, b2), 'responsive', '768 container').score}`);
    // a left-aligned text inset (symmetric container padding, text on the rail) is still container padding
    const r3 = copy(K); cen(r3, '768', 40, 728);
    const b3 = copy(K); cen(b3, '768', 80, 688); Object.assign(b3.spacing.container['768'], { railLeft: 80, railRight: 688 });
    const f3 = cmp(r3, b3).areas.responsive.findings.find((x) => /left edge/.test(x.what)) || {};
    check('syn B7a: text on the rail 40 px further in -> container padding finding', /side padding to 40px/.test(f3.fix || ''), (f3.fix || 'no finding').slice(0, 120));
  }
  // B7b: a band that re-segments at 390 (one 1440 band shown as four narrow bands, more than an independent
  // alignment can merge) is compared as one unit with the build's single band
  {
    const r = copy(K);
    const list = r.sectionsByViewport['390'];
    const k = list.findIndex((x) => x.role === 'features' && x.link != null);
    const s = list[k];
    const hs = [0.2, 0.3, 0.3].map((f) => Math.round(s.h * f)); hs.push(s.h - hs[0] - hs[1] - hs[2]);
    let y = s.y;
    const pieces = hs.map((h, n) => { const p = { ...copy(s), i: n === 0 ? s.i : 200 + n, id: n === 0 ? s.id : `s-syn${n}xx`, y, h, pad: [n === 0 ? s.pad[0] : 0, n === 3 ? s.pad[1] : 0] }; y += h; return p; });
    list.splice(k, 1, ...pieces);
    const prim = r.sections.find((x) => x.i === s.link);
    prim.collapse['390'] = { ...prim.collapse['390'], bands: pieces.map((p) => p.i) };
    const d = cmp(r, K);
    check('syn B7b: reference re-segments a band into 4 at 390 -> 390 heights 10', sub(d, 'responsive', '390 heights').score === 10, `390 heights ${sub(d, 'responsive', '390 heights').score} (${(d.areas.responsive.notes || []).join('; ')})`);
    check('syn B7b: ... and 390 padding 10', sub(d, 'responsive', '390 padding').score === 10, `390 padding ${sub(d, 'responsive', '390 padding').score}`);
    const b2 = copy(K); const bb = b2.sectionsByViewport['390'].find((x) => x.link === s.link); bb.h = Math.round(bb.h * 0.5);
    check('syn B7b: ... a build band genuinely half as tall at 390 still costs', sub(cmp(r, b2), 'responsive', '390 heights').score < 10, `390 heights ${sub(cmp(r, b2), 'responsive', '390 heights').score}`);
  }
  // D2: compare aligns by content where the two sides segment differently (LAYOUT.merge)
  {
    const unmatchedOf = (d, k) => d.areas[k].findings.filter((f) => /no counterpart/.test(f.what) || /no counterpart/.test(f.fix || ''));
    // (1) reference cuts its 390 features band into 7 row strips (an empty strip under the top, a thin dark
    // rule, an unlinked last strip); the build keeps one band of the same span -> scores as unsplit
    const r = copy(K);
    const list = r.sectionsByViewport['390'];
    const k = list.findIndex((x) => x.role === 'features' && x.link != null);
    const s = list[k];
    const hs = [40, 0.15, 30, 0.2, 0.2, 0.15].map((f) => (f < 1 ? Math.round(s.h * f) : f)); hs.push(s.h - hs.reduce((a, x) => a + x, 0));
    let y = s.y;
    const strips = hs.map((h, n) => {
      const p = { ...copy(s), i: n === 0 ? s.i : 300 + n, id: n === 0 ? s.id : `s-d2s${n}x`, y, h, cards: n === 3 ? s.cards : 0, cardCols: n === 3 ? s.cardCols : null };
      p.pad = n === 0 ? null : [n === 1 ? s.pad[0] - hs[0] : 0, n === hs.length - 1 ? s.pad[1] : 0];
      if (n === 2) p.bg = { type: 'color', color: '#000000', sampled: '#000000' };
      if (n === hs.length - 1) delete p.link;
      y += h; return p;
    });
    list.splice(k, 1, ...strips);
    const prim = r.sections.find((x) => x.i === s.link);
    prim.collapse['390'] = { ...prim.collapse['390'], bands: strips.filter((p) => 'link' in p).map((p) => p.i) };
    const d = cmp(r, K);
    const sq = sub(d, 'responsive', '390 sequence'), pd = sub(d, 'responsive', '390 padding'), ht = sub(d, 'responsive', '390 heights');
    check('syn D2-1: reference 390 band cut into 7 row strips vs one build band -> 390 sequence, padding, heights 10', sq.score === 10 && pd.score === 10 && ht.score === 10, `sequence ${sq.score} (${sq.detail}), padding ${pd.score}, heights ${ht.score}`);
    check('syn D2-1: ... responsive as unsplit (10) and no missing/extra band finding', area(d, 'responsive') === 10 && !d.findings.some((f) => /band sequence at 390|no counterpart/.test(f.what)), `responsive ${area(d, 'responsive')}`);
    // the same without DOM links on either side (older captures: the 390 sequences are aligned on their own)
    const unlink = (c) => { for (const vp of Object.keys(c.sectionsByViewport)) for (const x of c.sectionsByViewport[vp]) delete x.link; for (const x of c.sections) if (x.collapse) delete x.collapse; return c; };
    const dU = cmp(unlink(copy(r)), unlink(copy(K)));
    const sqU = sub(dU, 'responsive', '390 sequence'), pdU = sub(dU, 'responsive', '390 padding');
    check('syn D2-1: ... without links: 7 strips align as one run -> 390 sequence and padding 10', sqU.score === 10 && pdU.score === 10, `sequence ${sqU.score} (${sqU.detail}), padding ${pdU.score}`);

    // (2) two adjacent same-colour bands in the reference (section header + card grid) where the build has
    // one band over the same span -> aligned as one; also a light strip above a dark band where the build's
    // segmenter reads the whole span as the dark band (minority tone <= offTone)
    const split2 = (cap, recolour) => {
      const c = copy(cap); const q = c.sections.findIndex((x) => x.role === 'features'); const f = c.sections[q];
      const h0 = Math.round(f.h * 0.12 + (recolour ? 0 : f.h * 0.23));
      const home = (key) => (key === 'headings' || key === 'headingLike' || key === 'paragraphs' ? 0 : 1);
      const ps = [0, 1].map((n) => ({ ...copy(f), i: n === 0 ? f.i : 400, id: n === 0 ? f.id : 's-d2two', y: n === 0 ? f.y : f.y + h0, h: n === 0 ? h0 : f.h - h0,
        pad: [n === 0 ? f.pad[0] : 24, n === 0 ? 24 : f.pad[1]], cards: n === 0 ? null : f.cards, layout: n === 0 ? { cols: 1, ratios: [1] } : f.layout,
        counts: Object.fromEntries(Object.entries(f.counts).map(([key, v]) => [key, home(key) === n ? v : 0])) }));
      if (recolour) ps[1].bg = { ...ps[1].bg, type: 'color', color: '#111827', sampled: '#111827' };
      c.sections.splice(q, 1, ...ps);
      return c;
    };
    const d2 = cmp(split2(K, false), K);
    check('syn D2-2: reference has two adjacent same-colour bands, build one band over the span -> layout 10, nothing missing', area(d2, 'layout') === 10 && !unmatchedOf(d2, 'layout').length, `layout ${area(d2, 'layout')} ${(d2.areas.layout.notes || []).join('; ')}`);
    const bDark = copy(K); Object.assign(bDark.sections.find((x) => x.role === 'features').bg, { type: 'color', color: '#111827', sampled: '#111827' });
    const d2b = cmp(split2(K, true), bDark);
    check('syn D2-2: ... light strip (12%) above a dark band read as one dark band by the build -> no missing band', !unmatchedOf(d2b, 'layout').length && sub(d2b, 'layout', 'sequence').score === 10, `sequence ${sub(d2b, 'layout', 'sequence').score} ${(d2b.areas.layout.notes || []).join('; ')}`);

    // (3) a really missing band is still charged: the hero removed and the next band grown by its height
    // without its content; and a 390-only band removed from the build
    const b3 = copy(K); const hi = b3.sections.findIndex((x) => x.role === 'hero'); const hero = b3.sections[hi];
    const feat = b3.sections.find((x) => x.role === 'features'); feat.y = hero.y; feat.h += hero.h; b3.sections.splice(hi, 1);
    const d3 = cmp(K, b3);
    check('syn D2-3: hero missing, its span absorbed by the next band without its content -> still no counterpart', unmatchedOf(d3, 'layout').some((f) => /hero/.test(f.what)) && area(d3, 'layout') < 9.8, `layout ${area(d3, 'layout')} ${unmatchedOf(d3, 'layout').map((f) => f.what).join('; ')}`);
    const b4 = copy(K); b4.sectionsByViewport['390'] = b4.sectionsByViewport['390'].filter((x) => !(x.link == null && x.role === 'other'));
    const d4 = cmp(K, b4);
    check('syn D2-3: a 390-only band missing in the build -> 390 sequence < 10', b4.sectionsByViewport['390'].length < K.sectionsByViewport['390'].length && sub(d4, 'responsive', '390 sequence').score < 10, `390 sequence ${sub(d4, 'responsive', '390 sequence').score} (${sub(d4, 'responsive', '390 sequence').detail})`);
  }
  // R1: reveal strip timing (motion.frames.reveals[].content, build strips replay the reference's via like.ref)
  {
    const strip = (lag, inPlace, like) => ({ dir: 'motion/frames/reveal-1', n: 19, fps: 12, t0: 'wheel', band: 's-syn', scroll: { px: 675, settleMs: 106 }, content: { visibleMs: 167 + lag, scrollMs: 167, lagMs: lag, changed: inPlace ? 0.01 : 0.09, inPlace }, like });
    // reveal strips only: the load strip's appearance (an extra revealTiming pair, scored when both captures have
    // one) is taken out so these checks measure the reveal strips alone
    const withStrips = (cap, list) => { const c = copy(cap); const fl = c.motion.frames && c.motion.frames.load; c.motion.frames = { ...(c.motion.frames || {}), reveals: list, load: fl ? { ...fl, appear: undefined } : fl }; return c; };
    const r = withStrips(K, [strip(0, true)]);
    const rt = (b) => sub(cmp(r, b), 'motion', 'revealTiming');
    const late = cmp(r, withStrips(K, [strip(417, false, { ref: 1 })]));
    const s1 = sub(late, 'motion', 'revealTiming');
    check('syn R1: reference strip in place, build fades 417 ms after the scroll stops -> revealTiming 0', s1 && s1.score === 0, `revealTiming ${s1 && s1.score}`);
    const f = late.findings.find((x) => x.what === 'reveal strip 1 timing');
    check('syn R1: ... with a motion finding that costs points and names the strip', f && f.area === 'motion' && f.lost >= 0.04 && /already in place/.test(f.fix), f ? `lost ${f.lost}` : 'no finding');
    check('syn R1: same timing -> revealTiming 10', rt(withStrips(K, [strip(0, true, { ref: 1 })])).score === 10, `revealTiming ${rt(withStrips(K, [strip(0, true, { ref: 1 })])).score}`);
    const ra = withStrips(K, [strip(300, false)]);
    const near = sub(cmp(ra, withStrips(K, [strip(450, false, { ref: 1 })])), 'motion', 'revealTiming');
    const far = sub(cmp(ra, withStrips(K, [strip(900, false, { ref: 1 })])), 'motion', 'revealTiming');
    check('syn R1: both animate, build 150 ms later -> 10; 600 ms later -> < 5', near.score === 10 && far.score < 5, `150 ms: ${near.score}, 600 ms: ${far.score}`);
    check('syn R1: build strips without like (not --frames-like) -> not scored', rt(withStrips(K, [strip(417, false)])).score === null, `revealTiming ${rt(withStrips(K, [strip(417, false)])).score}`);
  }
  // T: tracking is scored by the line width it sets: a face 0.03 em/char narrower with +0.03 em tracking
  //    (fontmatch apply.letterSpacingEm) runs the reference's width and costs nothing; the same tracking on
  //    the same face still costs
  {
    const ok = Object.values(roles(K)).filter((v) => v && typeof v.adv === 'number').length > 0;
    const b = copy(K); for (const v of Object.values(roles(b))) if (v && typeof v.adv === 'number') { v.adv = +(v.adv - 0.03).toFixed(3); v.ls = +((v.ls || 0) + 0.03).toFixed(3); }
    const s1 = sub(cmp(K, b), 'type', 'letterSpacing');
    check('syn T: tracking that restores a narrower face\'s set width -> letterSpacing 10', ok && s1.score === 10, `letterSpacing ${s1.score}${ok ? '' : ' (no adv in the known capture)'}`);
    const b2 = copy(K); for (const v of Object.values(roles(b2))) if (v) v.ls = +((v.ls || 0) + 0.03).toFixed(3);
    const s2 = sub(cmp(K, b2), 'type', 'letterSpacing');
    check('syn T: the same tracking on the same face -> letterSpacing < 10', s2.score < 10, `letterSpacing ${s2.score}`);
  }
  // L: a logo colour (one svg in the nav band) as the reference's graphic-only accent2 and a minor colour is
  //    not required; the same colour on three nav icons is
  {
    const nav = (K.sections || []).find((s) => s.role === 'nav');
    const logo = (n, uses) => { const r = copy(K); r.colors.roles.accent2 = '#ff3737'; r.colors.palette = [...r.colors.palette, { hex: '#ff3737', oklch: [0.65, 0.23, 27], share: 0, uses: { graphic: 0.03 }, roles: ['accent2'] }]; r.colors.minor = [{ hex: '#ff3737', oklch: [0.65, 0.23, 27], n, uses, ex: 'svg.mark', band: nav && nav.id }, ...(r.colors.minor || [])]; return r; };
    const dL = cmp(logo(1, ['icon']), K);
    check('syn L: reference logo colour (1 svg in the nav band) as accent2 + minor -> colour 10', !!nav && area(dL, 'color') === 10, `colour ${area(dL, 'color')} ${(dL.areas.color.notes || []).join('; ')}`);
    const dI = cmp(logo(3, ['icon']), K);
    check('syn L: the same colour on 3 nav icons -> still required (colour < 10)', area(dI, 'color') < 10, `colour ${area(dI, 'color')}`);
  }
  // MS: a sale / status colour on a few small elements (reference only) is not a required minor colour; the
  //     same colour on enough elements, or painting a share of the text area, is (COLOR.minorRequire)
  {
    const sale = (n, uses, share) => { const r = copy(K); r.colors.minor = [{ hex: '#d01c1c', oklch: [0.53, 0.2, 27], n, uses, share, ex: 'span.sale-tag', band: null }, ...(r.colors.minor || [])]; return r; };
    const ms = (d) => `colour ${area(d, 'color')} minor ${(sub(d, 'color', 'minor') || {}).detail || '-'}`;
    const d1 = cmp(sale(1, ['tag'], 0.001), K), d3 = cmp(sale(3, ['text'], 0.002), K), d6 = cmp(sale(6, ['tag'], 0.004), K), dS = cmp(sale(2, ['text'], 0.05), K);
    check('syn MS: one tiny sale tag colour -> not a required minor colour (colour 10)', area(d1, 'color') === 10 && !/#d01c1c/.test((sub(d1, 'color', 'minor') || {}).detail || ''), ms(d1));
    check('syn MS: sale colour on 3 small text elements -> not required (colour 10)', area(d3, 'color') === 10, ms(d3));
    check('syn MS: the same colour on 6 tags -> required (colour < 10)', area(d6, 'color') < 10, ms(d6));
    check('syn MS: on 2 elements painting 5% of the text area -> required (colour < 10)', area(dS, 'color') < 10, ms(dS));
  }
  // GR: band gradients (round 7): a page-colour fade to transparent, a scrim over media and a thin strip are
  //     not band gradients on either side; a build gradient the reference also draws is never discounted as art
  {
    const band = (K.sections || []).find((s) => s.role !== 'nav' && s.bg && s.bg.type === 'color');
    const withG = (gs) => { const r = copy(K); r.colors.gradients = gs.map((g) => ({ n: 1, where: 'band', bands: band ? [band.id] : [], ...g })); return r; };
    const pg = band ? band.bg.color : '#ffffff';
    const fade = { css: `linear-gradient(to top, ${pg} 0%, rgba(0, 0, 0, 0) 100%)`, areaFrac: 0.05 };
    const scrim = { css: 'linear-gradient(rgba(0, 0, 0, 0) 40%, rgba(0, 0, 0, 0.7) 100%)', areaFrac: 0.05, onMedia: true };
    const strip = { css: 'linear-gradient(90deg, rgb(255, 0, 128), rgb(0, 128, 255))', areaFrac: 0.002, thin: true };
    const real = { css: 'linear-gradient(90deg, rgb(120, 40, 200), rgb(20, 120, 240))', areaFrac: 0.05 };
    const none = withG([]), gsub = (d) => sub(d, 'color', 'gradients') || {};
    const dF = cmp(withG([fade, scrim, strip]), none);
    check('syn GR: page-colour fade, scrim over media and thin strip are not band gradients (gradients not charged)', !!band && (gsub(dF).score === null || gsub(dF).score === 10), `gradients ${gsub(dF).score} ${gsub(dF).detail || ''}`.slice(0, 220));
    const dR = cmp(withG([real]), none);
    check('syn GR: a real band gradient missing in the build costs, finding says the build has none', gsub(dR).score === 0 && dR.findings.some((f) => f.what === 'gradient usage' && /build has none/.test(f.fix)), `gradients ${gsub(dR).score}`);
    const dM = cmp(withG([real]), withG([fade]));
    check('syn GR: build with only a page-colour fade -> finding says its gradients do not count (not "none")', dM.findings.some((f) => f.what === 'gradient usage' && /none that count as band gradients/.test(f.fix)), (dM.findings.find((f) => f.what === 'gradient usage') || {}).fix?.slice(0, 160) || '-');
  }
  // LF: layout / responsive false positives (round 7). Bands of the known capture: 2 hero, 3 features,
  //     5 cta (1 column, no cards), 6 footer (last).
  {
    const seq = (d) => sub(d, 'layout', 'sequence').score;
    // LF1: hero / footer position by place first: labels from landmarks on the first / last band never cost
    const r1 = copy(K); r1.sections.find((s) => s.i === 2).role = 'features';
    const d1 = cmp(r1, K);
    check('syn LF1: first band labelled content in the reference, hero in the build -> sequence 10', seq(d1) === 10 && !d1.findings.some((f) => /position in the page/.test(f.what)), `sequence ${seq(d1)}`);
    const r1b = copy(K); r1b.sections.find((s) => s.i === 6).role = 'other';
    check('syn LF1: last band footer in the build only -> sequence 10', seq(cmp(r1b, K)) === 10, `sequence ${seq(cmp(r1b, K))}`);
    const b1c = copy(K); b1c.sections.find((s) => s.i === 5).role = 'hero';
    check('syn LF1: a middle band read as hero in the build still costs', seq(cmp(K, b1c)) < 10, `sequence ${seq(cmp(K, b1c))}`);
    // LF2: a collage (text-free media pieces of uneven size) is one media object, never columns or cards
    const collage = (flag) => {
      const b = copy(K); const s = b.sections.find((x) => x.i === 5);
      s.layout = { cols: 4, ratios: [0.12, 0.28, 0.22, 0.38], gap: 12, ...(flag ? { collage: true } : {}) };
      s.cards = { n: 4, cols: 2, rows: 2, gap: 12, like: false, w: 300, h: 200, ...(flag ? { collage: true } : {}) };
      const n = b.sectionsByViewport['390'].find((x) => x.link === 5); n.cols = 4; n.ratios = [0.12, 0.28, 0.22, 0.38]; n.cardCols = 2; n.cards = 4;
      if (flag) n.collage = 'both';
      return b;
    };
    const dc = cmp(K, collage(true)), dn = cmp(K, collage(false));
    check('syn LF2: build collage over a 1-column band -> columns and cards 10', sub(dc, 'layout', 'columns').score === 10 && sub(dc, 'layout', 'cards').score === 10, `columns ${sub(dc, 'layout', 'columns').score} cards ${sub(dc, 'layout', 'cards').score}`);
    check('syn LF2: ... and 390 columns 10', sub(dc, 'responsive', '390 columns').score === 10, `390 columns ${sub(dc, 'responsive', '390 columns').score}`);
    check('syn LF2: the same row without the collage flag (a real 4-column row) costs', sub(dn, 'layout', 'columns').score < 10 && sub(dn, 'responsive', '390 columns').score < 10, `columns ${sub(dn, 'layout', 'columns').score} 390 columns ${sub(dn, 'responsive', '390 columns').score}`);
    // LF3: the largest row of a multi-screen band counts at reduced weight unless it covers >= 40% of the band
    const tall = (cover) => {
      const r = copy(K), b = copy(K);
      for (const c of [r, b]) { const s = c.sections.find((x) => x.i === 3); s.h = 2700; s.vh = 3; }
      const rs = r.sections.find((x) => x.i === 3); if (cover != null) rs.layout.rowCover = cover;
      const bs = b.sections.find((x) => x.i === 3); bs.layout = { cols: 2, ratios: [0.5, 0.5], gap: 20 };
      return sub(cmp(r, b), 'layout', 'columns').score;
    };
    const weak = tall(null), small = tall(0.1), strong = tall(0.9);
    check('syn LF3: 3 vs 2 columns in a 3-screen band, row cover unknown or 10% -> reduced loss', weak > strong && small === weak, `columns weak ${weak}, cover 0.1 ${small}, cover 0.9 ${strong}`);
    check('syn LF3: ... a row covering 90% of the band still costs fully (< 10)', strong < 10, `columns ${strong}`);
    // LF4: a transparent nav over a page of the solid nav's colour looks solid
    const navT = (over) => { const r = copy(K); Object.assign(r.spacing.nav, { transparent: true, bg: null, ...(over ? { overHero: true } : {}) }); return r; };
    const ns = (d) => sub(d, 'layout', 'navStyle').score, nsSelf = ns(cmp(K, K));
    check('syn LF4: transparent nav over white vs solid white nav -> navStyle as self', ns(cmp(navT(false), K)) === nsSelf, `navStyle ${ns(cmp(navT(false), K))} (self ${nsSelf})`);
    const bDark = copy(K); bDark.spacing.nav.bg = '#111827';
    check('syn LF4: ... vs a solid dark nav -> costs', ns(cmp(navT(false), bDark)) < nsSelf, `navStyle ${ns(cmp(navT(false), bDark))}`);
    check('syn LF4: ... transparent over hero media vs solid -> costs', ns(cmp(navT(true), K)) < nsSelf, `navStyle ${ns(cmp(navT(true), K))}`);
    // LF5: marquees per narrow width (motion.marqueesByViewport): scored only where a side has one
    const mq = (l390) => { const c = copy(K); c.motion.marqueesByViewport = { 768: [], 390: l390 }; return c; };
    const strip = [{ el: 'div.strip', band: null, axis: 'x', dir: 'left', pxPerSec: 30, css: 'strip 20000ms linear infinite' }];
    const dm = cmp(mq(strip), mq([]));
    check('syn LF5: reference strip keeps moving at 390, build still -> 390 marquee 0', sub(dm, 'responsive', '390 marquee').score === 0, `390 marquee ${sub(dm, 'responsive', '390 marquee').score}`);
    check('syn LF5: no marquee at 768 on either side -> not scored', sub(dm, 'responsive', '768 marquee').score === null, `768 marquee ${sub(dm, 'responsive', '768 marquee').score}`);
    check('syn LF5: both moving at 390 -> 390 marquee 10', sub(cmp(mq(strip), mq(strip)), 'responsive', '390 marquee').score === 10, `390 marquee ${sub(cmp(mq(strip), mq(strip)), 'responsive', '390 marquee').score}`);
  }
}

// 5. mock-up body symmetry: one type and colour design in two markups must measure the same
const dLab = differenceEuclidean('oklab');
async function mockupBody() {
  const base = path.join(ROOT, 'runs', 'dev', '_variants', 'mockup-body');
  const sides = ['ref', 'build'];
  const capOf = (side) => path.join(base, side);
  if (reuse && !sides.every((s) => fs.existsSync(path.join(capOf(s), 'capture.json')))) { console.log('SKIP  mockup-body: no capture yet (--reuse never captures; run without --reuse)'); return; }
  if (!reuse) {
    await Promise.all(sides.map(async (side) => {
      fs.rmSync(capOf(side), { recursive: true, force: true });
      const srv = await startServer(path.join(ROOT, 'harness', 'fixtures', 'mockup-body', side));
      try { await runNode(path.join(SCRIPTS, 'capture.mjs'), [srv.url, capOf(side), '--no-motion-frames']); } finally { await srv.stop(); }
    }));
  }
  const R = loadCapture(capOf('ref')), B = loadCapture(capOf('build'));
  const role = (c, r, vp = '1440') => (c.type.roles[vp] || {})[r] || null;
  for (const vp of ['1440', '768']) {
    const a = role(R, 'body', vp), b = role(B, 'body', vp);
    check(`mockup-body: body ${vp} = the 22px running text on both sides`, a && b && a.px === 22 && b.px === 22, `ref ${a && a.px} (${a && a.ex}), build ${b && b.px} (${b && b.ex})`);
  }
  const hb = role(B, 'body') || {};
  check('mockup-body: build mock-up panels inside a group of same-tag siblings are left out', /mock-up/.test(hb.how || ''), hb.how);
  check('mockup-body: build small print outside <footer> is left out', /small print/.test(hb.how || ''), hb.how);
  const la = (role(R, 'body') || {}).lead, lb = hb.lead;
  check('mockup-body: hero lead recorded as body.lead (26px) on both sides', la && lb && la.px === 26 && lb.px === 26, `ref ${la && la.px}, build ${lb && lb.px}`);
  const tiers = (c) => ['display', 'h1', 'h2', 'h3'].map((k) => (role(c, k) ? role(c, k).px : '-')).join('/');
  check('mockup-body: same heading tiers (statements set as <h2> are not a tier)', tiers(R) === tiers(B), `${tiers(R)} vs ${tiers(B)}`);
  // logo / brand marks: never an accent or minor colour
  const LOGO = { ref: ['#e5484d', '#8e4ec6', '#30a46c', '#0091ff', '#ff8b3e', '#46a758', '#12a594', '#ffc53d', '#3e63dd'], build: ['#f76b15', '#0d74ce', '#2a7e3b', '#ab4aba', '#e54666', '#0090ff', '#29a383', '#ffb224', '#6e56cf', '#ef5f00'] };
  for (const [side, cap] of [['ref', R], ['build', B]]) {
    const used = [...(cap.colors.minor || []).map((m) => m.hex), cap.colors.roles.accent, cap.colors.roles.accent2].filter(Boolean);
    const hit = used.filter((h) => LOGO[side].some((l) => dLab(h, l) < 0.04));
    check(`mockup-body: ${side} logo and logo-strip colours are not accent or minor colours`, hit.length === 0, `accent ${cap.colors.roles.accent}, accent2 ${cap.colors.roles.accent2}, minor ${(cap.colors.minor || []).map((m) => m.hex).join(' ') || '-'}${hit.length ? `; logo colours used: ${hit.join(' ')}` : ''}`);
    check(`mockup-body: ${side} accent = the button colour #4f46e5`, cap.colors.roles.accent && dLab(cap.colors.roles.accent, '#4f46e5') < 0.03, cap.colors.roles.accent);
  }
  const d = compareCaptures(R, B, { refDir: capOf('ref'), buildDir: capOf('build') });
  fs.writeFileSync(path.join(base, 'diff.json'), JSON.stringify(d, null, 1));
  console.log(`----  mockup-body: total ${d.total} | ${areaLine(d)}`);
  const tf = d.areas.type.findings[0];
  check('mockup-body: type area unaffected by the markup and landmark differences (>= 9.8)', d.areas.type.score >= 9.8, `type ${d.areas.type.score}${tf ? `; top: ${tf.what}` : ''}`);
  check('mockup-body: no body or scale finding', !d.areas.type.findings.some((f) => /^body (size|visual)|\/body size ratio/.test(f.what)), d.areas.type.findings.slice(0, 3).map((f) => f.what).join('; '));
  check('mockup-body: colour area unaffected by the different logos (>= 9.8)', d.areas.color.score >= 9.8, `colour ${d.areas.color.score}${d.areas.color.findings[0] ? `; top: ${d.areas.color.findings[0].what}` : ''}`);
}

// font health (part of --only syn): synthetic build font records -> capture's webFontsOf -> compare health.
// A non-catalogue web font (a made-up family self-hosted by @font-face, and a proprietary brand family that
// fonts.googleapis.com css2 still serves: r7 mailchimp's "Means") is a health failure listed first; a
// catalogue family (Inter) and a local()-only fallback face are not; area scores never change. Fetches the
// catalogue (no cache); offline, the unlisted families must come out as warnings instead (printed).
async function fontHealthSyn() {
  const refDir = path.join(ROOT, 'runs', 'dev', 'known', 'ref');
  if (!fs.existsSync(path.join(refDir, 'capture.json'))) { check('known reference capture exists', false, 'run node harness/check-capture.mjs first'); return; }
  const { loadCatalogue, webFontsOf } = await import('../skill/restyle/scripts/lib/font-catalogue.mjs');
  const K = loadCapture(refDir);
  const cat = await loadCatalogue(null);
  const ok = { googleUrls: ['https://fonts.googleapis.com/css2?family=Inter:wght@400..700&display=swap'], faceRules: [{ family: 'Inter Fallback', src: 'local("Arial")' }], base: 'http://localhost:8080/' };
  const bad = { ...ok, googleUrls: [...ok.googleUrls, 'https://fonts.googleapis.com/css2?family=Means:wght@400;700&display=swap'], faceRules: [...ok.faceRules, { family: 'Brandface Grotesk', src: 'url("/fonts/brandface.woff2") format("woff2")' }] };
  const bOk = JSON.parse(JSON.stringify(K)); bOk.type.webFonts = webFontsOf(ok, cat);
  const bBad = JSON.parse(JSON.stringify(K)); bBad.type.webFonts = webFontsOf(bad, cat);
  const dOk = compareCaptures(K, bOk), dBad = compareCaptures(K, bBad);
  const fails = (d) => (d.health || []).filter((h) => h.severity === 'fail').map((h) => h.what);
  check('syn FH1: Inter (google css2) + local() fallback face -> no health entry', (dOk.health || []).length === 0 && bOk.type.webFonts.families.length === 1, `health ${JSON.stringify(dOk.health)}; webFonts ${bOk.type.webFonts.families.map((f) => f.family)}`);
  const want = ['build loads a non-catalogue web font: Means', 'build loads a non-catalogue web font: Brandface Grotesk'];
  if (cat.full) {
    check('syn FH2: non-catalogue web fonts (css2-served brand family, self-hosted made-up family) -> health fail each', want.every((w) => fails(dBad).includes(w)) && fails(dBad).length === 2, JSON.stringify(fails(dBad)));
    check('syn FH2: ... listed first in findings (area health)', dBad.findings[0]?.area === 'health' && want.includes(dBad.findings[0]?.what), `[${dBad.findings[0]?.area}] ${dBad.findings[0]?.what}`);
  } else {
    console.log(`NOTE  catalogue offline (${cat.source}): FH2 checks the warning path`);
    check('syn FH2 (offline): unlisted web fonts -> health warn, never fail', fails(dBad).length === 0 && (dBad.health || []).filter((h) => h.severity === 'warn').length === 2, JSON.stringify(dBad.health));
  }
  check('syn FH3: health never changes the scores', dBad.total === dOk.total && Object.keys(dOk.areas).every((k) => dOk.areas[k].score === dBad.areas[k].score), `total ${dOk.total} vs ${dBad.total}`);
}

async function main() {
  if (!only || only === 'self') selfChecks();
  if (!only || only === 'syn') { synthetic(); await fontHealthSyn(); }
  if (!only || only === 'sens') await sensitivity();
  if (!only || only === 'fix') await mockupBody();
  const failed = results.filter((r) => !r.ok);
  console.log(JSON.stringify({ checks: results.length, passed: results.length - failed.length, failed: failed.map((f) => f.name) }));
  process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error(`check-compare: ${e.stack || e.message}`); process.exit(1); });
