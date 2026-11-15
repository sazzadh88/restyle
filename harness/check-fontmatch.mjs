#!/usr/bin/env node
// Asserts inspect.mjs fontmatch (skill/restyle/scripts/lib/fontmatch.mjs) on synthetic type samples with
// known answers. Each case is rendered in the installed Chrome with a Google font, cropped like capture.mjs
// crops a type sample (first line box + 4 px), written as a minimal capture dir (capture.json
// type.samples.<role> + shots/type-<role>.png) under runs/dev/fontmatch/<case>/, and matched against a
// fixed candidate list. Checks: rendered weight for dim, grey and light-on-dark text (contrast
// normalisation), the width axis that is reported is the one rendered (wdth variants: advance part,
// tracking), and sampleQuality (good on plain one-colour lines; poor on a busy background, two colours,
// low contrast, too few glyphs, and when the capture already flagged the sample; a line that was not drawn
// is poor with no candidates, never an error), weight by the capture's role ink over the crop fit, and the
// optical-size cut (Inter at display size in its default instance vs automatic opsz), and the public
// catalogue rule (non-catalogue families never candidates, also via --candidates; referenceFonts verdicts;
// the offline fallback reports "bundled (offline)").
//   node harness/check-fontmatch.mjs [--only id,id] [--module <path to fontmatch.mjs>]
// Needs network access to fonts.googleapis.com. Prints one line per assertion, then one JSON summary
// line; exits 1 if any assertion fails.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PNG } from 'pngjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const only = opt('--only') ? new Set(opt('--only').split(',')) : null;
const modPath = path.resolve(opt('--module') || path.join(root, 'skill/restyle/scripts/lib/fontmatch.mjs'));
const { fontmatch } = await import(pathToFileURL(modPath).href);
const { launchChrome, newCaptureContext } = await import(pathToFileURL(path.join(root, 'skill/restyle/scripts/lib/browser.mjs')).href);
const outRoot = path.join(root, 'runs', 'dev', 'fontmatch');

const R = ['Roboto'];
// weight: {w, tol} = expected best weight; wdth: expected axis value with minAdv on the advance part;
// quality: expected sampleQuality.level (reason must match `why` when given)
const CASES = [
  { id: 'plain', text: 'Hamburgefonstiv quietly', family: 'Roboto', weight: 400, px: 22, color: '#000000', bg: '#ffffff', cands: R, expect: { w: 400, tol: 25 }, quality: 'good' },
  { id: 'grey-on-white', text: 'Hamburgefonstiv quietly', family: 'Roboto', weight: 400, px: 22, color: '#767676', bg: '#ffffff', cands: R, expect: { w: 400, tol: 50 }, quality: 'good' },
  { id: 'light-on-dark', text: 'Orders and support', family: 'Roboto', weight: 700, px: 22, color: '#fffef2', bg: '#252525', cands: R, expect: { w: 700, tol: 50 }, quality: 'good' },
  { id: 'dim-on-dark', text: 'Figure index panel', family: 'Roboto', weight: 400, px: 16, color: '#8a8f98', bg: '#08090a', cands: R, expect: { w: 400, tol: 50 }, quality: 'good' },
  { id: 'opacity-dimmed', text: 'Hamburgefonstiv quietly', family: 'Roboto', weight: 400, px: 22, color: '#ffffff', bg: '#000000', opacity: 0.45, cands: R, expect: { w: 400, tol: 50 }, quality: 'good' },
  { id: 'large-light', text: 'Building the network', family: 'Roboto', weight: 300, px: 48, color: '#ffffff', bg: '#0a2540', cands: R, expect: { w: 300, tol: 50 }, quality: 'good' },
  { id: 'busy-bg', text: 'Building the network', family: 'Roboto', weight: 300, px: 48, color: '#ffffff', bg: '#0a2540', busy: true, cands: R, quality: 'poor', why: /busy|background/ },
  { id: 'two-tone', text: 'A new kind of tool.', text2: ' Purpose-built for teams', family: 'Roboto', weight: 500, px: 40, color: '#f7f8f8', color2: '#8a8f98', bg: '#08090a', cands: R, quality: 'poor', why: /colour/ },
  { id: 'two-hue', text: 'free.', text2: ' fun and effective', family: 'Roboto', weight: 700, px: 40, color: '#58cc02', color2: '#042c60', bg: '#ffffff', cands: R, quality: 'poor', why: /colour/ },
  { id: 'few-glyphs', text: 'Go', family: 'Roboto', weight: 500, px: 32, color: '#000000', bg: '#ffffff', cands: R, quality: 'poor', why: /glyph/ },
  { id: 'low-contrast', text: 'Hamburgefonstiv quietly', family: 'Roboto', weight: 400, px: 24, color: '#d9d9d9', bg: '#ffffff', cands: R, quality: 'poor', why: /contrast/ },
  { id: 'capture-flagged', text: 'Hamburgefonstiv quietly', family: 'Roboto', weight: 400, px: 22, color: '#000000', bg: '#ffffff', flag: { level: 'poor', reason: 'two colours in the line' }, cands: R, quality: 'poor', why: /two colours/ },
  { id: 'wdth-roboto', text: 'Condensed headline type', family: 'Roboto', weight: 400, px: 56, stretch: 75, color: '#000000', bg: '#ffffff', cands: R, expect: { wdth: 75, minAdv: 0.85 }, quality: 'good' },
  { id: 'wdth-static', text: 'Compressed display line', family: 'League Gothic', weight: 400, px: 72, stretch: 75, color: '#131313', bg: '#ffffff', cands: ['League Gothic'], expect: { wdth: 75, minAdv: 0.85 }, quality: 'good' },
  // a sample whose line was not drawn (text in the background colour): a poor result, never an error
  { id: 'no-ink', text: 'Hamburgefonstiv quietly', family: 'Roboto', weight: 400, px: 22, color: '#ffffff', bg: '#ffffff', cands: R, quality: 'poor', why: /contrast|ink/, none: true },
  // ink decides weight: the crop shows Roboto 500, the capture's role ink is Roboto 700's probe ink ->
  // weight 700 by role ink, crop fit about 500
  { id: 'ink-weight', text: 'Orders and support', family: 'Roboto', weight: 500, px: 20, color: '#000000', bg: '#ffffff', cands: R, inkOf: 700, expect: { w: 700, tol: 30, crop: 500, cropTol: 50, basis: 'role ink' }, quality: 'good' },
  // optical size: Inter at 64 px in its default (text) instance -> opsz "default"; with automatic optical
  // size (the display cut) -> opsz "auto"
  { id: 'opsz-default', text: 'Agents at work', family: 'Inter', weight: 600, px: 64, fvs: "'opsz' 14", color: '#111111', bg: '#ffffff', cands: ['Inter'], expect: { opsz: 'default' }, quality: 'good' },
  { id: 'opsz-auto', text: 'Agents at work', family: 'Inter', weight: 600, px: 64, color: '#111111', bg: '#ffffff', cands: ['Inter'], expect: { opsz: 'auto' }, quality: 'good' },
  // public catalogue only: a made-up brand family and a proprietary brand family that fonts.googleapis.com css2
  // still serves (r7 mailchimp's "Means") are never candidates, also when passed in --candidates; the
  // reference's own families carry their catalogue verdict (referenceFonts). Offline: the bundled subset is
  // used and the output says so (catalogue "bundled (offline)"), an unlisted family is unverified (null)
  { id: 'catalogue', text: 'Hamburgefonstiv quietly', family: 'Roboto', weight: 400, px: 22, color: '#000000', bg: '#ffffff', cands: ['Brandface Grotesk', 'Means', 'Roboto'],
    fams: ['Brandface Grotesk', 'Roboto'], quality: 'good', cat: { drop: ['Brandface Grotesk', 'Means'], verdict: { 'Brandface Grotesk': false, Roboto: true }, source: /^google/ } },
  { id: 'catalogue-offline', text: 'Hamburgefonstiv quietly', family: 'Roboto', weight: 400, px: 22, color: '#000000', bg: '#ffffff', cands: ['Brandface Grotesk', 'Roboto'], offline: true,
    fams: ['Brandface Grotesk', 'Roboto'], quality: 'good', cat: { drop: ['Brandface Grotesk'], verdict: { 'Brandface Grotesk': null, Roboto: true }, source: /^bundled \(offline\)$/ } },
];

const FONTS = 'https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,100..900&family=Roboto:wdth,wght@75..100,100..900&family=League+Gothic:wdth@75..100&display=block';

// the capture's role ink probe (lib/page-analyze.mjs probeInk): 'Hamburgefonstiv 0123' black on white with
// 0.3 em padding, ink / (advance x size), averaged over 1x, 0.94x and 1.06x for text <= 24 px
async function probeInkOf(page, family, weight, px) {
  const sizes = px <= 24 ? [px, px * 0.94, px * 1.06] : [px];
  const html = sizes.map((sz) => `<div style="font-family:'${family}';font-size:${sz}px;font-weight:${weight};font-synthesis:none;display:block;width:max-content;white-space:pre;line-height:normal;color:#000;background:#fff;padding:0.3em;margin:0 0 8px 0">Hamburgefonstiv 0123</div>`).join('');
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${FONTS}"><style>html,body{margin:0;background:#fff}#p{position:absolute;left:8px;top:8px}</style></head><body><div id="p">${html}</div></body></html>`, { waitUntil: 'load' });
  await page.evaluate(async (spec) => { await document.fonts.load(spec); await document.fonts.ready; }, `${weight} ${px}px '${family}'`);
  const rects = await page.evaluate(() => [...document.getElementById('p').children].map((e) => { const r = e.getBoundingClientRect(), cs = getComputedStyle(e); return [r.left, r.top, r.width, r.height, r.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)]; }));
  const png = PNG.sync.read(await page.screenshot({ type: 'png', fullPage: true }));
  let tot = 0;
  rects.forEach((r, k) => {
    let ink = 0;
    for (let y = Math.round(r[1]); y < Math.round(r[1] + r[3]); y++) for (let x = Math.round(r[0]); x < Math.round(r[0] + r[2]); x++) { const q = (y * png.width + x) * 4; ink += Math.max(0, 255 - (0.2126 * png.data[q] + 0.7152 * png.data[q + 1] + 0.0722 * png.data[q + 2])) / 255; }
    tot += ink / (r[4] * sizes[k]);
  });
  return Math.round((tot / rects.length) * 10000) / 10000;
}

// deterministic photo-like backdrop: soft blobs of several colours plus pixel noise
const BUSY = `(() => { const c = document.getElementById('bg'); const x = c.getContext('2d'); let s = 7; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  x.fillStyle = '#0a2540'; x.fillRect(0, 0, c.width, c.height);
  for (let i = 0; i < 60; i++) { const g = x.createRadialGradient(rnd() * c.width, rnd() * c.height, 0, rnd() * c.width, rnd() * c.height, 30 + rnd() * 120);
    const h = Math.floor(rnd() * 360); g.addColorStop(0, 'hsla(' + h + ',80%,' + Math.floor(30 + rnd() * 40) + '%,0.9)'); g.addColorStop(1, 'hsla(' + h + ',80%,40%,0)'); x.fillStyle = g; x.fillRect(0, 0, c.width, c.height); }
  const d = x.getImageData(0, 0, c.width, c.height); for (let i = 0; i < d.data.length; i += 4) { const n = (rnd() - 0.5) * 40; d.data[i] += n; d.data[i + 1] += n; d.data[i + 2] += n; } x.putImageData(d, 0, 0); })()`;

async function renderCase(page, c, dir) {
  const fam = `'${c.family}'`;
  const style = `font-family:${fam};font-size:${c.px}px;font-weight:${c.weight};line-height:1.2;white-space:pre;letter-spacing:${c.ls || 0}em;font-synthesis:none;${c.stretch ? `font-stretch:${c.stretch}%;` : ''}${c.fvs ? `font-variation-settings:${c.fvs};` : ''}color:${c.color}`;
  const inner = `<span id="t1">${c.text}</span>${c.text2 ? `<span id="t2" style="color:${c.color2}">${c.text2}</span>` : ''}`;
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${FONTS}"><style>html,body{margin:0;background:${c.bg}}#bg{position:absolute;left:0;top:0}#wrap{position:absolute;left:40px;top:40px;${c.opacity ? `opacity:${c.opacity};` : ''}}</style></head><body>${c.busy ? '<canvas id="bg" width="1400" height="300"></canvas>' : ''}<div id="wrap"><div id="line" style="${style}">${inner}</div></div></body></html>`, { waitUntil: 'load' });
  await page.evaluate(async (spec) => { await document.fonts.load(spec); await document.fonts.ready; }, `${c.weight} ${c.px}px ${fam}`);
  if (c.busy) await page.evaluate(BUSY);
  const bbox = await page.evaluate(() => { const rg = document.createRange(); rg.selectNodeContents(document.getElementById('line')); const r = rg.getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map((v) => Math.round(v * 10) / 10); });
  const shot = 'shots/type-sample.png';
  fs.mkdirSync(path.join(dir, 'shots'), { recursive: true });
  const x = Math.floor(bbox[0] - 4), y = Math.floor(bbox[1] - 4);
  const buf = await page.screenshot({ clip: { x, y, width: Math.ceil(bbox[2] + 8), height: Math.ceil(bbox[3] + 8) }, type: 'png', caret: 'hide', animations: 'disabled' });
  fs.writeFileSync(path.join(dir, shot), buf);
  const s = { text: c.text + (c.text2 || ''), bbox, px: c.px, weight: c.weight, ls: c.ls || 0, color: c.color, bg: c.bg, family: c.family, style: null, shot };
  if (c.flag) s.sampleQuality = c.flag;
  const cap = { schema: 'restyle-capture/2', type: { samples: { sample: s } } };
  if (c.fams) cap.type.families = c.fams.map((f) => ({ family: f, webfont: true }));
  if (c.inkOf) cap.type.roles = { 1440: { sample: { px: c.px, weight: c.weight, ls: c.ls || 0, family: c.family, ink: await probeInkOf(page, c.family, c.inkOf, c.px) } } };
  fs.writeFileSync(path.join(dir, 'capture.json'), JSON.stringify(cap, null, 1));
  return PNG.sync.read(buf);
}

const results = [];
const check = (name, ok, got, want) => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  got=${JSON.stringify(got)}  want=${JSON.stringify(want)}`); };

async function main() {
  const browser = await launchChrome([]);
  const ctx = await newCaptureContext(browser, { width: 1400, height: 400 });
  const page = await ctx.newPage();
  try {
    for (const c of CASES) {
      if (only && !only.has(c.id)) continue;
      const dir = path.join(outRoot, c.id);
      fs.rmSync(dir, { recursive: true, force: true });
      await renderCase(page, c, dir);
      let o;
      if (c.offline) process.env.RESTYLE_FONT_CATALOGUE = 'offline';
      try { o = await fontmatch(browser, { capDir: dir, role: 'sample', candidates: c.cands, top: 3 }); }
      catch (e) { check(`${c.id}: fontmatch runs`, false, String(e.message || e).slice(0, 160), 'a result'); continue; }
      finally { if (c.offline) delete process.env.RESTYLE_FONT_CATALOGUE; }
      if (c.cat) {
        const fams = o.candidates.map((x) => x.family);
        check(`${c.id}: catalogue source reported`, c.cat.source.test(o.catalogue || '') && (!c.offline || (o.notes || []).some((n) => /bundled subset/.test(n))), [o.catalogue, (o.notes || []).filter((n) => /catalogue|bundled/.test(n)).length], String(c.cat.source));
        check(`${c.id}: non-catalogue families never candidates, dropped with a note`, c.cat.drop.every((f) => !fams.includes(f) && (o.notes || []).some((n) => n.includes(`"${f}" dropped`))) && fams.includes('Roboto'), fams, `no ${c.cat.drop.join('/')}, Roboto kept`);
        const rv = Object.fromEntries((o.referenceFonts || []).map((f) => [f.family, f.inCatalogue]));
        check(`${c.id}: referenceFonts verdicts`, Object.entries(c.cat.verdict).every(([f, v]) => rv[f] === v), rv, c.cat.verdict);
      }
      const b = o.candidates[0] || {};
      const q = o.sampleQuality || null;
      if (c.none) check(`${c.id}: no candidates, no error`, Array.isArray(o.candidates) && o.candidates.length === 0, o.candidates.length, 0);
      if (c.expect && c.expect.w != null) check(`${c.id}: weight`, Math.abs(b.weight - c.expect.w) <= c.expect.tol, [b.family, b.weight], `${c.expect.w} +- ${c.expect.tol}`);
      if (c.expect && c.expect.basis) check(`${c.id}: weight basis ${c.expect.basis}, crop fit kept`, b.weightBasis === c.expect.basis && Math.abs(b.cropWeight - c.expect.crop) <= c.expect.cropTol, [b.weightBasis, b.cropWeight, b.ink], `${c.expect.basis}, crop ${c.expect.crop} +- ${c.expect.cropTol}`);
      if (c.expect && c.expect.opsz) check(`${c.id}: opsz ${c.expect.opsz}`, b.opsz === c.expect.opsz, [b.family, b.weight, b.opsz || null, b.score], c.expect.opsz);
      if (c.expect && c.expect.wdth != null) {
        const ax = (b.axes && b.axes.wdth) || 100;
        check(`${c.id}: reported width axis`, ax === c.expect.wdth, [b.family, b.axes || null], { wdth: c.expect.wdth });
        check(`${c.id}: advance matches at that axis (adv part, tracking)`, b.parts && b.parts.adv >= c.expect.minAdv && Math.abs(b.lsAdjustEm) <= 0.03, b.parts && [b.parts.adv, b.lsAdjustEm], `adv >= ${c.expect.minAdv}, |ls| <= 0.03`);
      }
      check(`${c.id}: sampleQuality ${c.quality}`, q && q.level === c.quality && (!c.why || c.why.test(q.reason || '')), q, c.why ? `${c.quality} (${c.why})` : c.quality);
    }
  } finally { await browser.close().catch(() => {}); }
  const failed = results.filter((r) => !r.ok).map((r) => r.name);
  console.log(JSON.stringify({ ok: failed.length === 0, checks: results.length, failed, module: path.relative(root, modPath), outDir: outRoot }));
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(`check-fontmatch: ${e.message}`); process.exit(1); });
