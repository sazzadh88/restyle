#!/usr/bin/env node
/*
 * inspect.mjs — small measuring tools so a builder never needs an ad-hoc Playwright script.
 * Each command prints exactly one JSON line; exits non-zero on failure.
 *
 *   node inspect.mjs color <image.png|jpg> <x> <y> [w h]        average + dominant hex of a region (default 1x1)
 *   node inspect.mjs crop <image> <x> <y> <w> <h> <out.png>     crop a region to a PNG
 *   node inspect.mjs overflow <url> [width]                      elements whose right edge passes the viewport, widest first, and
 *                                                                clipped[]: text/media cut at a viewport edge (capture overflow.clipped)
 *   node inspect.mjs style <url> <selector> [<selector> ...] [width]  computed style subset + box of the first matches (<= 5),
 *                                                                several selectors share one page load: {selectors: {<sel>: {matches, items, why?}}},
 *                                                                each scrolled into view and settled first (atTop: what differed at scroll 0);
 *                                                                0 matches: `why` {cause: invalid-selector | added-later | hashed-classes |
 *                                                                shadow-root | iframe | not-found, detail, hint, ...}
 *   node inspect.mjs activity <url> [--box x,y,w,h] [--width 1440]  first-screen media activity in ~10 s: per media box (or the
 *                                                                given box) activity level, rate (share of the box changing per
 *                                                                second, the capture's own code), intermittent, motion kind, hot region
 *   node inspect.mjs get <capDir> <path> [--depth N]             one capture.json value by dot path (type.roles.1440.body,
 *                                                                sections.3.pad, sections[3].pad); deep objects summarised,
 *                                                                long arrays/strings cut, `truncated` says what was shortened
 *   node inspect.mjs bands <url> [width]                         the capture's band segmentation only (no motion pass):
 *                                                                y, h, background, columns, cards, pad, contentX [left, right] text/media edges, headPx
 *   node inspect.mjs fontmatch <refCapDir> --role <display|h1|h2|h3|body|nav|button> [--candidates "Family A,Family B"] [--top 5] [--brief]
 *                                                                rank Google Fonts families against the reference's type sample crop
 *                                                                (capture.json type.samples[role] + shots/type-<role>.png): renders each
 *                                                                candidate over a weight grid and scores advance width, ink, x-height,
 *                                                                stroke contrast and shape; writes <refCapDir>/fontmatch-<role>.png and prints
 *                                                                {role, ref{text,px,weight,ls,class}, candidates[{family, weight, score,
 *                                                                lsAdjustEm, sizeAdjust, class, parts, apply, sizeClamped?, trackingClamped?}],
 *                                                                sizeAdjustSuspect?, composite, ms}. --brief: also a compact table on stderr,
 *                                                                and a short JSON (rank, family, class, weight, sizeAdjust, apply, score,
 *                                                                clamps; sampleQuality; composite)
 *
 * Images: PNG is decoded with pngjs; JPEG (motion frames) is decoded in headless Chrome. URLs open in the
 * installed Chrome (playwright-core, channel 'chrome') with exactly the browser settings capture.mjs uses
 * (lib/browser.mjs: flags, user agent, locale, timezone, headers) at <width> (default 1440) x the capture's
 * height for that width, wait for load + a quiet network, dismiss consent overlays, and scroll once to the
 * bottom and back so lazy content and scroll reveals are in their final state. When the page looks like a
 * bot wall or challenge (lib/browser.mjs blockedCheck), the JSON line carries blocked: true and
 * blockedReasons[]; the command still exits 0, but its data may describe the challenge page.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PNG } from 'pngjs';
import { converter, differenceEuclidean, formatHex } from 'culori';
import { pageCore } from './lib/page-core.mjs';
import { pageAnalyze } from './lib/page-analyze.mjs';
import { handleConsent } from './lib/consent.mjs';
import { launchChrome, newCaptureContext, blockedCheck } from './lib/browser.mjs';
import { fontmatch, fontmatchBrief } from './lib/fontmatch.mjs';
import { sampleMedia, intermittentOf, boxLevel, RATE_LEVELS } from './lib/frames.mjs';

const INIT = `(${pageCore})();(${pageAnalyze})();`;
const VH = { 1440: 900, 768: 1024, 390: 844 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toLab = converter('oklab');
const dLab = differenceEuclidean('oklab');
const out = (o) => { console.log(JSON.stringify(o)); };
const fail = (msg) => { console.error(`inspect: ${msg}`); process.exit(1); };
const USAGE = 'usage: node inspect.mjs color <image> <x> <y> [w h] | crop <image> <x> <y> <w> <h> <out.png> | overflow <url> [width] | style <url> <selector> [<selector> ...] [width] | bands <url> [width] | activity <url> [--box x,y,w,h] [--width 1440] | fontmatch <refCapDir> --role <role> [--candidates "A,B"] [--top 5] [--brief] | get <capDir> <path> [--depth N]';

let browser = null;
async function chrome() {
  // same launch flags as capture.mjs; file access lets file:// builds load their own local files
  if (!browser) browser = await launchChrome(['--allow-file-access-from-files']);
  return browser;
}
// bot-wall suspicion goes into every URL command's JSON line (the data may then describe the challenge page)
const withBlocked = (o, blocked) => (blocked && blocked.suspected
  ? Object.assign(o, { blocked: true, blockedReasons: blocked.reasons, blockedNote: 'the page looks like a bot wall or challenge page: the data above may describe that page, not the site' })
  : o);

// ---------- images ----------
async function decodeImage(file) {
  if (!fs.existsSync(file)) fail(`no such file ${file}`);
  if (/\.png$/i.test(file)) { const p = PNG.sync.read(fs.readFileSync(file)); return { width: p.width, height: p.height, data: p.data }; }
  // JPEG (or anything Chrome decodes): draw into a canvas and read the pixels back
  const b = await chrome();
  const page = await (await newCaptureContext(b, { width: 800, height: 600 })).newPage();
  const res = await page.evaluate(async (src) => {
    const img = new Image();
    img.src = src;
    await img.decode();
    const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
    const x = c.getContext('2d'); x.drawImage(img, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height).data;
    let s = ''; const chunk = 0x8000;
    for (let i = 0; i < d.length; i += chunk) s += String.fromCharCode.apply(null, d.subarray(i, i + chunk));
    return { width: c.width, height: c.height, b64: btoa(s) };
  }, `data:image/${/\.png$/i.test(file) ? 'png' : 'jpeg'};base64,${fs.readFileSync(file).toString('base64')}`);
  await page.close();
  return { width: res.width, height: res.height, data: Buffer.from(res.b64, 'base64') };
}
function region(img, x, y, w, h) {
  x = Math.max(0, Math.round(x)); y = Math.max(0, Math.round(y));
  w = Math.max(1, Math.min(Math.round(w), img.width - x)); h = Math.max(1, Math.min(Math.round(h), img.height - y));
  if (x >= img.width || y >= img.height) fail(`region outside the image (${img.width}x${img.height})`);
  return { x, y, w, h };
}
async function cmdColor([file, x, y, w = 1, h = 1]) {
  if (!file || x === undefined || y === undefined) fail(USAGE);
  const img = await decodeImage(file);
  const r = region(img, +x, +y, +w, +h);
  let R = 0, G = 0, B = 0, n = 0;
  const bins = new Map();
  for (let yy = r.y; yy < r.y + r.h; yy++) for (let xx = r.x; xx < r.x + r.w; xx++) {
    const i = (yy * img.width + xx) * 4;
    const pr = img.data[i], pg = img.data[i + 1], pb = img.data[i + 2];
    R += pr; G += pg; B += pb; n++;
    const k = ((pr >> 3) << 10) | ((pg >> 3) << 5) | (pb >> 3);
    const e = bins.get(k) || [0, 0, 0, 0]; e[0]++; e[1] += pr; e[2] += pg; e[3] += pb; bins.set(k, e);
  }
  const hex = (r0, g0, b0) => formatHex({ mode: 'rgb', r: r0 / 255, g: g0 / 255, b: b0 / 255 });
  // dominant: histogram bins merged within OKLab 0.02
  const cl = [];
  for (const e of [...bins.values()].sort((a, b) => b[0] - a[0]).slice(0, 300)) {
    const hx = hex(e[1] / e[0], e[2] / e[0], e[3] / e[0]);
    const lab = toLab(hx);
    const c = cl.find((k) => dLab(k.lab, lab) < 0.02);
    if (c) c.n += e[0]; else cl.push({ hex: hx, lab, n: e[0] });
  }
  cl.sort((a, b) => b.n - a.n);
  out({ cmd: 'color', file: path.resolve(file), region: r, average: hex(R / n, G / n, B / n), dominant: cl[0].hex, dominantShare: Math.round((cl[0].n / n) * 1000) / 1000, top: cl.slice(0, 4).map((c) => ({ hex: c.hex, share: Math.round((c.n / n) * 1000) / 1000 })) });
}
async function cmdCrop([file, x, y, w, h, dest]) {
  if (!file || dest === undefined) fail(USAGE);
  const img = await decodeImage(file);
  const r = region(img, +x, +y, +w, +h);
  const o = new PNG({ width: r.w, height: r.h });
  for (let row = 0; row < r.h; row++) { const s = ((r.y + row) * img.width + r.x) * 4; img.data.copy(o.data, row * r.w * 4, s, s + r.w * 4); }
  fs.mkdirSync(path.dirname(path.resolve(dest)), { recursive: true });
  fs.writeFileSync(dest, PNG.sync.write(o, { colorType: 2 }));
  out({ cmd: 'crop', file: path.resolve(file), region: r, out: path.resolve(dest) });
}

// ---------- pages ----------
async function openUrl(url, width) {
  const w = +width || 1440;
  const h = VH[w] || Math.round(w * (w >= 1000 ? 0.625 : 1.6));
  const b = await chrome();
  const ctx = await newCaptureContext(b, { width: w, height: h });
  const page = await ctx.newPage();
  await page.addInitScript({ content: INIT });
  const u = /^[a-z]+:\/\//i.test(url) ? url : fs.existsSync(url) ? pathToFileURL(path.resolve(url)).href : 'https://' + url;
  let inflight = 0, last = Date.now();
  page.on('request', () => { inflight++; last = Date.now(); });
  const done = () => { inflight = Math.max(0, inflight - 1); last = Date.now(); };
  page.on('requestfinished', done); page.on('requestfailed', done);
  const resp = await page.goto(u, { waitUntil: 'load', timeout: 60000 }).catch((e) => fail(`navigation failed: ${e.message.split('\n')[0]}`));
  const status = resp ? resp.status() : null;
  const t0 = Date.now();
  while (Date.now() - t0 < 6000 && !(inflight <= 1 && Date.now() - last > 500)) await sleep(100);
  await page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});
  // same point as capture.mjs: after load + quiet network, before consent handling
  const blocked = await blockedCheck(page, status);
  await handleConsent(page).catch(() => null);
  // one pass to the bottom and back: lazy content and scroll reveals settle in their final state
  for (let i = 0; i < 60; i++) {
    const s = await page.evaluate(() => ({ y: scrollY, max: document.documentElement.scrollHeight - innerHeight }));
    if (s.y >= s.max - 2) break;
    await page.mouse.wheel(0, Math.round(h * 0.85));
    await sleep(120);
  }
  await sleep(400);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await sleep(500);
  return { page, w, h, url: u, blocked };
}
async function cmdOverflow([url, width]) {
  if (!url) fail(USAGE);
  const { page, w, url: u, blocked } = await openUrl(url, width);
  const r = await page.evaluate(() => {
    const vw = innerWidth;
    const sw = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
    const bx = scrollX; window.scrollTo(100000, scrollY); const canX = scrollX > 0 && !(window.__rc && window.__rc.viewportClipsX && window.__rc.viewportClipsX()); window.scrollTo(bx, scrollY);
    const clipped = (el) => { for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) { const cs = getComputedStyle(p); if (cs.overflowX !== 'visible' && p.getBoundingClientRect().right <= vw + 1) return true; } return false; };
    const hits = [];
    for (const el of document.body.getElementsByTagName('*')) {
      if (el.ownerSVGElement) continue;
      const b = el.getBoundingClientRect();
      if (b.width < 1 || b.right <= vw + 1) continue;
      const cs = getComputedStyle(el);
      if (cs.position === 'fixed' || cs.display === 'none' || cs.visibility === 'hidden') continue;
      if (clipped(el)) continue;
      hits.push({ el, w: b.width, right: b.right, top: b.top + scrollY });
    }
    const outer = hits.filter((x) => !hits.some((q) => q !== x && q.el.contains(x.el) && q.right >= x.right - 1)).sort((a, b) => b.w - a.w);
    // content clipped past the viewport edge (the capture's own check, overflow.clipped)
    const ce = window.__rc && window.__rc.clippedEdge ? window.__rc.clippedEdge({ vw, canX }) : { n: 0, items: [] };
    return { vw, scrollWidth: sw, scrollsSideways: canX, offenders: outer.slice(0, 10).map((x) => ({ sel: window.__rc ? window.__rc.selPath(x.el) : x.el.tagName.toLowerCase(), w: Math.round(x.w), right: Math.round(x.right), y: Math.round(x.top) })), clippedN: ce.n, clipped: ce.items };
  });
  out(withBlocked(Object.assign({ cmd: 'overflow', url: u, width: w }, r), blocked));
}
// style <url> <selector> [<selector> ...] [width]: one page load for every selector (each load relaunches
// Chrome, ~15 s). One selector: {cmd, url, width, selector, matches, items, why?}; several: {cmd, url,
// width, selectors: {<selector>: {matches, items, why?}}}. An invalid selector sets exit code 1.
async function cmdStyle(args) {
  const [url, ...rest] = args;
  const width = rest.length > 1 && /^\d+$/.test(rest[rest.length - 1]) ? rest.pop() : undefined;
  if (!url || !rest.length) fail(USAGE);
  const { page, w, url: u, blocked } = await openUrl(url, width);
  if (rest.length === 1) {
    const r = await styleOne(page, rest[0]);
    out(withBlocked(Object.assign({ cmd: 'style', url: u, width: w, selector: rest[0] }, r), blocked));
    return;
  }
  const selectors = {};
  for (const s of rest) selectors[s] = await styleOne(page, s);
  out(withBlocked({ cmd: 'style', url: u, width: w, selectors }, blocked));
}
async function styleOne(page, sel) {
  const count = () => page.evaluate((s) => { try { return document.querySelectorAll(s).length; } catch (e) { return `bad selector: ${e.message}`; } }, sel);
  let n = await count(), why = null;
  if (typeof n === 'string') {
    // invalid selector: the JSON line says why, and the command exits non-zero
    process.exitCode = 1;
    return { matches: 0, items: [], why: { cause: 'invalid-selector', detail: n.replace(/^bad selector: /, '').split('\n')[0], hint: 'fix the selector syntax (escape special characters in class names, e.g. \\: or \\/ in utility classes)' } };
  }
  if (n === 0) {
    // added later? scroll slowly through the page and wait, then count again
    for (let i = 0; i < 40 && !n; i++) {
      const s = await page.evaluate(() => ({ y: scrollY, max: document.documentElement.scrollHeight - innerHeight }));
      n = await count();
      if (n || s.y >= s.max - 2) break;
      await page.mouse.wheel(0, Math.round(page.viewportSize().height * 0.7));
      await sleep(200);
    }
    if (!n) { await sleep(1500); n = await count(); }
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' })).catch(() => {});
    await sleep(300);
    if (n) why = { cause: 'added-later', detail: `0 matches after load; ${n} after scrolling through the page and waiting`, hint: 'the element is inserted or rendered late (lazy section, client render, scroll reveal); the items below are read after that' };
    else why = await styleWhyNone(page, sel);
  }
  // each match is scrolled to the middle of the viewport and left to settle (scroll reveals, lazy content and
  // content-visibility fire) before its style is read, so elements below the first screen report their
  // in-view state; `atTop` lists the properties that differ from the state read with the page at the top
  const P = ['display', 'position', 'color', 'backgroundColor', 'backgroundImage', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'textTransform', 'textAlign',
    'padding', 'margin', 'gap', 'gridTemplateColumns', 'flexDirection', 'borderRadius', 'border', 'boxShadow', 'opacity', 'transform', 'transition', 'animation', 'maxWidth', 'width', 'height', 'zIndex', 'overflow'];
  const read = (arg) => page.evaluate(({ s, i, P }) => {
    const el = document.querySelectorAll(s)[i];
    if (!el) return null;
    const cs = getComputedStyle(el), b = el.getBoundingClientRect();
    const style = {}; for (const p of P) style[p] = String(cs[p]).slice(0, 160);
    let rendered = null;
    try { const fam = cs.fontFamily.split(',')[0].trim().replace(/^["']|["']$/g, ''); const faces = [...document.fonts].filter((f) => f.status === 'loaded' && f.family.replace(/["']/g, '') === fam).map((f) => f.weight); rendered = faces.length ? { family: fam, loadedFaceWeights: [...new Set(faces)] } : null; } catch {}
    return { desc: window.__rc ? window.__rc.desc(el) : el.tagName.toLowerCase(), box: { x: Math.round(b.left + scrollX), y: Math.round(b.top + scrollY), w: Math.round(b.width), h: Math.round(b.height) }, style, fonts: rendered };
  }, arg);
  const items = [];
  for (let i = 0; i < Math.min(5, n); i++) {
    const top = await read({ s: sel, i, P });
    await page.evaluate(({ s, i }) => { const el = document.querySelectorAll(s)[i]; if (el) el.scrollIntoView({ block: 'center', behavior: 'instant' }); }, { s: sel, i });
    await sleep(350);
    await page.evaluate((m) => (window.__rc && window.__rc.waitAnimsIdle ? window.__rc.waitAnimsIdle(m) : null), 1500).catch(() => {});
    await sleep(150);
    const it = await read({ s: sel, i, P });
    if (!it) continue;
    const diff = top ? Object.fromEntries(P.filter((p) => top.style[p] !== it.style[p]).map((p) => [p, top.style[p]])) : {};
    if (Object.keys(diff).length) it.atTop = diff;
    items.push(it);
  }
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' })).catch(() => {});
  return Object.assign({ matches: n, items }, why ? { why } : {});
}
// 0 matches after the late re-check: shadow roots / same-origin iframes, then generated class names, else not found
function styleWhyNone(page, sel) {
  return page.evaluate((s) => {
    const want = [...s.matchAll(/\.((?:\\.|[\w-])+)/g)].map((m) => m[1].replace(/\\(.)/g, '$1'));
    const ids = [...s.matchAll(/#((?:\\.|[\w-])+)/g)].map((m) => m[1].replace(/\\(.)/g, '$1'));
    // inside open shadow roots / same-origin iframes (closed roots and cross-origin frames cannot be read)
    let inShadow = 0, roots = 0, inFrame = 0, frames = 0, xFrames = 0;
    const walk = (root, depth) => {
      for (const el of root.querySelectorAll('*')) if (el.shadowRoot && depth < 6) { roots++; try { inShadow += el.shadowRoot.querySelectorAll(s).length; } catch {} walk(el.shadowRoot, depth + 1); }
    };
    walk(document, 0);
    for (const f of document.querySelectorAll('iframe, frame')) { frames++; try { const d = f.contentDocument; if (!d) { xFrames++; continue; } inFrame += d.querySelectorAll(s).length; } catch { xFrames++; } }
    if (inShadow) return { cause: 'shadow-root', detail: `${inShadow} match(es) inside ${roots} open shadow root(s), none in the light DOM`, hint: 'inspect.mjs style reads the light DOM only; style the host element, or read the component in a build where it is not shadowed' };
    if (inFrame) return { cause: 'iframe', detail: `${inFrame} match(es) inside a same-origin iframe, none in the top document`, hint: 'open the iframe src directly with inspect.mjs style' };
    // class names on the page that look generated (hashed): css-in-js / CSS modules / build tools
    const HASH = [
      /^(?:css|sc|jsx|emotion|tw|sx|svelte|astro|chakra|mui|styled)-[a-z0-9]{4,}$/i,   // css-1x2y3z, sc-abc12, jsx-123456, sx-ab12cd
      /^_[a-z0-9]{5,}$/i,                                                          // _1e7jslxs
      /^[A-Za-z][\w]*_[\w-]+__[A-Za-z0-9_-]{4,}$/,                                 // Name_title__a1B2c (CSS modules)
      /^[A-Z][A-Za-z]*_[A-Za-z0-9-]{5,}$/,                                          // Name_hash
    ];
    const randTail = (c) => /^[a-z]{1,3}[A-Za-z0-9]{5,}$/.test(c) && (c.match(/\d/g) || []).length >= 2 && /[A-Za-z]\d+[A-Za-z]/.test(c);   // x3k9a2b
    const isHash = (c) => /\d/.test(c) && c.length >= 6 && (HASH.some((r) => r.test(c)) || randTail(c));
    const all = new Set();
    for (const el of document.querySelectorAll('[class]')) for (const c of el.classList) all.add(c);
    const hashed = [...all].filter(isHash);
    const missing = want.filter((c) => { try { return !document.querySelector(`.${CSS.escape(c)}`); } catch { return true; } });
    const missingIds = ids.filter((id) => !document.getElementById(id));
    // a missing class whose stem is on the page with another hash (Card_title__x1 vs Card_title__q9)
    const stem = (c) => c.replace(/(__|_|-)[A-Za-z0-9]{4,}$/, '');
    const similar = [...new Set(missing.flatMap((c) => { const st = stem(c); return st && st !== c && st.length >= 3 ? [...all].filter((x) => x !== c && stem(x) === st) : []; }))].slice(0, 6);
    const share = all.size ? hashed.length / all.size : 0;
    const base = {
      missingClasses: missing.length ? missing : undefined, missingIds: missingIds.length ? missingIds : undefined,
      shadowRoots: roots || undefined, iframes: frames ? { total: frames, crossOrigin: xFrames } : undefined,
    };
    const structural = 'match by tag / attribute / structure instead (e.g. "main h2", "header nav a", "[data-testid]", "section:nth-of-type(3) h2"), or use the `el` path from capture.json (bands[].el, type samples)';
    if (hashed.length >= 5 && share >= 0.15 && (missing.length || !want.length)) {
      return Object.assign({
        cause: 'hashed-classes',
        detail: `${missing.length ? `class ${missing.map((c) => '.' + c).join(', ')} is not on the page; ` : ''}${hashed.length} of ${all.size} class names on the page look generated/hashed (they change between builds)`,
        hashedSample: hashed.slice(0, 6), similar: similar.length ? similar : undefined, hint: structural,
      }, base);
    }
    const cross = xFrames ? `; ${xFrames} cross-origin iframe(s) could not be searched` : '';
    return Object.assign({
      cause: 'not-found',
      detail: `${missing.length ? `class ${missing.map((c) => '.' + c).join(', ')} is not on the page` : missingIds.length ? `id ${missingIds.map((x) => '#' + x).join(', ')} is not on the page` : 'no element matches the whole selector (each part may exist, but not in this combination)'}; not in open shadow roots or same-origin iframes either${cross}`,
      similar: similar.length ? similar : undefined, hint: structural,
    }, base);
  }, sel);
}
async function cmdBands([url, width]) {
  if (!url) fail(USAGE);
  const { page, w, url: u, blocked } = await openUrl(url, width);
  const A = await page.evaluate(() => window.__rc.analyze({ full: false }));
  out(withBlocked({ cmd: 'bands', url: u, width: w, docH: A.docH, bands: A.sections.map((s, i) => ({ i, id: s.id, role: s.role, y: s.y, h: s.h, bg: s.bg && (s.bg.type === 'color' ? s.bg.color : `${s.bg.type} ${s.bg.color || ''}`.trim()), cols: s.layout ? s.layout.cols : 1, cards: s.cards ? `${s.cards.n} x ${s.cards.cols}/row` : null, align: s.align, media: s.media ? s.media.place : null, pad: s.pad, contentX: s.contentX || null, headPx: s.headPx, el: s.desc, thirdParty: s.thirdParty || undefined })) }, blocked));
}

// ---------- media activity ----------
// The first screen's media boxes (the capture's hero media detection) or one given box, measured by the same
// code as capture.mjs (frames.mjs sampleMedia, after the same idle wait): a 4 s screencast; rate (share of the
// box changing per second, the number compare scores), active, intermittent, how it moves and the most-moving
// region from 6 fps picks; activity = rateLevel(rate), the capture's motion.load.media[].rateCont / activity.
async function cmdActivity(args) {
  const AU = 'usage: node inspect.mjs activity <url> [--box x,y,w,h] [--width 1440]';
  let url = null, box = null, width = 1440;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--box') box = String(args[++i] || '').split(',').map(Number);
    else if (a === '--width') width = +args[++i];
    else if (/^--/.test(a)) fail(`unknown option ${a}; ${AU}`);
    else if (!url) url = a;
    else fail(AU);
  }
  if (!url) fail(AU);
  if (box && !(box.length === 4 && box.every((v) => Number.isFinite(v)) && box[2] > 8 && box[3] > 8)) fail(`--box needs x,y,w,h in px (w, h > 8); ${AU}`);
  const t0 = Date.now();
  const { page, w, url: u, blocked } = await openUrl(url, width);
  // the capture's idle point: running finite animations done (at most 2.5 s), the pointer parked
  await page.evaluate(() => (window.__rc && window.__rc.waitAnimsIdle ? window.__rc.waitAnimsIdle(2500) : null)).catch(() => null);
  await page.mouse.move(4, 450).catch(() => {});
  const list = box ? [{ kind: 'box', desc: 'given box', box }] : await page.evaluate(() => (window.__rc && window.__rc.heroMedia ? window.__rc.heroMedia() : [])).catch(() => []);
  if (!list.length) return out(withBlocked({ cmd: 'activity', url: u, width: w, boxes: [], note: 'no media box in the first screen; pass --box x,y,w,h to measure a region', levels: RATE_LEVELS }, blocked));
  const s = await sampleMedia(page, list.map((m) => m.box));
  if (!s.results.some(Boolean)) fail('screencast recorded no frames');
  const res = list.map((m, i) => {
    const r = s.results[i];
    return { el: m.desc, kind: m.kind, box: m.box.map(Math.round), activity: boxLevel(r), intermittent: intermittentOf(r) || undefined, rate: r ? r.rate : null, ratePct: r && typeof r.rate === 'number' ? Math.round(r.rate * 1000) / 10 : null,
      motion: r ? r.motion || null : null, dir: r ? r.dir : undefined, pxPerSec: r ? r.pxPerSec : undefined, diff: r ? r.diff : null, active: r ? r.active : null, hot: r ? r.hot : null };
  });
  out(withBlocked({ cmd: 'activity', url: u, width: w, boxes: res, levels: RATE_LEVELS, note: 'settled-page activity, the same measure as capture motion.load.media[].rateCont (activity = level of rate; motion = in-place / lateral / cut / drift)', ms: Date.now() - t0 }, blocked));
}

// ---------- fonts ----------
const ROLES = ['display', 'h1', 'h2', 'h3', 'body', 'nav', 'button'];
async function cmdFontmatch(args) {
  const FM = 'usage: node inspect.mjs fontmatch <refCapDir> --role <display|h1|h2|h3|body|nav|button> [--candidates "Family A,Family B"] [--top 5] [--brief]';
  let dir = null, role = null, cands = null, top = 5, brief = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--role') role = args[++i];
    else if (a === '--brief') brief = true;
    else if (a === '--candidates') cands = args[++i];
    else if (a === '--top') top = +args[++i];
    else if (/^--/.test(a)) fail(`unknown option ${a}; ${FM}`);
    else if (!dir) dir = a;
    else fail(FM);
  }
  if (!dir || !role) fail(FM);
  if (!/^[\w-]+$/.test(role)) fail(`bad role "${role}" (one of ${ROLES.join(', ')})`);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) fail(`no such capture directory ${dir}`);
  if (!(top >= 1 && top <= 20)) fail('--top must be 1..20');
  const candidates = cands ? cands.split(',').map((x) => x.trim()).filter(Boolean) : null;
  if (cands !== null && !candidates.length) fail('--candidates is empty');
  const res = await fontmatch(await chrome(), { capDir: path.resolve(dir), role, candidates, top: Math.round(top) });
  if (!brief) return out(res);
  const b = fontmatchBrief(res);
  console.error(b.table);
  out(b.json);
}

// ---------- capture.json query ----------
// get <capDir|capture.json> <path> [--depth N]: one value of capture.json by dot path (array indexes as .1 or
// [1]; "" or "." = the root). Objects / arrays deeper than N levels (default 3) print as "{k keys: a, b, ...}" /
// "[n items]"; arrays longer than 25 keep their first 25; strings longer than 400 chars are cut; a value still
// over ~12 KB is cut to its top level. `truncated` says what was shortened. A missing path exits 1 naming
// the deepest part that exists and its keys.
async function cmdGet(args) {
  const GU = 'usage: node inspect.mjs get <capDir> <path> [--depth N]   e.g. get ref type.roles.1440.body';
  let dir = null, p = null, depth = 3;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--depth') depth = Number(args[++i]);
    else if (/^--/.test(a)) fail(`unknown option ${a}; ${GU}`);
    else if (dir === null) dir = a;
    else if (p === null) p = a;
    else fail(GU);
  }
  if (dir === null || p === null) fail(GU);
  if (!(Number.isInteger(depth) && depth >= 0 && depth <= 12)) fail('--depth must be an integer 0..12');
  const file = fs.existsSync(dir) && fs.statSync(dir).isDirectory() ? path.join(dir, 'capture.json') : dir;
  if (!fs.existsSync(file)) fail(`no capture.json at ${file}`);
  let cur;
  try { cur = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { fail(`capture.json does not parse: ${e.message}`); }
  const parts = p === '.' ? [] : p.replace(/\[(\d+)\]/g, '.$1').split('.').filter((x) => x !== '');
  const keysOf = (v) => (Array.isArray(v) ? `[${v.length} items]` : v && typeof v === 'object' ? Object.keys(v).slice(0, 40).join(', ') : typeof v);
  for (let k = 0; k < parts.length; k++) {
    const key = parts[k];
    const has = cur !== null && typeof cur === 'object' && (Array.isArray(cur) ? /^\d+$/.test(key) && +key < cur.length : Object.prototype.hasOwnProperty.call(cur, key));
    if (!has) fail(`no "${key}" at ${parts.slice(0, k).join('.') || '(root)'}; there: ${keysOf(cur)}`);
    cur = cur[key];
  }
  const notes = new Set();
  const shrink = (v, d) => {
    if (typeof v === 'string' && v.length > 400) { notes.add('strings over 400 chars cut'); return v.slice(0, 400) + '…'; }
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) {
      if (d >= depth) { notes.add(`arrays below depth ${depth} summarised`); return `[${v.length} items]`; }
      if (v.length > 25) notes.add('arrays over 25 items cut to the first 25');
      return v.slice(0, 25).map((x) => shrink(x, d + 1));
    }
    const ks = Object.keys(v);
    if (d >= depth) { notes.add(`objects below depth ${depth} summarised (raise --depth or query a deeper path)`); return `{${ks.length} keys: ${ks.slice(0, 16).join(', ')}${ks.length > 16 ? ', …' : ''}}`; }
    return Object.fromEntries(ks.map((k) => [k, shrink(v[k], d + 1)]));
  };
  let value = shrink(cur, 0);
  if (JSON.stringify(value).length > 12000) { notes.add('over 12 KB: shown to depth 1 only'); const keep = depth; depth = 1; value = shrink(cur, 0); depth = keep; }
  out({ cmd: 'get', file, path: parts.join('.') || '.', type: Array.isArray(cur) ? 'array' : cur === null ? 'null' : typeof cur, ...(Array.isArray(cur) ? { length: cur.length } : {}), value, ...(notes.size ? { truncated: [...notes].join('; ') } : {}) });
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const C = { color: cmdColor, crop: cmdCrop, overflow: cmdOverflow, style: cmdStyle, bands: cmdBands, fontmatch: cmdFontmatch, activity: cmdActivity, get: cmdGet }[cmd];
  if (!C) fail(USAGE);
  try { await C(args); } finally { if (browser) await browser.close().catch(() => {}); }
}
main().catch((e) => fail(e && e.message ? e.message.split('\n')[0] : String(e)));
