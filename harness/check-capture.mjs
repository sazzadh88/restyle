#!/usr/bin/env node
// Asserts that capture.mjs reports the known values of harness/fixtures/known/index.html.
//   node harness/check-capture.mjs                 serve the fixture, capture it into runs/dev/known/ref, check
//   node harness/check-capture.mjs <captureDir>    check an existing capture of the fixture
//   ... [--late <lateCaptureDir>]                  also check a capture of harness/fixtures/late-load (load
//                                                  sequence settling ~3.3 s after first paint); the no-argument
//                                                  mode captures that fixture too (runs/dev/known/late)
//   ... [--scroll <scrollCaptureDir>]              also check a capture of harness/fixtures/scroll-content (full
//                                                  shots as seen in view, overlapped wrapper segmented, in-flow region
//                                                  bar removed); the no-argument mode captures it (runs/dev/known/scroll)
//   ... [--clip <clipCaptureDir>]                  also check a capture of harness/fixtures/clip-edge at 768 (footer grid
//                                                  cut by an overflow-x:hidden body is reported in overflowX[768].clipped;
//                                                  designed peeking carousels, an off-canvas menu and sr-only text are not);
//                                                  the no-argument mode captures it (runs/dev/known/clip)
//   ... [--colours <colourCaptureDir>]             also check a capture of harness/fixtures/colour-roles (pageBg from band
//                                                  area, running-text roles, monochrome accent = button fill, no hidden /
//                                                  media / mock-up accent); alone it runs only these checks; the
//                                                  no-argument mode captures it (runs/dev/known/colours, 1440)
//   ... [--app <appCaptureDir>]                    also check a capture of harness/fixtures/app-shell (inner scroller
//                                                  unrolled, >= 6 bands at 1440 and 390, in-band <footer> not role footer,
//                                                  last band footer, full shot painted below the first screen, keycaps and
//                                                  text logos never a heading tier); alone it runs only these checks; the
//                                                  no-argument mode captures it (runs/dev/known/app, 1440 and 390)
//   ... [--retry <retryDir>]                       also check the viewport retry on harness/fixtures/vp-retry (390 throws
//                                                  once: retried and present; with ?always: exit non-zero, done.json error);
//                                                  captures <retryDir> when it has no capture.json and always runs the
//                                                  failing capture into <retryDir>-fail; alone it runs only these checks;
//                                                  the no-argument mode uses runs/dev/known/retry
// Prints one line per assertion, then one JSON summary line; exits 1 if any assertion fails.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { differenceEuclidean } from 'culori';
import { readPng, inkShare } from '../skill/restyle/scripts/lib/images.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDir = path.join(root, 'harness', 'fixtures', 'known');
const expected = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'expected.json'), 'utf8'));
const dist = differenceEuclidean('oklab');

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${path.basename(args[0])} exited ${code}: ${err.trim().slice(0, 400)}`))));
  });
}

async function captureFixture(fixture = fixtureDir, outDir = path.join(root, 'runs', 'dev', 'known', 'ref'), extra = [], query = '') {
  // no port: serve.mjs picks a free one and prints it (a fixed port could be busy, and serve.mjs then exits)
  const server = spawn(process.execPath, [path.join(root, 'skill/restyle/scripts/serve.mjs'), fixture], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  const url = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('serve.mjs did not start')), 10000);
    server.stdout.on('data', (d) => { const m = String(d).match(/"url":"([^"]+)"/); if (m) { clearTimeout(t); resolve(m[1]); } });
    server.on('exit', (c) => reject(new Error(`serve.mjs exited ${c}`)));
  });
  try { await run(process.execPath, [path.join(root, 'skill/restyle/scripts/capture.mjs'), url + query, outDir, ...extra]); }
  finally { server.kill(); }
  return outDir;
}

const results = [];
const check = (name, ok, got, want) => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  got=${JSON.stringify(got)}  want=${JSON.stringify(want)}`); };
const near = (a, b, tol) => typeof a === 'number' && Math.abs(a - b) <= tol;
const nearPct = (a, b, pct) => typeof a === 'number' && Math.abs(a - b) <= b * pct / 100;
const colorNear = (a, b, d) => !!a && dist(a, b) <= d;

async function main() {
  const argv = process.argv.slice(2);
  const li = argv.indexOf('--late');
  const lateArg = li >= 0 ? argv.splice(li, 2)[1] : null;
  const sci = argv.indexOf("--scroll");
  const scrollArg = sci >= 0 ? argv.splice(sci, 2)[1] : null;
  const coi = argv.indexOf('--colours');
  const colArg = coi >= 0 ? argv.splice(coi, 2)[1] : null;
  const cli = argv.indexOf('--clip');
  const clipArg = cli >= 0 ? argv.splice(cli, 2)[1] : null;
  const api = argv.indexOf('--app');
  const appArg = api >= 0 ? argv.splice(api, 2)[1] : null;
  const rti = argv.indexOf('--retry');
  const retryArg = rti >= 0 ? argv.splice(rti, 2)[1] : null;
  // --retry <dir> alone: only the viewport retry / exit-code checks (captures harness/fixtures/vp-retry when needed)
  if (retryArg && !argv[0] && !lateArg && !scrollArg && !clipArg && !colArg && !appArg) { await retryChecks(path.resolve(retryArg)); return finish({ retryDir: path.resolve(retryArg) }); }
  // --app <dir> alone: only the app-shell checks on that capture of harness/fixtures/app-shell
  if (appArg && !argv[0] && !lateArg && !scrollArg && !clipArg && !colArg) { appChecks(path.resolve(appArg)); return finish({ appDir: path.resolve(appArg) }); }
  // --colours <dir> alone: only the colour-role checks on that capture of harness/fixtures/colour-roles
  if (colArg && !argv[0] && !lateArg && !scrollArg && !clipArg) { colourChecks(path.resolve(colArg)); if (appArg) appChecks(path.resolve(appArg)); return finish({ colourDir: path.resolve(colArg), appDir: appArg ? path.resolve(appArg) : undefined }); }
  const dir = argv[0] ? path.resolve(argv[0]) : await captureFixture();
  const lateDir = lateArg ? path.resolve(lateArg) : !argv[0] ? await captureFixture(path.join(root, 'harness', 'fixtures', 'late-load'), path.join(root, 'runs', 'dev', 'known', 'late'), ['--viewports', '1440']) : null;
  const scrollDir = scrollArg ? path.resolve(scrollArg) : !argv[0] ? await captureFixture(path.join(root, 'harness', 'fixtures', 'scroll-content'), path.join(root, 'runs', 'dev', 'known', 'scroll'), ['--viewports', '1440,390', '--no-motion-frames']) : null;
  const clipDir = clipArg ? path.resolve(clipArg) : !argv[0] ? await captureFixture(path.join(root, 'harness', 'fixtures', 'clip-edge'), path.join(root, 'runs', 'dev', 'known', 'clip'), ['--viewports', '768', '--no-motion-frames']) : null;
  const c = JSON.parse(fs.readFileSync(path.join(dir, 'capture.json'), 'utf8'));
  const E = expected;

  // sections
  const roles = c.sections.map((s) => s.role);
  check('sections roles/order', JSON.stringify(roles) === JSON.stringify(E.sections.roles), roles, E.sections.roles);
  for (const [role, want] of Object.entries(E.bands)) {
    const s = c.sections.find((x) => x.role === role);
    const bg = s && (s.bg.sampled || s.bg.color);
    check(`band ${role} background`, s && colorNear(bg, want.bg, E.bgMaxDistance) && colorNear(s.bg.color, want.bg, E.bgMaxDistance), s && { css: s.bg.color, sampled: s.bg.sampled }, want.bg);
    check(`band ${role} padding`, s && s.pad && near(s.pad[0], want.pad[0], E.padTolPx) && near(s.pad[1], want.pad[1], E.padTolPx), s && s.pad, want.pad);
  }
  const feat = c.sections.find((s) => s.role === 'features' && s.bg && colorNear(s.bg.color, E.bands.features.bg, 0.02));
  for (const [vp, cols] of Object.entries(E.cardCols)) {
    const got = vp === '1440' ? feat && feat.cards && feat.cards.cols : feat && feat.collapse && feat.collapse[vp] && feat.collapse[vp].cardCols;
    check(`card grid columns @${vp}`, got === cols, got, cols);
  }
  // type
  for (const [vp, rolesWant] of Object.entries(E.type)) {
    for (const [role, want] of Object.entries(rolesWant)) {
      const got = c.type.roles[vp] && c.type.roles[vp][role];
      const ok = got && Object.entries(want).every(([k, v]) => (typeof v === 'number' ? near(got[k], v, k === 'px' ? 0.5 : 0) : got[k] === v));
      check(`type ${role} @${vp}`, ok, got && Object.fromEntries(Object.keys(want).map((k) => [k, got[k]])), want);
    }
  }
  // hover
  const h = (c.hover || []).find((x) => x && x.kind === E.hover.kind);
  const hd = h && h.self && h.self[E.hover.prop];
  check('hover delta (primary button background)', hd && colorNear(hd[0], E.hover.from, 0.02) && colorNear(hd[1], E.hover.to, 0.02), hd, [E.hover.from, E.hover.to]);
  const hm = h && h.transition && Number((h.transition.match(/(\d+)ms/) || [])[1]);
  check('hover transition duration', nearPct(hm, E.hover.transitionMs, 20), hm, E.hover.transitionMs);
  // reveals
  const rs = c.motion.reveals && c.motion.reveals.summary;
  const g = c.motion.reveals && c.motion.reveals.groups && c.motion.reveals.groups[0];
  check('reveal detected', !!rs && rs.groups >= 1, rs && rs.groups, '>=1');
  check('reveal from-state y', rs && near(rs.from.y, E.reveal.y, 2), rs && rs.from.y, E.reveal.y);
  check('reveal from-state opacity', rs && near(rs.from.opacity, E.reveal.opacity, 0.05), rs && rs.from.opacity, E.reveal.opacity);
  check('reveal duration', rs && nearPct(rs.ms, E.reveal.ms, E.reveal.tolPct), rs && rs.ms, E.reveal.ms);
  check('reveal duration from frame sampling alone', g && nearPct(g.sampledMs, E.reveal.ms, E.reveal.tolPct), g && g.sampledMs, E.reveal.ms);
  check('reveal stagger', rs && nearPct(rs.stagger, E.reveal.stagger, E.reveal.tolPct), rs && rs.stagger, E.reveal.stagger);
  check('reveal easing family', rs && rs.family === E.reveal.family && (!g || g.sampledFamily === E.reveal.family), rs && [rs.family, g && g.sampledFamily], E.reveal.family);
  // marquee / parallax / sticky
  const mq = (c.motion.marquees || [])[0];
  check('marquee speed', mq && nearPct(mq.pxPerSec, E.marquee.pxPerSec, E.marquee.tolPct) && mq.dir === E.marquee.dir, mq && [mq.pxPerSec, mq.dir], [E.marquee.pxPerSec, E.marquee.dir]);
  const px = (c.motion.parallax || [])[0];
  check('parallax rate', px && near(px.rate, E.parallax.rate, E.parallax.tol) && c.motion.parallax.length === 1, c.motion.parallax && c.motion.parallax.map((p) => p.rate), E.parallax.rate);
  const st = (c.motion.sticky || []).find((s) => s.kind === E.sticky.kind);
  check('sticky nav', st && near(st.h, E.sticky.h, 1), st && [st.kind, st.h], [E.sticky.kind, E.sticky.h]);
  check('nav height/position', c.spacing.nav && near(c.spacing.nav.h, E.nav.h, 1) && c.spacing.nav.pos === E.nav.pos, c.spacing.nav && [c.spacing.nav.h, c.spacing.nav.pos], [E.nav.h, E.nav.pos]);
  check('smooth scroll not detected', c.motion.smoothScroll && c.motion.smoothScroll.detected === E.smoothScroll, c.motion.smoothScroll && c.motion.smoothScroll.detected, E.smoothScroll);
  // spacing
  check('container max-width', c.spacing.container['1440'] && c.spacing.container['1440'].maxWidthCss === E.container.maxWidthCss, c.spacing.container['1440'] && c.spacing.container['1440'].maxWidthCss, E.container.maxWidthCss);
  for (const [vp, gw] of Object.entries(E.container.gutter)) {
    const got = c.spacing.container[vp] && c.spacing.container[vp].gutter;
    check(`gutter @${vp}`, near(got, gw, E.container.tolPx), got, gw);
  }
  check('radius button', c.spacing.radius.button === E.radius.button, c.spacing.radius.button, E.radius.button);
  check('radius card', c.spacing.radius.card === E.radius.card, c.spacing.radius.card, E.radius.card);
  // colours
  check('theme', c.colors.theme === E.colors.theme, c.colors.theme, E.colors.theme);
  for (const k of ['pageBg', 'accent', 'text']) check(`color role ${k}`, colorNear(c.colors.roles[k], E.colors[k], E.colors.maxDistance), c.colors.roles[k], E.colors[k]);
  // polish
  const ov = Object.values(c.meta.overflowX).some((o) => o && o.overflow);
  check('no horizontal overflow', ov === E.overflowX, ov, E.overflowX);
  const ce = Object.values(c.meta.consoleErrors).reduce((s, v) => s + v, 0);
  check('no console errors', ce === E.consoleErrors, ce, E.consoleErrors);
  check('motion frames written', c.motion.frames && c.motion.frames.load && c.motion.frames.load.n === 61 && c.motion.frames.reveals.length >= 1, c.motion.frames && [c.motion.frames.load && c.motion.frames.load.n, c.motion.frames.reveals.length], '[61, >=1]');
  check('schema restyle-capture/2', c.schema === 'restyle-capture/2', c.schema, 'restyle-capture/2');

  // load staging: hero headline -> lead -> actions, from opacity 0 / translateY(16px), ~1000 ms in total
  const ls = c.motion.load && c.motion.load.summary;
  const stg = ls && ls.staging;
  check('load sequence detected', ls && ls.groups >= E.load.minGroups, ls && ls.groups, `>=${E.load.minGroups}`);
  check('load order (headline > text > cta)', stg && E.load.orderPrefix.every((k, i) => (stg.order[i] || '').split('+').includes(k)), stg && stg.order, E.load.orderPrefix);
  check('load from-state', ls && typeof ls.from === 'object' && near(ls.from.opacity, E.load.from.opacity, 0.05) && near(ls.from.y, E.load.from.y, 3), ls && ls.from, E.load.from);
  check('load total duration', stg && nearPct(stg.totalMs, E.load.totalMs, E.load.tolPct), stg && stg.totalMs, E.load.totalMs);
  check('load first paint and delay recorded', stg && typeof stg.firstContentMs === 'number' && typeof stg.delayMs === 'number', stg && [stg.firstContentMs, stg.delayMs], 'numbers');
  // an infinite CSS marquee is ambient motion, never a load group
  const lg = (c.motion.load && c.motion.load.groups) || [];
  check('infinite marquee not in load', !lg.some((g) => (g.el || '').includes(E.marqueeNotLoad.el)) && (!ls || ls.lastEndMs < E.marqueeNotLoad.maxLastEndMs), lg.map((g) => g.el), `no ${E.marqueeNotLoad.el}`);
  check('marquee in ambient inventory', c.motion.ambient && (c.motion.ambient.kinds || {}).marquee >= 1, c.motion.ambient && c.motion.ambient.kinds, 'marquee >= 1');
  // third-party chrome: ad slot band, cookie banner, captcha badge excluded everywhere
  const ad = c.sections[0];
  check('ad slot band marked third-party', ad && ad.role === E.thirdParty.adRole && ad.thirdParty === true, ad && [ad.role, ad.thirdParty], [E.thirdParty.adRole, true]);
  const palHex = (c.colors.palette || []).map((p) => p.hex).concat(Object.values(c.colors.roles || {}).filter(Boolean));
  const leaked = E.thirdParty.notInPalette.filter((h) => palHex.some((p) => colorNear(p, h, E.thirdParty.maxDistance)));
  check('third-party colours not in palette/roles', leaked.length === 0, leaked, []);
  check('captcha badge not sticky', !(c.motion.sticky || []).some((s) => (s.el || '').includes(E.thirdParty.notSticky)), (c.motion.sticky || []).map((s) => s.el), `no ${E.thirdParty.notSticky}`);
  // rendered weight: eyebrow declared 900 on a 400-only face with font-synthesis: none renders 400
  // (asserted with the type roles above: eyebrow weight 400, declared 900)
  // invisible slide: the 80px heading on an off-screen aria-hidden slide is not the h1/display
  // (asserted above: h1 64, display 64)
  // mobile-only band: its own band at 390 (not padding of the next band), not linked to a primary band
  const mb = (c.sectionsByViewport[E.mobileOnly.vp] || []).find((s) => colorNear(s.bg && s.bg.color, E.mobileOnly.bg, 0.02));
  check('mobile-only band segmented at 390', mb && mb.link === null, mb && { link: mb.link, h: mb.h }, { link: null });
  const lg390 = (c.sectionsByViewport[E.mobileOnly.vp] || []).find((s) => colorNear(s.bg && s.bg.color, E.bands.logos.bg, 0.02));
  check('band after the mobile-only band keeps its padding at 390', lg390 && lg390.pad && near(lg390.pad[0], E.mobileOnly.logosPadTop, E.padTolPx), lg390 && lg390.pad, E.mobileOnly.logosPadTop);
  check('mobile-only band absent at 1440', !c.sections.some((s) => colorNear(s.bg && s.bg.color, E.mobileOnly.bg, 0.02)), c.sections.map((s) => s.bg && s.bg.color), `no ${E.mobileOnly.bg}`);
  check('scrolled shots written', ['1440', '768', '390'].every((vp) => c.shots[vp] && c.shots[vp].scrolled && fs.existsSync(path.join(dir, c.shots[vp].scrolled))), ['1440', '768', '390'].map((vp) => c.shots[vp] && c.shots[vp].scrolled), 'all three');
  check('hover frame pairs written', (c.motion.frames.hover || []).some((h) => h.kind === 'primary-button' && fs.existsSync(path.join(dir, h.dir, 'f-01.png'))), (c.motion.frames.hover || []).map((h) => h.kind), 'primary-button pair');

  // capture/3: heading roles from size clusters (tags recorded, never deciding)
  const sameObj = (a, b) => !!a && Object.keys(b).length === Object.keys(a).length && Object.entries(b).every(([k, v]) => a[k] === v);
  const HC = E.headingClusters, rr = c.type.roles[HC.vp] || {};
  check('h1 role tags histogram', rr.h1 && sameObj(rr.h1.tags, HC.h1Tags), rr.h1 && rr.h1.tags, HC.h1Tags);
  check('h2 size cluster includes the div heading', rr.h2 && sameObj(rr.h2.tags, HC.h2Tags) && rr.h2.n === HC.h2N, rr.h2 && [rr.h2.tags, rr.h2.n], [HC.h2Tags, HC.h2N]);
  // block-level line spans inside one heading element are one heading (the CTA h2 is two display:block spans)
  const LS = E.lineSpans, rls = (c.type.roles[LS.vp] || {})[LS.role];
  check('heading of two block line spans counts as one element', rls && rls.n === HC.h2N && rls.tags && rls.tags.h2 === HC.h2Tags.h2, rls && [rls.n, rls.tags], [HC.h2N, HC.h2Tags]);
  // stat figures (98%, 2.4M, 24/7 in the hero; the counter) are type.stats, never a heading tier or display
  for (const [vp, want] of Object.entries(E.stats)) {
    const s = c.type.stats && c.type.stats[vp], rv = c.type.roles[vp] || {};
    const tierHit = ['display', 'h1', 'h2', 'h3'].filter((k) => rv[k] && s && rv[k].px === s.px);
    check(`stat figures recorded apart @${vp} (type.stats)`, s && s.px === want.px && s.n >= want.minN && (want.weight === undefined || s.weight === want.weight) && (want.sample === undefined || s.sample === want.sample), s && { px: s.px, weight: s.weight, n: s.n, sample: s.sample }, want);
    check(`stat figures define no heading tier @${vp}`, !!s && tierHit.length === 0, tierHit, []);
  }
  // art-led band: absolutely positioned pieces in an in-flow wrapper; top padding to the first piece
  const AL = E.artLed, alb = c.sections.find((s) => s.role === AL.band);
  check('art-led band: top padding measured to its first art piece', alb && alb.pad && near(alb.pad[0], AL.padTop, E.padTolPx) && alb.counts.art >= AL.pieces, alb && [alb.pad, alb.counts.art], [AL.padTop, `art >= ${AL.pieces}`]);
  // a small fixed back-to-top button fading in after scrolling is not a scroll reveal
  const FU = E.fixedUi, rgs = (c.motion.reveals && c.motion.reveals.groups) || [];
  check('fixed back-to-top fade is not a scroll reveal', !rgs.some((x) => (x.el || '').includes(FU.notIn)) && rs && rs.elements === FU.revealElements, rgs.map((x) => [x.el, x.n]), `${FU.revealElements} reveal elements, no ${FU.notIn}`);
  // pseudo-element paints: hero ::after scrim gradient, button filled only by ::before
  const PS = E.pseudo;
  const scrim = (c.colors.gradients || []).find((g) => g.css.includes(PS.scrimStop));
  check('pseudo-element scrim gradient captured', scrim && scrim.where.split(',').includes(PS.scrimWhere), scrim && [scrim.css.slice(0, 70), scrim.where], PS);
  const pfill = (c.colors.palette || []).find((p) => colorNear(p.hex, PS.buttonFill, PS.maxDistance));
  check('pseudo-element button fill in palette', !!pfill && pfill.uses && pfill.uses.bg > 0, pfill, PS.buttonFill);
  // HTML/CSS composite panel counts as media
  const cb = c.sections.find((s) => s.role === E.composite.band);
  check('UI mock-up panel counts as media', cb && cb.counts.composites >= 1 && cb.media.kind === E.composite.kind, cb && [cb.counts.composites, cb.media], E.composite);
  // container: text inset and rails, from full-width bands
  for (const [vp, want] of Object.entries(E.containerEdges)) {
    if (vp === 'tolPx') continue;
    const got = c.spacing.container[vp] || {};
    check(`container text/rail edges @${vp}`, Object.entries(want).every(([k, v]) => near(got[k], v, E.containerEdges.tolPx)) && got.contentLeft === got.railLeft && got.contentRight === got.railRight, Object.fromEntries(Object.keys(want).map((k) => [k, got[k]])), want);
  }
  // ink from DOM probes (same magnitude as before: Arial regular ~0.21, bold ~0.30), on every role and viewport
  const IK = E.ink, ri = c.type.roles[IK.vp] || {};
  check('ink Arial regular / bold', ri[IK.arialRegular.role] && near(ri[IK.arialRegular.role].ink, IK.arialRegular.ink, IK.tol) && ri[IK.arialBold.role] && near(ri[IK.arialBold.role].ink, IK.arialBold.ink, IK.tol), [ri[IK.arialRegular.role] && ri[IK.arialRegular.role].ink, ri[IK.arialBold.role] && ri[IK.arialBold.role].ink], [IK.arialRegular.ink, IK.arialBold.ink]);
  const noInk = Object.entries(c.type.roles).flatMap(([vp, r]) => Object.entries(r || {}).filter(([, v]) => v && !(v.ink > 0 && v.adv > 0)).map(([k]) => `${k}@${vp}`));
  check('ink and adv measured for every role at every viewport', noInk.length === 0, noInk, []);
  // rendered line box per role
  const LB = E.lineBox, rl = c.type.roles[LB.vp] || {};
  check('rendered line box (lhr) per role', Object.entries(LB.lhr).every(([k, v]) => rl[k] && near(rl[k].lhr, v, LB.tol) && near(rl[k].lhPx, v * rl[k].px, 1)), Object.fromEntries(Object.keys(LB.lhr).map((k) => [k, rl[k] && [rl[k].lhr, rl[k].lhPx]])), LB.lhr);
  // type samples: first rendered line, bbox in the 1440 full shot, tight crop written
  const SM = E.samples, smp = (c.type && c.type.samples) || {};
  const badS = SM.roles.filter((k) => { const s = smp[k]; return !s || !s.text || s.text.replace(/\s/g, '').length < SM.minChars || !Array.isArray(s.bbox) || s.bbox.length !== 4 || !(s.px > 0) || !s.color || !s.bg || !s.shot || !fs.existsSync(path.join(dir, s.shot)); });
  check('type samples with crops for the main roles', badS.length === 0, badS, SM.roles);
  check('h1 sample = first rendered line with its colours', smp.h1 && smp.h1.text === SM.h1Text && smp.h1.color === SM.h1Color && smp.h1.bg === SM.h1Bg, smp.h1 && [smp.h1.text, smp.h1.color, smp.h1.bg], [SM.h1Text, SM.h1Color, SM.h1Bg]);

  // load frames start at first contentful paint: a page that paints at once shows its content in frame 0
  const lf = c.motion.frames && c.motion.frames.load, lv = lf && lf.visual;
  const fgMax = lv && lv.fg ? Math.max(...lv.fg) : 0;
  check('load strip starts at first contentful paint', lf && lf.t0 === E.loadFrames.t0, lf && lf.t0, E.loadFrames.t0);
  check('load frame 0 shows content (no blank pre-paint frame)', lv && lv.fg && lv.fg[0] >= E.loadFrames.minFirstFrameFg && lv.fg[0] >= fgMax * E.loadFrames.minFirstFrameShare, lv && lv.fg && [lv.fg[0], fgMax], `>= ${E.loadFrames.minFirstFrameShare} x ${fgMax}`);
  // popups: a region modal (dismissed) and a non-CMP privacy box (hidden) are removed before measuring
  const ovl = c.meta.overlays || [];
  check('region modal dismissed and recorded', ovl.some((x) => x.action === 'dismissed' && /rg-modal/.test(x.el)), ovl.map((x) => `${x.action} ${x.kind} ${x.el}`), `dismissed ${E.overlays.dismissed}`);
  check('privacy box hidden and recorded', ovl.some((x) => x.action === 'hidden' && /pv-box/.test(x.el)), ovl.map((x) => `${x.action} ${x.kind} ${x.el}`), `hidden ${E.overlays.hidden}`);
  const lgAll = ((c.motion.load && c.motion.load.groups) || []).map((g) => g.el || '');
  check('popups not in load motion', !lgAll.some((el) => E.overlays.notInLoad.some((k) => el.includes(k))), lgAll, `none of ${E.overlays.notInLoad}`);
  check('popups not sticky', !(c.motion.sticky || []).some((s) => E.overlays.notSticky.some((k) => (s.el || '').includes(k))), (c.motion.sticky || []).map((s) => s.el), 'no popup');
  const ovLeak = E.overlays.notInPalette.filter((hx) => palHex.some((p) => colorNear(p, hx, E.overlays.maxDistance)) || (c.colors.minor || []).some((m) => colorNear(m.hex, hx, E.overlays.maxDistance)));
  check('popup and blocked-embed colours not in palette/roles/minor', ovLeak.length === 0, ovLeak, []);
  const pb = c.components.primaryButton;
  check('blocked-embed / popup button is not the primary button', pb && !E.overlays.notPrimary.some((hx) => colorNear(pb.bg, hx, 0.03)), pb && pb.bg, `not ${E.overlays.notPrimary}`);
  // load skip rules: a poster fading out and a number rolling in are not load staging; the staged hero still is
  const lsk = (c.motion.load && c.motion.load.skipped) || {};
  check('fade-out poster and digit roll not in load groups', !lgAll.some((el) => E.loadSkip.notInLoad.some((k) => el.includes(k))), lgAll, `none of ${E.loadSkip.notInLoad}`);
  check('skip counts recorded (fade-out, digits)', lsk.fadeOut >= E.loadSkip.fadeOut && lsk.digits >= E.loadSkip.digits, lsk, E.loadSkip);
  check('staged load: meaningful share of the first viewport animates in', ls && ls.staged === true && ls.areaShare >= E.loadSkip.minAreaShare, ls && [ls.staged, ls.areaShare], `staged, >= ${E.loadSkip.minAreaShare}`);
  // hero media that keeps moving: frame differencing inside its box
  const hmed = ((c.motion.load && c.motion.load.media) || []).find((m) => m.kind === E.heroMedia.kind);
  check('moving hero canvas measured', hmed && hmed.moving && E.heroMedia.activity.includes(hmed.activity), hmed && [hmed.kind, hmed.activity, hmed.when, hmed.diff], E.heroMedia);
  check('moving hero canvas in ambient inventory', (c.motion.ambient.items || []).some((x) => x.kind === 'media' && x.media === E.heroMedia.kind), (c.motion.ambient.items || []).map((x) => x.kind), 'media item');
  // round 5: activity read from rate (share of the box changing per second), the most-moving region, and the
  // settle note's media part; hover crops measured; done.json written last
  const lvlOf = (rt) => (rt < 0.004 ? 'static' : rt < 0.04 ? 'low' : rt < 0.4 ? 'medium' : 'high');
  check('hero canvas rate measured and activity read from it', hmed && typeof hmed.rate === 'number' && hmed.rate > 0 && hmed.activity === lvlOf(hmed.rate) && Array.isArray(hmed.hot) && hmed.hot.length === 4, hmed && [hmed.rate, hmed.rateLoad, hmed.rateCont, hmed.activity, hmed.hot], 'rate > 0, activity = level(rate), hot box');
  const km = lf && lf.keepsMoving;
  check('load strip says the moving media keeps moving after the content settled', km && (km.media || []).some((m) => m.kind === E.heroMedia.kind && typeof m.rate === 'number'), km, `keepsMoving.media includes the ${E.heroMedia.kind}`);
  const hvp = (c.motion.frames.hover || []).find((x) => x.kind === 'primary-button');
  check('hover pair crop difference measured (button fill change visible)', hvp && hvp.visual && hvp.visual.changed >= 0.005 && (c.hover || []).some((x) => x && x.pair === hvp.dir), hvp && hvp.visual, 'changed >= 0.005, paired hover entry');
  const dj = fs.existsSync(path.join(dir, 'done.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'done.json'), 'utf8')) : null;
  check('done.json written with the summary line', dj && dj.ok === true && dj.sections === c.sections.length, dj && { ok: dj.ok, sections: dj.sections }, { ok: true, sections: c.sections.length });
  const sj = fs.existsSync(path.join(dir, 'started.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'started.json'), 'utf8')) : null;
  check('done.json belongs to the latest start (startedAt = started.json)', dj && sj && dj.startedAt && dj.startedAt === sj.startedAt, dj && sj && [dj.startedAt, sj.startedAt], 'same startedAt');
  check('no scroll tint on a page without one (rests vs full shot)', c.motion.scrollTint && c.motion.scrollTint.changes === 0 && c.motion.scrollTint.rests >= 3, c.motion.scrollTint && [c.motion.scrollTint.changes, c.motion.scrollTint.rests], '0 changes over >= 3 rests');
  const smLines = fs.existsSync(path.join(dir, 'summary.md')) ? fs.readFileSync(path.join(dir, 'summary.md'), 'utf8').split(/\r?\n/).length : null;
  check('summary.md written (<= 250 lines)', smLines !== null && smLines <= 250, smLines, '<= 250');

  // type-sample choice and quality: a one-colour line is preferred over the two-colour first card heading;
  // the skip link parked above the page is never a type sample, the button sample or the primary button
  const SC = E.sampleChoice;
  if (SC) {
    check('h3 sample skips the two-colour card heading', smp.h3 && smp.h3.text === SC.h3Text, smp.h3 && smp.h3.text, SC.h3Text);
    const badQ = SC.goodRoles.filter((k) => !(smp[k] && smp[k].sampleQuality && smp[k].sampleQuality.level === 'good' && smp[k].sampleQuality.reason));
    check('sampleQuality good on the plain one-colour samples', badQ.length === 0, Object.fromEntries(SC.goodRoles.map((k) => [k, smp[k] && smp[k].sampleQuality])), 'good on every listed role');
    check('skip link is never a type sample', !Object.values(smp).some((s) => s && (s.text || '').toLowerCase().includes(SC.skipText.toLowerCase())), Object.fromEntries(Object.entries(smp).map(([k, s]) => [k, s && s.text])), `no "${SC.skipText}"`);
    check('button sample is a visible button label', smp.button && smp.button.text === SC.buttonText && smp.button.bbox[1] >= 0, smp.button && [smp.button.text, smp.button.bbox], SC.buttonText);
    check('skip link is not the primary button or link component', pb && !(pb.desc || '').includes(SC.skipClass) && !((c.components.link || {}).desc || '').includes(SC.skipClass), pb && [pb.desc, c.components.link && c.components.link.desc], `not .${SC.skipClass}`);
  }

  // evidence for the judge: load strip until settled, reveal strips from the wheel input, media sample frames
  const frameFiles = (rel) => (rel && fs.existsSync(path.join(dir, rel)) ? fs.readdirSync(path.join(dir, rel)).filter((f) => /^f-\d+\.jpg$/.test(f)).length : 0);
  check('load strip covers 5 s from first paint (61 frames on disk)', lf && lf.windowMs === 5000 && lf.n === 61 && frameFiles(lf.dir) === 61, lf && [lf.windowMs, lf.n, frameFiles(lf.dir)], [5000, 61, 61]);
  const domEnd = ls && typeof c.motion.load.fcpMs === 'number' ? ls.lastEndMs - c.motion.load.fcpMs : null;
  check('load settle time recorded near the known load end', lf && lf.settled === true && near(lf.settleMs, domEnd, 250) && lf.settleMs >= E.load.totalMs * 0.75 && lf.settleMs <= E.load.totalMs + 700, lf && [lf.settleMs, lf.settleHow, domEnd], `~${domEnd} (load end after first paint), >= ${E.load.totalMs * 0.75}`);
  const si = lf && lv && lv.fg ? Math.min(lv.fg.length - 1, Math.ceil((lf.settleMs || 0) * 12 / 1000)) : -1;
  check('frames from the settle time on show the settled first screen', si >= 0 && lv.fg.slice(si).every((v) => near(v, lv.fg[lv.fg.length - 1], 0.01)), si >= 0 && [lv.fg[si], lv.fg[lv.fg.length - 1]], 'equal');
  check('no lead-in skipped on a page that paints at once', lf && (!lf.leadIn || lf.leadIn.skippedMs === 0), lf && lf.leadIn, 'none');
  const rv0 = (c.motion.frames.reveals || [])[0];
  check('reveal strip starts at the wheel input with the measured scroll', rv0 && rv0.t0 === 'wheel' && rv0.scroll && near(rv0.scroll.px, rv0.scrollTo - rv0.scrollFrom, 2) && typeof rv0.scroll.settleMs === 'number' && rv0.scroll.settleMs < 1500, rv0 && [rv0.t0, rv0.scroll], 'wheel, px = step, settleMs < 1500');
  const mf = c.motion.frames.media;
  check('first-screen media sample frames written (moving hero canvas)', mf && mf.n >= 10 && frameFiles(mf.dir) === mf.n, mf && [mf.n, frameFiles(mf.dir)], '>= 10 frames');

  // late load (harness/fixtures/late-load): the strip holds a load that settles ~3.3 s after first paint, and a
  // large panel that is missing at first paint is a designed entrance (load animations), never a skipped lead-in
  if (lateDir) {
    const LE = JSON.parse(fs.readFileSync(path.join(root, 'harness', 'fixtures', 'late-load', 'expected.json'), 'utf8'));
    const lc = JSON.parse(fs.readFileSync(path.join(lateDir, 'capture.json'), 'utf8'));
    const lL = lc.motion.frames && lc.motion.frames.load, lV = lL && lL.visual;
    const lfiles = lL && fs.existsSync(path.join(lateDir, lL.dir)) ? fs.readdirSync(path.join(lateDir, lL.dir)).filter((f) => /^f-\d+\.jpg$/.test(f)).length : 0;
    check('late load: strip covers 5 s (61 frames)', lL && lL.windowMs === LE.windowMs && lfiles === LE.frames, lL && [lL.windowMs, lfiles], [LE.windowMs, LE.frames]);
    check('late load: settle time ~3.3 s after first paint', lL && lL.settled === true && near(lL.settleMs, LE.settleMs, LE.settleTolMs), lL && [lL.settleMs, lL.settleHow], `${LE.settleMs} +- ${LE.settleTolMs}`);
    const lsum = lc.motion.load && lc.motion.load.summary;
    check('late load: the DOM sampler sees the load groups', lsum && lsum.groups >= LE.minLoadGroups, lsum && lsum.groups, `>= ${LE.minLoadGroups}`);
    const fin = lV && lV.fg ? lV.fg[lV.fg.length - 1] : 0, at = lV && lV.fg ? lV.fg[Math.round(LE.hiddenAtMs * 12 / 1000)] : null;
    // fg = share of the frame that differs from the settled page's main colour: at 1.5 s the first screen is
    // still far from its settled look (the old fixed 1.5 s strip ended there)
    check('late load: the first screen at 1.5 s is still far from its settled look', lV && at !== null && Math.abs(at - fin) >= LE.hiddenMinFgDiff, lV && [at, fin], `|fg(1.5 s) - fg(end)| >= ${LE.hiddenMinFgDiff}`);
    check('late load: designed entrance is not skipped as a lead-in', lL && (!lL.leadIn || lL.leadIn.skippedMs === 0), lL && lL.leadIn, 'skippedMs 0');
  } else console.log('SKIP  late-load checks (pass --late <captureDir of harness/fixtures/late-load>)');

  // scroll content (harness/fixtures/scroll-content): full-page shots show every band as it looks in view
  // (content-visibility, scroll-driven reveals, art mounted only in view), the overlapping wrapper is segmented,
  // and an in-flow region bar that pushes the page down after load is removed before measuring
  if (scrollDir) {
    const sc = JSON.parse(fs.readFileSync(path.join(scrollDir, 'capture.json'), 'utf8'));
    const sh = sc.shots['1440'] || {}, bl = sh.blank || {}, rd = sh.render || {};
    const ov = (sc.meta.overlays || []).find((o) => /region/i.test(o.why || ''));
    check('scroll: region bar removed before measuring (meta.overlays)', !!ov && /region-bar/.test(ov.sel || ov.el || ''), ov && [ov.kind, ov.action, ov.sel], 'banner #region-bar');
    const hero = sc.sections.find((s) => s.role === 'hero') || sc.sections[1];
    check('scroll: page not pushed down by the region bar (hero starts under the 64 px header)', hero && near(hero.y, 64, 4), hero && hero.y, 64);
    check('scroll: content-visibility bands forced visible', rd.contentVisibility >= 3, rd, 'contentVisibility >= 3 (two bands + footer)');
    check('scroll: scroll-driven reveals paused in their in-view state', rd.frozen >= 3, rd, 'frozen >= 3');
    check('scroll: no text left blank in the 1440 full shot', typeof bl.after === 'number' && bl.after <= 0.05, bl && [bl.before, bl.after], '<= 0.05');
    const png = readPng(path.join(scrollDir, sh.full));
    const inkAt = (s, frac = 0.5) => (s ? inkShare(png, { x: 0, y: s.y + 60, w: png.width, h: Math.max(40, s.h - 120) }, 3) : null);
    const bands = sc.sections.filter((s) => s.role !== 'nav');
    // bands of the wrapper: the four stacked bands must be separate (segmentation descends into the wrapper)
    const wrapBands = bands.filter((s) => s.y >= 900 && s.role !== 'footer');
    check('scroll: the four bands inside the overlapped wrapper are segmented', wrapBands.length >= 4, sc.sections.map((s) => `${s.role}:${s.y}+${s.h}`), '>= 4 bands below the hero');
    const lowInk = wrapBands.concat(bands.filter((s) => s.role === 'footer')).filter((s) => !(inkAt(s) > 0.01)).map((s) => `${s.role}@${s.y}`);
    check('scroll: every band below the fold is painted in the full shot (ink > 1%)', lowInk.length === 0, lowInk, 'none blank');
    const pb = sc.sections.find((s) => s.shot && s.shot.inView >= 0.2);
    check('scroll: art mounted only in view is filled from in-view shots', bl.inView && bl.inView.pastedPx >= 200 && !!pb, bl.inView && [bl.inView.pastedPx, pb && pb.y], 'pastedPx >= 200 and a band with shot.inView');
    check('scroll: the scroll-0 state is kept for scroll tints (full-rest shot)', !!sh.fullRest && fs.existsSync(path.join(scrollDir, sh.fullRest)), sh.fullRest, 'shots/1440-full-rest.png');
    const tn = sc.motion.scrollTint;
    check('scroll: art mounted only in view is not read as a scroll tint', tn && tn.changes === 0 && !sc.sections.some((s) => s.bg && s.bg.scrollTheme), tn && [tn.changes, (tn.colors || []).map((x) => x.color)], '0 changes, no band scroll theme');
    const s390 = (sc.shots['390'] || {}).blank || {};
    check('scroll: no text left blank in the 390 full shot', typeof s390.after === 'number' && s390.after <= 0.05, [s390.before, s390.after], '<= 0.05');
    const sm = fs.readFileSync(path.join(scrollDir, 'summary.md'), 'utf8');
    check('scroll: digest states how the full shots were rendered', /full shots as seen in view/.test(sm) && !/WARNING full shot still BLANK/.test(sm), (sm.match(/- full shots as seen in view[^\n]*/) || [''])[0].slice(0, 140), 'line present, no BLANK warning');
  } else console.log('SKIP  scroll-content checks (pass --scroll <captureDir of harness/fixtures/scroll-content>)');

  // clipped content (harness/fixtures/clip-edge at 768): the page cannot scroll sideways (body overflow-x hidden),
  // so the footer grid's 4th column is cut at the right viewport edge: reported in overflowX[768].clipped and the
  // digest; the two peeking carousels (scroll-snap scroller; clipped track with carousel semantics), the
  // off-canvas menu and the sr-only text are designed and never reported
  if (clipDir) {
    const cc = JSON.parse(fs.readFileSync(path.join(clipDir, 'capture.json'), 'utf8'));
    const ox = (cc.meta.overflowX || {})['768'] || {};
    const cl = Array.isArray(ox.clipped) ? ox.clipped : null;
    check('clip: page does not scroll sideways (overflow false)', ox.overflow === false, [ox.overflow, ox.scrollWidth], false);
    check('clip: footer links cut at the right edge are reported', cl && cl.some((x) => /flink|fcol/.test(x.sel) && x.side === 'right' && x.kind === 'text' && x.cut >= 6), cl && cl.map((x) => `${x.sel} ${x.side} ${x.cut}`), 'a .flink/.fcol text item, side right');
    check('clip: designed carousels, off-canvas menu and sr-only text are not reported', cl && !cl.some((x) => /peek|card-text|menu|sr-only/.test(x.sel)), cl && cl.map((x) => x.sel), 'no peek/card/menu/sr-only item');
    const csm = fs.readFileSync(path.join(clipDir, 'summary.md'), 'utf8');
    check('clip: digest names the clipped content', /CLIPPED CONTENT[^\n]*768/.test(csm), (csm.match(/- CLIPPED CONTENT[^\n]*/) || [''])[0].slice(0, 140), 'CLIPPED CONTENT line for 768');
  } else console.log('SKIP  clip-edge checks (pass --clip <captureDir of harness/fixtures/clip-edge>)');

  const colourDir = colArg ? path.resolve(colArg) : !argv[0] ? await captureFixture(path.join(root, 'harness', 'fixtures', 'colour-roles'), path.join(root, 'runs', 'dev', 'known', 'colours'), ['--viewports', '1440', '--no-motion-frames']) : null;
  if (colourDir) colourChecks(colourDir);
  else console.log('SKIP  colour-role checks (pass --colours <captureDir of harness/fixtures/colour-roles>)');
  const appDir = appArg ? path.resolve(appArg) : !argv[0] ? await captureFixture(path.join(root, 'harness', 'fixtures', 'app-shell'), path.join(root, 'runs', 'dev', 'known', 'app'), ['--viewports', '1440,390', '--no-motion-frames']) : null;
  if (appDir) appChecks(appDir);
  else console.log('SKIP  app-shell checks (pass --app <captureDir of harness/fixtures/app-shell>)');
  const retryDir = retryArg ? path.resolve(retryArg) : !argv[0] ? path.join(root, 'runs', 'dev', 'known', 'retry') : null;
  if (retryDir) await retryChecks(retryDir);
  else console.log('SKIP  viewport retry checks (pass --retry <dir>)');
  finish({ captureDir: dir, lateDir: lateDir || undefined, scrollDir: scrollDir || undefined, clipDir: clipDir || undefined, colourDir: colourDir || undefined, appDir: appDir || undefined, retryDir: retryDir || undefined });
}

// viewport retry (harness/fixtures/vp-retry): the 390 view throws on its first load and is retried on a fresh page
// (capture <dir>, 1440 + 390); with ?always it throws every time and the capture exits non-zero with the error
// (capture <dir>-fail). Captures are made when <dir>/capture.json is missing; the failing one always runs.
async function retryChecks(dir) {
  const fx = path.join(root, 'harness', 'fixtures', 'vp-retry');
  const args = ['--viewports', '1440,390', '--no-motion-frames'];
  if (!fs.existsSync(path.join(dir, 'capture.json'))) await captureFixture(fx, dir, args);
  const rc = JSON.parse(fs.readFileSync(path.join(dir, 'capture.json'), 'utf8'));
  const n390 = (rc.sectionsByViewport && rc.sectionsByViewport['390'] || []).length;
  check('retry: a viewport that throws once is retried (390 bands and full shot present)', n390 >= 3 && !!(rc.shots['390'] || {}).full, n390, '>= 3 bands at 390 and a 390 full shot');
  const rn = (rc.notes || []).find((x) => /viewport 390 failed .*retried once/.test(x));
  check('retry: the retry is noted', !!rn, rn && rn.slice(0, 120), 'note "viewport 390 failed (...); retried once on a fresh page"');
  const fdir = `${dir}-fail`;
  let failed = false;
  try { await captureFixture(fx, fdir, args, '?always'); } catch { failed = true; }
  let done = null; try { done = JSON.parse(fs.readFileSync(path.join(fdir, 'done.json'), 'utf8')); } catch { done = null; }
  check('retry: a viewport failing twice fails the capture (exit non-zero, done.json ok:false with the error)', failed && done && done.ok === false && /viewport 390 failed twice/.test(done.error || ''), [failed, done && done.error && done.error.slice(0, 120)], 'exit != 0, "viewport 390 failed twice: ..."');
}

function finish(dirs) {
  const failed = results.filter((r) => !r.ok).map((r) => r.name);
  console.log(JSON.stringify({ ok: failed.length === 0, checks: results.length, failed, ...dirs }));
  process.exit(failed.length ? 1 : 0);
}

// colour roles (harness/fixtures/colour-roles, values in its expected.json): page background from band area
// and the first screens (not the dark footer / dark band), text and mutedText from running text on the page
// background (not white text over the hero photo), accent = the primary button fill of a monochrome page
// (never a chromatic colour from an illustration, a mock-up swatch grid or button, or a hidden / opacity-0 /
// inactive-slide button)
// app shell (harness/fixtures/app-shell): the document is one viewport tall and the content scrolls inside a
// <main> inner scroller; the capture unrolls it, so the six bands are found and measured at 1440 and 390, the
// section with its own <footer> row is not the footer band, the page footer is, the full shot is painted below
// the first screen, and the boxed keycap labels (28 px) and the row of text logos (22 px) never form a heading tier
function appChecks(adir) {
  const ac = JSON.parse(fs.readFileSync(path.join(adir, 'capture.json'), 'utf8'));
  const is = ac.meta.innerScroller || {};
  check('app: inner scroller unrolled at 1440 and 390 (meta.innerScroller)', ['1440', '390'].every((vp) => is[vp] && is[vp].ok && /main/.test(is[vp].el || '')), is, '{1440, 390}: ok, el main');
  for (const vp of ['1440', '390']) {
    const secs = (vp === '1440' ? ac.sections : (ac.sectionsByViewport || {})[vp] || []).filter((s) => s.role !== 'nav' && !s.virtual);
    check(`app: >= 6 bands below the nav at ${vp}`, secs.length >= 6, secs.map((s) => `${s.role}:${s.y}+${s.h}`), '>= 6');
    const last = secs[secs.length - 1];
    check(`app: last band is the footer at ${vp}`, !!last && last.role === 'footer', last && [last.role, last.why || last.el], 'footer');
    if (vp === '1440') {
      const b3 = secs.find((s) => /#b3\b/.test(s.el || ''));
      check('app: band with a section <footer> row is not role footer', !!b3 && b3.role !== 'footer', b3 && [b3.role, b3.why], 'not footer');
      const emptyB = secs.filter((s) => s.empty || !s.counts || !(s.counts.words > 0));
      check('app: every band has measured content (counts.words > 0, not empty)', emptyB.length === 0, emptyB.map((s) => `${s.el}:${JSON.stringify(s.counts)}`), 'none empty');
      const heads = secs.reduce((n, s) => n + ((s.counts && s.counts.headings) || 0), 0);
      check('app: headings counted in the bands', heads >= 5, heads, '>= 5');
    }
    const sh = (ac.shots || {})[vp] || {};
    let ink = null;
    try {
      const png = readPng(path.join(adir, sh.full));
      const vh = vp === '1440' ? 900 : 844;
      ink = png.height > vh * 2 ? inkShare(png, { x: 0, y: vh, w: png.width, h: png.height - vh }, 3) : 0;
    } catch { ink = null; }
    check(`app: full shot at ${vp} is taller than two screens and painted below the first`, typeof ink === 'number' && ink > 0.02 && sh.fullHeight > (vp === '1440' ? 1800 : 1688), [sh.fullHeight, ink], 'fullHeight > 2 vh, ink > 2%');
  }
  const R = (ac.type && ac.type.roles && ac.type.roles['1440']) || {};
  const body = R.body;
  check('app: body role measured at 1440', !!body && body.px === 16, body && body.px, 16);
  const tiers = ['h1', 'h2', 'h3'].map((k) => R[k] ? `${k}:${R[k].px}:${R[k].ex}` : `${k}:-`);
  check('app: heading tiers h1 48 / h2 32 / h3 20 at 1440 (keycaps and text logos never a tier)', R.h1 && R.h1.px === 48 && R.h2 && R.h2.px === 32 && R.h3 && R.h3.px === 20 && !/key|marks/.test(`${R.h2.ex} ${R.h3.ex}`), tiers, 'h1:48 h2:32 h3:20, no .key/.marks example');
  const asm = fs.readFileSync(path.join(adir, 'summary.md'), 'utf8');
  check('app: digest names the app shell', /- APP SHELL[^\n]*unrolled/.test(asm), (asm.match(/- APP SHELL[^\n]*/) || [''])[0].slice(0, 160), 'APP SHELL ... unrolled line');
}

function colourChecks(cdir) {
  const X = JSON.parse(fs.readFileSync(path.join(root, 'harness', 'fixtures', 'colour-roles', 'expected.json'), 'utf8'));
  const cc = JSON.parse(fs.readFileSync(path.join(cdir, 'capture.json'), 'utf8')).colors || {};
  const ro = cc.roles || {};
  check('colours: pageBg = the cream page (not the dark footer or dark band)', colorNear(ro.pageBg, X.pageBg, X.maxDistance), ro.pageBg, X.pageBg);
  check('colours: theme follows the page background', cc.theme === X.theme, cc.theme, X.theme);
  check('colours: text = the dark running text (not white text over the photo)', colorNear(ro.text, X.text, X.maxDistance), ro.text, X.text);
  check('colours: mutedText = the lighter secondary text', colorNear(ro.mutedText, X.mutedText, X.maxDistance), ro.mutedText, X.mutedText);
  check('colours: accent = the primary button fill (monochrome page)', colorNear(ro.accent, X.accent, X.maxDistance), ro.accent, X.accent);
  const bad = ['accent', 'accent2'].filter((k) => ro[k] && X.notAccent.some((h) => colorNear(ro[k], h, X.maxDistance))).map((k) => `${k} ${ro[k]}`);
  check('colours: no hidden, media, mock-up or white-button colour as accent / accent2', bad.length === 0, bad, `none of ${X.notAccent.length} colours`);
  check('colours: no role marked WEAK on this unambiguous page', !cc.weak || !['pageBg', 'text', 'accent'].some((k) => cc.weak[k]), cc.weak || {}, 'no weak pageBg/text/accent');
}

main().catch((e) => { console.error(`check-capture: ${e.message}`); process.exit(1); });
