#!/usr/bin/env node
/*
 * compare.mjs — how close is a build's design to the reference's?
 *
 *   node compare.mjs <refCapDir> <buildCapDir> <out.json>
 *
 * Reads two capture dirs written by capture.mjs (same script, same measurements) and writes
 * diff.json (schema "restyle-diff/2"):
 *   { schema, ref, build, total (0-10, 2 decimals, null if a capture looks blocked), blocked?,
 *     areas: { layout|color|type|motion|responsive: { score, weight, subs:[{name,score,weight,detail}], findings[] } },
 *     findings: [{ area, severity, what, ref, build, fix, lost }],  // sorted by points lost on the total, <= 30
 *     health: [{ check, severity: fail|warn, what, fix, family? }]   // hard-rule checks on the build (non-catalogue
 *   }                                                              // web font); never scored; a fail is also findings[0]
 * Content (words, image pixels, brand) is not compared; design measurements are. Every formula,
 * weight and tolerance is in lib/cmp-constants.mjs and explained in references/scoring.md.
 * Prints one JSON summary line to stdout and a readable table to stderr. Never throws on a
 * sparse capture: a missing reference value removes that check, a missing build value scores 0.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadCapture, compareCaptures } from './lib/cmp-core.mjs';
import { stripGrids, stripContent, stripAppear, loadAppear } from './lib/frames.mjs';

// Strips recorded before captures stored `content` (when the content in view is in place after the scroll
// stops) or `appear` (step vs fade / slide, reveal strips and the load strip): measured here from the
// stored frames, in memory only (capture dirs are never written). Reveal strips only when the build was
// captured --frames-like (its strips replay the reference's; `reveals`). Chrome decodes the JPEG frames; if
// it cannot start, those checks are left out.
async function fillStripContent(caps, { reveals = true } = {}) {
  const todo = [], loads = [];
  for (const [cap, dir] of caps) {
    if (reveals) for (const st of cap?.motion?.frames?.reveals || []) if (st && st.dir && (!st.content || !st.content.appear)) todo.push([st, path.join(dir, st.dir)]);
    const fl = cap?.motion?.frames?.load;
    if (fl && fl.dir && !fl.appear && fs.existsSync(path.join(dir, fl.dir))) loads.push([cap, fl, path.join(dir, fl.dir)]);
  }
  if (!todo.length && !loads.length) return 0;
  const { launchChrome } = await import('./lib/browser.mjs');
  const browser = await launchChrome();
  try {
    const ctx = await browser.newContext();
    for (const [st, d] of todo) {
      const g = await stripGrids(ctx, d).catch(() => null);
      const opt = { fps: st.fps || 12, scrollSettleMs: st.scroll ? st.scroll.settleMs : null };
      const c = st.content || (g ? stripContent(g, opt) : null);
      if (c && g && !c.appear) { const a = stripAppear(g, opt); if (a) c.appear = a; }
      if (c) st.content = c;
    }
    for (const [cap, fl, d] of loads) {
      const g = await stripGrids(ctx, d).catch(() => null);
      const groups = cap.motion?.load?.groups || [];
      const masks = (cap.motion?.load?.media || []).filter((m) => m && m.moving && Array.isArray(m.box)).map((m) => m.box);
      const a = g ? loadAppear(g, { fps: fl.fps || 12, boxes: groups.map((x) => x.box || null), masks }) : null;
      if (a && a.screen) fl.appear = a.screen;
      if (a) a.boxes.forEach((x, i) => { if (x && groups[i] && !groups[i].appear) groups[i].appear = x; });
    }
  } finally { await browser.close().catch(() => {}); }
  return todo.length + loads.length;
}

function table(diff) {
  const lines = [];
  lines.push(`restyle compare  total ${diff.total ?? 'null'}${diff.blocked ? `  (${diff.blocked})` : ''}`);
  for (const h of (diff.health || []).filter((x) => x.severity === 'fail')) lines.push(`HEALTH FAIL  ${h.what}  -> ${h.fix}`);
  for (const h of (diff.health || []).filter((x) => x.severity !== 'fail')) lines.push(`health warn  ${h.what}`);
  lines.push('area        score  weight');
  for (const [k, a] of Object.entries(diff.areas)) lines.push(`${k.padEnd(11)} ${String(a.score ?? '-').padStart(5)}  ${String(a.weight).padStart(5)}`);
  lines.push('');
  for (const [k, a] of Object.entries(diff.areas)) {
    const subs = (a.subs || []).filter((s) => s.score != null && s.score < 9.95).map((s) => `${s.name} ${s.score}`);
    if (subs.length) lines.push(`${k}: ${subs.join(' | ')}`);
  }
  lines.push('');
  lines.push('top findings (points lost on the total):');
  for (const f of diff.findings.slice(0, 12)) lines.push(`  ${String(f.lost).padStart(5)} ${f.severity.padEnd(6)} [${f.area}] ${f.fix}`);
  return lines.join('\n');
}

async function main() {
  const [refDir, buildDir, outFile] = process.argv.slice(2);
  if (!refDir || !buildDir || !outFile) { console.error('usage: node compare.mjs <refCapDir> <buildCapDir> <out.json>'); process.exit(2); }
  const ref = loadCapture(path.resolve(refDir));
  const build = loadCapture(path.resolve(buildDir));
  const likeStrips = (build?.motion?.frames?.reveals || []).some((r) => r && r.like) && (ref?.motion?.frames?.reveals || []).length > 0;
  const needLoad = [ref, build].some((c) => c?.motion?.frames?.load && !c.motion.frames.load.appear);
  if (likeStrips || needLoad) {
    try { await fillStripContent([[ref, path.resolve(refDir)], [build, path.resolve(buildDir)]], { reveals: likeStrips }); } catch (e) { console.error('compare: strip content not measured: ' + e.message.split('\n')[0]); }
  }
  const diff = compareCaptures(ref, build, { refDir: path.resolve(refDir), buildDir: path.resolve(buildDir) });
  fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(diff, null, 1));
  console.error(table(diff));
  const summary = { out: path.resolve(outFile), total: diff.total, ...Object.fromEntries(Object.entries(diff.areas).map(([k, a]) => [k, a.score])), findings: diff.findings.length };
  if (diff.blocked) summary.blocked = diff.blocked;
  const hf = (diff.health || []).filter((x) => x.severity === 'fail');
  if (hf.length) summary.healthFail = hf.map((x) => x.what);
  if (diff.partial) summary.partial = true;
  if (diff.errors) summary.errors = Object.keys(diff.errors);
  console.log(JSON.stringify(summary));
}

main().catch((e) => { console.error('compare: ' + e.message); process.exit(1); });
