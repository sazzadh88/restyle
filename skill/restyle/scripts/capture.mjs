#!/usr/bin/env node
/*
 * capture.mjs — the eyes of the restyle skill.
 *
 *   node capture.mjs <url> <outDir> [--viewports 1440,768,390] [--no-motion-frames] [--fast] [--frames-like <refCapDir>] [--timeout 60000]
 *   node capture.mjs --wait <outDir> [--timeout-s 600]   waits for <outDir>/done.json of the latest capture (written last,
 *                                                        also on failure), prints it, exits 0 (ok) or 1; on timeout
 *                                                        exits 3 while that capture still runs (re-run the same --wait)
 *
 * --fast: quick iteration (largest viewport only, no motion frames, no hover); compare.mjs marks the
 * diff partial. The final verify is always a full capture.
 * --frames-like <refCapDir>: record the reveal strips at the reference capture's page positions (band
 * alignment, offset inside the band; page fraction as fallback), same step and timing, whatever this
 * page's own reveals did (build captures, so the judge and the builder see a build row for every strip).
 * Also writes <outDir>/summary.md (capture digest, lib/summary.mjs) and shots/type-<role>.png samples.
 * Popups/banners shown on load (dialogs, backdrops, drawers, consent/region/newsletter bars) are
 * dismissed or hidden before anything is measured (lib/consent.mjs) and listed in meta.overlays.
 * Load strips start at the frame that shows first contentful paint (lib/frames.mjs loadStart).
 *
 * Loads <url> in the installed Chrome (playwright-core, channel 'chrome', never downloads a
 * browser), measures its design language (layout, colour, type, spacing, motion) the same way
 * on any site, and writes:
 *   <outDir>/capture.json                 compact, model-readable measurements (schema below)
 *   <outDir>/shots/<vp>-full.png          full page after the scroll pass, back at top (<=20000px tall,
 *                                         shot in 8000px tiles and stitched: Chrome wraps captures >16384px)
 *   <outDir>/shots/<vp>-fold.png          first viewport
 *   <outDir>/shots/<vp>-scrolled.png      viewport after scrolling 1.5 screens down (header scrolled state)
 *   <outDir>/shots/<vp>-sec-<n>.png       one crop per section (index n = sections order, <=2400px tall)
 *   <outDir>/shots/comp-<name>.png        component crops (1440): nav, primaryButton, secondaryButton, card, input, link, badge
 *   <outDir>/motion/frames/load/f-NN.jpg  61 JPEG frames, 12 fps x 5 s from first contentful paint (settle time and
 *                                         lead-in in motion.frames.load)
 *   <outDir>/motion/frames/reveal-<n>/    19 frames, 12 fps x 1.5 s from the wheel input, while a not-yet-seen band
 *                                         scrolls into view (fresh page, <=4 sequences)
 *   <outDir>/motion/frames/media/         16 frames, 6 fps x 2.5 s of the settled first screen (when it has hero media)
 *   <outDir>/motion/frames/hover-<kind>/  f-00.png / f-01.png before and during hover (primary button, card, nav link)
 * Page-side code lives in lib/page-core.mjs + lib/page-analyze.mjs (installed with addInitScript, so it
 * runs before site scripts); consent handling in lib/consent.mjs; Node-side maths in lib/motion.mjs
 * (easing fits, reveal grouping, sticky/parallax), lib/colors.mjs (palette, roles), lib/images.mjs
 * (pngjs crops, histograms, stitching), lib/frames.mjs (CDP screencast).
 * Prints one JSON summary line on success; exits non-zero on failure. A suspected bot wall is
 * not a failure: it is reported in meta.blocked.
 *
 * Order per run (motion is measured before anything scrolls, because reveals fire once):
 *   primary viewport (largest, normally 1440): screencast -> goto -> load frames -> settle (load,
 *   fonts, network-quiet window with hard caps) -> load-time rAF sampler result -> bot-wall check
 *   -> consent (reject button, else hide overlays) -> snapshot of hidden-ish elements (opacity,
 *   transform, clip-path, filter, visibility) + layout candidates -> idle sample (marquees) ->
 *   wheel-scroll in 0.75vh steps, rAF-sampling each step (reveals: from-state, duration, easing,
 *   stagger; rest rects: sticky / parallax / horizontal; nav state) -> back to top -> shots ->
 *   static analysis -> cursor probe -> real-mouse hover deltas. A page that ignores wheel input
 *   (intro scroll lock, wheel listener off the gutter) is retried from the centre, then scrolled
 *   programmatically (noted).
 *   other viewports (fresh page, same context): settle -> consent -> fast scroll pass (reveal
 *   count, lazy content) -> top -> shots -> analysis reusing the primary band signatures.
 *   reveal frames: fresh primary page, jump just above a band that revealed, wheel it into view.
 *
 * capture.json (full field-by-field reference: skill/restyle/references/capture-schema.md)
 *   schema            "restyle-capture/2"
 *   meta              url, finalUrl, title, time, runMs, status, blocked{suspected,reasons}, userAgent,
 *                     viewports, pageHeight{vp}, libraries[{name,evidence}], consoleErrors{vp},
 *                     consoleSample[], overflowX{vp:{overflow,by,scrollWidth}}, consent{action,detail},
 *                     stylesheets{total,readable,fetched,unreadable[]}, settle{vp}, segmentation{vp}
 *   sections[]        primary-viewport bands in page order: id (stable, from DOM signature), i, role,
 *                     why, el, y, h, yFrac, hFrac, vh, bg{type,color,sampled,sampledShare,gradient,src},
 *                     layout{cols,ratios,gap,overflow?}, cards{n,cols,rows,gap,like,w,h}|null, counts{...},
 *                     align, media{place,kind,frac}, headPx, pad[top,bottom], collapse{vp:{cols,cardCols,h}|null}
 *   sectionsByViewport{vp}[]  the primary bands re-found by DOM signature at each other viewport:
 *                     id, i, role, y, h, hFrac, bg, cols, ratios, cardCols, cards, align, pad, headPx, media
 *   colors            theme, roles{pageBg,surface,text,mutedText,border,accent,accent2},
 *                     palette[{hex,oklch[L,C,H],share,uses{bg,text,border,graphic},roles[],shot,variants?}],
 *                     clustersBeforeCap, gradients[{css,n,areaFrac,where,bands,clipText?}], gradientsTotal,
 *                     vars{--name:hex}, screenshot{fold[],full[]}, mediaAreaFrac, imageHeavy
 *   type              families[{family,category,webfont,local?,variable,source[],weights,share,roles,stack}],
 *                     roles{vp:{display,h1,h2,h3,body,small,nav,button,eyebrow:{px,weight,lh,ls,tt,
 *                     style,family,color,n,how}}}, scale{vp:{"h1/h2":ratio,...}}, bodyPx{vp},
 *                     stats?{vp:{px,weight,family,n,sample,band,ex}} (stat figures, never a heading tier)
 *   spacing           container{vp:{maxWidthCss,maxWidthBands,contentWidth,contentBands,gutter,gutterHow}},
 *                     sectionPad{vp:{modeTop,modeBottom,medianTop,medianBottom,values}}, gaps{vp}[{px,n}],
 *                     stack{vp:{headingToText,textToButton}}, radius{button,card,input,image,top,how},
 *                     shadows[{css,n,on}], borders[{w,color,sides,n}], nav{pos,h,bg,transparent,overHero,
 *                     blur,shadow,border,linkCount,ownBgAlpha,byViewport,onScroll}
 *   components        {nav,primaryButton,secondaryButton,card,input,link,badge}: {desc,x,y,w,h,pad,radius,
 *                     border,bg,color,font{px,weight,family,ls,tt,lh},shadow,transition,shot,hover?} | null
 *   hover[]           real-mouse hover deltas: kind, desc, self{prop:[from,to]}, before/after (pseudo),
 *                     kids[{desc,kind,delta}], transition, cursor | {skipped}
 *   motion            transitions[], cssAnimations[], keyframes{name:[[key,decl]]}, getAnimations[],
 *                     getAnimationsTotal, load{summary,groups[]}, reveals{summary,groups[],scrollLinked[],
 *                     jsMarquees}, sticky[], parallax[], horizontal[], marquees[], loops[], carousels{},
 *                     smoothScroll{library,t90Ms,detected,input}, scrollPass{}, layoutBasis, scrollTimeline{},
 *                     scrollSnap[], scrollBehavior, cursor{}, byViewport{vp:{revealCount}}, frames{load,reveals[]}
 *   shots             {vp:{full,fold,sections[],fullHeight,capped}, components{name:path}}
 *   notes[]           everything that could not be measured reliably or was capped
 * Values: px rounded to 0.5 (most to 1), colours hex (#rrggbb, "@a" suffix = alpha), ratios 2-3 dp.
 * Unmeasurable fields are null with a notes[] entry — never guessed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { launchChrome, newCaptureContext, userAgentFor, blockedCheck } from './lib/browser.mjs';
import { pageCore } from './lib/page-core.mjs';
import { pageAnalyze, probeInk } from './lib/page-analyze.mjs';
import { handleConsent, overlayPass, overlayHideCss, CMP_HIDE_CSS } from './lib/consent.mjs';
import { readPng, cropToFile, dominant, topColors, decodePng, seamCheck, stitchTiles, pairDelta, lineCropStats } from './lib/images.mjs';
import { buildPalette } from './lib/colors.mjs';
import { loadCatalogue, webFontsOf, isSystemFamily } from './lib/font-catalogue.mjs';
import { analyzeReveals, summarizeReveals, linkRevealStrips as linkStrips, analyzeLoad, analyzeLayoutMotion, analyzeNav, analyzeSmooth, classifyEasingString } from './lib/motion.mjs';
import { normBands, alignBands } from './lib/cmp-layout.mjs';
import { writeSummary } from './lib/summary.mjs';
import { differenceEuclidean } from 'culori';
import { startScreencast, writeFrames, pickFrames, visualLoad, loadStart, boxActivity, boxLevel, mediaEntry, epochToTs, loadSettle, leadInSeries, leadInOf, stripGrids, stripContent, LOAD_FPS, LOAD_WINDOW_MS, LOAD_MEDIA_MS } from './lib/frames.mjs';
import { sampleMedia, sustained, mediaArrival, intermittentOf } from './lib/frames.mjs';

import { stripAppear, loadAppear } from './lib/frames.mjs';
import { navShots, applyNavShots } from './lib/motion.mjs';
import { pairLook, inkShare, inkOf, pasteRows, writePng, clonePng, rowsOf, dominantBg, recolorRows } from './lib/images.mjs';import { PAIR_CHANGED_MIN } from './lib/images.mjs';

const INIT = `(${pageCore})();(${pageAnalyze})();`;
const VP = { 1440: [1440, 900], 768: [768, 1024], 390: [390, 844] };
const MAX_SHOT_H = 20000;
const MAX_TAIL_TO = 60000;   // tail shots past MAX_SHOT_H cover the page down to this row
const MAX_SEC_H = 2400;
const TILE_H = 8000;
const TILE_OVERLAP = 240;
const MAX_REVEAL_STRIPS = 4;
const WATCH_MS = 8000;      // slow watch for auto-advance: >= 2 steps of any period up to ~4 s, 1 step up to 8 s
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;

function parseArgs(argv) {
  const pos = [];
  const o = { viewports: [1440, 768, 390], motionFrames: true, timeout: 60000, fast: false, hover: true, framesLike: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--viewports') o.viewports = String(argv[++i] || '').split(',').map((s) => parseInt(s, 10)).filter((n) => n > 0);
    else if (a.startsWith('--viewports=')) o.viewports = a.split('=')[1].split(',').map((s) => parseInt(s, 10)).filter((n) => n > 0);
    else if (a === '--no-motion-frames') o.motionFrames = false;
    else if (a === '--fast') { o.fast = true; }
    else if (a === '--frames-like') o.framesLike = path.resolve(String(argv[++i] || ''));
    else if (a.startsWith('--frames-like=')) o.framesLike = path.resolve(a.split('=')[1]);
    else if (a === '--timeout') o.timeout = parseInt(argv[++i], 10) || 60000;
    else if (a.startsWith('--timeout=')) o.timeout = parseInt(a.split('=')[1], 10) || 60000;
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else pos.push(a);
  }
  if (pos.length < 2) throw new Error('usage: node capture.mjs <url> <outDir> [--viewports 1440,768,390] [--no-motion-frames] [--fast] [--frames-like <refCapDir>] [--timeout 60000]');
  if (o.framesLike && !fs.existsSync(path.join(o.framesLike, 'capture.json'))) throw new Error(`--frames-like: no capture.json in ${o.framesLike}`);
  o.url = /^[a-z]+:\/\//i.test(pos[0]) ? pos[0] : 'https://' + pos[0];
  o.outDir = path.resolve(pos[1]);
  if (!o.viewports.length) throw new Error('no valid viewports');
  o.viewports = [...new Set(o.viewports)].sort((a, b) => b - a);
  // --fast: quick iteration capture (largest viewport only, no motion frames, no hover); never the final verify
  if (o.fast) { o.viewports = o.viewports.slice(0, 1); o.motionFrames = false; o.hover = false; }
  return o;
}

const notes = [];
const note = (s) => { if (s && !notes.includes(s) && notes.length < 100) notes.push(String(s).slice(0, 300)); };
// short progress lines on stderr (stdout stays one JSON line)
const T_START = Date.now();
const progress = (s) => { try { process.stderr.write(`capture: ${s} (${Math.round((Date.now() - T_START) / 1000)}s)\n`); } catch { /* closed */ } };

async function ev(page, fn, arg, ms = 30000, label = 'evaluate') {
  let timer;
  try {
    return await Promise.race([page.evaluate(fn, arg), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms); })]);
  } finally { clearTimeout(timer); }
}

async function openPage(ctx, w, h, { load = false, captureCss = false, hideCmp = false, hideCss = '' } = {}) {
  const page = await ctx.newPage();
  await page.setViewportSize({ width: w, height: h });
  await page.addInitScript({ content: INIT + (load ? ';window.__rc && window.__rc.startLoad();' : '') });
  if (hideCmp) {
    // consent banners / chat launchers (and popups already found on an earlier load of this page) hidden
    // from the first paint so the load frames show the design
    await page.addInitScript({ content: `(() => { try { if (window.top !== window) return; const css = ${JSON.stringify(CMP_HIDE_CSS + hideCss)}; let done = false; const add = () => { if (done) return true; const root = document.head || document.documentElement; if (!root) return false; const st = document.createElement('style'); st.id = 'rc-cmp-hide'; st.textContent = css; root.appendChild(st); done = true; return true; }; if (!add()) { const mo = new MutationObserver(() => { if (add()) mo.disconnect(); }); mo.observe(document, { childList: true, subtree: true }); } } catch (e) {} })();` });
  }
  const st = { errors: 0, samples: [], inflight: new Map(), last: Date.now(), css: new Map(), cssBytes: 0 };
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const loc = (m.location() && m.location().url) || '';
    if (/favicon\.ico/i.test(loc)) { st.favicon = true; return; } // browsers' implicit favicon request, not a page error
    st.errors++; if (st.samples.length < 5) st.samples.push(m.text().slice(0, 160));
  });
  page.on('pageerror', (e) => { st.errors++; if (st.samples.length < 5) st.samples.push(('pageerror: ' + (e.message || e)).slice(0, 160)); });
  page.on('request', (r) => { const t = r.resourceType(); if (t === 'websocket' || t === 'eventsource') return; st.inflight.set(r, Date.now()); st.last = Date.now(); if (/^https?:\/\/fonts\.googleapis\.com\/css/i.test(r.url())) (st.gfonts || (st.gfonts = new Set())).add(r.url()); });
  const done = (r) => { st.inflight.delete(r); st.last = Date.now(); };
  page.on('requestfinished', done);
  page.on('requestfailed', done);
  if (captureCss) {
    page.on('response', async (res) => {
      try {
        if (res.request().resourceType() !== 'stylesheet' || st.cssBytes > 8e6) return;
        const t = await res.text();
        st.css.set(res.url(), t); st.cssBytes += t.length;
      } catch { /* body unavailable */ }
    });
  }
  page.setDefaultTimeout(30000);
  return { page, st };
}

async function networkQuiet(st, quietMs, capMs) {
  const start = Date.now();
  while (Date.now() - start < capMs) {
    const now = Date.now();
    let active = 0;
    for (const t of st.inflight.values()) if (now - t < 8000) active++;
    if (active <= 1 && now - st.last >= quietMs) return true;
    await sleep(100);
  }
  return false;
}

async function settle(page, st, { loadCap, quietCap }) {
  const t = Date.now();
  let loaded = true;
  await page.waitForLoadState('load', { timeout: loadCap }).catch(() => { loaded = false; });
  const fonts = await ev(page, () => Promise.race([document.fonts.ready.then(() => true), new Promise((r) => setTimeout(() => r(false), 4000))]), null, 6000, 'fonts').catch(() => false);
  const quiet = await networkQuiet(st, 500, quietCap);
  return { ms: Date.now() - t, load: loaded, fonts, quiet };
}

async function ensureRc(page) {
  const ok = await ev(page, () => !!(window.__rc && window.__rc.analyze), null, 5000).catch(() => false);
  if (!ok) { await page.evaluate(INIT).catch(() => {}); note('page lost the capture helpers (navigation after load?); re-injected'); }
}

// Waits until the screencast covers LOAD_WINDOW_MS (5 s) after first contentful paint (or after navigation
// commit when the page reports no FCP within 8 s), stops it and writes the load frames (12 fps, 61 frames)
// to dir, starting at the frame that shows FCP (frames.mjs loadStart): both sides of a comparison start at
// the same defined instant, blank pre-paint frames of a fast local page are never in the strip, and a load
// that settles up to 4 s after first paint is inside it (finishLoad measures when it settled). Returns the
// frames entry or null. The first 1.5 s of picked frames are kept on the result for the hero media
// load activity (not serialised).
async function grabLoadFrames(sc, commitRef, dir, page) {
  const deadline = Date.now() + 15000;
  let fcpEpoch = null;
  const fcpOf = () => page.evaluate(() => { const e = performance.getEntriesByType('paint').find((x) => x.name === 'first-contentful-paint'); return e ? performance.timeOrigin + e.startTime : null; }).catch(() => null);
  while (Date.now() < deadline) {
    if (fcpEpoch === null && page) fcpEpoch = await fcpOf();
    const anchor = fcpEpoch ?? (commitRef.ts && Date.now() - commitRef.ts > 8000 ? commitRef.ts : null);
    if (anchor !== null && Date.now() - anchor >= LOAD_WINDOW_MS + 200) break;
    await sleep(80);
  }
  const frames = await sc.stop();
  if (sc.capped) note('load screencast hit its frame cap; the end of the load strip may repeat the last frame');
  const st = loadStart(frames, commitRef.ts || 0, fcpEpoch);
  if (!st) return null;
  const w = writeFrames(frames, st.t0, dir, { fps: LOAD_FPS, durationMs: LOAD_WINDOW_MS });
  const post = frames.filter((f) => f.recv >= commitRef.ts).sort((a, b) => a.ts - b.ts);
  const entry = { n: w.n, fps: LOAD_FPS, windowMs: LOAD_WINDOW_MS, distinct: w.distinct, t0: st.how, fcpAfterCommitMs: st.fcpAfterCommitMs, firstPaintAfterCommitMs: post.length ? Math.max(0, Math.round(post[0].recv - commitRef.ts)) : null };
  Object.defineProperty(entry, 'picked', { value: pickFrames(frames, st.t0, { fps: LOAD_FPS, durationMs: LOAD_MEDIA_MS }).map((f) => f.data), enumerable: false });
  return entry;
}

// Second load of the page in the same browser context (HTTP cache warm, consent choice kept): load
// sampler (motion.load) and, when framesDir is given, the load frames. What only the cold run shows
// (a blank hold or content arriving in steps) is network timing, not design.
async function warmLoad(ctx, o, pw, ph, framesDir, hideCss, repeat = []) {
  const { page } = await openPage(ctx, pw, ph, { load: true, hideCmp: !!framesDir, hideCss });
  try {
    const commitRef = { ts: null };
    page.on('framenavigated', (f) => { if (f === page.mainFrame() && !commitRef.ts && f.url() !== 'about:blank') commitRef.ts = Date.now(); });
    const sc = framesDir ? await startScreencast(page, { width: pw, height: ph }).catch(() => null) : null;
    await page.goto(o.url, { waitUntil: 'commit', timeout: o.timeout });
    if (!commitRef.ts) commitRef.ts = Date.now();
    const frames = sc ? await grabLoadFrames(sc, commitRef, framesDir, page) : null;
    await page.waitForLoadState('domcontentloaded', { timeout: o.timeout }).catch(() => {});
    await page.waitForFunction(() => !window.__rc || !window.__rc.load || window.__rc.load.done, null, { timeout: 12000, polling: 100 }).catch(() => {});
    // popups that come back on the warm load are marked (hidden, never clicked) so the load sampler leaves them out
    const ov = await overlayPass(page, { allowClick: false }).catch(() => []);
    // repeat: elements the first run saw repeating (slow watch, idle bursts): never load groups
    const loadRaw = await ev(page, (rep) => window.__rc.loadResult(rep), repeat, 10000, 'loadResult').catch(() => null);
    return { loadRaw, frames, overlays: ov };
  } finally { await page.close().catch(() => {}); }
}

async function scrollTop(page) {
  await ev(page, () => {
    try { if (window.lenis && window.lenis.scrollTo) window.lenis.scrollTo(0, { immediate: true }); } catch {}
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    if (document.scrollingElement) document.scrollingElement.scrollTop = 0;
  }, null, 5000).catch(() => {});
  await sleep(250);
  for (let i = 0; i < 12; i++) {
    const s = await ev(page, () => window.__rc.scrollInfo(), null, 5000).catch(() => null);
    if (!s || (s.vs <= 2 && s.sy <= 2)) break;
    await page.mouse.wheel(0, -Math.max(2000, s.vs + 1000));
    await sleep(350);
  }
}

// App-shell page (content scrolls inside an inner box while the document does not scroll): the box is unrolled
// into the document (page-core rc.unrollScroller) right after consent, on every page opened on the site, so
// window scrolling, segmentation, shots, reveals and full shots work unchanged. With meta, the result is
// recorded as meta.innerScroller[vp] and noted. Returns the page-side result or null (normal page).
async function unrollInner(page, vp, meta = null) {
  const u = await ev(page, () => (window.__rc && window.__rc.unrollScroller ? window.__rc.unrollScroller() : null), null, 15000, 'inner scroller').catch((e) => { if (meta) note(`${vp}: inner scroller check failed: ${e.message.split('\n')[0]}`); return null; });
  if (!u) return null;
  if (meta) {
    (meta.innerScroller ||= {})[vp] = u;
    note(u.ok ? `${vp}: app-shell page: content scrolls inside ${u.el} (${u.clientH}px box, ${u.scrollH}px content) while the document does not; unrolled into the document (height/overflow of the box and its ancestors released, content-visibility forced visible) before measuring: document ${u.docH[0]} -> ${u.docH[1]}px`
      : `${vp}: app-shell page: content scrolls inside ${u.el} (${u.clientH}px box, ${u.scrollH}px content) but unrolling it did not lengthen the document; measured as one screen (bands, shots and counts cover the first screen only)`);
  }
  if (u.ok) await sleep(400);
  return u;
}

// ---------- full-page shots as a user sees each band in view ----------
// Page-side: content-visibility:auto subtrees that are off-screen are not painted by a full-page capture (whole
// bands below the first screens come out blank, and their children have no layout for the band segmentation):
// every element is forced to content-visibility:visible for the shots and the analysis (scrolled to, a user sees
// them rendered). Returns how many elements used another value (-1: already applied; the count when the
// app-shell unroll applied it earlier, window.__rcCvN).
function cvOverride() {
  if (document.getElementById('rc-cv')) return window.__rcCvN || -1;
  let n = 0, k = 0;
  for (const el of document.getElementsByTagName('*')) { if (++k > 25000) break; const c = getComputedStyle(el).contentVisibility; if (c && c !== 'visible') n++; }
  const st = document.createElement('style'); st.id = 'rc-cv'; st.textContent = '*{content-visibility:visible!important}';
  (document.head || document.documentElement).appendChild(st);
  return n;
}
// Page-side: scroll-driven animations (CSS animation-timeline scroll()/view(), WAAPI ScrollTimeline/ViewTimeline)
// that change visibility, position, clip or filter sit in their scroll-0 state in a full-page capture (content
// further down reads as not yet revealed). Each is read with its target as near the viewport centre as the page
// allows (scroll in quarter-viewport steps, two frames after each), then paused at that time, so the full shot and
// the analysis see every band as it looks in view. Page-tall targets (> 1.5 viewport heights: page tints, layers)
// and colour-only animations are left alone. window.__rcFrozen holds the paused animations (thawed with play(),
// which re-aligns a scroll-driven animation to its timeline).
async function freezeScrollAnims() {
  const DT = typeof DocumentTimeline !== 'undefined' ? DocumentTimeline : null;
  const vh = innerHeight;
  const VIS = /opacity|transform|translate|scale|rotate|clip|filter|visibility|inset|top|left|mask/i;
  const list = [];
  for (const a of document.getAnimations()) {
    if (!a.timeline || (DT && a.timeline instanceof DT)) continue;
    const t = a.effect && a.effect.target;
    if (!t || t === document.documentElement || t === document.body || t.closest('[data-rc-overlay]')) continue;
    let props = [];
    try { props = a.effect.getKeyframes().flatMap((k) => Object.keys(k)).filter((p) => !['offset', 'computedOffset', 'easing', 'composite'].includes(p)); } catch { props = []; }
    if (!props.some((p) => VIS.test(p))) continue;
    if (t.getBoundingClientRect().height > vh * 1.5) continue;
    list.push({ a, t, best: null, dist: Infinity });
  }
  if (!list.length) return { found: 0, frozen: 0 };
  const go = (y) => { try { if (window.lenis && window.lenis.scrollTo) window.lenis.scrollTo(y, { immediate: true }); } catch {} window.scrollTo({ top: y, behavior: 'instant' }); };
  const raf2 = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const docH = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
  const max = Math.max(0, docH - vh), step = Math.max(120, Math.round(vh * 0.25)), t0 = performance.now();
  for (let y = 0; ; y = Math.min(max, y + step)) {
    go(y); await raf2();
    for (const e of list) {
      const r = e.t.getBoundingClientRect(), d = Math.abs((r.top + r.bottom) / 2 - vh / 2);
      if (d < e.dist) { const ct = e.a.currentTime; if (ct !== null && ct !== undefined) { e.dist = d; e.best = ct; } }
    }
    if (y >= max || performance.now() - t0 > 15000) break;
  }
  go(0); await raf2();
  window.__rcFrozen = [];
  for (const e of list) { if (e.best === null) continue; try { e.a.pause(); e.a.currentTime = e.best; window.__rcFrozen.push(e.a); } catch { /* read-only */ } }
  return { found: list.length, frozen: window.__rcFrozen.length };
}
function thawScrollAnims() { const l = window.__rcFrozen || []; for (const a of l) { try { a.play(); } catch { /* gone */ } } window.__rcFrozen = []; return l.length; }
// Page-side: what a full-page shot should show. texts: boxes of elements with their own text (>= 3 characters,
// CSS-visible, <= 400 px tall), op = effective opacity now; boxes: media and panel boxes (video, canvas, iframe,
// img, svg >= 120x90, or any box >= 8% of the viewport with little text and <= 1.5 viewport heights tall), which
// content mounted or painted only while in view leaves blank. Document coordinates.
function shotProbe() {
  const vw = innerWidth, vh = innerHeight, sx = scrollX, sy = scrollY;
  const texts = [], boxes = [];
  let k = 0;
  for (const el of document.body ? document.body.getElementsByTagName('*') : []) {
    if (++k > 30000 || texts.length >= 2500) break;
    const tag = el.tagName;
    if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|OPTION|TITLE)$/.test(tag) || el.ownerSVGElement) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4 || r.right <= 0 || r.left >= vw) continue;
    let own = 0;
    for (const c of el.childNodes) if (c.nodeType === 3) { own += c.textContent.replace(/\s+/g, '').length; if (own >= 3) break; }
    const media = /^(VIDEO|CANVAS|IFRAME|IMG|svg)$/i.test(tag);
    const area = r.width * r.height;
    if (own < 3 && !media && area < vw * vh * 0.08) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || el.closest('[data-rc-overlay],[data-rc-embed]')) continue;
    const box = [Math.round(r.left + sx), Math.round(r.top + sy), Math.round(r.width), Math.round(r.height)];
    if (own >= 3 && !media) {
      if (r.height > 400 || r.width < 8) continue;
      // text painted through a background clip has a transparent colour: its ink is the background
      if (/rgba\([^)]*,\s*0\)$/.test(cs.color) && !/text/.test(cs.backgroundClip || cs.webkitBackgroundClip || '')) continue;
      // effective opacity, and text clipped away by an overflow ancestor (a collapsed accordion, a masked
      // ticker) is not expected to show
      let op = 1, clipped = false;
      const cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2;
      for (let e = el; e && e.nodeType === 1 && op >= 0.05; e = e.parentElement) {
        const ecs = e === el ? cs : getComputedStyle(e);
        const o = parseFloat(ecs.opacity); if (!isNaN(o)) op *= o;
        if (e !== el && (ecs.overflowX !== 'visible' || ecs.overflowY !== 'visible') && e !== document.body && e !== document.documentElement) {
          const er = e.getBoundingClientRect();
          if (cx < er.left - 1 || cx > er.right + 1 || cy < er.top - 1 || cy > er.bottom + 1) { clipped = true; break; }
        }
      }
      if (clipped) continue;
      texts.push([...box, Math.round(op * 100) / 100]);
      continue;
    }
    const ok = media ? r.width >= 120 && r.height >= 90 : r.height <= vh * 1.5 && r.width >= 160 && (el.textContent || '').replace(/\s+/g, '').length < 40;
    if (ok && boxes.length < 600) boxes.push(box);
  }
  return { texts, boxes, docH: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0) };
}
// Blank text in a full-page shot: text boxes CSS-visible now (effective opacity >= 0.5) whose rows show no ink
// (< 0.2% of the box, or fewer than 6 sampled pixels): share of that text area. Writes t[5] = blank (0/1).
function textBlank(png, texts) {
  let all = 0, blank = 0, n = 0;
  for (const t of texts) {
    const [x, y, w, h, op] = t;
    if (y >= png.height - 2) { t[5] = null; continue; }
    const r = inkOf(png, { x, y, w, h: Math.min(h, png.height - y) }, 2);
    if (!r) { t[5] = null; continue; }
    t[5] = r.share < 0.002 || r.n < 6 ? 1 : 0;
    if (op >= 0.5) { all += w * h; n++; if (t[5]) blank += w * h; }
  }
  return { share: all ? Math.round((blank / all) * 1000) / 1000 : 0, texts: n };
}
// Rows of a full-page shot that may be blank only because they were not in view: blank text (any opacity) and
// flat media/panel boxes. Merged into row ranges (gaps < 160 px joined).
function blankRows(png, probe) {
  const rows = [];
  for (const t of probe.texts) if (t[5] === 1) rows.push([t[1], t[1] + t[3]]);
  for (const b of probe.boxes) {
    if (b[1] >= png.height - 2) continue;
    // flat but for a small control (a play button in a corner of an unpainted video panel): < 1.2% ink
    const s = inkShare(png, { x: b[0], y: b[1], w: b[2], h: Math.min(b[3], png.height - b[1]) }, 4);
    if (s !== null && s < 0.012) rows.push([b[1], b[1] + b[3]]);
  }
  rows.sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [a, b] of rows) { const p = out[out.length - 1]; if (p && a <= p[1] + 160) p[1] = Math.max(p[1], b); else out.push([a, b]); }
  return out.map(([a, b]) => [Math.max(0, a), Math.min(png.height, b)]).filter(([a, b]) => b - a >= 8);
}
// Fills rows that are blank in the full shot with the same rows shot while in view: for each row range the page
// is scrolled so the rows sit just below a pinned header, left to settle (lazily mounted panels, videos, in-view
// paints), and the viewport is shot; each 60-row block that shows clearly more ink in view (>= +1% of the block and
// >= 1.5x) replaces the full shot's block. Rows line up only while the page is as tall as the shot was (an uncapped
// shot's own height; else the height at the start): a position where the height differs (> max(40 px, 1%)) is
// re-read for 1.5 s and skipped when it still differs; 4 such positions in a row stop the fill, as do 24 viewport
// shots or 30 s. Returns {ranges, shots, pasted: [[y0, y1]], stopped?, skipped?}.
async function patchInView(page, png, ranges, vw, vh, topInset) {
  const t0 = Date.now(), pasted = [];
  let shots = 0, stopped = null, miss = 0, skipped = 0;
  const docHNow = (await ev(page, () => window.__rc.scrollInfo(), null, 5000).catch(() => null) || {}).docH;
  const docH0 = png.height < MAX_SHOT_H ? png.height : docHNow;
  const tol = Math.max(40, (docH0 || 0) * 0.01);
  const go = (y) => ev(page, (v) => { try { if (window.lenis && window.lenis.scrollTo) window.lenis.scrollTo(v, { immediate: true }); } catch {} window.scrollTo({ top: v, behavior: 'instant' }); }, y, 5000).catch(() => {});
  const max = Math.max(0, (docH0 || png.height) - vh);
  for (const [y0, y1] of ranges) {
    let y = y0;
    while (y < y1) {
      if (shots >= 24 || Date.now() - t0 > 30000) { stopped = 'budget (24 viewport shots / 30 s)'; break; }
      const s = Math.max(0, Math.min(max, y - topInset - 16));
      await go(s); await sleep(shots ? 900 : 1300);
      let info = await ev(page, () => window.__rc.scrollInfo(), null, 5000).catch(() => null);
      if (!info) break;
      for (let k = 0; k < 6 && docH0 && Math.abs(info.docH - docH0) > tol; k++) { await sleep(250); info = await ev(page, () => window.__rc.scrollInfo(), null, 5000).catch(() => null) || info; }
      if (docH0 && Math.abs(info.docH - docH0) > tol) {
        skipped++;
        if (++miss >= 4) { stopped = `page height differs from the shot's (${docH0} -> ${info.docH} px)`; break; }
        y += Math.max(60, vh - topInset - 16);
        continue;
      }
      miss = 0;
      const at = Math.abs(info.vs - info.sy) > 4 ? info.vs : info.sy;
      const buf = await page.screenshot({ timeout: 15000 }).catch(() => null);
      shots++;
      if (!buf) break;
      const V = decodePng(buf);
      const r0 = Math.max(y, at + topInset), r1 = Math.min(y1, at + vh);
      if (r1 <= r0) { y = Math.max(y + 60, r1); continue; }
      for (let b = r0; b < r1; b += 60) {
        const n = Math.min(60, r1 - b);
        const f = inkShare(png, { x: 0, y: b, w: png.width, h: n }, 3), v = inkShare(V, { x: 0, y: b - at, w: V.width, h: n }, 3);
        if (f === null || v === null) continue;
        if (v >= f + 0.01 && v >= f * 1.5) {
          pasteRows(png, V, b - at, b, n);
          const p = pasted[pasted.length - 1];
          if (p && p[1] === b) p[1] = b + n; else pasted.push([b, b + n]);
        }
      }
      y = r1;
    }
    if (stopped) break;
  }
  return { ranges: ranges.length, shots, pasted, stopped: stopped || undefined, skipped: skipped || undefined, ms: Date.now() - t0 };
}
// Waits (<= maxMs) until the page height reads the same three times 250 ms apart: a full-page capture resizes the
// page's viewport for an instant, and a page that re-renders on resize (virtualised rows, lazily mounted rows)
// changes height for a moment after it; the DOM probe and the in-view fill need the page as the shot drew it.
async function stableHeight(page, maxMs = 4000) {
  const t0 = Date.now();
  let last = null, same = 0, h = null;
  while (Date.now() - t0 < maxMs) {
    h = (await ev(page, () => window.__rc.scrollInfo(), null, 5000).catch(() => null) || {}).docH ?? null;
    if (h !== null && h === last) { if (++same >= 2) break; } else same = 0;
    last = h;
    await sleep(250);
  }
  return h;
}
// Height of a pinned header at the top of the viewport (rows below it are the ones an in-view shot shows clear).
async function headerInset(page, vh) {
  const hdr = await ev(page, () => { const n = window.__rc.findNav && window.__rc.findNav(); if (!n || !n.el) return 0; const cs = getComputedStyle(n.el); const r = n.el.getBoundingClientRect(); return (cs.position === 'fixed' || cs.position === 'sticky') && r.top <= 2 ? Math.round(r.bottom) : 0; }, null, 5000).catch(() => 0);
  return Math.min(hdr || 0, Math.round(vh * 0.3));
}
// Flat rows of a shot: 60-row blocks with no ink across the full width (< 0.2%). Returns {share (of the shot's
// height), run (longest run of flat blocks in px, the last block of the page left out)}.
function flatRows(png) {
  let f = 0, run = 0, cur = 0;
  for (let y = 0; y < png.height; y += 60) {
    const h = Math.min(60, png.height - y), k = inkShare(png, { x: 0, y, w: png.width, h }, 4);
    if (k !== null && k < 0.002) { f += h; cur += h; if (y + h < png.height) run = Math.max(run, cur); } else cur = 0;
  }
  return { share: png.height ? f / png.height : 0, run };
}
// Page-side: bars fixed or stuck at the top or bottom edge of the viewport (within 32 px, < 30% of its height:
// headers, cookie/app bars, floating buttons) hidden (visibility) so a shot stitched from viewport tiles shows them
// once, on the first tile; `false` shows them again. Full-viewport fixed layers and tall pinned sections are kept.
function hideBars(on) {
  if (!on) { for (const el of document.querySelectorAll('[data-rc-bar]')) { el.style.removeProperty('visibility'); el.removeAttribute('data-rc-bar'); } return 0; }
  const vh = innerHeight;
  let n = 0, k = 0;
  for (const el of document.body ? document.body.getElementsByTagName('*') : []) {
    if (++k > 30000) break;
    const cs = getComputedStyle(el);
    if ((cs.position !== 'fixed' && cs.position !== 'sticky') || el.closest('[data-rc-bar]')) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || r.height > vh * 0.3 || !(r.top <= 32 || r.bottom >= vh - 32)) continue;
    el.setAttribute('data-rc-bar', '1'); el.style.setProperty('visibility', 'hidden', 'important'); n++;
  }
  return n;
}
// Rebuilds a full shot from viewport shots scrolled through the page, for a page whose full-page capture stays
// largely blank (the capture resizes the page for an instant and some pages re-render their rows as empty
// placeholders, then load them again only in view, at another height): tile k is shot after scrolling (vh - 120)
// px further and settling 700 ms, and placed at the scroll position read then; edge bars are hidden after the
// first tile. Overlap rows are checked against the previous tile (seamCheck; shifted seams counted). Stops at the
// page end, MAX_SHOT_H, 40 tiles or 45 s. Returns {png, tiles, shifted, bars, ms} or null.
async function stitchInView(page, vw, vh) {
  const t0 = Date.now(), tiles = [];
  const go = (y) => ev(page, (v) => { try { if (window.lenis && window.lenis.scrollTo) window.lenis.scrollTo(v, { immediate: true }); } catch {} window.scrollTo({ top: v, behavior: 'instant' }); }, y, 5000).catch(() => {});
  let target = 0, shifted = 0, bars = 0;
  try {
    for (let k = 0; k < 40 && Date.now() - t0 < 45000; k++) {
      await go(target); await sleep(k ? 700 : 900);
      if (k) { bars += await ev(page, hideBars, true, 10000).catch(() => 0); await sleep(80); }
      const info = await ev(page, () => window.__rc.scrollInfo(), null, 5000).catch(() => null);
      if (!info) break;
      const at = Math.round(Math.abs(info.vs - info.sy) > 4 ? info.vs : info.sy);
      const prev = tiles[tiles.length - 1];
      if (prev && at <= prev.at + 4) break;
      const buf = await page.screenshot({ timeout: 15000 }).catch(() => null);
      if (!buf) break;
      const png = decodePng(buf);
      if (prev && prev.at + prev.png.height > at) { const chk = seamCheck(prev.png, prev.at, png, at, prev.at + prev.png.height); if (chk.offset) shifted++; }
      tiles.push({ png, at });
      const end = Math.min(info.docH, MAX_SHOT_H);
      if (at + vh >= end - 2) break;
      target = Math.min(at + vh - 120, Math.max(0, end - vh));
    }
  } finally { await ev(page, hideBars, false, 10000).catch(() => {}); await scrollTop(page); }
  if (tiles.length < 2) return null;
  const H = Math.min(MAX_SHOT_H, Math.max(...tiles.map((t) => t.at + t.png.height)));
  const png = rowsOf(tiles.map((t) => ({ png: t.png, y: t.at })), 0, H);
  return png ? { png, tiles: tiles.length, shifted, bars, ms: Date.now() - t0 } : null;
}
// After the analysis (the DOM in the state its bands were measured in): bands with content (>= 3 words or any
// media) whose rows the full shot shows flat (ink < 0.2% of the band) are filled from in-view shots the same way,
// then the DOM probe is taken again so shots[vp].blank says what is still blank: `after` (share of the text area)
// and `rows` (share of the shot's height in content bands still flat), `bands` (their indices).
async function fillBlankBands(page, outDir, vp, vh, A, shots) {
  if (!shots || !shots.full || !A || !A.sections) return;
  const file = path.join(outDir, shots.full);
  let png; try { png = readPng(file); } catch { return; }
  const inShot = (s) => [Math.max(0, s.y), Math.min(png.height, s.y + s.h)];
  const flat = (s) => { const [a, b] = inShot(s); if (b - a < 40) return false; const k = inkShare(png, { x: 0, y: a, w: png.width, h: b - a }, 3); return k !== null && k < 0.002; };
  const list = A.sections.map((s, i) => Object.assign({ i }, s)).filter((s) => !s.virtual && !s.thirdParty && s.role !== 'nav' && s.h >= 40 && s.y < png.height - 2 && s.counts && (s.counts.words >= 3 || s.counts.media >= 1));
  const blank = shots.blank || (shots.blank = { before: null, texts: 0, ranges: [] });
  let flats = list.filter(flat);
  if (flats.length) {
    const ranges = [];
    for (const s of flats) { const [a, b] = inShot(s); const p = ranges[ranges.length - 1]; if (p && a <= p[1] + 160) p[1] = Math.max(p[1], b); else ranges.push([a, b]); }
    const rest = shots.fullRest ? null : clonePng(png);
    const p = await patchInView(page, png, ranges, vp, vh, await headerInset(page, vh));
    await scrollTop(page);
    if (p.pasted.length) {
      if (rest) { writePng(rest, path.join(outDir, `shots/${vp}-full-rest.png`)); shots.fullRest = `shots/${vp}-full-rest.png`; }
      writePng(png, file);
      note(`${vp}: ${flats.length} band(s) with content blank in the full shot filled from ${p.shots} in-view viewport shot(s): ${p.pasted.slice(0, 6).map(([a, b]) => `${a}-${b}`).join(', ')}${p.pasted.length > 6 ? ' ...' : ''}`);
    }
    const iv = blank.inView || { shots: 0, pasted: [], pastedPx: 0 };
    blank.inView = { shots: iv.shots + p.shots, pasted: [...iv.pasted, ...p.pasted].sort((a, b) => a[0] - b[0]).slice(0, 24), pastedPx: iv.pastedPx + p.pasted.reduce((q, [a, b]) => q + b - a, 0), stopped: p.stopped || iv.stopped, skipped: p.skipped || iv.skipped };
    blank.bandRanges = ranges.slice(0, 16);
    flats = list.filter(flat);
  }
  const probe = await ev(page, shotProbe, null, 30000, 'shot probe').catch(() => null);
  // text boxes are compared with the shot only while the page is as tall as the shot (rows line up); otherwise
  // the text share is unknown (null, probeDocH = the height then) and `rows` alone says what is blank
  const aligned = probe && (png.height >= MAX_SHOT_H || Math.abs((probe.docH || png.height) - png.height) <= Math.max(40, png.height * 0.01));
  if (aligned) { blank.after = textBlank(png, probe.texts).share; Object.defineProperty(shots, '_probe', { value: probe, enumerable: false, configurable: true }); }
  else if (probe) { blank.after = null; blank.probeDocH = probe.docH; Object.defineProperty(shots, '_probe', { value: null, enumerable: false, configurable: true }); }
  blank.rows = r3(flats.reduce((q, s) => { const [a, b] = inShot(s); return q + b - a; }, 0) / Math.max(1, png.height));
  blank.bands = flats.length ? flats.map((s) => s.i).slice(0, 20) : undefined;
}

async function takeShots(page, outDir, vp, vh) {
  const shots = {};
  // rendering as in view: content-visibility forced visible, scroll-driven animations paused at their in-view time
  const cv = await ev(page, cvOverride, null, 15000).catch(() => null);
  if (cv > 0) { note(`${vp}: ${cv} element(s) use content-visibility (off-screen bands are not painted by a full-page shot): forced visible for the shots and the analysis`); await sleep(300); }
  const info = await ev(page, () => window.__rc.scrollInfo(), null, 5000).catch(() => ({ docH: vh, vw: vp }));
  const fold = `shots/${vp}-fold.png`;
  await page.screenshot({ path: path.join(outDir, fold), timeout: 30000 }).then(() => { shots.fold = fold; }).catch((e) => note(`fold screenshot failed at ${vp}: ${e.message.split('\n')[0]}`));
  const H = Math.min(info.docH, MAX_SHOT_H);
  if (info.docH > MAX_SHOT_H) note(`page is ${info.docH}px tall at ${vp}; full screenshot capped at ${MAX_SHOT_H}px`);
  if (info.docH <= vh + 4) note(`document height equals the viewport at ${vp}; content may scroll inside an inner/transform scroller, so the full-page shot can be truncated`);
  const full = `shots/${vp}-full.png`;
  // scroll-driven animations: the scroll-0 state is kept as <vp>-full-rest.png (scroll tints compare against it),
  // then the animations are paused at their in-view time for the full shot and the analysis
  let sda = null;
  const hasSda = await ev(page, () => { const DT = typeof DocumentTimeline !== 'undefined' ? DocumentTimeline : null; return document.getAnimations().some((a) => a.timeline && !(DT && a.timeline instanceof DT)); }, null, 5000).catch(() => false);
  if (hasSda) {
    await shootFull(page, outDir, vp, H, `shots/${vp}-full-rest.png`).then(() => { shots.fullRest = `shots/${vp}-full-rest.png`; }).catch(() => {});
    sda = await ev(page, freezeScrollAnims, null, 25000, 'freeze scroll-driven animations').catch((e) => { note(`${vp}: scroll-driven animations not frozen: ${e.message.split('\n')[0]}`); return null; });
    await sleep(250);
  }
  try {
    // a failed full shot is taken once more (the caller fails the viewport when there is still none)
    const seams = await shootFull(page, outDir, vp, H, full).catch(async (e) => { note(`full screenshot at ${vp} failed once (${e.message.split('\n')[0]}); shot again`); await sleep(1000); await scrollTop(page); return shootFull(page, outDir, vp, H, full); });
    if (seams) shots.seams = seams;
    shots.full = full; shots.fullHeight = H; shots.capped = info.docH > MAX_SHOT_H;
  } catch (e) { note(`full screenshot failed at ${vp}: ${e.message.split('\n')[0]}`); }
  // rows past the height cap: tail shots of <= MAX_SHOT_H rows each (to MAX_TAIL_TO px), in the same state as the
  // full shot, so every band has a section crop and the sheets show the lower bands (shots[vp].tails)
  if (shots.full && info.docH > MAX_SHOT_H) {
    const tails = [];
    for (let y0 = MAX_SHOT_H, k = 1; y0 < Math.min(info.docH, MAX_TAIL_TO); y0 += MAX_SHOT_H, k++) {
      const th = Math.min(MAX_SHOT_H, info.docH - y0, MAX_TAIL_TO - y0), f = `shots/${vp}-full-tail-${k}.png`;
      try { const sm = await shootFull(page, outDir, vp, th, f, y0); tails.push({ file: f, y: y0, h: th, seams: sm && sm.some((x) => !x.ok) ? sm : undefined }); }
      catch (e) { note(`tail shot ${k} at ${vp} failed: ${e.message.split('\n')[0]}`); break; }
    }
    if (tails.length) { shots.tails = tails; note(`${vp}: full shot capped at ${MAX_SHOT_H}px; tail shot(s) ${tails.map((t) => t.file).join(', ')} cover rows ${MAX_SHOT_H}-${tails[tails.length - 1].y + tails[tails.length - 1].h} of ${info.docH}`); }
  }
  shots.render = { contentVisibility: cv > 0 ? cv : 0, scrollDriven: sda ? sda.found : 0, frozen: sda ? sda.frozen : 0 };
  if (sda && sda.frozen) note(`${vp}: ${sda.frozen} scroll-driven animation(s) paused at their in-view state for the full shot and the analysis (scroll-0 state: ${shots.fullRest || 'not shot'})`);
  // blank check: text the DOM paints that shows no ink in the shot, and flat media/panel boxes; rows blank only
  // because they were not in view are replaced by the same rows shot in view
  if (shots.full) {
    try {
      // the page as the shot drew it (a page re-rendering after the capture's resize changes height for a moment)
      await stableHeight(page);
      let probe = await ev(page, shotProbe, null, 30000, 'shot probe');
      let png = readPng(path.join(outDir, full));
      const before = textBlank(png, probe.texts);
      const ranges = blankRows(png, probe);
      const blank = { before: before.share, texts: before.texts, ranges: ranges.slice(0, 16) };
      let restFromFill = false;
      if (ranges.length) {
        const rest = clonePng(png);
        const p = await patchInView(page, png, ranges, vp, vh, await headerInset(page, vh));
        await scrollTop(page);
        if (p.pasted.length) {
          if (!shots.fullRest) { writePng(rest, path.join(outDir, `shots/${vp}-full-rest.png`)); shots.fullRest = `shots/${vp}-full-rest.png`; restFromFill = true; }
          writePng(png, path.join(outDir, full));
          note(`${vp}: full shot rows blank at scroll 0 filled from ${p.shots} in-view viewport shot(s): ${p.pasted.slice(0, 6).map(([a, b]) => `${a}-${b}`).join(', ')}${p.pasted.length > 6 ? ' ...' : ''} (content painted or mounted only while in view)`);
        }
        blank.inView = { shots: p.shots, pasted: p.pasted.slice(0, 16), pastedPx: p.pasted.reduce((s, [a, b]) => s + b - a, 0), stopped: p.stopped, skipped: p.skipped };
      }
      // a full-page capture still largely blank (>= 25% of its height in flat rows, with a flat run of >= 1.5
      // viewport heights or an in-view fill whose rows could not line up) is rebuilt from viewport tiles scrolled
      // through the page; the rebuild is kept only when it has at most half the flat rows (a page that is simply
      // airy keeps its capture)
      const fr0 = flatRows(png);
      if (fr0.share >= 0.25 && (fr0.run >= vh * 1.5 || (blank.inView && (blank.inView.stopped || blank.inView.skipped)))) {
        const st = await stitchInView(page, vp, vh);
        const fr1 = st ? flatRows(st.png) : null;
        blank.stitched = st ? { tiles: st.tiles, shifted: st.shifted || undefined, flatBefore: r3(fr0.share), flatAfter: r3(fr1.share), kept: fr1.share <= fr0.share / 2 } : { kept: false, flatBefore: r3(fr0.share) };
        if (st && blank.stitched.kept) {
          png = st.png;
          writePng(png, path.join(outDir, full));
          shots.fullHeight = png.height;
          // a rest shot written from the blank capture would read its blank rows as a rest colour (false tints)
          if (restFromFill) { fs.rmSync(path.join(outDir, shots.fullRest), { force: true }); delete shots.fullRest; }
          await stableHeight(page);
          probe = await ev(page, shotProbe, null, 30000, 'shot probe').catch(() => probe);
          note(`${vp}: the full-page capture stayed ${Math.round(fr0.share * 100)}% blank (rows the page loads only in view, at another height): full shot rebuilt from ${st.tiles} viewport tiles scrolled through the page (${Math.round(fr1.share * 100)}% flat rows${st.shifted ? `, ${st.shifted} seam(s) shifted` : ''})`);
        }
      }
      const after = textBlank(png, probe.texts);
      blank.after = after.share;
      shots.blank = blank;
      Object.defineProperty(shots, '_probe', { value: probe, enumerable: false, configurable: true });
      // what is still blank is decided after the analysis (fillBlankBands) and warned about once for every width
    } catch (e) { note(`${vp}: blank check of the full shot failed: ${e.message.split('\n')[0]}`); }
  }
  return shots;
}

// Full-page screenshot of rows [off, off + H) into file (tiled above TILE_H; off > 0: a tail shot past the full
// shot's height cap). Returns the tile seams or null.
async function shootFull(page, outDir, vp, H, file, off = 0) {
  const full = file;
  {
    // Chrome wraps captures taller than its 16384px texture limit, so tall pages are shot in tiles
    if (H <= TILE_H) {
      await page.screenshot({ path: path.join(outDir, full), fullPage: true, clip: { x: 0, y: off, width: vp, height: H }, timeout: 90000 });
    } else {
      // tiles overlap by TILE_OVERLAP rows; the overlap must match the previous tile (seam self-check).
      // A tile whose content is shifted (page scrolled or relaid out while shooting) is shot again from
      // scroll 0; a shift that persists is recorded in shots[vp].seams and notes.
      const shoot = async (y) => {
        await ev(page, () => { try { if (window.lenis && window.lenis.scrollTo) window.lenis.scrollTo(0, { immediate: true }); } catch {} window.scrollTo({ top: 0, left: 0, behavior: 'instant' }); }, null, 5000).catch(() => {});
        const y0 = y ? y - TILE_OVERLAP : 0;
        const buf = await page.screenshot({ fullPage: true, clip: { x: 0, y: off + y0, width: vp, height: Math.min(TILE_H, H - y) + (y - y0) }, timeout: 90000 });
        return { y, y0, png: decodePng(buf) };
      };
      const tiles = [];
      const seams = [];
      for (let y = 0; y < H; y += TILE_H) {
        let t = await shoot(y);
        if (tiles.length) {
          const p = tiles[tiles.length - 1];
          let chk = seamCheck(p.png, p.y0, t.png, t.y0, y);
          if ((chk.diff !== null && chk.diff > 6) || (chk.offset !== null && chk.offset !== 0)) {
            await sleep(400);
            t = await shoot(y);
            chk = seamCheck(p.png, p.y0, t.png, t.y0, y);
          }
          // a seam is wrong only when the overlap's content is found shifted; a large overlap difference with
          // no shifted match is live content (animated gradient/canvas) changing between the two shots
          const ok = !(chk.offset !== null && chk.offset !== 0);
          seams.push({ y, diff: chk.diff, offset: chk.offset, ok, live: ok && chk.diff !== null && chk.diff > 6 ? true : undefined });
          if (!ok) note(`full screenshot at ${vp}: tile seam at y=${y} does not line up (overlap diff ${chk.diff}, content offset ${chk.offset ?? '?'}px); sections below it may be offset`);
        }
        t.skip = t.y - t.y0;
        tiles.push(t);
      }
      stitchTiles(tiles, path.join(outDir, full));
      return seams;
    }
  }
  return null;
}

// One scroll input. mode 'wheel' (real wheel events, works with smooth-scroll libraries) or
// 'scrollTo' (programmatic fallback for pages that ignore synthetic wheel input).
async function scrollBy(page, mode, dy) {
  if (mode === 'wheel') await page.mouse.wheel(0, dy);
  else await ev(page, (d) => window.scrollTo({ top: scrollY + d, behavior: 'instant' }), dy, 5000).catch(() => {});
}
// Some pages lock scrolling during an intro, or listen for wheel events on a container that does
// not cover the left gutter. Before giving up on a page that has not moved yet: wait, retry from the
// viewport centre, then fall back to programmatic scrolling.
async function unstick(page, vw, vh, step, state) {
  const tries = [[4, vh / 2, 'wheel', 1200], [vw / 2, vh / 2, 'wheel', 1500], [vw / 2, vh / 2, 'wheel', 2500], [vw / 2, vh / 2, 'scrollTo', 300]];
  for (const [x, y, mode, wait] of tries) {
    const before = await ev(page, () => window.__rc.scrollInfo());
    await page.mouse.move(x, y);
    await sleep(wait);
    await scrollBy(page, mode, step);
    await sleep(600);
    const after = await ev(page, () => window.__rc.scrollInfo());
    if (Math.abs(after.vs - before.vs) >= 5 || Math.abs(after.sy - before.sy) >= 5) {
      state.mode = mode;
      if (mode === 'scrollTo') note('page ignored wheel input; scroll pass used programmatic window.scrollTo (smooth-scroll lag not measurable)');
      else if (x > 10) note('wheel input only scrolled with the pointer at the viewport centre (hover states may be triggered during the scroll pass)');
      return true;
    }
  }
  return false;
}

// wheel-driven step pass with rAF sampling (primary viewport)
async function stepPass(page, vw, vh, budgetMs) {
  const step = Math.round(vh * 0.75);
  const rests = [await ev(page, (i) => window.__rc.restMeasure(i), 0)];
  const steps = [], tintSamples = [];
  let info = await ev(page, () => window.__rc.scrollInfo());
  const t0 = Date.now();
  let stuck = 0, k = 0, fast = 0, native = null, moved = false;
  const state = { mode: 'wheel' };
  const startDoc = info.docH;
  while (k < 90) {
    if (native === true && info.sy + vh >= info.docH - 2) break;
    if (info.vs > 30000) { note('scroll pass stopped at 30000px (very long or infinite page)'); break; }
    k++;
    const detailed = k <= 45 && Date.now() - t0 < budgetMs;
    if (detailed) {
      await ev(page, (o) => window.__rc.startSampler(o), { minMs: 450, maxMs: 1800, quietMs: 320, aheadPx: step, recordScroll: k === 1 || !moved });
      await scrollBy(page, state.mode, step);
      await page.waitForFunction(() => window.__rc.smp && window.__rc.smp.done, null, { timeout: 6000, polling: 50 }).catch(() => {});
      const res = await ev(page, (i) => window.__rc.collectSampler(i), k);
      const rest = await ev(page, (i) => window.__rc.restMeasure(i), k);
      steps.push(Object.assign({ k }, res));
      rests.push(rest);
      // screenshot-level background at this rest (middle 70% of the viewport, below a fixed header): the
      // scroll tint is read from these against the scroll-0 full shot, whatever paints the background
      // background only: media, background images and moving tracks in view are left out (contentHoles; `holes`
      // kept in page rows so the full shot's rows are read the same way)
      const holes = await ev(page, contentHoles, null, 8000).catch(() => []);
      const tb = await page.screenshot({ clip: { x: 0, y: Math.round(vh * 0.15), width: vw, height: Math.round(vh * 0.7) }, timeout: 10000 }).catch(() => null);
      if (tb) { try { const png = decodePng(tb); const at = rest.vs; const d = dominantBg(png, { x: 0, y: 0, w: png.width, h: png.height }, holes.map((h) => ({ x: h.x, y: h.y - Math.round(vh * 0.15), w: h.w, h: h.h })), 6); if (d) tintSamples.push({ vs: rest.vs, sy: rest.sy, docH: rest.docH, color: d.hex, share: d.share, holes: holes.map((h) => ({ x: h.x, y: h.y + at, w: h.w, h: h.h })) }); } catch { /* skip */ } }
    } else {
      fast++;
      await scrollBy(page, state.mode, step);
      await sleep(280);
    }
    const prev = info;
    info = await ev(page, () => window.__rc.scrollInfo());
    const didMove = Math.abs(info.vs - prev.vs) >= 5 || Math.abs(info.sy - prev.sy) >= 5;
    if (didMove && native === null) native = Math.abs(info.sy - prev.sy) > 5;
    if (didMove) { moved = true; stuck = 0; continue; }
    if (!moved) {
      // nothing has scrolled yet: drop this empty step and try to unstick the page
      steps.pop(); rests.pop(); k--;
      if (info.docH <= vh + 4) { note('page is not taller than the viewport and did not scroll; scroll motion pass skipped'); break; }
      if (await unstick(page, vw, vh, step, state)) {
        // continue from here; reveals in the first scrolled step fired unsampled
        moved = true;
        info = await ev(page, () => window.__rc.scrollInfo());
        native = info.sy > 5;
        continue;
      }
      note('page did not scroll with wheel or programmatic input; motion pass skipped');
      break;
    }
    if (++stuck >= 2) break;
  }
  if (fast) note(`scroll pass: ${fast} steps after the time/step budget ran without motion sampling`);
  if (info.docH > startDoc * 1.3 && info.docH > startDoc + 2000) note(`page grew from ${startDoc}px to ${info.docH}px while scrolling (lazy / infinite content)`);
  return { steps, rests, tintSamples, stepPx: step, native, ms: Date.now() - t0, endDocH: info.docH, mode: state.mode };
}

async function fastPass(page, vw, vh, maxMs = 40000) {
  const step = Math.round(vh * 0.85);
  let info = await ev(page, () => window.__rc.scrollInfo());
  const t0 = Date.now();
  let stuck = 0, n = 0, moved = false;
  const state = { mode: 'wheel' };
  while (Date.now() - t0 < maxMs && n < 80) {
    if (info.sy + vh >= info.docH - 2 && info.sy > 0) break;
    if (info.vs > 40000) break;
    await scrollBy(page, state.mode, step);
    await sleep(260);
    n++;
    const prev = info;
    info = await ev(page, () => window.__rc.scrollInfo());
    if (Math.abs(info.vs - prev.vs) >= 5 || Math.abs(info.sy - prev.sy) >= 5) { moved = true; stuck = 0; continue; }
    if (!moved) { if (info.docH > vh + 4 && await unstick(page, vw, vh, step, state)) { moved = true; info = await ev(page, () => window.__rc.scrollInfo()); continue; } break; }
    if (++stuck >= 2) break;
  }
  await sleep(500);
  return n;
}

async function hoverPass(page, count, kinds, { outDir, vw, vh, pairs } = {}) {
  const out = [];
  const frames = [];
  const away = await ev(page, () => window.__rc.awayPoint()).catch(() => [4, 400]);
  const want = new Set(pairs ? ['primary-button', 'card', 'nav-link'] : []);
  for (let i = 0; i < count; i++) {
    try {
      const ok = await ev(page, (j) => window.__rc.hoverScroll(j), i, 5000);
      if (!ok) continue;
      await page.mouse.move(away[0], away[1]);
      await sleep(300);
      const b = await ev(page, (j) => window.__rc.hoverBefore(j), i, 5000);
      if (!b.inView) { out.push({ kind: kinds[i], skipped: 'not in view after scrollIntoView' }); continue; }
      let pair = null;
      if (want.has(kinds[i])) {
        want.delete(kinds[i]);
        const m = 24;
        const x = Math.max(0, Math.floor(b.left - m)), y = Math.max(0, Math.floor(b.top - m));
        const clip = { x, y, width: Math.max(8, Math.min(vw - x, Math.ceil(b.w + m * 2))), height: Math.max(8, Math.min(vh - y, Math.ceil(b.h + m * 2))) };
        pair = { kind: kinds[i], dir: `motion/frames/hover-${kinds[i]}`, clip };
        fs.mkdirSync(path.join(outDir, pair.dir), { recursive: true });
        await page.screenshot({ path: path.join(outDir, pair.dir, 'f-00.png'), clip }).catch(() => { pair = null; });
        // a crop that changes with the pointer away (a marquee, an auto-advancing slide, a looping video) cannot
        // show a hover: no pair on it, the next element of that kind gets the pair, the entry is `invalid`
        if (pair) {
          const fa = path.join(outDir, pair.dir, 'f-00.png'), fz = path.join(outDir, pair.dir, 'f-00b.png');
          await sleep(350);
          const idle = await page.screenshot({ path: fz, clip }).then(() => pairDelta(fa, fz)).catch(() => null);
          try { fs.unlinkSync(fz); } catch {}
          if (idle && idle.changed >= PAIR_CHANGED_MIN) { b.moving = true; try { fs.unlinkSync(fa); } catch {} pair = null; want.add(kinds[i]); }
        }
      }
      await page.mouse.move(b.x, b.y, { steps: 3 });
      await sleep(Math.min(1600, b.maxMs + 180));
      // the pair's pixel difference (visual: changed share, mean delta), so data and crops can be checked
      // against each other (summary marks a disagreement WEAK; compare then judges that kind on the crops)
      // look = what the pair visibly does in words (lightens / darkens / recolours or moves / none)
      if (pair) { await page.screenshot({ path: path.join(outDir, pair.dir, 'f-01.png'), clip: pair.clip }).then(() => { const fa = path.join(outDir, pair.dir, 'f-00.png'), fb = path.join(outDir, pair.dir, 'f-01.png'); const v = pairDelta(fa, fb), lk = pairLook(fa, fb); if (v && lk) Object.assign(v, { look: lk.look, dL: lk.dL }); frames.push({ kind: pair.kind, dir: pair.dir, n: 2, visual: v }); }).catch(() => {}); }
      const d = await ev(page, (j) => window.__rc.hoverDiff(j), i, 5000);
      if (pair) d.pair = pair.dir;
      if (b.covered) d.note = 'hover point covered by another element';
      // not a valid sample of its kind (compare skips it): it moves with the pointer away, or is not shown
      if (b.moving) d.invalid = 'moves without hover';
      else if (b.shown === false) d.invalid = 'not shown (opacity ~0 or hidden)';
      out.push(d);
      await page.mouse.move(away[0], away[1]);
      await sleep(Math.min(900, b.maxMs + 100));
    } catch (e) { out.push({ kind: kinds[i], skipped: e.message.split('\n')[0].slice(0, 100) }); }
  }
  return { list: out, frames };
}

// Viewport after scrolling down 1.5 viewport heights and settling: the header's scrolled state.
async function scrolledShot(page, outDir, vp, vw, vh) {
  try {
    await page.mouse.move(Math.round(vw / 2), Math.round(vh / 2));
    for (let k = 0; k < 3; k++) { await page.mouse.wheel(0, Math.round(vh * 0.5)); await sleep(220); }
    await sleep(1200);
    const info = await ev(page, () => window.__rc.scrollInfo(), null, 5000).catch(() => null);
    if (info && info.sy < vh * 0.5 && info.vs < vh * 0.5) { await ev(page, (y) => window.scrollTo({ top: y, behavior: 'instant' }), Math.round(vh * 1.5), 5000).catch(() => {}); await sleep(900); }
    const rel = `shots/${vp}-scrolled.png`;
    await page.screenshot({ path: path.join(outDir, rel), timeout: 30000 });
    const hdr = await ev(page, () => window.__rc.pinnedHeader(), null, 5000).catch(() => null);
    return { shot: rel, hdr };
  } catch (e) { note(`scrolled screenshot failed at ${vp}: ${e.message.split('\n')[0]}`); return { shot: null, hdr: null }; }
}

async function cursorProbe(page, vw, vh) {
  try {
    await page.mouse.move(vw * 0.3, vh * 0.4);
    await sleep(250);
    const n = await ev(page, () => window.__rc.cursorProbe(0), null, 8000);
    if (!n) return { followers: [] };
    const dx = Math.round(vw * 0.25), dy = Math.round(vh * 0.2);
    await page.mouse.move(vw * 0.3 + dx, vh * 0.4 + dy, { steps: 6 });
    await sleep(500);
    return { followers: await ev(page, (d) => window.__rc.cursorProbe(d), [dx, dy], 8000) };
  } catch { return { followers: [] }; }
}

function parseCssText(text) {
  // minimal at-rule extraction: @keyframes name {...} and @font-face {...}
  const kf = {}, ff = [];
  let tl = { animationTimeline: 0, viewTimeline: 0, scrollTimeline: 0 };
  const block = (i) => { let d = 0; for (let j = i; j < text.length; j++) { if (text[j] === '{') d++; else if (text[j] === '}') { d--; if (d === 0) return j; } } return text.length; };
  const re = /@(-webkit-)?keyframes\s+([^\s{]+)\s*\{|@font-face\s*\{/g;
  let m;
  while ((m = re.exec(text))) {
    const open = text.indexOf('{', m.index);
    const end = block(open);
    const body = text.slice(open + 1, end);
    if (m[0].startsWith('@font-face')) {
      const g = (p) => { const mm = body.match(new RegExp(p + '\\s*:\\s*([^;]+)')); return mm ? mm[1].trim() : ''; };
      ff.push({ family: g('font-family').replace(/["']/g, ''), src: g('src').slice(0, 300), weight: g('font-weight'), style: g('font-style') });
    } else {
      const name = m[2].replace(/["']/g, '');
      if (!kf[name]) { const steps = []; const sr = /([^{}]+)\{([^{}]*)\}/g; let s; while ((s = sr.exec(body)) && steps.length < 8) steps.push([s[1].trim(), s[2].trim().replace(/\s+/g, ' ').slice(0, 200)]); kf[name] = steps; }
    }
    re.lastIndex = end;
  }
  tl.animationTimeline = (text.match(/animation-timeline/g) || []).length;
  tl.viewTimeline = (text.match(/view-timeline|\bview\(/g) || []).length;
  tl.scrollTimeline = (text.match(/scroll-timeline|animation-timeline:\s*scroll\(/g) || []).length;
  return { kf, ff, tl };
}

const FAMILY_CAT = [
  ['mono', /mono|code|consol|courier|menlo|monaco|jetbrains|fira code|ibm plex mono|space mono|sf mono|berkeley|input mono/i],
  ['serif', /serif(?!.*sans)|georgia|times|garamond|baskerville|caslon|merriweather|playfair|lora\b|tiempos|freight|canela|gt super|ivar|domaine|lyon|publico|spectral|fraunces|newsreader|cormorant|bodoni|didot|recoleta|editorial new|\bogg\b|crimson|source serif|libre baskerville|charter|cambria|palatino|minion|sabon|perpetua|noe display|reckless|signifier|tobias/i],
  ['display', /display|headline|poster|black|condensed|extended|druk|monument|bebas|anton|oswald|league gothic|abril|alfa slab/i],
];
function familyCategory(name, fallback, roles) {
  for (const [cat, re] of FAMILY_CAT) if (re.test(name)) { if (cat === 'serif' && /sans/i.test(name)) continue; if (cat === 'display' && roles && roles.includes('body')) continue; return cat; }
  if (fallback && /^(serif|ui-serif)$/i.test(fallback)) return 'serif';
  if (fallback && /monospace/i.test(fallback)) return 'mono';
  return 'sans';
}

function hostOf(u, base) { try { return new URL(u, base).host; } catch { return null; } }

// Removed popups/banners, de-duplicated over passes and viewports (meta.overlays, notes).
function addOverlays(meta, list, vp, phase) {
  if (!list || !list.length) return;
  meta.overlays = meta.overlays || [];
  for (const x of list) {
    const k = `${x.kind}|${x.sel || x.el}`;
    const e = meta.overlays.find((y) => `${y.kind}|${y.sel || y.el}` === k);
    if (e) { if (!e.vps.includes(String(vp))) e.vps.push(String(vp)); if (x.action === 'dismissed') e.action = 'dismissed'; continue; }
    if (meta.overlays.length >= 12) continue;
    meta.overlays.push(Object.assign({}, x, { vps: [String(vp)], phase: phase || undefined }));
    note(`${x.action} ${x.kind} popup before measuring at ${vp}: ${x.el}${x.text ? ` ("${x.text.slice(0, 50)}")` : ''} (${x.why})`);
  }
}
// A later consent / popup pass (handleConsent result): its overlays are added, and a reject click there (a
// consent banner that appeared after the first pass, e.g. a consent frame seconds after load) becomes
// meta.consent when the first pass found nothing to click.
function lateConsent(meta, r, vp, phase) {
  if (!r) return;
  addOverlays(meta, r.overlays, vp, phase);
  if (r.action === 'clicked' && (!meta.consent || meta.consent.action !== 'clicked')) {
    meta.consent = { action: 'clicked', detail: `${r.detail} (at ${vp}${phase ? `, ${phase}` : ''})` };
    note(`consent at ${vp}${phase ? ` (${phase})` : ''}: clicked ${r.detail}`);
  }
}

// Hero media in the first viewport (page settled at the top, popups gone): frames.mjs sampleMedia, the same
// code path as `inspect.mjs activity` (a 4 s screencast; rate, active, hot and how it moves from the 6 fps
// picks, diff from 12 fps over the first 1.25 s). Static images read as static; a playing video, a changing
// canvas/WebGL, a Lottie, a UI mock-up cycling its states read as moving. The load-time activity is added
// from the load frames later. With framesOut ({outDir, frames: motion.frames}) the 6 fps picks are saved to
// motion/frames/media/ (motion.frames.media): the sheets crop the media boxes from them, so small moving art
// is visible at a readable size.
async function sampleHeroMedia(page, ctx, vw, vh, framesOut = null) {
  const list = await ev(page, () => window.__rc.heroMedia(), null, 10000).catch(() => []);
  if (!list || !list.length) return [];
  const dir = framesOut ? path.join(framesOut.outDir, 'motion', 'frames', 'media') : null;
  const s = await sampleMedia(page, list.map((m) => m.box), { framesDir: dir }).catch((e) => { note('media sample failed: ' + e.message.split('\n')[0]); return null; });
  if (!s) return list;
  if (framesOut && s.frames) framesOut.frames.media = Object.assign({ dir: 'motion/frames/media' }, s.frames);
  return list.map((m, i) => Object.assign(m, { continuous: s.results[i] || null }));
}

// Each primary band scrolled to the centre of the viewport and left to settle; the band's visible rows
// (below the top 12%, where a fixed header sits) are shot and their dominant colour read. Compared with
// the same document rows of the full-page shot (taken at the scroll-0 state) this gives the settled band
// colour and shows backgrounds that change with scroll position (scroll-driven tints), whatever paints
// them (body background, a fixed layer, a pseudo-element).
// Each band is read twice from viewport shots (never from the full-page shot, whose rendering differs by how
// it was captured): `enter` = its top rows with its top edge 85% down the viewport (the colour it shows while it
// comes into view; bands that start in the first screen have none), then centred. Both read the background only:
// pixels outside media, background images and moving tracks (contentHoles); a read with < 2% of its pixels left
// is dropped. A band shorter than the read area is read over its own rows only.
async function centredBands(page, A, vw, vh) {
  const out = {};
  const t0 = Date.now();
  const list = A.sections.map((s, i) => ({ s, i })).filter(({ s }) => !s.virtual && s.role !== 'nav' && s.role !== 'ad' && !s.thirdParty && s.h >= 40);
  const go = (y) => ev(page, (v) => { try { if (window.lenis && window.lenis.scrollTo) window.lenis.scrollTo(v, { immediate: true }); } catch {} window.scrollTo({ top: v, behavior: 'instant' }); }, y, 5000).catch(() => {});
  // band rows [top, bot) of the viewport now: background colour, the shot kept (non-enumerable) for the near-tie check.
  // The band's own box is found live (bandBox: the element with the band's id): a page whose layout moved after the
  // shots (content above collapsed or grew) is read over the band's rows, not over the rows the band had then;
  // `dy` = the band's top in the analysis (and full-shot) layout minus its top now, so the rest read compares the
  // same band rows
  const read = async (s, top0) => {
    const info = await ev(page, () => window.__rc.scrollInfo(), null, 5000).catch(() => null);
    if (!info) return null;
    const sy = Math.abs(info.vs - info.sy) > 4 ? info.vs : info.sy;
    const box = await ev(page, bandBox, [s.id, s.y, sy], 8000).catch(() => null);
    const bt = box ? box.top : s.y - sy, bb = box ? box.bottom : s.y + s.h - sy;
    const top = Math.max(top0, Math.round(bt)), bot = Math.min(vh, Math.round(bb));
    if (bot - top < 24) return null;
    const holes = await ev(page, contentHoles, null, 8000).catch(() => []);
    const buf = await page.screenshot({ clip: { x: 0, y: top, width: vw, height: bot - top }, timeout: 15000 }).catch(() => null);
    if (!buf) return null;
    const png = decodePng(buf);
    const d = dominantBg(png, { x: 0, y: 0, w: png.width, h: png.height }, holes.map((h) => ({ x: h.x, y: h.y - top, w: h.w, h: h.h })), 4);
    if (!d) return null;
    const dy = Math.round(s.y - (sy + bt));
    const r = { color: d.hex, share: d.share, sy, y0: sy + top, y1: sy + bot, dy: Math.abs(dy) > 2 ? dy : undefined };
    Object.defineProperty(r, 'png', { value: png, enumerable: false });
    return r;
  };
  // the band's live top in page px (null when its element is not found)
  const liveTop = async (s) => { const info = await ev(page, () => window.__rc.scrollInfo(), null, 5000).catch(() => null); if (!info) return null; const sy = Math.abs(info.vs - info.sy) > 4 ? info.vs : info.sy; const b = await ev(page, bandBox, [s.id, s.y, sy], 8000).catch(() => null); return b ? Math.round(sy + b.top) : null; };
  for (const { s, i } of list) {
    if (Date.now() - t0 > 40000) { note(`band-centred pass stopped after 40 s (${Object.keys(out).length} of ${list.length} bands)`); break; }
    let enter = null;
    const ly = (await liveTop(s)) ?? s.y;
    const et = Math.round(ly - vh * 0.85);
    if (et > 0) { await go(et); await sleep(350); enter = await read(s, Math.round(vh * 0.85)); }
    await go(Math.max(0, Math.round(ly + s.h / 2 - vh / 2)));
    await sleep(500);
    const c = await read(s, Math.round(vh * 0.12));
    if (c) { if (enter) Object.defineProperty(c, 'enter', { value: enter, enumerable: false }); out[i] = c; }
  }
  return out;
}
// Page-side: viewport box {top, bottom} of the element whose band id is `id` (rc.idOf), the one nearest page y
// `y0` when several match (`sy` = the scroll position now); null when none is found.
function bandBox([id, y0, sy]) {
  const rc = window.__rc;
  if (!rc || !rc.idOf || !document.body) return null;
  const vw = innerWidth;
  let best = null, k = 0;
  for (const el of document.body.getElementsByTagName('*')) {
    if (++k > 40000) break;
    const r = el.getBoundingClientRect();
    if (r.height < 20 || r.width < vw * 0.3) continue;
    let ok = false; try { ok = rc.idOf(el) === id; } catch { ok = false; }
    if (ok && (!best || Math.abs(r.top + sy - y0) < Math.abs(best.top + sy - y0))) best = { top: r.top, bottom: r.bottom };
  }
  return best;
}
// Page-side: boxes (viewport px) of content that passes through an area without being its background: media
// (img, picture, video, canvas, iframe, svg >= 24 px), elements painted with a background image (< 90% of the
// viewport), and moving tracks (an element with a running transform animation: a marquee or carousel track). Page
// tints and band scroll themes are read from the pixels outside them.
function contentHoles() {
  const vw = innerWidth, vh = innerHeight, out = [];
  const push = (r) => { if (r.width >= 24 && r.height >= 24 && r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw) out.push({ x: Math.round(Math.max(0, r.left)), y: Math.round(Math.max(0, r.top)), w: Math.round(Math.min(vw, r.right) - Math.max(0, r.left)), h: Math.round(Math.min(vh, r.bottom) - Math.max(0, r.top)) }); };
  let k = 0;
  for (const el of document.body ? document.body.getElementsByTagName('*') : []) {
    if (++k > 20000 || out.length > 400) break;
    if (/^(IMG|PICTURE|VIDEO|CANVAS|IFRAME|SVG)$/i.test(el.tagName)) { if (!el.ownerSVGElement) push(el.getBoundingClientRect()); continue; }
    if (el.ownerSVGElement || el.closest('[data-rc-overlay]')) continue;
    const r = el.getBoundingClientRect();
    if (r.bottom <= 0 || r.top >= vh || r.width < 24 || r.height < 24) continue;
    const bi = getComputedStyle(el).backgroundImage;
    if (bi && /url\(/.test(bi) && r.width * r.height < vw * vh * 0.9) push(r);
  }
  for (const a of document.getAnimations()) {
    const t = a.effect && a.effect.target;
    if (!t || !t.getBoundingClientRect || a.playState !== 'running') continue;
    let kf = []; try { kf = a.effect.getKeyframes(); } catch { kf = []; }
    if (kf.some((f) => f.transform || f.translate)) push(t.getBoundingClientRect());
  }
  return out;
}
// Scroll-driven page tint: at each rest of the scroll pass the dominant colour of the middle 70% of the
// viewport is compared with the same document rows of the scroll-0 full shot; a rest whose colour differs
// (OKLab > 0.02, both colours >= 30% of the rows) shows a background that changes with scroll position,
// whatever paints it (body background, a fixed layer, a pseudo-element). Rests inside the range of a
// sticky/pinned element >= half a viewport tall are skipped (the full shot shows such a section unpinned;
// fixed layers are kept: a full-page shot shows them in their scroll-0 state, which is the comparison).
// Consecutive flagged rests of a similar colour count as one change. Bands found settling to a different
// colour when centred (bg.scrollTheme) are added.
function scrollTintOf(pass, png, vh, sticky, bandAt, themes, inViewShare = () => 0) {
  if (!pass || !pass.tintSamples || !png) return null;
  const pinned = sticky.filter((x) => x.kind !== 'fixed' && (x.hFrac || 0) >= 0.5 && Array.isArray(x.range)).map((x) => x.range);
  const colors = [];
  let prev = null;
  for (const t of pass.tintSamples) {
    if (pinned.some(([a, b]) => t.vs >= a - 1 && t.vs <= b + 1)) { prev = null; continue; }
    // rows the full shot only shows once in view (content mounted or painted while in view): their colour at a
    // rest is that content, not a page tint
    if (inViewShare(Math.round(t.vs + vh * 0.15), Math.round(t.vs + vh * 0.85)) >= 0.3) { prev = null; continue; }
    // the page was a different height at this rest (lazy content still arriving): rows do not line up
    if (t.docH && Math.abs(t.docH - png.height) > Math.max(40, png.height * 0.01) && png.height < 19990) { prev = null; continue; }
    const y0 = Math.round(t.vs + vh * 0.15), y1 = Math.min(png.height, Math.round(t.vs + vh * 0.85));
    if (y1 - y0 < 40 || y0 >= png.height) continue;
    const rect = { x: 0, y: y0, w: png.width, h: y1 - y0 };
    // background only, the same pixels as the live sample: media, background images and moving tracks left out
    // (content passing through the rows, e.g. a marquee of coloured images, is not a page tint)
    const rest = t.holes ? dominantBg(png, rect, t.holes, 6) : dominant(png, rect, 6);
    const dd = rest ? dHex(rest.hex, t.color) : null;
    // a tint is a colour the scroll-0 page does not show in those rows at all (not a near-tie between two
    // colours that flips with a few px of offset, e.g. card fill vs gaps)
    const present = (hex) => topColors(png, rect, 6, 6, 0.02).some((c) => c.share >= 0.15 && (dHex(c.hex, hex) ?? 1) <= 0.02);
    if (rest && dd !== null && dd > 0.02 && rest.hex !== t.color && t.share >= 0.3 && rest.share >= 0.3 && !present(t.color)) {
      if (!(prev && (dHex(prev.color, t.color) ?? 1) < 0.02)) colors.push({ at: t.vs, band: bandAt(y0 + vh * 0.35), color: t.color, rest: rest.hex });
      prev = t;
    } else prev = null;
  }
  for (const th of themes || []) if (!colors.some((c) => c.band === th.band)) colors.push(th);
  colors.sort((a, b) => a.at - b.at);
  return { changes: colors.length, colors: colors.slice(0, 12), rests: pass.tintSamples.length, how: 'background colour (media, background images and moving tracks left out) of the middle of the viewport at each scroll rest vs the same rows of the scroll-0 full shot, and of each band centred vs the same band coming into view' };
}
// The tinted band's colour per state, from the evidence the capture has: before = the full-page shot's
// colour of those rows (taken at the scroll-0 state: how the band looks before it is scrolled to);
// entering = the colour at the scroll rest where the change was seen, with the band's top edge `bandTop`
// down the viewport (only when that edge was in view, -0.1..1); centred = the band-centred pass (band
// centred, page settled), with `top` = its top edge then. `shape` says it in words: `flash on entry`
// (before -> entering colour while the top edge is in view -> before again when centred), `changed while in
// view` (the change holds when centred), or null.
function tintStates(tint, secs, centred, vh) {
  if (!tint || !tint.colors) return;
  for (const c of tint.colors) {
    const i = c.band ? secs.findIndex((x) => x.id === c.band) : -1;
    if (i < 0) continue;
    const sec = secs[i], cen = centred && centred[i];
    const st = { before: c.rest || null };
    const top = typeof c.at === 'number' ? (sec.y - c.at) / vh : null;
    const fromRest = !(cen && Math.abs((cen.sy ?? -1) - c.at) < 2);
    if (fromRest && top !== null && top >= -0.1 && top <= 1) st.entering = { color: c.color, bandTop: r2(top) };
    if (cen && cen.color) st.centred = { color: cen.color, top: r2((sec.y - cen.sy) / vh) };
    const near = (a, b) => (dHex(a, b) ?? 1) <= 0.03;
    c.states = st;
    c.shape = st.entering && st.centred && st.before ? (near(st.centred.color, st.before) && !near(st.entering.color, st.before) ? 'flash on entry' : near(st.centred.color, st.entering.color) ? 'changed while in view' : null) : null;
  }
}
const dOk = differenceEuclidean('oklab');
const dHex = (a, b) => { try { return a && b ? dOk(a, b) : null; } catch { return null; } };

// Where each scroll tint / band scroll theme starts and how long it takes (fresh page, no input but
// scrolling). From 1.5 scroll steps before the rest where the change was seen, the page is scrolled in
// 30 px steps; 150 ms after each step the dominant colour of the band's visible rows (below the top 12%;
// the middle 70% of the viewport for a tint without a band) is compared with the same rows of the scroll-0
// full shot. The first position where it has moved >= 15% of the way to the tint colour (and is nearer it
// than any other tint colour) is the trigger: `triggerAt` (scroll px), `triggerBand` (the tinted band when
// its top is in view, else the band entering the viewport) and `bandTop` (that band's top edge as a fraction
// of the viewport height then; 0.6 = the change starts when its top is 60% down the viewport). The page is then held still and
// sampled until the colour stays within OKLab 0.004 of its final value: `ms` = time from that scroll step to
// settled. A colour that stops part-way is scroll-scrubbed (`scrub`, `rangePx` = scroll distance until it
// is >= 85% of the way). Writes the fields onto motion.scrollTint.colors[] and the band's bg.scrollTheme.
async function probeTints(ctx, o, pw, ph, tint, sections, png) {
  if (!tint || !tint.colors || !tint.colors.length || !png) return;
  const t0 = Date.now();
  const { page, st } = await openPage(ctx, pw, ph, {});
  try {
    await page.goto(o.url, { waitUntil: 'domcontentloaded', timeout: o.timeout });
    await settle(page, st, { loadCap: Math.min(o.timeout, 25000), quietCap: 8000 });
    await ensureRc(page);
    await handleConsent(page).catch(() => null);
    await overlayPass(page, { allowClick: false }).catch(() => null);
    await unrollInner(page, pw);
    await page.mouse.move(4, Math.round(ph / 2)).catch(() => {});
    const scrollTo = (y) => ev(page, (v) => { try { if (window.lenis && window.lenis.scrollTo) window.lenis.scrollTo(v, { immediate: true }); } catch {} window.scrollTo({ top: v, behavior: 'instant' }); }, y, 5000).catch(() => {});
    const stepPx = Math.round(ph * 0.75);
    for (const c of tint.colors) {
      if (Date.now() - t0 > 40000) { note('scroll tint timing stopped after 40 s'); break; }
      const band = c.band ? sections.find((s) => s.id === c.band) : null;
      const others = tint.colors.filter((o) => o !== c && o.color && (dHex(o.color, c.color) ?? 0) > 0.01).map((o) => o.color);
      const rows = (p) => {
        let top = Math.round(ph * 0.15), bot = Math.round(ph * 0.85);
        if (band) { top = Math.max(Math.round(ph * 0.12), Math.round(band.y - p)); bot = Math.min(Math.round(ph * 0.95), Math.round(band.y + band.h - p)); }
        return bot - top >= 40 && p + bot <= png.height ? [top, bot] : null;
      };
      const read = async (p) => {
        const rr = rows(p);
        if (!rr) return null;
        const buf = await page.screenshot({ clip: { x: 0, y: rr[0], width: pw, height: rr[1] - rr[0] }, timeout: 10000 }).catch(() => null);
        if (!buf) return null;
        const lp = decodePng(buf);
        const live = dominant(lp, { x: 0, y: 0, w: lp.width, h: lp.height }, 6) || null;
        // a band theme read while the band came into view keeps that rest colour (not the full shot's rows)
        const th = band && band.bg && band.bg.scrollTheme;
        const rest = th && th.restFrom === 'entering' ? { hex: th.rest } : dominant(png, { x: 0, y: p + rr[0], w: png.width, h: rr[1] - rr[0] }, 6);
        if (!live || !rest) return null;
        const D = dHex(rest.hex, c.color) ?? 0;
        const toRest = dHex(live.hex, rest.hex) ?? 0, toTint = dHex(live.hex, c.color) ?? 1;
        // with several tints, the colour must be nearer this one than any other (the lighter first step of a
        // two-step tint is not the start of the second)
        const nearest = others.every((o) => toTint < (dHex(live.hex, o) ?? 1));
        return { live: live.hex, rest: rest.hex, D, f: D > 0.004 ? Math.max(0, Math.min(1, (D - toTint) / D)) : 0, moved: D > 0.004 && toRest >= Math.max(0.006, 0.15 * D) && toTint < D && nearest };
      };
      // from 1.5 steps before the rest where it was seen (further back when the colour has already changed
      // the first time its rows are readable), forward in 30 px steps until the colour starts to change
      let trig = null, tScroll = 0, early = false;
      for (let back = 0, start = Math.max(0, Math.round(c.at - 1.5 * stepPx)); back < 3 && !trig; back++, start = Math.max(0, start - stepPx)) {
        await scrollTo(start); await sleep(1000);
        let seen = false;
        for (let p = start; p <= c.at + Math.round(stepPx * 0.5); p += 30) {
          tScroll = Date.now();
          if (p > start) { await scrollTo(p); await sleep(150); }
          const r = await read(p);
          if (!r) continue;
          if (r.moved) { if (!seen) { early = true; break; } trig = { p, r }; break; }
          seen = true;
        }
        if (trig || !early || start === 0) break;
        early = false;
      }
      if (!trig) { c.triggerAt = null; if (early) c.early = true; continue; }
      // hold still: sample until settled
      const series = [];
      while (Date.now() - tScroll < 2600) { const r = await read(trig.p); if (r) series.push([Date.now() - tScroll, r]); }
      if (!series.length) { c.triggerAt = null; continue; }
      const fin = series[series.length - 1][1];
      let k = series.length - 1;
      while (k > 0 && (dHex(series[k - 1][1].live, fin.live) ?? 1) <= 0.004) k--;
      const settledMs = series[k][0];
      c.triggerAt = trig.p;
      // reference band: the tinted band when its top is in view (or just above it), else the band whose top
      // is entering the viewport (a tint shown in a tall band is triggered by the next band coming in)
      const inView = (s) => s && s.y - trig.p >= -0.1 * ph && s.y - trig.p <= ph;
      const refBand = inView(band) ? band : sections.filter((s) => !s.virtual && s.role !== 'nav' && !s.thirdParty && s.y - trig.p > 0 && s.y - trig.p <= ph).sort((a, b) => a.y - b.y)[0] || band;
      c.triggerBand = refBand ? refBand.id : null;
      c.bandTop = refBand ? r2((refBand.y - trig.p) / ph) : null;
      if (fin.f >= 0.7 || settledMs >= 2400) c.ms = settledMs >= 2400 ? null : settledMs;
      else {
        // stopped part-way: the colour follows the scroll position
        c.scrub = true; c.ms = null;
        let q = trig.p, fq = fin.f;
        while (fq < 0.85 && q < trig.p + 2 * stepPx) { q += 30; await scrollTo(q); await sleep(150); const r = await read(q); if (r) fq = r.f; }
        c.rangePx = q - trig.p;
      }
      const s = band && band.bg && band.bg.scrollTheme;
      if (s && typeof s === 'object') Object.assign(s, { triggerAt: c.triggerAt, triggerBand: c.triggerBand, bandTop: c.bandTop, ms: c.ms, scrub: c.scrub, rangePx: c.rangePx });
    }
    tint.timing = 'triggerAt: scroll px where the colour starts to change (30 px steps, read 150 ms after each); bandTop: top edge of triggerBand (the tinted band when its top is in view, else the band entering the viewport) as a fraction of the viewport height then; ms: time from that step until it settles; scrub/rangePx: it follows the scroll position instead';
  } finally { await page.close().catch(() => {}); }
}

// <outDir>/done.json: written last (the stdout summary line, or {ok:false,error}, with `startedAt`), so a
// capture run in the background can be waited for: `capture.mjs --wait <outDir> [--timeout-s 600]` polls for
// it, prints it and exits 0 (ok) or 1 (failed, or not there before the timeout; 3 = timeout while the
// capture's pid from started.json is still alive). The very first thing a
// capture does is delete <outDir>/done.json and write <outDir>/started.json {pid, startedAt}. --wait waits
// WAIT_GRACE_MS before its first look (a capture launched just before it has started by then) and takes a
// done.json only when it belongs to the latest start: same startedAt as started.json (or no started.json).
// A done.json from an earlier run while a newer capture is starting or running is ignored.
let DONE_FILE = null, STARTED_AT = null;
const WAIT_GRACE_MS = 4000;
const writeDone = (obj) => { try { if (DONE_FILE) fs.writeFileSync(DONE_FILE, JSON.stringify(Object.assign({}, obj, { startedAt: STARTED_AT || undefined })) + '\n'); } catch { /* best effort */ } };
function markStart(argv) {
  // the output dir is the second positional argument (flags that take a value are skipped)
  const takes = new Set(['--viewports', '--frames-like', '--timeout']);
  const pos = []; for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (takes.has(a)) { i++; continue; } if (!a.startsWith('--')) pos.push(a); }
  if (pos.length < 2) return;
  const dir = path.resolve(pos[1]);
  try { fs.rmSync(path.join(dir, 'done.json'), { force: true }); } catch { /* best effort */ }
  STARTED_AT = new Date().toISOString();
  try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'started.json'), JSON.stringify({ pid: process.pid, startedAt: STARTED_AT }) + '\n'); } catch { /* best effort */ }
}
async function waitDone(argv) {
  const ti = argv.indexOf('--timeout-s');
  const dir = argv.find((a, i) => !a.startsWith('--') && (ti < 0 || i !== ti + 1));
  const limit = (ti >= 0 ? Number(argv[ti + 1]) : 600) * 1000 || 600000;
  if (!dir) throw new Error('usage: node capture.mjs --wait <outDir> [--timeout-s 600]');
  const f = path.join(path.resolve(dir), 'done.json'), sf = path.join(path.resolve(dir), 'started.json');
  const t = Date.now();
  await sleep(WAIT_GRACE_MS);
  const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
  while (Date.now() - t < limit) {
    if (fs.existsSync(f)) {
      await sleep(200);
      let txt = ''; try { txt = fs.readFileSync(f, 'utf8').trim(); } catch { /* removed meanwhile */ }
      let d = null; try { d = JSON.parse(txt); } catch { /* partial write */ }
      const st = readJson(sf);
      // a done.json of an earlier run while a newer capture is starting or running: keep waiting
      if (d && !(st && st.startedAt && d.startedAt !== st.startedAt)) { console.log(txt); process.exit(d.ok === true ? 0 : 1); }
    }
    await sleep(2000);
  }
  // timed out: exit 3 while the latest capture's process is still alive (run the same --wait again: it
  // returns that run's done.json once written, even if it finished in between), else 1 (it died or never ran)
  const st = readJson(sf);
  let alive = false;
  if (st && Number.isInteger(st.pid)) { try { process.kill(st.pid, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; } }
  if (alive) {
    console.log(JSON.stringify({ ok: false, running: true, pid: st.pid, startedAt: st.startedAt, waitedS: Math.round(limit / 1000) }));
    console.error(`capture --wait: the capture (pid ${st.pid}) is still running after ${Math.round(limit / 1000)} s; run the same --wait again`);
    process.exit(3);
  }
  console.error(`capture --wait: no ${f} from the latest capture after ${Math.round(limit / 1000)} s`);
  process.exit(1);
}

async function main() {
  const t0 = Date.now();
  if (process.argv[2] === '--wait') return waitDone(process.argv.slice(3));
  markStart(process.argv.slice(2));
  const o = parseArgs(process.argv.slice(2));
  const { outDir } = o;
  fs.mkdirSync(outDir, { recursive: true });
  DONE_FILE = path.join(outDir, 'done.json');
  fs.rmSync(DONE_FILE, { force: true });
  fs.mkdirSync(path.join(outDir, 'shots'), { recursive: true });
  fs.mkdirSync(path.join(outDir, 'motion', 'frames'), { recursive: true });
  for (const f of fs.readdirSync(path.join(outDir, 'shots'))) if (/\.png$/.test(f)) fs.unlinkSync(path.join(outDir, 'shots', f));
  fs.rmSync(path.join(outDir, 'motion', 'frames'), { recursive: true, force: true });
  fs.mkdirSync(path.join(outDir, 'motion', 'frames'), { recursive: true });

  const browser = await launchChrome();
  const watchdog = setTimeout(() => { console.error('capture: hard time limit (8 min) reached'); writeDone({ ok: false, error: 'hard time limit (8 min) reached' }); process.exit(3); }, 8 * 60 * 1000);
  let doneLine = null;
  try {
    const ua = userAgentFor(browser);
    const ctx = await newCaptureContext(browser);
    const out = { schema: 'restyle-capture/2', meta: {}, sections: [], sectionsByViewport: {}, colors: {}, type: { roles: {}, scale: {}, bodyPx: {} }, spacing: { container: {}, sectionPad: {}, gaps: {}, stack: {} }, components: {}, hover: [], motion: {}, shots: {}, notes };
    const meta = out.meta;
    Object.assign(meta, { url: o.url, finalUrl: null, title: null, time: new Date().toISOString(), runMs: null, status: null, blocked: null, userAgent: ua, viewports: o.viewports, fast: o.fast || undefined, partial: o.fast ? ['viewports: largest only', 'motion frames', 'hover', 'scrolled shots at other viewports'] : undefined, pageHeight: {}, libraries: [], consoleErrors: {}, consoleSample: [], overflowX: {}, consent: null, overlays: [], stylesheets: null, settle: {}, segmentation: {} });

    // ================= primary viewport =================
    const PV = o.viewports[0];
    const [pw, ph] = VP[PV] || [PV, Math.round(PV * 0.625)];
    progress(`loading ${o.url} at ${PV}`);
    const { page, st } = await openPage(ctx, pw, ph, { load: true, captureCss: true, hideCmp: o.motionFrames });
    const commitRef = { ts: null };
    page.on('framenavigated', (f) => { if (f === page.mainFrame() && !commitRef.ts && f.url() !== 'about:blank') commitRef.ts = Date.now(); });
    let sc = null;
    if (o.motionFrames) sc = await startScreencast(page, { width: pw, height: ph }).catch((e) => { note('screencast unavailable: ' + e.message.split('\n')[0]); return null; });
    let resp;
    try { resp = await page.goto(o.url, { waitUntil: 'commit', timeout: o.timeout }); }
    catch (e) { throw new Error(`navigation failed: ${e.message.split('\n')[0]}`); }
    if (!commitRef.ts) commitRef.ts = Date.now();
    meta.status = resp ? resp.status() : null;
    const motion = out.motion;
    motion.frames = { load: null, reveals: [] };
    if (sc) {
      // cold run: kept apart; the warm run (end of capture) normally provides motion/frames/load
      const fl = await grabLoadFrames(sc, commitRef, path.join(outDir, 'motion', 'frames', 'load-cold'), page);
      if (fl) { motion.frames.load = Object.assign({ dir: 'motion/frames/load-cold' }, fl, { run: 'cold' }); Object.defineProperty(motion.frames.load, 'picked', { value: fl.picked, enumerable: false }); }
      else note('no screencast frames after navigation commit; load frames missing');
    }
    await page.waitForLoadState('domcontentloaded', { timeout: o.timeout }).catch(() => note('domcontentloaded not reached within timeout'));
    // consent is handled normally from here on (reject button or overlay hiding)
    await ev(page, () => { const st = document.getElementById('rc-cmp-hide'); if (st) st.remove(); }, null, 5000).catch(() => {});
    meta.settle[PV] = await settle(page, st, { loadCap: Math.min(o.timeout, 30000), quietCap: 10000 });
    if (!meta.settle[PV].load) note(`load event not reached within cap at ${PV}`);
    if (!meta.settle[PV].quiet) note(`network never went quiet at ${PV} (capped wait)`);
    await ensureRc(page);
    // let the load sampler finish (it stops itself once the first screen is still, or at DCL + 5 s)
    await page.waitForFunction(() => !window.__rc || !window.__rc.load || window.__rc.load.done, null, { timeout: 7000, polling: 100 }).catch(() => {});
    meta.finalUrl = page.url();
    meta.title = await page.title().catch(() => null);
    meta.blocked = await blockedCheck(page, meta.status);
    // consent and popups are dismissed (or hidden) BEFORE anything is measured; their subtrees are marked
    // and left out of load motion, sticky, roles, palette and components
    meta.consent = await handleConsent(page).catch((e) => ({ action: 'error', detail: e.message.split('\n')[0], overlays: [] }));
    addOverlays(meta, meta.consent.overlays, PV);
    delete meta.consent.overlays;
    if (meta.consent.action === 'clicked' || meta.consent.action === 'dismissed') { await networkQuiet(st, 400, 4000); await ensureRc(page); }
    const loadRaw = await ev(page, () => window.__rc.loadResult(), null, 10000, 'loadResult').catch((e) => { note('load sampler: ' + e.message); return null; });
    await unrollInner(page, PV, meta);
    // ---- motion measurement (nothing has scrolled yet) ----
    progress(`settled (${meta.settle[PV].ms} ms); consent ${meta.consent && meta.consent.action}; motion pass at ${PV}`);
    let snap = null, idle = null, pass = null, tinfo = [], heroMedia = null, auto = null;
    try {
      await ev(page, (m) => window.__rc.waitAnimsIdle(m), 2500, 5000).catch(() => null);
      // popups and consent banners that arrive a little later (newsletter boxes after a delay, a consent frame
      // seconds after load) are removed before the snapshot
      lateConsent(meta, await handleConsent(page).catch(() => null), PV);
      // slow watch for auto-advance (long periods): runs, with the pointer parked and no input, through the
      // hero-media sample, the snapshot and the idle sample, and is read after at least WATCH_MS in total
      await page.mouse.move(4, Math.round(ph / 2)).catch(() => {});
      await ev(page, () => window.__rc.watchStart(), null, 5000).catch((e) => note('slow watch not started: ' + e.message.split('\n')[0]));
      if (!o.fast) heroMedia = await sampleHeroMedia(page, ctx, pw, ph, o.motionFrames ? { outDir, frames: motion.frames } : null);
      else await ev(page, () => window.__rc.heroMedia(), null, 10000).catch(() => null); // media boxes only (motion inside them is not ambient)
      snap = await ev(page, () => window.__rc.snapshot(), null, 40000, 'snapshot');
      if (snap.capped) note(`${snap.hiddenTotal} hidden-ish elements before scrolling; tracked the 2000 largest`);
      idle = await ev(page, (ms) => window.__rc.idleSample(ms), 1500, 15000, 'idle sample');
      const watched = await ev(page, () => window.__rc.watchElapsed(), null, 5000).catch(() => WATCH_MS);
      if (watched < WATCH_MS) await sleep(WATCH_MS - watched);
      auto = await ev(page, () => window.__rc.watchResult(), null, 15000, 'slow watch').catch((e) => { note('slow watch: ' + e.message.split('\n')[0]); return null; });
      await page.mouse.move(4, Math.round(ph / 2));
      pass = await stepPass(page, pw, ph, o.fast ? 40000 : 75000);
      const changed = [...new Set(pass.steps.flatMap((s) => s.changes.map((c) => c.i)))];
      tinfo = await ev(page, (ids) => window.__rc.trackedInfo(ids), changed, 20000, 'trackedInfo');
      // layout elements that turned out to be popups / third-party (found after the snapshot) never count as sticky or parallax
      const ovIdx = await ev(page, () => window.__rc.overlayLayoutIdx(), null, 15000).catch(() => []);
      if (ovIdx.length) for (const r of pass.rests) for (const j of ovIdx) if (r.L) r.L[j] = null;
    } catch (e) { note('motion pass failed: ' + e.message.split('\n')[0]); }
    await scrollTop(page);
    await networkQuiet(st, 500, 5000);
    await sleep(700);
    const late = await handleConsent(page, { allowClick: false, reject: true }).catch(() => null);
    if (late && late.overlays && late.overlays.length) note(`late overlay hidden before screenshots: ${late.detail}`);
    lateConsent(meta, late, PV, 'late');
    await scrollTop(page);
    progress(`scroll pass done (${pass ? pass.steps.length : 0} steps); screenshots and analysis at ${PV}`);
    out.shots[PV] = await takeShots(page, outDir, pw, ph);
    if (!out.shots[PV].full) throw new Error(`full screenshot failed at ${PV}`);
    let A = null;
    try { A = await ev(page, (x) => window.__rc.analyze(x), { full: true }, 90000, 'analyze'); }
    catch (e) {
      // retried once (the page may have navigated or re-rendered under the analysis); a second failure fails the capture
      note(`analysis at ${PV} failed (${e.message.split('\n')[0]}); retried once`);
      await networkQuiet(st, 500, 5000); await ensureRc(page); await scrollTop(page);
      try { A = await ev(page, (x) => window.__rc.analyze(x), { full: true }, 90000, 'analyze'); }
      catch (e2) { throw new Error(`analysis failed twice at ${PV}: ${e2.message.split('\n')[0]}`); }
    }
    for (const n of A.notes) note(`${PV}: ${n}`);
    // role ink from DOM probes (page-analyze lays them out, one screenshot here)
    await probeInk(page, A).catch((e) => note(`${PV}: ink probes failed: ${e.message.split('\n')[0]}`));
    await fillBlankBands(page, outDir, pw, ph, A, out.shots[PV]).catch((e) => note(`${PV}: blank band fill failed: ${e.message.split('\n')[0]}`));
    await ev(page, thawScrollAnims, null, 5000).catch(() => {});
    // each band centred in the viewport after the page settles: settled band colours and scroll-driven tints
    progress(`${A.sections.length} bands at ${PV}; band-centred pass, scrolled shot, hover`);
    const centred = await centredBands(page, A, pw, ph).catch((e) => { note('band-centred pass failed: ' + e.message.split('\n')[0]); return null; });
    await scrollTop(page);
    const scr = await scrolledShot(page, outDir, PV, pw, ph);
    if (scr.shot) out.shots[PV].scrolled = scr.shot;
    await scrollTop(page);
    const cursor = await cursorProbe(page, pw, ph);
    motion.frames.hover = [];
    if (o.hover && A.hoverTargets.length) {
      const hp = await hoverPass(page, A.hoverTargets.length, A.hoverTargets.map((h) => h.kind), { outDir, vw: pw, vh: ph, pairs: o.motionFrames });
      out.hover = hp.list; motion.frames.hover = hp.frames;
    } else { out.hover = []; if (!o.hover) note('hover pass skipped (--fast)'); }
    // scroll-driven animations on the header: its scrolled state, not scroll-scrubbed content
    const navAnims = await ev(page, () => window.__rc.navScrollAnims(), null, 5000).catch(() => null);
    meta.consoleErrors[PV] = st.errors;
    meta.consoleSample = st.samples;
    meta.pageHeight[PV] = A.docH;
    meta.overflowX[PV] = A.overflow;
    meta.libraries = A.libraries || [];
    meta.segmentation[PV] = A.seg;
    // stylesheets: CSSOM for readable sheets, captured response bodies for the rest
    const sheets = (A.motionStatic && A.motionStatic.sheets) || [];
    const unreadable = sheets.filter((s) => !s.readable && s.href);
    let fetched = 0;
    const extra = { kf: {}, ff: [], tl: { animationTimeline: 0, viewTimeline: 0, scrollTimeline: 0 } };
    const missing = [];
    for (const s of unreadable) {
      let text = st.css.get(s.href);
      if (text === undefined) {
        try { const r = await ctx.request.get(s.href, { timeout: 10000 }); if (r.ok()) { text = await r.text(); } } catch { /* ignore */ }
      }
      if (text === undefined) { missing.push(hostOf(s.href) || s.href.slice(0, 80)); continue; }
      fetched++;
      const p = parseCssText(text.slice(0, 3e6));
      for (const [k, v] of Object.entries(p.kf)) if (!extra.kf[k]) extra.kf[k] = v;
      for (const f of p.ff) { f.base = s.href; extra.ff.push(f); }
      for (const k of Object.keys(extra.tl)) extra.tl[k] += p.tl[k];
    }
    meta.stylesheets = { total: sheets.length, readable: sheets.filter((s) => s.readable).length, fetched, unreadable: [...new Set(missing)].slice(0, 10) };
    if (missing.length) note(`${missing.length} cross-origin stylesheet(s) could not be read (keyframes/@font-face from them missing)`);
    await page.close().catch(() => {});

    // ================= other viewports =================
    const primaryReal = A.sections.filter((s) => !s.virtual);
    const bandSigs = primaryReal.map((s) => s.sigs);
    const others = {};
    for (const vp of o.viewports.slice(1)) {
      const [w, h] = VP[vp] || [vp, Math.round(vp * 1.6)];
      // a viewport whose capture throws (analysis, shots) is retried once on a fresh page; a second failure
      // fails the whole capture (exit non-zero): a capture never silently drops a viewport
      for (let attempt = 1; attempt <= 2; attempt++) {
      progress(`viewport ${vp}${attempt > 1 ? ' (retry)' : ''}`);
      let p2 = null;
      try {
        const op = await openPage(ctx, w, h, {});
        p2 = op.page;
        await p2.goto(o.url, { waitUntil: 'domcontentloaded', timeout: o.timeout });
        meta.settle[vp] = await settle(p2, op.st, { loadCap: Math.min(o.timeout, 25000), quietCap: 8000 });
        await ensureRc(p2);
        const c2 = await handleConsent(p2).catch(() => null);
        if (c2 && c2.action !== 'none' && c2.action !== 'clicked' && c2.action !== meta.consent.action) note(`consent at ${vp}: ${c2.action} ${c2.detail || ''}`);
        lateConsent(meta, c2, vp);
        await ev(p2, (m) => window.__rc.waitAnimsIdle(m), 2500, 5000).catch(() => null);
        lateConsent(meta, await handleConsent(p2).catch(() => null), vp);
        await unrollInner(p2, vp, meta);
        await ev(p2, () => window.__rc.snapshot(), null, 40000, 'snapshot');
        // marquees at this width: a short idle sample (motion.marqueesByViewport; bands mapped after analysis)
        const idle2 = await ev(p2, (ms) => window.__rc.idleSample(ms), 900, 10000).catch(() => null);
        if (idle2) (motion.marqueesByViewport ||= {})[vp] = (idle2.continuous || []).filter((m) => m.kind === 'marquee').map((m) => ({ el: m.desc, y: m.y, axis: m.axis, dir: m.dir, pxPerSec: m.pxPerSec, css: m.css ? m.css.map((c) => `${c.name || c.prop} ${c.dur}ms ${c.easing} ${c.iter}`).join('; ') : 'js' }));
        await p2.mouse.move(4, Math.round(h / 2));
        await fastPass(p2, w, h);
        const revealCount = await ev(p2, () => window.__rc.revealCount(), null, 20000).catch(() => null);
        await scrollTop(p2);
        await networkQuiet(op.st, 400, 4000);
        await sleep(600);
        const late2 = await handleConsent(p2, { allowClick: false, reject: true }).catch(() => null);
        lateConsent(meta, late2, vp, 'late');
        await scrollTop(p2);
        out.shots[vp] = await takeShots(p2, outDir, w, h);
        if (!out.shots[vp].full) throw new Error(`full screenshot failed at ${vp}`);
        const A2 = await ev(p2, (x) => window.__rc.analyze(x), { full: false, bandSigs }, 90000, 'analyze');
        for (const n of A2.notes) note(`${vp}: ${n}`);
        await probeInk(p2, A2).catch((e) => note(`${vp}: ink probes failed: ${e.message.split('\n')[0]}`));
        await fillBlankBands(p2, outDir, w, h, A2, out.shots[vp]).catch((e) => note(`${vp}: blank band fill failed: ${e.message.split('\n')[0]}`));
        await ev(p2, thawScrollAnims, null, 5000).catch(() => {});
        const scr2 = await scrolledShot(p2, outDir, vp, w, h);
        if (scr2.shot && out.shots[vp]) out.shots[vp].scrolled = scr2.shot;
        others[vp] = { A: A2, revealCount, scrolledHdr: scr2.hdr };
        meta.consoleErrors[vp] = op.st.errors;
        meta.pageHeight[vp] = A2.docH;
        meta.overflowX[vp] = A2.overflow;
        meta.segmentation[vp] = A2.seg;
        if (p2) await p2.close().catch(() => {});
        break;
      } catch (e) {
        if (p2) await p2.close().catch(() => {});
        const msg = e.message.split('\n')[0];
        if (attempt >= 2) throw new Error(`viewport ${vp} failed twice: ${msg}`);
        note(`viewport ${vp} failed (${msg}); retried once on a fresh page`);
      }
      }
    }

    // full shots still blank after both fills: one warning that states the share for every width (page height in
    // content bands still flat, and text area with no ink)
    {
      const bl = o.viewports.map((vp) => [vp, out.shots[vp] && out.shots[vp].blank]).filter(([, b]) => b);
      if (bl.some(([, b]) => (b.rows || 0) >= 0.1 || (b.after || 0) >= 0.2)) note(`WARNING full shots still blank: ${bl.map(([vp, b]) => `${vp} ${Math.round((b.rows || 0) * 100)}% of the page height${b.bands ? ` (bands ${b.bands.join(',')})` : ''}, ${typeof b.after === 'number' ? `${Math.round(b.after * 100)}% of its text` : 'text not comparable (page height changed after the shot)'}`).join('; ')} (shots[vp].blank): read those bands from the fold, scrolled and reveal frames, not the full shot`);
    }

    // ================= assemble: sections =================
    const sectionOfY = (y) => { let idx = null; for (const s of A.sections) if (!s.virtual && y >= s.y - 1 && y < s.y + s.h) idx = A.sections.indexOf(s); return idx; };
    const pngCache = {};
    const fullPng = (vp) => {
      if (pngCache[vp] !== undefined) return pngCache[vp];
      const sh = out.shots[vp];
      try { pngCache[vp] = sh && sh.full ? readPng(path.join(outDir, sh.full)) : null; } catch { pngCache[vp] = null; }
      return pngCache[vp];
    };
    // the scroll-0 state of the full shot (before scroll-driven animations were paused in view or rows were
    // filled from in-view shots): what scroll tints and band scroll themes are compared against
    const restCache = {};
    const restPng = (vp) => {
      if (restCache[vp] !== undefined) return restCache[vp];
      const sh = out.shots[vp];
      try { restCache[vp] = sh && sh.fullRest ? readPng(path.join(outDir, sh.fullRest)) : fullPng(vp); } catch { restCache[vp] = fullPng(vp); }
      return restCache[vp];
    };
    // page rows [y, y + h) from the full shot and its tail shots (bands past the full shot's height cap)
    const tailCache = {};
    const docRows = (vp, y, h) => {
      const sh = out.shots[vp], main = fullPng(vp);
      if (!sh || !main || !sh.tails || !sh.tails.length) return null;
      const parts = [{ png: main, y: 0 }];
      for (const t of sh.tails) { if (tailCache[t.file] === undefined) { try { tailCache[t.file] = readPng(path.join(outDir, t.file)); } catch { tailCache[t.file] = null; } } if (tailCache[t.file]) parts.push({ png: tailCache[t.file], y: t.y }); }
      return rowsOf(parts, y, h);
    };
    // share of document rows [a, b) that the full shot at vp took from in-view shots
    const inViewShare = (vp, a, b) => {
      const pasted = (out.shots[vp] && out.shots[vp].blank && out.shots[vp].blank.inView && out.shots[vp].blank.inView.pasted) || [];
      if (!pasted.length || b <= a) return 0;
      return pasted.reduce((q, [p0, p1]) => q + Math.max(0, Math.min(b, p1) - Math.max(a, p0)), 0) / (b - a);
    };
    // share of document rows [a, b) that are blank in the full or rest shot although the DOM paints content there:
    // rows of text the page shows with no ink in that shot, and flat media/panel boxes (the shot probe, blankRows),
    // or, when no probe lines up with the shot, runs of flat 60-row blocks of >= 1.5 viewport heights inside bands
    // with >= 3 words or any media. Such rows have no colour to read: scroll tints and band scroll themes are
    // never read from them, and a band with them is never recoloured. (An empty background area the DOM leaves
    // empty, e.g. a tall pinned section's track, is not blank.)
    const blankCache = {};
    const blankShare = (vp, a, b) => {
      if (!blankCache[vp]) {
        const pr = out.shots[vp] && out.shots[vp]._probe, vh = (VP[vp] || [0, 900])[1];
        let rr = [];
        for (const P of [...new Set([fullPng(vp), restPng(vp)].filter(Boolean))]) {
          if (pr) { const texts = pr.texts.map((t) => t.slice(0, 5)); textBlank(P, texts); rr.push(...blankRows(P, { texts, boxes: pr.boxes })); continue; }
          const secs = +vp === PV ? A.sections : (others[vp] && others[vp].A.sections) || [];
          const flat = (y, h) => { if (y + h > P.height) return false; const k = inkShare(P, { x: 0, y, w: P.width, h }, 4); return k !== null && k < 0.002; };
          for (const s of secs) {
            if (s.virtual || !s.counts || !(s.counts.words >= 3 || s.counts.media >= 1)) continue;
            let run = null;
            const close = () => { if (run && run[1] - run[0] >= vh * 1.5) rr.push(run); run = null; };
            for (let y = Math.max(0, s.y); y < s.y + s.h - 20; y += 60) { const h = Math.min(60, s.y + s.h - y); if (flat(y, h)) { if (run) run[1] = y + h; else run = [y, y + h]; } else close(); }
            close();
          }
        }
        rr.sort((p, q) => p[0] - q[0]);
        const m = [];
        for (const [p0, p1] of rr) { const l = m[m.length - 1]; if (l && p0 <= l[1]) l[1] = Math.max(l[1], p1); else m.push([p0, p1]); }
        blankCache[vp] = m;
      }
      if (b <= a) return 0;
      return blankCache[vp].reduce((q, [p0, p1]) => q + Math.max(0, Math.min(b, p1) - Math.max(a, p0)), 0) / (b - a);
    };
    // per band: share of its text the shot still shows blank, share of its rows filled from in-view shots
    const shotOf = (vp, s) => {
      const sh = out.shots[vp], pr = sh && sh._probe;
      if (!pr) return undefined;
      let all = 0, bl = 0;
      for (const t of pr.texts) { const cy = t[1] + t[3] / 2; if (cy < s.y || cy >= s.y + s.h || t[4] < 0.5 || t[5] === null || t[5] === undefined) continue; all += t[2] * t[3]; if (t[5]) bl += t[2] * t[3]; }
      const pasted = ((sh.blank && sh.blank.inView && sh.blank.inView.pasted) || []).reduce((q, [a, b]) => q + Math.max(0, Math.min(b, s.y + s.h) - Math.max(a, s.y)), 0);
      const o = { blank: all ? r2(bl / all) : 0, inView: s.h ? r2(pasted / s.h) : 0 };
      return o.blank >= 0.05 || o.inView >= 0.05 ? o : undefined;
    };
    const secOut = (Ares, vp, vh, detailed) => {
      const png = fullPng(vp);
      let rpng = restPng(vp) || png, themed = false;
      const list = [];
      const files = [];
      Ares.sections.forEach((s, i) => {
        const bg = Object.assign({}, s.bg);
        if (png && s.y < png.height - 2) {
          const d = dominant(png, { x: 0, y: s.y, w: Math.min(png.width, Math.max(1, s.w || vp)), h: Math.min(s.h, png.height - s.y) }, 4);
          if (d) { bg.sampled = d.hex; bg.sampledShare = d.share; }
          // settled colour with the band centred vs the same rows of the full shot (scroll-0 state)
          const c = detailed && centred ? centred[i] : null;
          // rest = the same rows of the scroll-0 full shot; but when the full shot already draws the band in its
          // centred colour (its rendering under a full-page capture put it in the in-view state) while the band's
          // top rows read as it comes into view (viewport shot, its top 85% down) differ from the same rows of the
          // full shot, rest = that entering read (restFrom 'entering'): the measure does not depend on how the
          // full-page shot was rendered
          const ent = c && c.enter;
          // the centred read's band rows in the full-shot layout (c.dy: the band moved since the shots)
          const cy0 = c ? Math.round(c.y0 + (c.dy || 0)) : 0, cy1 = c ? Math.round(c.y1 + (c.dy || 0)) : 0;
          if (c && (bg.type === 'color' || bg.type === 'gradient') && inViewShare(vp, cy0, cy1) < 0.3 && blankShare(vp, cy0, cy1) < 0.3) {
            const y0 = Math.max(0, cy0), y1 = Math.min(rpng.height, cy1);
            let rest = y1 - y0 >= 12 ? dominant(rpng, { x: 0, y: y0, w: rpng.width, h: y1 - y0 }, 4) : null, restFrom = 'full shot';
            let shown = rest ? topColors(rpng, { x: 0, y: y0, w: rpng.width, h: y1 - y0 }, 4, 6, 0.02).some((q) => q.share >= 0.15 && (dHex(q.hex, c.color) ?? 1) <= 0.02) : true;
            if (ent && rest && (dHex(rest.hex, c.color) ?? 1) <= 0.02 && ent.share >= 0.3) {
              const ey0 = Math.max(0, Math.round(ent.y0 + (ent.dy || 0))), ey1 = Math.min(rpng.height, Math.round(ent.y1 + (ent.dy || 0)));
              const fr = ey1 - ey0 >= 12 ? dominant(rpng, { x: 0, y: ey0, w: rpng.width, h: ey1 - ey0 }, 4) : null;
              if (fr && (dHex(fr.hex, ent.color) ?? 0) > 0.02 && (dHex(fr.hex, c.color) ?? 1) <= 0.03) {
                rest = { hex: ent.color, share: ent.share }; restFrom = 'entering';
                shown = topColors(ent.png, { x: 0, y: 0, w: ent.png.width, h: ent.png.height }, 4, 6, 0.02).some((q) => q.share >= 0.15 && (dHex(q.hex, c.color) ?? 1) <= 0.02);
              }
            }
            const dd = rest ? dHex(rest.hex, c.color) : null;
            if (rest && dd !== null && dd > 0.02 && rest.hex !== c.color && c.share >= 0.3 && rest.share >= 0.3 && !shown) {
              bg.scrollTheme = { rest: rest.hex, centred: c.color, restFrom };
              bg.sampled = c.color; bg.sampledShare = c.share;
              if (bg.type === 'color') { bg.cssColor = bg.color; bg.color = c.color; }
              tints.push({ at: c.sy, band: s.id, color: c.color, rest: rest.hex });
              // the full shot shows a scroll-theme band in its in-view state on every page: its rows' rest-colour
              // pixels are painted the centred colour (the scroll-0 state stays in <vp>-full-rest.png); a band the
              // full shot already draws in that state (restFrom 'entering') is left as it is
              if (restFrom === 'full shot' && blankShare(vp, s.y, s.y + s.h) < 0.05) {
              if (!themed) { themed = true; if (!out.shots[vp].fullRest) { restCache[vp] = rpng = clonePng(png); writePng(rpng, path.join(outDir, `shots/${vp}-full-rest.png`)); out.shots[vp].fullRest = `shots/${vp}-full-rest.png`; } }
              const n = recolorRows(png, s.y, Math.min(png.height, s.y + s.h), rest.hex, c.color);
              (out.shots[vp].themed ||= []).push({ band: i, px: n });
              }
            }
          }
          // the screenshot wins over the CSS colour when it clearly covers the band (a footer whose CSS
          // reads white while it paints near-black through a child, pseudo-element or image)
          if (bg.type === 'color' && !bg.cssColor && bg.sampled && bg.sampledShare > 0.8 && bg.color && (dHex(bg.color, bg.sampled) ?? 0) > 0.03) { bg.cssColor = bg.color; bg.color = bg.sampled; }
          const f = `shots/${vp}-sec-${i}.png`;
          // a band running past the full shot's cap is cropped from the full shot and its tail shot together
          const cut = s.y + Math.min(s.h, MAX_SEC_H) > png.height ? docRows(vp, s.y, Math.min(s.h, MAX_SEC_H)) : null;
          const ok = cut ? cropToFile(cut, 0, 0, cut.width, cut.height, path.join(outDir, f)) : cropToFile(png, 0, s.y, png.width, Math.min(s.h, MAX_SEC_H, png.height - s.y), path.join(outDir, f));
          files.push(ok ? f : null);
        } else {
          // a band below the full shot's height cap: sampled and cropped from the tail shot(s)
          const tp = docRows(vp, s.y, Math.min(s.h, MAX_SEC_H));
          if (tp) {
            const d = dominant(tp, { x: 0, y: 0, w: Math.min(tp.width, Math.max(1, s.w || vp)), h: tp.height }, 4);
            if (d) { bg.sampled = d.hex; bg.sampledShare = d.share; }
            if (bg.type === 'color' && bg.sampled && bg.sampledShare > 0.8 && bg.color && (dHex(bg.color, bg.sampled) ?? 0) > 0.03) { bg.cssColor = bg.color; bg.color = bg.sampled; }
            const f = `shots/${vp}-sec-${i}.png`;
            files.push(cropToFile(tp, 0, 0, tp.width, tp.height, path.join(outDir, f)) ? f : null);
          } else files.push(null);
        }
        const base = { id: s.id, i, role: s.role, y: s.y, h: s.h, hFrac: r3(s.h / Ares.docH), bg, shot: shotOf(vp, s) };
        const flags = { gapBefore: s.gapBefore, analysed: s.analysed, thirdParty: s.thirdParty, empty: s.empty };
        if (detailed) {
          list.push(Object.assign(base, { why: s.why, el: s.desc, yFrac: r3(s.y / Ares.docH), vh: r2(s.h / vh), layout: s.layout, cards: s.cards, counts: s.counts, align: s.align, media: s.media, headPx: s.headPx, pad: s.pad, contentX: s.contentX, navOverlay: s.navOverlay, pos: s.pos }, flags));
        } else {
          const primaryI = s.link !== null && s.link !== undefined ? A.sections.indexOf(primaryReal[s.link]) : null;
          list.push(Object.assign(base, { link: primaryI !== null && primaryI >= 0 ? primaryI : null, cols: s.layout.cols, ratios: s.layout.ratios, cardCols: s.cards ? s.cards.cols : null, cards: s.cards ? s.cards.n : 0, cardGap: s.cards ? s.cards.gap : null, peek: (s.cards && s.cards.peek) || s.layout.overflow || undefined, rowCover: s.layout.rowCover, collage: s.layout.collage ? (s.cards && s.cards.collage ? 'both' : 'row') : s.cards && s.cards.collage ? 'cards' : undefined, align: s.align, pad: s.pad, headPx: s.headPx, media: s.media.place }, flags));
        }
      });
      if (out.shots[vp]) out.shots[vp].sections = files;
      if (themed && out.shots[vp] && out.shots[vp].full) { writePng(png, path.join(outDir, out.shots[vp].full)); note(`${vp}: scroll-theme band(s) ${out.shots[vp].themed.map((t) => t.band).join(', ')} shown in their in-view (centred) colour in the full shot (scroll-0 state: ${out.shots[vp].fullRest})`); }
      return list;
    };
    const tints = [];
    out.sections = secOut(A, PV, ph, true);
    for (const [vp, r] of Object.entries(others)) out.sectionsByViewport[vp] = secOut(r.A, +vp, (VP[vp] || [0, 900])[1], false);
    // collapse{vp}: the same band at the other viewports (bands linked by DOM signature); null only when
    // the band's element is not rendered there (display:none / zero size)
    out.sections.forEach((s, pi) => {
      s.collapse = {};
      const ri = primaryReal.indexOf(A.sections[pi]);
      for (const [vp, list] of Object.entries(out.sectionsByViewport)) {
        const hidden = ri >= 0 && (others[vp].A.hiddenPrimary || []).includes(ri);
        const m = list.filter((x) => x.link === pi);
        s.collapse[vp] = hidden ? null : m.length ? { cols: m[0].cols, cardCols: m[0].cardCols, h: m.reduce((a, x) => a + x.h, 0), bands: m.map((x) => x.i) } : { unlinked: true };
      }
      if (s.pos === undefined) delete s.pos;
    });

    // ================= colours =================
    const p1 = fullPng(PV);
    let foldPng = null;
    try { foldPng = out.shots[PV].fold ? readPng(path.join(outDir, out.shots[PV].fold)) : null; } catch { foldPng = null; }
    const shotTop = { fold: foldPng ? topColors(foldPng, { x: 0, y: 0, w: foldPng.width, h: foldPng.height }, 2, 8, 0.015) : [], full: p1 ? topColors(p1, { x: 0, y: 0, w: p1.width, h: p1.height }, 4, 10, 0.015) : [] };
    const pal = buildPalette(A.colorsRaw, shotTop, { bands: out.sections, vh: ph });
    for (const n of pal.notes) note('colors: ' + n);
    for (const [k, why] of Object.entries(pal.weak || {})) note(`colors: WEAK ${k}: ${why}`);
    const bandId = (b) => (b !== null && b !== undefined && b >= 0 && A.sections[b] ? A.sections[b].id : null);
    out.colors = {
      theme: pal.theme, roles: pal.roles, roleWhere: pal.roleWhere, weak: pal.weak && Object.keys(pal.weak).length ? pal.weak : undefined, palette: pal.palette, minor: pal.minor.map((m) => Object.assign(m, { band: bandId(m.band) })), brandMarks: pal.brandMarks && pal.brandMarks.length ? pal.brandMarks : undefined, clustersBeforeCap: pal.clusters,
      gradients: A.colorsRaw.gradients.map((g) => Object.assign({}, g, { bands: g.bands.map((b) => (A.sections[b] ? A.sections[b].id : b)) })), gradientsTotal: A.colorsRaw.gradientsTotal,
      vars: A.colorsRaw.vars, screenshot: shotTop, mediaAreaFrac: A.colorsRaw.mediaAreaFrac, imageHeavy: A.colorsRaw.mediaAreaFrac >= 0.25,
    };
    if (A.colorsRaw.gradientsTotal > 10) note(`colors.gradients capped at 10 of ${A.colorsRaw.gradientsTotal}`);

    // ================= type =================
    const used = (A.fonts && A.fonts.used) || [];
    const faceRules = ((A.fonts && A.fonts.fontFaceRules) || []).concat(extra.ff);
    const totalChars = used.reduce((s, f) => s + f.chars, 0) || 1;
    const famMap = new Map();
    for (const f of used) {
      const name = f.rendered.family;
      const e = famMap.get(name) || { family: name, chars: 0, weights: new Set(), roles: new Set(), stack: f.stack, rendered: f.rendered, metrics: f.metrics };
      e.chars += f.chars; f.weights.forEach((w) => e.weights.add(w)); f.roles.forEach((r) => e.roles.add(r));
      famMap.set(name, e);
    }
    out.type.families = [...famMap.values()].map((e) => {
      const faces = ((A.fonts && A.fonts.faces) || []).find((x) => x.family.toLowerCase() === e.family.toLowerCase());
      const rules = faceRules.filter((r) => r.family && r.family.toLowerCase() === e.family.toLowerCase());
      const hosts = [...new Set(rules.map((r) => { const mm = (r.src || '').match(/url\(\s*["']?([^"')]+)/); if (!mm) return /local\(/.test(r.src || '') ? 'local()' : null; if (mm[1].startsWith('data:')) return 'data-uri'; return hostOf(mm[1], r.base || meta.finalUrl); }).filter(Boolean))];
      const variable = !!(faces && faces.variable) || rules.some((r) => /\d+\s+\d+/.test(r.weight || '') || /variations|-VF|variable/i.test(r.src || ''));
      const roles = [...e.roles];
      return {
        family: e.family, category: e.rendered.generic ? (/(serif)$/i.test(e.family) && !/sans/i.test(e.family) ? 'serif' : /mono/i.test(e.family) ? 'mono' : 'sans') : familyCategory(e.family, e.rendered.fallback, roles),
        webfont: !!e.rendered.webfont, local: !!e.rendered.local || undefined, generic: !!e.rendered.generic || undefined, unresolved: e.rendered.unresolved || undefined,
        variable, source: hosts.slice(0, 3), weights: [...e.weights].sort((a, b) => a - b), share: r3(e.chars / totalChars), roles, stack: e.stack,
        width: e.metrics ? e.metrics.width : null, adv: e.metrics ? e.metrics.adv : null, xHeight: e.metrics ? e.metrics.xh : null,
      };
    }).sort((a, b) => b.share - a.share);
    // web fonts the page loads, each with its public-catalogue verdict (lib/font-catalogue.mjs): families
    // requested from fonts.googleapis.com (link, @import or script: every css/css2 request names them in
    // `family=`) and @font-face rules with a url() source; local()-only faces (metric fallbacks) are not web fonts
    try {
      const cat = await loadCatalogue(path.dirname(outDir));
      const googleUrls = [...(st.gfonts || []), ...sheets.map((s) => s.href).filter((h) => h && /fonts\.googleapis\.com\/css/i.test(h))];
      out.type.webFonts = webFontsOf({ googleUrls, faceRules, base: meta.finalUrl }, cat);
      for (const f of out.type.families) f.inCatalogue = isSystemFamily(f.family) ? 'system' : cat.verdict(f.family);
      if (!cat.full) note(`type.webFonts: ${cat.note}`);
    } catch (e) { note('type.webFonts not recorded: ' + String(e && e.message || e).slice(0, 160)); }
    const typeFor = (vp, Ares) => { out.type.roles[vp] = Ares.type.roles; out.type.scale[vp] = Ares.type.ratios; out.type.bodyPx[vp] = Ares.type.bodyPx; if (Ares.type.stats) (out.type.stats = out.type.stats || {})[vp] = Ares.type.stats; };
    typeFor(PV, A);
    // type samples: first rendered line of each role's example at the primary viewport + a tight crop
    // (bbox + 4 px) of it from the full screenshot
    // Candidates (the DOM's pick + its alts, already ranked by issues, contrast and, for display / h1, the
    // first screen) are re-judged on the full screenshot's pixels: a line whose 2 px frame is busy (> 10%
    // off: canvas, photo or gradient behind it, neighbouring text) or whose drawn contrast is low ranks
    // after a clean high-contrast one, whatever the DOM said about its background. The pixel verdict joins
    // sampleQuality.
    out.type.samples = {};
    for (const [role, smp0] of Object.entries((A.type && A.type.samples) || {})) {
      const full = fullPng(PV);
      const cands = [Object.assign({}, smp0, { alts: undefined }), ...((smp0.alts || []).map((a) => Object.assign({}, smp0, a, { alts: undefined })))];
      const judged = cands.map((c, i) => {
        const px = full && c.bbox && c.bbox[1] < full.height ? lineCropStats(full, c.bbox) : null;
        const pixPen = !px ? 3 : (px.frameOut > 0.1 ? 8 : 0) + (px.contrast < 1.8 ? 4 : px.contrast < 3 ? 2 : px.contrast < 4.5 ? 1 : 0);
        const domPen = c.sampleQuality && c.sampleQuality.level === 'poor' ? 4 : 0;
        return { c, px, pen: pixPen + domPen + i * 0.25 };
      }).sort((a, b) => a.pen - b.pen);
      const best = judged[0];
      const smp = best.c;
      if (best.px) {
        const bad = [];
        if (best.px.frameOut > 0.1) bad.push(`busy background (${Math.round(best.px.frameOut * 100)}% of the frame around the line differs from ${best.px.bg}, pixels)`);
        if (best.px.contrast < 1.8) bad.push(`low contrast (${best.px.contrast}:1 drawn, pixels)`);
        if (bad.length) smp.sampleQuality = { level: 'poor', reason: [...bad, ...(smp.sampleQuality && smp.sampleQuality.level === 'poor' ? [smp.sampleQuality.reason] : [])].join('; ') };
        smp.pixels = best.px;
      }
      if (cands.length > 1) smp.candidates = cands.length;
      const s1 = Object.assign({}, smp, { shot: null });
      const b = smp.bbox;
      if (full && b && b[1] < full.height) {
        const f = `shots/type-${role}.png`;
        const x = Math.max(0, Math.floor(b[0] - 4)), y = Math.max(0, Math.floor(b[1] - 4));
        if (cropToFile(full, x, y, Math.ceil(b[2] + 8), Math.ceil(b[3] + 8), path.join(outDir, f))) s1.shot = f;
      }
      out.type.samples[role] = s1;
    }
    for (const [vp, r] of Object.entries(others)) typeFor(vp, r.A);

    // ================= spacing =================
    const spFor = (vp, Ares) => {
      out.spacing.container[vp] = Ares.spacing.container;
      const sp = Ares.spacing.sectionPad;
      out.spacing.sectionPad[vp] = { modeTop: sp.modeTop, modeBottom: sp.modeBottom, medianTop: sp.medianTop, medianBottom: sp.medianBottom, values: sp.values };
      out.spacing.gaps[vp] = Ares.spacing.gaps;
      out.spacing.stack[vp] = Ares.spacing.stack;
    };
    spFor(PV, A);
    for (const [vp, r] of Object.entries(others)) spFor(vp, r.A);
    out.spacing.radius = A.spacing.radius;
    out.spacing.shadows = A.spacing.shadows;
    out.spacing.borders = A.spacing.borders;
    out.spacing.nav = A.nav ? Object.assign({}, A.nav) : null;
    if (out.spacing.nav) {
      out.spacing.nav.byViewport = {};
      for (const [vp, r] of Object.entries(others)) {
        const sh = r.scrolledHdr;
        out.spacing.nav.byViewport[vp] = r.A.nav ? { pos: r.A.nav.pos, h: r.A.nav.h, scrolled: sh ? { pinned: true, h: sh.h, bg: sh.bg, transparent: sh.transparent, buttons: (sh.btns || []).length } : { pinned: false } } : null;
      }
    }

    // ================= components =================
    // a component inside the first screen is cropped from the fold shot (scroll 0, at rest): a tall page's
    // tiled full shot can show a fixed header in its scrolled state, so the nav crops of two pages would show
    // different states (the scrolled state has its own shot, <vp>-scrolled.png)
    let pFold = null;
    try { if (out.shots[PV] && out.shots[PV].fold) pFold = readPng(path.join(outDir, out.shots[PV].fold)); } catch { pFold = null; }
    for (const [name, c] of Object.entries(A.components || {})) {
      const comp = Object.assign({}, c);
      const src = pFold && c.y >= 0 && c.y + c.h <= pFold.height ? pFold : p1;
      if (src && c.y < src.height) {
        const f = `shots/comp-${name}.png`;
        const pad = 12;
        const ok = cropToFile(src, c.x - pad, c.y - pad, Math.min(c.w + pad * 2, src.width), Math.min(c.h + pad * 2, 1200), path.join(outDir, f));
        if (ok) { comp.shot = f; out.shots.components = out.shots.components || {}; out.shots.components[name] = f; }
        // the computed text colour checked against the pixels of the component's own box: a button with a
        // transparent background over art (or text recoloured by a blend mode, a mask or a child layer)
        // can show another colour than its CSS `color`. colorWeak = no colour of the box's top 10 is within
        // OKLab 0.08 of `color`; `seen` = the box's most common colours (read the crop, not `color`).
        try {
          if (comp.color && /^#/.test(comp.color) && c.w >= 8 && c.h >= 8) {
            const tops = topColors(src, { x: Math.max(0, c.x), y: Math.max(0, c.y), w: Math.min(c.w, src.width - Math.max(0, c.x)), h: Math.min(c.h, src.height - Math.max(0, c.y)) }, 1, 10, 0.035);
            if (tops.length && !tops.some((t) => (dHex(t.hex, comp.color) ?? 1) <= 0.08)) comp.colorWeak = { seen: tops.slice(0, 3).map((t) => t.hex), why: `no pixels near its CSS color ${comp.color} in its box${!comp.bg ? ' (transparent background: it sits over whatever is behind it)' : ''}` };
          }
        } catch { /* best effort */ }
      }
      out.components[name] = comp;
    }
    for (const name of ['nav', 'primaryButton', 'secondaryButton', 'card', 'input', 'link', 'badge']) if (!out.components[name]) out.components[name] = null;
    const missingComps = Object.entries(out.components).filter(([, v]) => !v).map(([k]) => k);
    if (missingComps.length) note(`components not found: ${missingComps.join(', ')}`);
    // attach hover deltas to components
    for (const h of out.hover) {
      if (!h || h.skipped) continue;
      const map = { 'primary-button': 'primaryButton', 'secondary-button': 'secondaryButton', card: 'card', 'text-link': 'link', 'nav-link': 'nav' };
      const k = map[h.kind];
      if (k && out.components[k] && !out.components[k].hover) out.components[k].hover = { self: h.self, before: h.before, after: h.after, kids: h.kids, transition: h.transition };
    }
    const hoverOk = out.hover.filter((h) => h && !h.skipped);
    if (hoverOk.length && !hoverOk.some((h) => h.self || h.before || h.after || (h.kids && h.kids.length))) note('no hover deltas observed on sampled elements');

    // ================= motion =================
    const ms = A.motionStatic || {};
    for (const [k, v] of Object.entries(extra.kf)) if (!ms.keyframes[k] && ms.keyframesWanted.includes(k)) ms.keyframes[k] = v;
    const kfMissing = (ms.keyframesWanted || []).filter((k) => !ms.keyframes[k]);
    if (kfMissing.length) note(`@keyframes not found for: ${kfMissing.slice(0, 8).join(', ')}`);
    motion.transitions = (ms.transitions || []).map((t) => Object.assign(t, { family: (classifyEasingString(t.easing) || {}).family || null }));
    // elements seen animating (reveal / load) whose transitions were checked for no-ops (transitions[].noop / .rv)
    if (typeof ms.transitionsObserved === 'number') motion.transitionsObserved = ms.transitionsObserved;
    if ((ms.transitionsTotal || 0) > 25) note(`motion.transitions capped at 25 of ${ms.transitionsTotal} distinct`);
    // names that differ only by digits (generated per-element keyframes) are one pattern
    const pat = (n) => String(n || '').replace(/\d+/g, '#');
    const gaM = new Map();
    for (const g of ms.getAnimations || []) {
      const k = [g.type, pat(g.name), g.props, g.ms, g.easing, g.iter].join('|');
      const e = gaM.get(k);
      if (e) { e.n += g.n; e.variants = (e.variants || 1) + 1; } else gaM.set(k, Object.assign({}, g));
    }
    motion.getAnimations = [...gaM.values()].sort((a, b) => b.n - a.n).slice(0, 20);
    motion.getAnimationsTotal = ms.getAnimationsTotal || 0;
    const caM = new Map();
    for (const a of ms.cssAnimations || []) { const k = pat(a.name) + '|' + a.ms; const e = caM.get(k); if (e) { e.n += a.n; e.variants = (e.variants || 1) + 1; } else caM.set(k, Object.assign({}, a)); }
    motion.cssAnimations = [...caM.values()].sort((a, b) => b.n - a.n).slice(0, 12);
    const use = new Map();
    for (const a of ms.cssAnimations || []) use.set(a.name, (use.get(a.name) || 0) + a.n);
    for (const g of ms.getAnimations || []) if (g.type === 'animation') use.set(g.name, (use.get(g.name) || 0) + g.n);
    const kfOut = {}, seenPat = new Map();
    for (const name of [...use.keys()].sort((a, b) => use.get(b) - use.get(a))) {
      if (!ms.keyframes[name]) continue;
      const p = pat(name);
      if (seenPat.has(p)) { seenPat.set(p, seenPat.get(p) + 1); continue; }
      seenPat.set(p, 1);
      if (Object.keys(kfOut).length < 12) kfOut[name] = ms.keyframes[name];
    }
    for (const [p, n] of seenPat) if (n > 1) { const nm = Object.keys(kfOut).find((k) => pat(k) === p); if (nm) kfOut[nm] = [[`(${n} keyframes named like ${p})`, '']].concat(kfOut[nm]); }
    if (Object.keys(ms.keyframes || {}).length > Object.keys(kfOut).length) note(`motion.keyframes: kept ${Object.keys(kfOut).length} of ${Object.keys(ms.keyframes).length} referenced @keyframes (most used, one per name pattern)`);
    motion.keyframes = kfOut;
    motion.load = analyzeLoad(loadRaw);
    if (pass) {
      const info = new Map(tinfo.map((t) => [t.i, t]));
      // text-free pieces of media / illustration boxes (page-analyze inMedia): that box's media activity,
      // never scroll-linked, a JS marquee, parallax or horizontal scroll
      for (const i of (A.inMedia && A.inMedia.els) || []) if (info.has(i)) info.get(i).media = true;
      for (const j of (A.inMedia && A.inMedia.layout) || []) if (snap.layoutInfo[j]) snap.layoutInfo[j][5] = true;
      motion.reveals = analyzeReveals(pass.steps, info, sectionOfY);
      if (motion.reveals.groups) for (const g of motion.reveals.groups) if (g.band !== null && A.sections[g.band]) g.band = A.sections[g.band].id;
      if (motion.reveals.scrollLinked) for (const g of motion.reveals.scrollLinked) if (g.band !== null && A.sections[g.band]) g.band = A.sections[g.band].id;
      const lm = analyzeLayoutMotion(pass.rests, snap.layoutInfo, ph, pw, sectionOfY);
      const idOfBand = (b) => (b !== null && b !== undefined && A.sections[b] ? A.sections[b].id : null);
      motion.sticky = lm.sticky.map((s) => Object.assign(s, { band: idOfBand(s.band) }));
      motion.parallax = lm.parallax.map((s) => Object.assign(s, { band: idOfBand(s.band) }));
      motion.horizontal = lm.horizontal.map((s) => Object.assign(s, { band: idOfBand(s.band) }));
      motion.layoutBasis = lm.basis;
      const navCh = analyzeNav(pass.rests);
      if (out.spacing.nav && navCh) out.spacing.nav.onScroll = navCh;
      motion.smoothScroll = Object.assign(analyzeSmooth(pass.mode === 'wheel' && pass.steps[0] ? pass.steps[0].scroll : null, meta.libraries), { input: pass.mode });
      motion.scrollPass = { steps: pass.steps.length, stepPx: pass.stepPx, ms: pass.ms, nativeScroll: pass.native, trackedHidden: snap.hidden, layoutTracked: snap.layout };
    } else {
      motion.reveals = null; motion.sticky = null; motion.parallax = null; motion.horizontal = null; motion.smoothScroll = null;
      note('motion pass did not run; reveals/sticky/parallax are null');
    }
    // the header in the screenshots: still at the top of <vp>-scrolled.png = it stays in view, whatever its
    // computed position says; a line or shadow under it that only the scrolled shot shows is an on-scroll
    // change; a scroll-driven animation on it is its scrolled state (motion.applyNavShots)
    if (out.spacing.nav) {
      const nv = out.spacing.nav;
      try {
        const sh = out.shots[PV] || {};
        if (sh.fold && sh.scrolled) applyNavShots(nv, navShots(readPng(path.join(outDir, sh.fold)), readPng(path.join(outDir, sh.scrolled)), nv.h), scr && scr.hdr ? scr.hdr.pos : null);
        for (const [vp, b] of Object.entries(nv.byViewport || {})) {
          const s2 = out.shots[vp] || {};
          if (!b || !s2.fold || !s2.scrolled) continue;
          const e2 = navShots(readPng(path.join(outDir, s2.fold)), readPng(path.join(outDir, s2.scrolled)), b.h);
          if (!e2) continue;
          b.shot = { pinned: e2.pinned, match: e2.match };
          if (e2.pinned === true && b.scrolled && !b.scrolled.pinned) Object.assign(b.scrolled, { pinned: true, how: 'scrolled shot' });
          if (e2.pinned === true && b.pos !== 'fixed' && b.pos !== 'sticky') { b.posCss = b.pos; b.pos = nv.pos === 'fixed' || nv.pos === 'sticky' ? nv.pos : 'sticky'; }
        }
      } catch (e) { note('nav screenshot evidence failed: ' + e.message.split('\n')[0]); }
      const na = (navAnims || []).filter((a) => a && (a.props || []).length);
      if (na.length && nv.onScroll) {
        const props = new Set(na.flatMap((a) => a.props));
        const ch = Object.assign({}, nv.onScroll.changes || {});
        if (props.has('boxShadow') && !ch.shadow && !ch.line) ch.shadow = [false, true];
        if ([...props].some((p) => /^border/.test(p)) && !ch.border && !ch.line) ch.border = [null, 'scroll-driven'];
        nv.onScroll.changes = Object.keys(ch).length ? ch : null;
        nv.onScroll.scrollDriven = na.map((a) => `${a.name || 'animation'} (${a.props.join(', ')})`).slice(0, 4);
      }
    }
    const hscroll = (ms.overflowScrollers || []).map((s) => Object.assign({ kind: 'overflow-x scroller' }, s, { band: idOfBandSafe(A, s.band) }));
    motion.horizontal = (motion.horizontal || []).concat(hscroll).slice(0, 8);
    // motion inside a first-viewport media / illustration box is that box's media activity (motion.load.media,
    // frame-differenced): never a marquee, loop or auto-advance. Graphic motion (no text, not a marquee strip)
    // in or mostly over the box; and any piece of the box element itself (page-core rc.heroIn: a track sliding
    // across it, cycling cards or states, a cursor; never a heading, link or button outside a UI mock-up)
    const absorbed = new Map();
    const absorb = (x) => {
      const h = x && typeof x.hero === 'number' && x.hero >= 0 ? x.hero : -1;
      if (h < 0) return false;
      if (!x.heroIn && (x.text || x.strip || x.kind === 'marquee')) return false;
      const s = absorbed.get(x.hero) || new Set(); s.add(x.desc || x.el); absorbed.set(x.hero, s);
      return true;
    };
    const idleCont = idle ? idle.continuous.filter((c) => !absorb(c)) : [];
    const idleBursts = idle ? idle.bursts.filter((c) => !absorb(c)) : [];
    const autoItems = auto && auto.items ? auto.items.filter((c) => !absorb(c)) : [];
    for (const a of ms.ambient || []) if (absorb(a)) a.absorbed = true;
    for (const [i, s] of absorbed) if (heroMedia && heroMedia[i]) heroMedia[i].keyframes = s.size;
    const mq = idleCont.filter((c) => c.kind === 'marquee');
    motion.marquees = mq.map((m) => ({ el: m.desc, band: idOfBandSafe(A, sectionOfY(m.y)), axis: m.axis, dir: m.dir, pxPerSec: m.pxPerSec, css: m.css ? m.css.map((c) => `${c.name || c.prop} ${c.dur}ms ${c.easing} ${c.iter}`).join('; ') : 'js' }))
      .concat(((motion.reveals && motion.reveals.jsMarquees) || []).filter((m) => ![...absorbed.values()].some((s) => s.has(m.el))).map((m) => ({ el: m.el, band: idOfBandSafe(A, m.band), axis: m.axis, pxPerSec: m.pxPerSec, css: 'js (detected while scrolling)' })));
    // per-viewport marquees (768/390 idle samples): band = that width's band holding the strip's y
    for (const [vp, list] of Object.entries(motion.marqueesByViewport || {})) {
      const secs = (others[vp] && others[vp].A && others[vp].A.sections) || [];
      for (const m of list) { const s = secs.find((x) => x && x.role !== 'nav' && typeof x.y === 'number' && m.y >= x.y && m.y < x.y + x.h); m.band = s ? s.id : null; delete m.y; }
    }
    motion.loops = idleCont.filter((c) => c.kind !== 'marquee').slice(0, 8).map((m) => ({ el: m.desc, kind: m.kind, band: idOfBandSafe(A, sectionOfY(m.y)), pxPerSec: m.pxPerSec, paused: m.paused, css: m.css ? m.css.map((c) => `${c.name || c.prop} ${c.dur}ms ${c.iter}`).join('; ') : 'js' }));
    const carLibs = (meta.libraries || []).filter((l) => /swiper|splide|flickity|slick/.test(l.name)).map((l) => l.name);
    // auto-advance: the slow watch (period = median interval between visible steps) and the idle sample's
    // bursts of content moving by a visible step
    const autoAdvance = autoItems.map((a) => ({ el: a.desc, band: idOfBandSafe(A, sectionOfY(a.y + Math.min(a.h, ph) / 2)), periodMs: a.periodMs, steps: a.steps, how: a.how, stepPx: a.stepPx }));
    const cand = autoAdvance.map((a) => ({ el: a.el, band: a.band, periodMs: a.periodMs ?? undefined }));
    for (const b of idleBursts) { const band = idOfBandSafe(A, sectionOfY(b.y)); if (!cand.some((c) => c.el === b.desc || c.band === band)) cand.push({ el: b.desc, band }); }
    motion.carousels = { libraries: carLibs, autoAdvance, autoAdvanceCandidates: cand.slice(0, 5), watchMs: auto ? auto.ms : null,
      note: `auto-advance = content moving by a visible step in bursts while the page was left alone (${auto ? `slow watch ${Math.round(auto.ms / 100) / 10} s` : 'slow watch unavailable'}, period = median interval between steps) or during the 1.5 s idle sample` };
    if (motion.reveals && (motion.reveals.crossFades || motion.reveals.layers)) note(`scroll pass: ${motion.reveals.crossFades || 0} cross-fading slide(s) and ${motion.reveals.layers || 0} page-tall layer fade(s) not counted as reveals`);
    if (motion.reveals && (motion.reveals.header || motion.reveals.tiny)) note(`scroll pass: ${motion.reveals.header || 0} header-bar toggle(s) and ${motion.reveals.tiny || 0} change(s) on boxes under 64 px² not counted as reveals`);
    // scroll-driven animations that change something visible (custom-property-only "detectors" excluded)
    // scroll-driven animations on the header (navAnims) are its scrolled state (spacing.nav.onScroll), not
    // scroll-scrubbed content: counted in `nav`, left out of scrollDrivenAnimations
    const navAnimNames = new Set((navAnims || []).map((a) => a && a.name).filter(Boolean));
    const sdAnims = (ms.getAnimations || []).filter((g) => g.scrollTimeline && g.visual !== false);
    motion.scrollTimeline = { elements: (ms.scrollTimeline || {}).elements || 0, timelineNames: (ms.scrollTimeline || {}).timelineNames || 0, cssRuleHits: sumObj((ms.scrollTimeline || {}).ruleHits, extra.tl), scrollDrivenAnimations: sdAnims.filter((g) => !navAnimNames.has(g.name)).length, nav: sdAnims.filter((g) => navAnimNames.has(g.name)).length, stateOnly: (ms.getAnimations || []).filter((g) => g.scrollTimeline && g.visual === false).length };
    for (const m of heroMedia || []) m.band = idOfBandSafe(A, sectionOfY(m.docY + Math.min(m.box[3], 900) / 2));
    motion.ambient = ambientInventory(motion, ms.ambient || [], A, idOfBandSafe, heroMedia);
    motion.scrollSnap = (ms.scrollSnap || []).map((s) => Object.assign(s, { band: idOfBandSafe(A, s.band) }));
    motion.scrollBehavior = ms.scrollBehavior || null;
    motion.cursor = { cursorNone: !!ms.cursorNone, followers: cursor.followers || [] };
    motion.byViewport = {};
    for (const [vp, r] of Object.entries(others)) motion.byViewport[vp] = { revealCount: r.revealCount };
    motion.byViewport[PV] = { revealCount: motion.reveals && motion.reveals.summary ? motion.reveals.summary.elements : 0 };

    // ================= reveal frames (fresh page) =================
    // Normal: the steps with the largest reveal area. --frames-like <refCapDir>: the reference's strips,
    // recorded at the same page positions on this page (band alignment, offset inside the aligned band or
    // run of bands, page fraction as fallback) with the same scroll step and timing, whatever was detected
    // here, so a build that animates differently (or with an undetected effect) still gets a row.
    // scroll tint first: its first change also gets a strip (below), so the sheets show the page colour
    // changing while scrolling (the full-page shots show every band at its scroll-0 colour)
    motion.scrollTint = scrollTintOf(pass, restPng(PV), ph, motion.sticky || [], (y) => idOfBandSafe(A, sectionOfY(y)), tints, (a, b) => Math.max(inViewShare(PV, a, b), blankShare(PV, a, b)));
    tintStates(motion.scrollTint, A.sections, centred, ph);
    let targets = [];
    if (o.motionFrames && o.framesLike) {
      try { targets = likeTargets(o.framesLike, out, ph); } catch (e) { note('--frames-like: ' + e.message.split('\n')[0]); }
      if (!targets.length) note('--frames-like: the reference has no reveal sequences; none recorded');
      motion.frames.like = o.framesLike;
    } else if (o.motionFrames && pass && motion.reveals && motion.reveals.groups && motion.reveals.groups.length) {
      const stepsSeen = new Set();
      // the steps with the largest reveal area, spread down the page (>= 2 steps apart), up to 4
      const byStep = new Map();
      for (const g of motion.reveals.groups.filter((x) => /^step\d+$/.test(x.phase))) { const k = +g.phase.slice(4); const e = byStep.get(k) || { k, band: g.band, score: 0 }; e.score += g.n * g.area; if (g.n * g.area > (e.top || 0)) { e.top = g.n * g.area; e.band = g.band; } byStep.set(k, e); }
      for (const e of [...byStep.values()].sort((x, y) => y.score - x.score)) {
        const k = e.k;
        if (stepsSeen.has(k) || k < 1 || !pass.rests[k] || !pass.rests[k - 1]) continue;
        if ([...stepsSeen].some((s2) => Math.abs(s2 - k) < 2)) continue;
        stepsSeen.add(k);
        targets.push({ k, band: e.band, from: pass.rests[k - 1].vs, to: pass.rests[k].vs });
        if (targets.length >= MAX_REVEAL_STRIPS) break;
      }
      targets.sort((x, y) => x.from - y.from);
    } else if (o.motionFrames) note('no scroll reveals detected; reveal frame sequences skipped');
    // a strip across the first scroll-tint change (wheel step from the rest before it to the rest that shows
    // it), unless a reveal strip already covers that step or there are already 4 strips
    if (o.motionFrames && !o.framesLike && pass && motion.scrollTint && motion.scrollTint.changes && targets.length < MAX_REVEAL_STRIPS) {
      const c0 = (motion.scrollTint.colors || []).find((x) => x && typeof x.at === 'number');
      if (c0) {
        let k = -1, best = Infinity;
        pass.rests.forEach((r, j) => { if (j && r && Math.abs(r.vs - c0.at) < best) { best = Math.abs(r.vs - c0.at); k = j; } });
        const near = k > 0 && best <= pass.stepPx / 2 && pass.rests[k - 1];
        const to = near ? pass.rests[k].vs : Math.round(c0.at), from = near ? pass.rests[k - 1].vs : Math.max(0, Math.round(c0.at - pass.stepPx));
        if (to - from >= 100 && !targets.some((t) => Math.abs(t.from - from) < pass.stepPx * 0.75)) {
          targets.push({ k: near ? k : null, band: c0.band || null, from, to, why: 'scroll tint' });
          targets.sort((x, y) => x.from - y.from);
        }
      }
    }
    if (targets.length) {
      progress(`recording ${targets.length} reveal strip(s)`);
      try {
        const { page: p3, st: st3 } = await openPage(ctx, pw, ph, {});
        await p3.goto(o.url, { waitUntil: 'domcontentloaded', timeout: o.timeout });
        await settle(p3, st3, { loadCap: Math.min(o.timeout, 25000), quietCap: 8000 });
        await ensureRc(p3);
        await handleConsent(p3).catch(() => null);
        await unrollInner(p3, PV);
        await ev(p3, () => window.__rc.snapshot(), null, 40000);
        await p3.mouse.move(4, Math.round(ph / 2));
        let n = 0;
        for (const t of targets) {
          await ev(p3, (y) => { try { if (window.lenis && window.lenis.scrollTo) window.lenis.scrollTo(y, { immediate: true }); } catch {} window.scrollTo({ top: y, behavior: 'instant' }); }, t.from);
          await sleep(300);
          let si = await ev(p3, () => window.__rc.scrollInfo());
          for (let i = 0; i < 40 && si.vs < t.from - 20; i++) { await p3.mouse.wheel(0, Math.min(ph * 0.9, t.from - si.vs)); await sleep(250); si = await ev(p3, () => window.__rc.scrollInfo()); }
          await sleep(900);
          const rec = await startScreencast(p3, { width: pw, height: ph });
          // page-side rAF log of the scroll position (native and visual: smooth-scroll libraries) during the strip
          await ev(p3, (ms) => { const log = window.__rcScrollLog = []; const end = performance.now() + ms; const f = () => { let sy = scrollY, vs = scrollY; try { if (window.__rc && window.__rc.vscroll) [sy, vs] = window.__rc.vscroll(); } catch {} log.push([performance.timeOrigin + performance.now(), sy, vs]); if (performance.now() < end) requestAnimationFrame(f); }; requestAnimationFrame(f); }, 2100).catch(() => {});
          await sleep(150);
          const tw = Date.now();
          await p3.mouse.wheel(0, Math.max(100, t.to - t.from));
          await sleep(1700);
          const fr = await rec.stop();
          const slog = await ev(p3, () => window.__rcScrollLog || []).catch(() => []);
          if (!fr.length) continue;
          // every strip starts at the wheel input (Node clock mapped onto the screencast's compositor clock), so
          // frame 0 is the page as it was when the input was sent, whatever the page painted before it
          const startTs = epochToTs(fr, tw);
          n++;
          const dir = path.join(outDir, 'motion', 'frames', `reveal-${n}`);
          const w = writeFrames(fr, startTs, dir, { fps: 12, durationMs: 1500 });
          const sm = scrollMotion(slog, tw);
          const entry = { dir: `motion/frames/reveal-${n}`, n: w.n, fps: 12, t0: 'wheel', distinct: w.distinct, band: t.band, step: t.k ?? undefined, scrollFrom: t.from, scrollTo: t.to, scroll: sm, why: t.why || undefined, like: t.like };
          // when the content in view is in place after the scroll stopped (frames.mjs stripContent)
          try {
            const g = await stripGrids(ctx, dir); const c = stripContent(g, { fps: 12, scrollSettleMs: sm ? sm.settleMs : null }); if (c) entry.content = c;
            // how it arrives after the scroll stops: step (one or two frames) or fade / slide (frames.mjs stripAppear)
            const ap = c ? stripAppear(g, { fps: 12, scrollSettleMs: sm ? sm.settleMs : null, frameW: pw, frameH: ph }) : null;
            if (ap) entry.content.appear = ap;
          } catch (e) { note('reveal strip content failed: ' + e.message.split('\n')[0]); }
          motion.frames.reveals.push(entry);
        }
        await p3.close().catch(() => {});
      } catch (e) { note('reveal frames failed: ' + e.message.split('\n')[0]); }
      linkRevealStrips(motion, pw, ph);
    }

    if (!o.fast) progress('warm-cache reload (load sequence)');
    await finishLoad(ctx, o, pw, ph, outDir, motion, { heroMedia, bandAt: (y) => idOfBandSafe(A, sectionOfY(y)), hideCss: overlayHideCss((meta.overlays || []).map((x) => x.sel)), meta,
      repeat: [...((auto && auto.items) || []), ...((idle && idle.bursts) || [])].filter((x) => x && x.desc).slice(0, 24).map((x) => ({ desc: x.desc, x: x.x, y: x.y, w: x.w, h: x.h })) });
    if (motion.scrollTint && motion.scrollTint.changes) {
      progress(`scroll tint: where ${motion.scrollTint.changes} change(s) start and how long they take`);
      await probeTints(ctx, o, pw, ph, motion.scrollTint, out.sections, restPng(PV)).catch((e) => note('scroll tint timing failed: ' + e.message.split('\n')[0]));
    }
    try { const sm = writeSummary(outDir, out); out.shots.summary = 'summary.md'; if (sm && sm.lines > 250) note(`summary.md has ${sm.lines} lines`); } catch (e) { note('summary.md failed: ' + e.message.split('\n')[0]); }
    meta.runMs = Date.now() - t0;
    meta.time = new Date().toISOString();
    const json = shrink(out);
    fs.writeFileSync(path.join(outDir, 'capture.json'), json);
    progress(`wrote ${path.join(outDir, 'capture.json')}`);
    const summaryLine = { ok: true, outDir, url: o.url, fast: o.fast || undefined, sections: out.sections.length, palette: out.colors.palette ? out.colors.palette.length : 0, reveals: motion.reveals && motion.reveals.summary ? motion.reveals.summary.groups : 0, notes: notes.length, blocked: !!(meta.blocked && meta.blocked.suspected), kb: Math.round(json.length / 1024), ms: meta.runMs };
    console.log(JSON.stringify(summaryLine));
    doneLine = summaryLine;
  } finally {
    clearTimeout(watchdog);
    await browser.close().catch(() => {});
    if (doneLine) writeDone(doneLine);
  }
}

// One inventory of continuous (ambient) motion from every source: idle-sampled marquees and loops,
// infinite visible CSS/WAAPI animations, playing videos, auto-advancing carousels and JS marquees.
// Items are de-duplicated per band and animation name pattern.
// Reveal strip positions on this page that match the reference's strips (--frames-like): the content
// entering the viewport during the reference's step (y = scrollFrom + vh + step/2) is mapped through the
// band alignment of the two pages (offset inside the aligned band, or inside the merged run of bands
// when one band aligns with several), else by page fraction; same step size.
// How the page scrolled during a reveal strip, from the page-side rAF log [[epoch ms, scrollY, visual scroll]]
// and the wheel instant tw (epoch ms): px = visual scroll distance, startMs / settleMs = ms after the wheel
// when the visual scroll position first moved / reached its final value (within 1 px) for good, as seen by
// the page's animation frames; firstFrameMs = the first page animation frame after the input (a busy main
// thread delays it, so then the times are upper bounds).
// Reveal groups linked to their strips (skip, strip, inStrip, trigger from the strip): motion.mjs linkRevealStrips.
function linkRevealStrips(motion, vw, vh) {
  if (!motion.reveals || !motion.frames || !motion.frames.reveals) return;
  linkStrips(motion.reveals, motion.frames.reveals, vw, vh);
}

function scrollMotion(log, tw) {
  if (!Array.isArray(log) || log.length < 2) return null;
  const before = log.filter((e) => e[0] <= tw);
  const v0 = (before.length ? before[before.length - 1] : log[0])[2];
  const vEnd = log[log.length - 1][2];
  const after = log.filter((e) => e[0] > tw);
  const px = Math.round(vEnd - v0);
  const firstFrameMs = after.length ? Math.max(0, Math.round(after[0][0] - tw)) : null;
  if (Math.abs(px) < 2 || !after.length) return { px, startMs: null, settleMs: null, firstFrameMs };
  const st = after.find((e) => Math.abs(e[2] - v0) >= 1);
  let settle = null;
  for (let i = after.length - 1; i >= 0; i--) { if (Math.abs(after[i][2] - vEnd) > 1) break; settle = after[i]; }
  return { px, startMs: st ? Math.max(0, Math.round(st[0] - tw)) : null, settleMs: settle ? Math.max(0, Math.round(settle[0] - tw)) : null, firstFrameMs };
}

function likeTargets(refDir, cap, vh) {
  const ref = JSON.parse(fs.readFileSync(path.join(refDir, 'capture.json'), 'utf8'));
  const list = (ref.motion && ref.motion.frames && ref.motion.frames.reveals) || [];
  if (!list.length) return [];
  const PVk = '1440';
  const refPH = (ref.meta && ref.meta.pageHeight && ref.meta.pageHeight[PVk]) || 1, bPH = (cap.meta && cap.meta.pageHeight && cap.meta.pageHeight[PVk]) || 1;
  const R = normBands(ref.sections, PVk, refPH), B = normBands(cap.sections, PVk, bPH);
  const pairs = R.length && B.length ? alignBands(R, B) : [];
  const span = (secs) => ({ y0: secs[0].y, y1: secs[secs.length - 1].y + secs[secs.length - 1].h });
  return list.map((r, idx) => {
    const step = Math.max(100, (r.scrollTo ?? 0) - (r.scrollFrom ?? 0));
    const yA = (r.scrollFrom || 0) + vh + step / 2;
    const ri = R.findIndex((b) => { const s = ref.sections[b.i]; return s && yA >= s.y && yA < s.y + s.h; });
    let yB = null, how = 'fraction', frac = null, refBand = null;
    if (ri >= 0) {
      const sA = ref.sections[R[ri].i];
      refBand = R[ri].i; frac = Math.round(((yA - sA.y) / Math.max(1, sA.h)) * 1000) / 1000;
      const p = pairs.find((q) => (q.aRun || [q.a]).includes(ri) && (q.bRun || []).length);
      if (p) {
        const a = span(p.aRun.map((k) => ref.sections[R[k].i])), b = span(p.bRun.map((k) => cap.sections[B[k].i]));
        yB = b.y0 + ((yA - a.y0) / Math.max(1, a.y1 - a.y0)) * (b.y1 - b.y0);
        how = p.aRun.length > 1 || p.bRun.length > 1 ? 'band run' : 'band';
      }
    }
    if (yB === null) yB = (yA / refPH) * bPH;
    const from = Math.max(0, Math.round(yB - vh - step / 2));
    const bs = cap.sections.find((s) => yB >= s.y && yB < s.y + s.h);
    return { k: idx + 1, band: bs ? bs.id : null, from, to: from + step, why: r.why || undefined, like: { ref: idx + 1, refBand, refScrollFrom: r.scrollFrom, how, frac } };
  });
}

function ambientInventory(motion, staticAmb, A, idOf, media) {
  const items = [];
  const pat = (n) => String(n || '').replace(/[0-9]+/g, '#');
  const has = (band, name) => items.some((x) => x.band === band && name && x.names.some((m) => pat(m) === pat(name)));
  const kindOf = (k) => ({ 'rotate-loop': 'rotate', 'pulse-loop': 'pulse', oscillate: 'move', drift: 'move', loop: 'loop', marquee: 'marquee' }[k] || k);
  const namesOf = (css) => String(css || '').split(';').map((x) => x.trim().split(' ')[0]).filter((x) => x && x !== 'js');
  // one item per band and animation name pattern (several elements running the same keyframes = n)
  const push = (x) => { const e = x.names.length ? items.find((y) => y.band === x.band && y.kind === x.kind && y.names.some((n) => x.names.some((m) => pat(m) === pat(n)))) : null; if (e) e.n = (e.n || 1) + 1; else items.push(x); };
  for (const m of motion.marquees || []) push({ kind: 'marquee', band: m.band, el: m.el, src: /js/.test(m.css) ? 'js' : 'css', names: namesOf(m.css) });
  for (const l of motion.loops || []) push({ kind: kindOf(l.kind), band: l.band, el: l.el, src: l.css === 'js' ? 'js' : 'css', names: namesOf(l.css) });
  for (const a of staticAmb) {
    if (a.absorbed) continue; // motion inside a hero media / illustration box: that box's media activity
    const band = idOf(A, a.band);
    if (has(band, a.name) || items.some((x) => x.band === band && x.el === a.el)) continue;
    items.push({ kind: a.kind, band, el: a.el, src: a.src, n: a.n, names: [a.name] });
  }
  for (const c of (motion.carousels && motion.carousels.autoAdvanceCandidates) || []) if (!items.some((x) => x.band === c.band && x.kind === 'auto-advance')) items.push({ kind: 'auto-advance', band: c.band, el: c.el, src: 'js', names: [], periodMs: c.periodMs ?? undefined });
  // hero media that keeps moving (frame differencing inside its box): video, canvas/WebGL, Lottie, an
  // illustration of keyframe-animated pieces, a UI mock-up cycling its states, ... The level comes from the
  // settled-page `rate` alone (the same rule as motion.load.media)
  for (const m of media || []) {
    const lvl = boxLevel(m.continuous);
    if (!lvl || lvl === 'static') continue;
    if (items.some((x) => x.el === m.desc)) continue;
    items.push({ kind: 'media', band: m.band, el: m.desc, src: 'frames', names: [], media: m.kind, box: m.box, activity: lvl, intermittent: intermittentOf(m.continuous) || undefined, rate: m.continuous && typeof m.continuous.rate === 'number' ? m.continuous.rate : undefined, motion: (m.continuous && m.continuous.motion) || undefined, keyframes: m.keyframes || undefined });
  }
  const content = (A.sections || []).filter((x) => !x.virtual && x.role !== 'nav' && x.role !== 'ad');
  const bands = [...new Set(items.map((x) => x.band).filter(Boolean))];
  const kinds = {};
  for (const x of items) kinds[x.kind] = (kinds[x.kind] || 0) + 1;
  return { count: items.length, kinds, bands, bandShare: content.length ? r3(bands.filter((b) => content.some((x) => x.id === b)).length / content.length) : 0,
    items: items.slice(0, 16).map(({ names, ...x }) => Object.assign(x, { name: names[0] || undefined })) };
}

// Load staging from the warm-cache second load (warmLoad). motion.load and motion/frames/load describe
// the warm run, unless only the cold run saw a load animation (an intro played on the first visit
// only), then both come from the cold run. frames.load.visual.designed = the first screen builds up in
// steps in that run and the build-up is design, not network: on the warm run it repeats with a warm
// cache; on a cold-only run it is driven by load animations. visual.network = the cold run built up in
// steps but the warm run did not (slow progressive rendering).
async function finishLoad(ctx, o, pw, ph, outDir, motion, { heroMedia = null, bandAt = () => null, hideCss = '', meta = null, repeat = [] } = {}) {
  const fdir = (n) => path.join(outDir, 'motion', 'frames', n);
  const coldFrames = motion.frames.load;
  const coldLoad = motion.load;
  const warm = o.fast ? null : await warmLoad(ctx, o, pw, ph, o.motionFrames ? fdir('load-warm') : null, hideCss, repeat).catch((e) => { note('warm load run failed: ' + e.message.split('\n')[0]); return null; });
  if (warm && warm.overlays && warm.overlays.length && meta) addOverlays(meta, warm.overlays, pw, 'warm load');
  // hero media activity inside each run's load frames (and the settled-page sample taken earlier); media
  // that moves by itself is masked out of the visual build-up measure below
  const media = heroMedia || [];
  const actOf = async (fr) => (fr && fr.picked && media.length ? boxActivity(ctx, fr.picked, media.map((m) => m.box)).catch(() => []) : []);
  const coldAct = await actOf(coldFrames), warmAct = await actOf(warm && warm.frames);
  // continuous: level from rate alone (also intermittent motion); load phase: sustained change only (an image
  // arriving once is not media motion)
  const moves = (r) => { const l = boxLevel(r); return !!l && l !== 'static'; };
  const masks = media.filter((m, i) => moves(m.continuous) || sustained(coldAct[i]) || sustained(warmAct[i])).map((m) => m.box);
  const vis = (n) => visualLoad(ctx, fdir(n), masks).catch((e) => { note(`visual load measure failed: ${e.message.split('\n')[0]}`); return null; });
  const coldVisual = coldFrames ? await vis('load-cold') : null;
  const warmA = warm && warm.loadRaw ? analyzeLoad(warm.loadRaw) : null;
  const hasAnim = (l) => !!(l && l.summary);
  const useWarm = !!warmA && !(hasAnim(coldLoad) && !hasAnim(warmA));
  const short = (l) => (l && l.summary ? { groups: l.summary.groups, firstStartMs: l.summary.firstStartMs, lastEndMs: l.summary.lastEndMs, staging: l.summary.staging } : null);
  if (useWarm) motion.load = Object.assign(warmA, { run: 'warm', cold: short(coldLoad) });
  else if (coldLoad) {
    coldLoad.run = 'cold';
    if (warmA) { coldLoad.warm = short(warmA); note('load animation seen on the first (cold) visit only; motion.load and the load frames come from the cold run'); }
    else if (!o.fast) note('warm load run unavailable; motion.load and the load frames come from the cold run');
  }
  const warmVisual = warm && warm.frames ? await vis('load-warm') : null;
  const chosen = useWarm && warm && warm.frames ? 'warm' : coldFrames ? 'cold' : null;
  // lead-in of each run's strip (frames after first paint where the first screen does not look loaded yet),
  // read before the run directories are merged; decided below
  const leadOf = async (n) => leadInOf(await leadInSeries(ctx, fdir(n), media.map((m) => m.box)).catch((e) => { note(`load lead-in measure failed: ${e.message.split('\n')[0]}`); return null; }));
  const coldLead = coldFrames && fs.existsSync(fdir('load-cold')) ? await leadOf('load-cold') : null;
  const warmLead = warm && warm.frames ? await leadOf('load-warm') : null;
  if (chosen) {
    fs.rmSync(fdir('load'), { recursive: true, force: true });
    fs.renameSync(fdir(`load-${chosen}`), fdir('load'));
  }
  for (const d of ['load-warm', 'load-cold']) fs.rmSync(fdir(d), { recursive: true, force: true });
  // hero media activity: on load (inside the chosen run's load frames) and continuously (settled-page sample),
  // and when each box first looks loaded in the chosen strip (with the load staging, or from first paint)
  if (media.length) {
    const onLoad = chosen === 'warm' ? warmAct : chosen === 'cold' ? coldAct : [];
    const arrival = chosen ? await mediaArrival(ctx, fdir('load'), media.map((m) => m.box)).catch((e) => { note(`media arrival measure failed: ${e.message.split('\n')[0]}`); return []; }) : [];
    if (!motion.load) motion.load = { summary: null, groups: [] };
    motion.load.media = media.map((m, i) => mediaEntry(m, onLoad[i], bandAt, arrival[i] || null));
  }
  if (!chosen) { motion.frames.load = null; return; }
  const brief = (x) => (x ? { firstContentMs: x.firstContentMs, growSteps: x.growSteps, lastGrowMs: x.lastGrowMs, staged: x.staged, live: x.live } : null);
  const v = chosen === 'warm' ? warmVisual : coldVisual;
  if (v) {
    const stagedHere = v.staged && !v.live;
    v.designed = chosen === 'warm' ? stagedHere : stagedHere && hasAnim(motion.load);
    const coldStaged = !!(coldVisual && coldVisual.staged && !coldVisual.live);
    v.network = chosen === 'warm' && coldStaged && !stagedHere;
    if (chosen === 'warm') v.cold = brief(coldVisual); else v.warm = brief(warmVisual);
  }
  const fl = Object.assign({}, chosen === 'warm' ? warm.frames : coldFrames, { dir: 'motion/frames/load', run: chosen, visual: v });
  // when the first screen stopped changing (frames, and the end of the load animations the DOM sampler saw)
  const L = motion.load, sum = L && L.summary;
  const domEnd = sum && typeof L.fcpMs === 'number' && typeof sum.lastEndMs === 'number' ? sum.lastEndMs - L.fcpMs : null;
  Object.assign(fl, loadSettle(v, domEnd, fl.windowMs || (v && v.windowMs) || LOAD_WINDOW_MS, undefined, motion.load && motion.load.media));
  const lead = chosen === 'warm' ? warmLead : coldLead;
  if (lead) fl.leadIn = leadInDecision(lead, chosen === 'warm' ? coldLead : undefined, { load: L, visual: v, media: motion.load && motion.load.media ? motion.load.media : [], vw: pw, vh: ph, windowMs: fl.windowMs || LOAD_WINDOW_MS });
  // a media box that only arrives with a skipped (network) lead-in does not arrive with the load staging
  const skip = fl.leadIn && fl.leadIn.skippedMs ? fl.leadIn.skippedMs : 0;
  if (skip) for (const m of (L && L.media) || []) if (m && typeof m.appearsMs === 'number' && m.appearsMs <= skip + 120) m.withLoad = false;
  // how the first screen and each load group arrive in the strip: step (one or two frames: build it with no
  // transition) or fade / slide with the duration the frames show (frames.mjs loadAppear; the strip wins
  // over a sampled duration that disagrees)
  try {
    const groups = (L && L.groups) || [];
    const mv = ((L && L.media) || []).filter((m) => m && m.moving && Array.isArray(m.box)).map((m) => m.box);
    const ap = loadAppear(await stripGrids(ctx, fdir('load')), { fps: LOAD_FPS, frameW: pw, frameH: ph, boxes: groups.map((g) => g.box || null), masks: mv });
    if (ap) {
      if (ap.screen) fl.appear = Object.assign(ap.screen, ap.masked ? { masked: ap.masked } : {});
      ap.boxes.forEach((a, i) => { if (a && groups[i]) groups[i].appear = a; });
    }
  } catch (e) { note('load appearance measure failed: ' + e.message.split('\n')[0]); }
  motion.frames.load = fl;
}

// Lead-in of the load strip (frames.mjs leadInOf: frames after first paint in which a large part of the
// first screen does not look loaded yet). It is left out of the strip shown to a reviewer (skippedMs) only
// when it is media or network arrival, never design: no load animation starts inside it (motion.load), the
// frames do not build up in steps on the warm load (visual.designed), and either most of what is missing is
// a network-loaded hero media box (video, image, background image, iframe; >= 25% of the first screen) or
// the cold load took clearly longer to get there (other = the cold run's lead-in; undefined when the strip
// is the cold run). The frames on disk always start at first paint.
function leadInDecision(lead, other, { load, visual, media, vw, vh, windowMs }) {
  const out = { skippedMs: 0, paintedMs: lead.paintedMs };
  if (other !== undefined) out.coldPaintedMs = other ? other.paintedMs : 0;
  if (lead.paintedMs === null) return Object.assign(out, { why: 'the first screen does not reach its loaded look inside the strip; nothing skipped' });
  const sum = load && load.summary;
  const animStart = sum && typeof load.fcpMs === 'number' && typeof sum.firstStartMs === 'number' ? Math.round(sum.firstStartMs - load.fcpMs) : null;
  if (animStart !== null && animStart < lead.paintedMs + 100) return Object.assign(out, { why: `not skipped: load animations start ${Math.max(0, animStart)} ms after first paint, inside the lead-in (kept on the sheets)` });
  if (visual && visual.designed) return Object.assign(out, { why: 'not skipped: the first screen builds up in steps on the warm-cache load (designed)' });
  if (lead.paintedMs > windowMs - 1500) return Object.assign(out, { why: 'not skipped: the first screen is painted too late in the strip to start there' });
  const net = media.filter((m) => /^(video|img|bg-image|iframe)$/.test(m.kind) && m.box && m.box[2] * m.box[3] >= 0.25 * vw * vh).sort((a, b) => b.box[2] * b.box[3] - a.box[2] * a.box[3]);
  const mediaArrival = net.length > 0 && lead.inShare >= 0.5;
  const coldLater = !!other && (other.paintedMs === null || other.paintedMs - lead.paintedMs >= Math.max(400, lead.paintedMs * 0.5));
  if (!mediaArrival && !coldLater) return Object.assign(out, { why: 'not skipped: no sign of media or network arrival (not a hero media box, and the cold load was not slower)' });
  const m = net[0];
  out.skippedMs = lead.paintedMs;
  out.why = [mediaArrival ? `hero media still arriving: ${m.kind} ${m.el} (${Math.round((m.box[2] * m.box[3]) / (vw * vh) * 100)}% of the first screen) not painted yet` : 'the first screen still arriving',
    coldLater ? `the cold load took ${other.paintedMs === null ? `more than ${windowMs}` : other.paintedMs} ms to get there (network)` : null,
    'no load animation in it (motion.load)'].filter(Boolean).join('; ');
  return out;
}

function idOfBandSafe(A, b) { return b !== null && b !== undefined && b >= 0 && A.sections[b] ? A.sections[b].id : null; }
function sumObj(a, b) { const o = {}; for (const k of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) o[k] = ((a || {})[k] || 0) + ((b || {})[k] || 0); return o; }

// Keep capture.json under ~150 KB: drop the most verbose optional detail first, noting each cut.
function shrink(out) {
  const LIMIT = 150 * 1024;
  let s = JSON.stringify(out, null, 1);
  const cuts = [
    ['keyframes steps trimmed to 4', () => { for (const k of Object.keys(out.motion.keyframes || {})) out.motion.keyframes[k] = out.motion.keyframes[k].slice(0, 4); }],
    ['colors.vars capped at 25', () => { const e = Object.entries(out.colors.vars || {}); if (e.length > 25) out.colors.vars = Object.fromEntries(e.slice(0, 25)); }],
    ['section pad value lists dropped from spacing.sectionPad', () => { for (const v of Object.values(out.spacing.sectionPad)) delete v.values; }],
    ['getAnimations capped at 10', () => { out.motion.getAnimations = (out.motion.getAnimations || []).slice(0, 10); }],
    ['reveal groups capped at 12', () => { if (out.motion.reveals && out.motion.reveals.groups) out.motion.reveals.groups = out.motion.reveals.groups.slice(0, 12); }],
    ['transitions capped at 12', () => { out.motion.transitions = (out.motion.transitions || []).slice(0, 12); }],
    ['hover kids dropped', () => { for (const h of out.hover) if (h && h.kids) h.kids = h.kids.slice(0, 2); }],
    // keeps what compare and the builder read per narrow band (link, pads, headPx, columns, cards, align, media)
    ['sectionsByViewport trimmed to geometry, link, pad, headPx, columns, cards, align, media', () => { for (const [vp, l] of Object.entries(out.sectionsByViewport)) out.sectionsByViewport[vp] = l.map((x) => ({ id: x.id, i: x.i, role: x.role, y: x.y, h: x.h, hFrac: x.hFrac, link: x.link, cols: x.cols, cardCols: x.cardCols, cards: x.cards, cardGap: x.cardGap, peek: x.peek, collage: x.collage, align: x.align, pad: x.pad, headPx: x.headPx, media: x.media, bg: { type: x.bg.type, color: x.bg.color, sampled: x.bg.sampled } })); }],
  ];
  for (const [label, fn] of cuts) {
    if (s.length <= LIMIT) break;
    fn(); out.notes.push(`size cap: ${label}`);
    s = JSON.stringify(out, null, 1);
  }
  return s;
}

main().catch((e) => { const msg = e && e.message ? e.message : String(e); console.error(`capture: ${msg}`); if (process.env.RESTYLE_DEBUG && e && e.stack) console.error(e.stack); writeDone({ ok: false, error: msg.slice(0, 300) }); process.exit(1); });
