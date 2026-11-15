#!/usr/bin/env node
/*
 * score.mjs — combine the metric (diff.json) and the blind judge (judge.json) for one site.
 *
 *   node harness/score.mjs <runDir>        runDir = runs/<round>/<slug>
 *
 * Writes <runDir>/score.json:
 *   { schema: "restyle-score/1", slug, round, metric{area: 0-10}, judge{area: 0-10|null} | null,
 *     combined{area}, total (weighted, 2 decimals), pass (total >= 8.5), weights, notes[], issues[] }
 * combined = 0.5 x metric + 0.5 x judge per area; where the judge's score is null (motion when the
 * frame strips were insufficient) or judge.json is missing, the metric alone is used for that area.
 * A blocked capture (diff.total null) gives total null and pass false. A compare health failure
 * (diff.health[] severity "fail", e.g. a non-catalogue web font) gives pass false with healthFail[] and a note.
 * issues = the metric's findings and the judge's mismatches merged by severity (<= 12).
 */
import fs from 'node:fs';
import path from 'node:path';

const WEIGHTS = { layout: 25, color: 20, type: 20, motion: 20, responsive: 15 };
const PASS = 8.5;
const r2 = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

export function scoreRun(diff, judge) {
  const notes = [];
  const metric = {}, jd = judge ? {} : null, combined = {};
  for (const k of Object.keys(WEIGHTS)) {
    metric[k] = num(diff?.areas?.[k]?.score);
    if (jd) jd[k] = num(judge?.areas?.[k]);
    const m = metric[k], j = jd ? jd[k] : null;
    combined[k] = m != null && j != null ? r2(0.5 * m + 0.5 * j) : r2(m ?? j);
    if (jd && j == null) notes.push(`judge gave no ${k} score; metric alone used for ${k}`);
  }
  if (!judge) notes.push('judge.json missing: combined = metric only');
  let total = null;
  const live = Object.keys(WEIGHTS).filter((k) => combined[k] != null);
  if (diff && diff.total != null && live.length) total = r2(live.reduce((s, k) => s + combined[k] * WEIGHTS[k], 0) / live.reduce((s, k) => s + WEIGHTS[k], 0));
  if (diff && diff.total == null) notes.push(`metric total is null: ${diff.blocked || 'capture unusable'}`);

  const sev = { high: 0, medium: 1, low: 2 };
  const fromMetric = (diff?.findings || []).slice(0, 10).map((f) => ({ source: 'metric', area: f.area, severity: f.severity, text: f.fix, lost: f.lost }));
  const fromJudge = (judge?.mismatches || []).slice(0, 5).map((m) => ({ source: 'judge', area: m.area, severity: m.impact || 'medium', text: `${m.what}${m.sheet ? ` [${m.sheet}${m.where ? `, ${m.where}` : ''}]` : ''}` }));
  const polish = (judge?.polish || []).map((p) => ({ source: 'judge-polish', area: 'responsive', severity: 'high', text: `${p.what}${p.sheet ? ` [${p.sheet}${p.where ? `, ${p.where}` : ''}]` : ''}` }));
  const issues = [...polish, ...fromJudge, ...fromMetric]
    .map((x, i) => ({ ...x, _i: i }))
    .sort((a, b) => (sev[a.severity] ?? 1) - (sev[b.severity] ?? 1) || a._i - b._i)
    .slice(0, 12).map(({ _i, ...x }) => x);
  // a compare health failure (e.g. the build loads a non-catalogue web font) breaks a hard rule: never a pass
  const healthFail = (diff?.health || []).filter((h) => h && h.severity === 'fail').map((h) => h.what);
  for (const h of healthFail) notes.push(`not passing: ${h}`);
  return { metric, judge: jd, combined, total, pass: total != null && total >= PASS && !healthFail.length, ...(healthFail.length ? { healthFail } : {}), weights: WEIGHTS, notes, issues };
}

function main() {
  const runDir = process.argv[2] && path.resolve(process.argv[2]);
  if (!runDir) { console.error('usage: node harness/score.mjs <runDir>'); process.exit(2); }
  const diff = readJson(path.join(runDir, 'diff.json'));
  if (!diff) { console.error(`score: no readable diff.json in ${runDir}`); process.exit(1); }
  const judge = readJson(path.join(runDir, 'judge.json'));
  const res = scoreRun(diff, judge);
  const out = { schema: 'restyle-score/1', slug: path.basename(runDir), round: path.basename(path.dirname(runDir)), ...res, judgeConfidence: num(judge?.confidence) };
  fs.writeFileSync(path.join(runDir, 'score.json'), JSON.stringify(out, null, 1));
  console.log(JSON.stringify({ out: path.join(runDir, 'score.json'), total: out.total, pass: out.pass, ...out.combined, judge: !!judge }));
}
main();
