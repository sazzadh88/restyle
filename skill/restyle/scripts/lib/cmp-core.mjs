// Core of compare.mjs: two capture objects -> restyle-diff/2 object. See compare.mjs header.
import fs from 'node:fs';
import path from 'node:path';
import { AREA_WEIGHTS, MAX_FINDINGS } from './cmp-constants.mjs';
import { r2 } from './cmp-util.mjs';
import { scoreLayout } from './cmp-layout.mjs';
import { scoreColor } from './cmp-color.mjs';
import { scoreType } from './cmp-type.mjs';
import { scoreMotion } from './cmp-motion.mjs';
import { scoreResponsive } from './cmp-responsive.mjs';

export function loadCapture(dir) {
  const f = path.join(dir, 'capture.json');
  if (!fs.existsSync(f)) throw new Error(`no capture.json in ${dir}`);
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

// Font health (SKILL.md Hard rules): every web font the build loads (capture type.webFonts) must be in the
// public Google Fonts catalogue. inCatalogue false -> fail; null (catalogue unreachable at capture time and
// the family outside the bundled subset) -> warn. A capture without type.webFonts -> warn (not checked).
export function fontHealth(build) {
  const wf = build?.type?.webFonts;
  if (!wf) return build?.type ? [{ check: 'font-catalogue', severity: 'warn', what: 'build web fonts not recorded (older capture): the non-catalogue font check did not run', fix: 'Recapture the build with the current capture.mjs.' }] : [];
  const out = [];
  for (const f of wf.families || []) {
    const via = `${(f.via || []).join(' + ')}${f.hosts && f.hosts.length ? ` from ${f.hosts.join(', ')}` : ''}`;
    if (f.inCatalogue === false) out.push({ check: 'font-catalogue', severity: 'fail', family: f.family, via: f.via, catalogue: wf.catalogue,
      what: `build loads a non-catalogue web font: ${f.family}`,
      fix: `Build loads the web font "${f.family}" (${via}), which is not in the public Google Fonts catalogue (checked: ${wf.catalogue}). Replace it with a catalogue family chosen with inspect.mjs fontmatch (font-substitutes §procedure), then regenerate type-scale's fontsUrl, the <link> and the preload.` });
    else if (f.inCatalogue == null) out.push({ check: 'font-catalogue', severity: 'warn', family: f.family, via: f.via, catalogue: wf.catalogue,
      what: `build web font not verified against the catalogue: ${f.family}`,
      fix: `The catalogue was not reachable when the build was captured (${wf.catalogue}) and "${f.family}" is not in the bundled subset: recapture online to verify it.` });
  }
  return out;
}

/** Pure function: two capture objects -> diff object. */
export function compareCaptures(ref, build, { refDir = null, buildDir = null } = {}) {
  ref = ref || {}; build = build || {};
  const built = {};
  const errors = {};
  let primary = null;
  const safe = (name, fn) => { try { return fn(); } catch (e) { errors[name] = String(e && e.stack || e).split('\n').slice(0, 3).join(' | '); return null; } };
  const lay = safe('layout', () => scoreLayout(ref, build));
  if (lay) { built.layout = lay.area; primary = lay; }
  // colour gets the capture dirs and the band alignment: a gradient shipped as an image on one side is
  // checked against that side's screenshot pixels in the aligned band
  const c = safe('color', () => scoreColor(ref, build, { refDir, buildDir, pairs: primary?.pairs || null })); if (c) built.color = c.area;
  const t = safe('type', () => scoreType(ref, build)); if (t) built.type = t.area;
  const m = safe('motion', () => scoreMotion(ref, build, { refDir, buildDir })); if (m) built.motion = m.area;
  const rsp = safe('responsive', () => scoreResponsive(ref, build, primary)); if (rsp) built.responsive = rsp.area;
  const partial = !!(build.meta?.fast || ref.meta?.fast);

  // Area shares for "points lost": only areas that produced a score count.
  const prelim = {};
  for (const [k, a] of Object.entries(built)) prelim[k] = a.result(1);
  const scored = Object.keys(prelim).filter((k) => prelim[k].score != null);
  const wSum = scored.reduce((s, k) => s + AREA_WEIGHTS[k], 0);
  const areas = {};
  for (const k of Object.keys(AREA_WEIGHTS)) {
    if (!built[k]) { areas[k] = { score: null, weight: AREA_WEIGHTS[k], subs: [], findings: [], error: errors[k] || 'not computed' }; continue; }
    areas[k] = built[k].result(wSum > 0 ? AREA_WEIGHTS[k] / wSum : 0);
  }
  let total = wSum > 0 ? r2(scored.reduce((s, k) => s + areas[k].score * AREA_WEIGHTS[k], 0) / wSum) : null;
  // health: hard rule checks on the build alone; they never change an area score. A failure is also the
  // first finding (area "health", lost 0).
  const health = fontHealth(build);
  const hardFindings = health.filter((h) => h.severity === 'fail').map((h) => ({ area: 'health', severity: 'high', health: 'fail', what: h.what, ref: null, build: h.family, fix: h.fix, lost: 0 }));
  const findings = [...hardFindings, ...Object.values(areas).flatMap((a) => a.findings || []).sort((a, b) => b.lost - a.lost)].slice(0, MAX_FINDINGS);

  const blockedReasons = [];
  if (ref.meta?.blocked?.suspected) blockedReasons.push(`reference capture looks blocked (${(ref.meta.blocked.reasons || []).join('; ') || 'bot wall suspected'})`);
  if (build.meta?.blocked?.suspected) blockedReasons.push(`build capture looks blocked (${(build.meta.blocked.reasons || []).join('; ') || 'bot wall suspected'})`);
  const KNOWN = ['restyle-capture/1', 'restyle-capture/2'];
  if (ref.schema && !KNOWN.includes(ref.schema)) blockedReasons.push(`unknown reference schema ${ref.schema}`);
  const out = { schema: 'restyle-diff/2', ref: refDir, build: buildDir, total, areas, findings, health };
  const notes = [];
  if (ref.schema !== build.schema) notes.push(`captures use different schemas (${ref.schema} vs ${build.schema}); recapture the older one`);
  if (partial) { out.partial = true; notes.push(`${build.meta?.fast ? 'build' : 'reference'} capture is --fast: only the largest viewport, no hover and no motion frames were captured, so those checks are not scored; the final verify needs a full capture`); }
  if (notes.length) out.notes = notes;
  if (blockedReasons.length) { out.total = null; out.blocked = blockedReasons.join('; '); }
  if (Object.keys(errors).length) out.errors = errors;
  return out;
}

