#!/usr/bin/env node
/*
 * pipeline.mjs - the mechanical steps of a test round, so they are not retyped by hand.
 *
 *   node harness/pipeline.mjs ref  <round> <slug> [--force] [--from <round> | --from-build] [--no-motion-frames]
 *       Capture the site's url (harness/sites.json) into runs/<round>/<slug>/ref. Skips if
 *       ref/capture.json exists unless --force. --from <round> copies runs/<from>/<slug>/ref instead.
 *       --from-build copies runs/<round>/<slug>/build/.restyle/ref: the reference snapshot the builder
 *       worked from (live sites change; a build is judged against what its builder saw).
 *   node harness/pipeline.mjs eval <round> <slug> [--no-motion-frames] [--keep-ref]
 *       Uses the builder's snapshot as the reference when build/.restyle/ref exists (copied to ref/
 *       first, as ref --from-build; --keep-ref keeps an existing ref/ as it is). Serves
 *       runs/<round>/<slug>/build on a free port, captures it into buildcap/ with --frames-like ref (the
 *       build's reveal strips are recorded at the reference's page positions), stops the server,
 *       compares ref vs buildcap -> diff.json and builds the judge sheets -> sheets/. A reference captured
 *       before round 5 is first brought up to date from its stored frames and shots (harness/backfill-ref.mjs).
 * Each prints one JSON line; exits non-zero on failure.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, SCRIPTS, startServer, runNode, lastJson } from './lib/run.mjs';

const [cmd, round, slug, ...rest] = process.argv.slice(2);
const flag = (n) => rest.includes(n);
const opt = (n) => (rest.includes(n) ? rest[rest.indexOf(n) + 1] : null);
const usage = () => { console.error('usage: node harness/pipeline.mjs ref|eval <round> <slug> [--force] [--from <round> | --from-build] [--keep-ref] [--no-motion-frames]'); process.exit(2); };

// Copies the builder's own reference snapshot (build/.restyle/ref) to ref/.
function copyFromBuild(runDir) {
  const src = path.join(runDir, 'build', '.restyle', 'ref');
  if (!fs.existsSync(path.join(src, 'capture.json'))) throw new Error(`no builder snapshot at ${src}`);
  const refDir = path.join(runDir, 'ref');
  fs.rmSync(refDir, { recursive: true, force: true });
  fs.cpSync(src, refDir, { recursive: true });
  return { refDir, copiedFrom: src };
}

async function ref() {
  const runDir = path.join(ROOT, 'runs', round, slug);
  const refDir = path.join(runDir, 'ref');
  if (fs.existsSync(path.join(refDir, 'capture.json')) && !flag('--force')) return { step: 'ref', round, slug, refDir, skipped: 'capture.json exists (use --force)' };
  if (flag('--from-build')) return { step: 'ref', round, slug, ...copyFromBuild(runDir) };
  const from = opt('--from');
  if (from) {
    const src = path.join(ROOT, 'runs', from, slug, 'ref');
    if (!fs.existsSync(path.join(src, 'capture.json'))) throw new Error(`no capture at ${src}`);
    fs.rmSync(refDir, { recursive: true, force: true });
    fs.mkdirSync(runDir, { recursive: true });
    fs.cpSync(src, refDir, { recursive: true });
    return { step: 'ref', round, slug, refDir, copiedFrom: src };
  }
  const sites = JSON.parse(fs.readFileSync(path.join(ROOT, 'harness', 'sites.json'), 'utf8'));
  const site = sites.find((s) => s.slug === slug);
  if (!site) throw new Error(`slug ${slug} not in harness/sites.json`);
  fs.rmSync(refDir, { recursive: true, force: true });
  const args = [site.url, refDir];
  if (flag('--no-motion-frames')) args.push('--no-motion-frames');
  const r = await runNode(path.join(SCRIPTS, 'capture.mjs'), args, { timeoutMs: 600000 });
  const sum = lastJson(r.stdout) || {};
  return { step: 'ref', round, slug, refDir, url: site.url, sections: sum.sections, blocked: sum.blocked, ms: sum.ms };
}

async function evaluate() {
  const runDir = path.join(ROOT, 'runs', round, slug);
  const refDir = path.join(runDir, 'ref'), buildDir = path.join(runDir, 'build'), capDir = path.join(runDir, 'buildcap');
  let refSource = 'ref/';
  const snap = path.join(buildDir, '.restyle', 'ref', 'capture.json');
  if (fs.existsSync(snap) && !(flag('--keep-ref') && fs.existsSync(path.join(refDir, 'capture.json')))) { copyFromBuild(runDir); refSource = 'build/.restyle/ref (builder snapshot)'; }
  if (!fs.existsSync(path.join(refDir, 'capture.json'))) throw new Error(`no reference capture at ${refDir} (run: pipeline.mjs ref ${round} ${slug})`);
  if (!fs.existsSync(path.join(buildDir, 'index.html'))) throw new Error(`no build at ${buildDir}/index.html`);
  // an older snapshot gets the measurements that can be re-made from its stored frames and shots
  // (media rate, settle, hover crop deltas, first-screen component crops: harness/backfill-ref.mjs)
  let backfilled = null;
  const refCap = JSON.parse(fs.readFileSync(path.join(refDir, 'capture.json'), 'utf8'));
  if (!refCap.meta?.backfilled && refCap.motion?.frames?.load && refCap.motion.frames.load.keepsMoving === undefined && !(refCap.motion?.load?.media || []).some((m) => m && typeof m.rate === 'number')) {
    backfilled = (lastJson((await runNode(path.join(ROOT, 'harness', 'backfill-ref.mjs'), [refDir], { timeoutMs: 300000 })).stdout) || {}).backfilled || null;
  }
  fs.rmSync(capDir, { recursive: true, force: true });
  const srv = await startServer(buildDir);
  let cap;
  try {
    const args = [srv.url, capDir, '--frames-like', refDir];
    if (flag('--no-motion-frames')) args.push('--no-motion-frames');
    cap = lastJson((await runNode(path.join(SCRIPTS, 'capture.mjs'), args, { timeoutMs: 600000 })).stdout) || {};
  } finally { await srv.stop(); }
  const diffFile = path.join(runDir, 'diff.json');
  const cmp = lastJson((await runNode(path.join(SCRIPTS, 'compare.mjs'), [refDir, capDir, diffFile])).stdout) || {};
  const sh = lastJson((await runNode(path.join(SCRIPTS, 'sheet.mjs'), [refDir, capDir, path.join(runDir, 'sheets')])).stdout) || {};
  return { step: 'eval', round, slug, ref: refSource, refBackfilled: backfilled || undefined, served: srv.url, buildcap: capDir, captureMs: cap.ms, diff: diffFile, total: cmp.total,
    areas: { layout: cmp.layout, color: cmp.color, type: cmp.type, motion: cmp.motion, responsive: cmp.responsive },
    sheets: path.join(runDir, 'sheets'), sheetCount: sh.sheets, sheetsOverSize: sh.overSize };
}

async function main() {
  if (!cmd || !round || !slug) usage();
  if (!/^[\w.-]+$/.test(round) || !/^[\w.-]+$/.test(slug)) throw new Error('round and slug must be simple names');
  const res = cmd === 'ref' ? await ref() : cmd === 'eval' ? await evaluate() : usage();
  console.log(JSON.stringify(res));
}
main().then(() => process.exit(0)).catch((e) => { console.error(`pipeline: ${e.message}`); process.exit(1); });
