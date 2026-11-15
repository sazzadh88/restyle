#!/usr/bin/env node
/*
 * backfill-ref.mjs - brings an older reference capture (a builder's snapshot made before round 5) up to the
 * round-5 measurements that can be re-measured from what the capture already stored, without reloading the
 * live site (which has changed since the builder saw it):
 *   - motion.load.media[]: rate / rateLoad / rateCont / hot / activity from motion/frames/media (6 fps, 2.5 s)
 *     and the first 1.5 s of motion/frames/load (12 fps), exactly the frames a new capture measures; `active`
 *     per phase is not stored, so the stored max is used for both phases
 *   - motion.frames.load: contShare, lastChangeMs and the settle fields (keepsMoving) from the load frames
 *   - motion.ambient.items[] of kind media: rate
 *   - motion.frames.hover[].visual from the hover PNG pairs
 *   - shots/comp-<name>.png of components inside the first screen, re-cropped from shots/1440-fold.png
 * Page-side analysis changes (type roles, stat figures, padding, media-box exclusions) cannot be backfilled.
 *
 *   node harness/backfill-ref.mjs <capDir>     edits <capDir>/capture.json in place (only on a copy: never
 *                                              under runs/<round>/<slug>/build); prints one JSON line
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { boxActivity, mediaEntry, visualLoad, loadSettle, LOAD_FPS, LOAD_WINDOW_MS } from '../skill/restyle/scripts/lib/frames.mjs';
import { pairDelta, readPng, cropToFile } from '../skill/restyle/scripts/lib/images.mjs';

const dir = path.resolve(process.argv[2] || '');
const capFile = path.join(dir, 'capture.json');
if (!process.argv[2] || !fs.existsSync(capFile)) { console.error('usage: node harness/backfill-ref.mjs <capDir>'); process.exit(2); }
if (/[\\/]build[\\/]\.restyle[\\/]/.test(dir)) { console.error('backfill-ref: refusing to edit a builder snapshot in place; copy it first'); process.exit(2); }

const jpgs = (d) => (fs.existsSync(d) ? fs.readdirSync(d).filter((x) => /^f-\d+\.jpg$/.test(x)).sort().map((x) => fs.readFileSync(path.join(d, x)).toString('base64')) : []);

async function main() {
  const c = JSON.parse(fs.readFileSync(capFile, 'utf8'));
  const done = [];
  const media = c.motion?.load?.media || [];
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const ctx = await browser.newContext();
    if (media.length && !media.some((m) => m && typeof m.rate === 'number')) {
      const boxes = media.map((m) => m.box);
      const mf = jpgs(path.join(dir, c.motion?.frames?.media?.dir || 'motion/frames/media'));
      const lf = jpgs(path.join(dir, c.motion?.frames?.load?.dir || 'motion/frames/load')).slice(0, Math.round(1.5 * LOAD_FPS) + 1);
      const cont = mf.length >= 3 ? await boxActivity(ctx, mf, boxes, { fps: c.motion?.frames?.media?.fps || 6 }) : boxes.map(() => null);
      const load = lf.length >= 3 ? await boxActivity(ctx, lf, boxes, { fps: LOAD_FPS }) : boxes.map(() => null);
      c.motion.load.media = media.map((e, i) => {
        const m = { kind: e.kind, desc: e.el, box: e.box, band: e.band, playing: e.playing, pieces: e.pieces, keyframes: e.keyframes,
          continuous: e.continuous !== null && e.continuous !== undefined ? { diff: e.continuous, active: e.active ?? 0, rate: cont[i] ? cont[i].rate : null, hot: cont[i] ? cont[i].hot : null } : null };
        const onLoad = e.load !== null && e.load !== undefined ? { diff: e.load, active: e.active ?? 0, rate: load[i] ? load[i].rate : null, hot: load[i] ? load[i].hot : null } : null;
        return mediaEntry(m, onLoad, () => e.band);
      });
      for (const it of c.motion?.ambient?.items || []) {
        const e = c.motion.load.media.find((m) => it && it.kind === 'media' && m.el === it.el);
        if (e) { it.rate = e.rateCont ?? e.rate; it.activity = e.activity; }
      }
      done.push(`media rate (${c.motion.load.media.map((m) => `${m.kind} ${m.activity} ${m.rate}`).join('; ')})`);
    }
    const fl = c.motion?.frames?.load;
    if (fl && fl.visual && fl.keepsMoving === undefined) {
      const masks = (c.motion?.load?.media || []).filter((m) => m && m.moving).map((m) => m.box);
      const v = await visualLoad(ctx, path.join(dir, fl.dir || 'motion/frames/load'), masks);
      if (v) {
        fl.visual.lastChangeMs = v.lastChangeMs;
        if (v.contShare) fl.visual.contShare = v.contShare; else delete fl.visual.contShare;
        const L = c.motion.load, sum = L && L.summary;
        const domEnd = sum && typeof L.fcpMs === 'number' && typeof sum.lastEndMs === 'number' ? sum.lastEndMs - L.fcpMs : null;
        const before = { settleMs: fl.settleMs, settled: fl.settled };
        Object.assign(fl, loadSettle(fl.visual, domEnd, fl.windowMs || LOAD_WINDOW_MS, undefined, c.motion.load && c.motion.load.media));
        done.push(`load settle ${before.settleMs ?? 'null'} -> ${fl.settleMs ?? 'null'}${fl.keepsMoving ? ' (keepsMoving)' : ''}`);
      }
    }
  } finally { await browser.close().catch(() => {}); }
  for (const h of c.motion?.frames?.hover || []) {
    if (h && h.dir && !h.visual) { h.visual = pairDelta(path.join(dir, h.dir, 'f-00.png'), path.join(dir, h.dir, 'f-01.png')); if (h.visual) done.push(`hover ${h.kind} crops ${h.visual.changed}`); }
  }
  const PV = String((c.meta?.viewports || [1440])[0]);
  const foldRel = c.shots?.[PV]?.fold;
  if (foldRel && fs.existsSync(path.join(dir, foldRel))) {
    const pf = readPng(path.join(dir, foldRel));
    for (const [name, comp] of Object.entries(c.components || {})) {
      if (!comp || !comp.shot || !(comp.y >= 0 && comp.y + comp.h <= pf.height)) continue;
      const pad = 12;
      if (cropToFile(pf, comp.x - pad, comp.y - pad, Math.min(comp.w + pad * 2, pf.width), Math.min(comp.h + pad * 2, 1200), path.join(dir, comp.shot))) done.push(`comp ${name} from fold`);
    }
  }
  c.meta = c.meta || {};
  c.meta.backfilled = { by: 'harness/backfill-ref.mjs', time: new Date().toISOString(), what: done };
  fs.writeFileSync(capFile, JSON.stringify(c, null, 1));
  console.log(JSON.stringify({ ok: true, capDir: dir, backfilled: done }));
}
main().catch((e) => { console.error(`backfill-ref: ${e.message}`); process.exit(1); });
