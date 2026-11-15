#!/usr/bin/env node
/*
 * report.mjs — round summary.
 *
 *   node harness/report.mjs runs/<round>
 *
 * Reads runs/<round>/<slug>/score.json for every site dir, writes runs/<round>/REPORT.md
 * (one row per site: total, five areas, pass; averages; lowest area across sites; most frequent
 * issues grouped by area), prints the table to stderr and one JSON summary line to stdout.
 */
import fs from 'node:fs';
import path from 'node:path';

const AREAS = ['layout', 'color', 'type', 'motion', 'responsive'];
const f2 = (v) => (typeof v === 'number' ? v.toFixed(2) : '-');
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

/** Groups similar issue texts: digits/hex/quoted bits removed, first 9 words. */
const issueKey = (t) => String(t).toLowerCase().replace(/#[0-9a-f]{3,8}/g, '#').replace(/[\d.]+(px|ms|vh|em|%)?/g, 'N').replace(/"[^"]*"/g, '').split(/\s+/).slice(0, 9).join(' ');

function main() {
  const roundDir = process.argv[2] && path.resolve(process.argv[2]);
  if (!roundDir || !fs.existsSync(roundDir)) { console.error('usage: node harness/report.mjs runs/<round>'); process.exit(2); }
  const rows = [];
  for (const slug of fs.readdirSync(roundDir).sort()) {
    const s = readJson(path.join(roundDir, slug, 'score.json'));
    if (s) rows.push({ slug, s });
  }
  const lines = [];
  lines.push(`# Round ${path.basename(roundDir)} report`, '', `Generated ${new Date().toISOString()} from ${rows.length} score.json file(s). Score = 0.5 x metric + 0.5 x judge per area; pass = total >= 8.5.`, '');
  const head = `| site | total | ${AREAS.join(' | ')} | pass |`;
  const sep = `|---|---|${AREAS.map(() => '---').join('|')}|---|`;
  const table = [head, sep];
  for (const { slug, s } of rows) table.push(`| ${slug} | ${f2(s.total)} | ${AREAS.map((a) => f2(s.combined?.[a])).join(' | ')} | ${s.pass ? 'yes' : 'NO'}${s.judge ? '' : ' (no judge)'} |`);
  const avg = (get) => { const v = rows.map(get).filter((x) => typeof x === 'number'); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const avgs = Object.fromEntries(AREAS.map((a) => [a, avg((r) => r.s.combined?.[a])]));
  const avgTotal = avg((r) => r.s.total);
  table.push(`| **average** | **${f2(avgTotal)}** | ${AREAS.map((a) => `**${f2(avgs[a])}**`).join(' | ')} | ${rows.filter((r) => r.s.pass).length}/${rows.length} |`);
  lines.push(...table, '');
  const lowest = AREAS.filter((a) => avgs[a] != null).sort((a, b) => avgs[a] - avgs[b])[0];
  if (lowest) lines.push(`**Lowest area across sites:** ${lowest} (average ${f2(avgs[lowest])}).`, '');
  const metricVsJudge = AREAS.map((a) => `${a} metric ${f2(avg((r) => r.s.metric?.[a]))} / judge ${f2(avg((r) => r.s.judge?.[a]))}`);
  lines.push(`Averages, metric vs judge: ${metricVsJudge.join('; ')}.`, '');

  lines.push('## Most frequent issues by area', '');
  for (const a of AREAS) {
    const groups = new Map();
    for (const { slug, s } of rows) for (const it of s.issues || []) {
      if (it.area !== a) continue;
      const k = issueKey(it.text);
      const g = groups.get(k) || { n: 0, sites: new Set(), example: it.text, sources: new Set() };
      g.n++; g.sites.add(slug); g.sources.add(it.source); groups.set(k, g);
    }
    const top = [...groups.values()].sort((x, y) => y.sites.size - x.sites.size || y.n - x.n).slice(0, 6);
    lines.push(`### ${a}`);
    if (!top.length) lines.push('- none reported');
    for (const g of top) lines.push(`- (${g.sites.size} site${g.sites.size > 1 ? 's' : ''}: ${[...g.sites].join(', ')}; ${[...g.sources].join('/')}) ${g.example}`);
    lines.push('');
  }
  const failing = rows.filter((r) => !r.s.pass);
  if (failing.length) {
    lines.push('## Not passing', '');
    for (const { slug, s } of failing) lines.push(`- ${slug}: ${f2(s.total)}${(s.notes || []).length ? ` (${s.notes.join('; ')})` : ''}`);
    lines.push('');
  }
  fs.writeFileSync(path.join(roundDir, 'REPORT.md'), lines.join('\n'));
  console.error(table.join('\n'));
  console.log(JSON.stringify({ out: path.join(roundDir, 'REPORT.md'), sites: rows.length, passed: rows.filter((r) => r.s.pass).length, average: avgTotal == null ? null : Math.round(avgTotal * 100) / 100, lowestArea: lowest || null }));
}
main();
