// Shared maths for compare.mjs: tolerance curves, colour distance, band alignment, and the
// Area accumulator that turns checks into a 0-10 score plus ranked findings.
import { parse, converter, differenceEuclidean } from 'culori';
import { BOTH_ABSENT_WEIGHT, SEVERITY } from './cmp-constants.mjs';

const toOklab = converter('oklab');
const toOklch = converter('oklch');
const dist = differenceEuclidean('oklab');

export const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const r2 = (v) => (isNum(v) ? Math.round(v * 100) / 100 : v);
export const r3 = (v) => (isNum(v) ? Math.round(v * 1000) / 1000 : v);
export const px = (v) => (isNum(v) ? `${Math.round(v)}px` : String(v));

/** 1 when err <= full, 0 when err >= zero, linear in between. Non-numbers score 0. */
export function lin(err, [full, zero]) {
  if (!isNum(err)) return 0;
  if (err <= full) return 1;
  if (err >= zero) return 0;
  return 1 - (err - full) / (zero - full);
}
export const relErr = (ref, b) => Math.abs(b - ref) / Math.max(Math.abs(ref), 1e-9);
export const logRatio = (ref, b, floor = 0) => Math.abs(Math.log((b + floor) / (ref + floor)));
/** Score from a step table, e.g. [1, 0.5, 0.2, 0] for a diff of 0, 1, 2, >=3. */
export const stepScore = (diff, table) => table[Math.min(Math.round(Math.abs(diff)), table.length - 1)];

// ------------------------------------------------------------------ colour
/** Parses '#rrggbb', '#rrggbb@0.5', css colours. Returns {hex, alpha, c} or null. */
export function col(s) {
  if (!s || typeof s !== 'string') return null;
  const [h, a] = s.split('@');
  const c = parse(h.trim());
  if (!c) return null;
  const alpha = a != null ? Number(a) : (c.alpha ?? 1);
  return { hex: h.trim(), alpha, c };
}
export function dE(a, b) {
  const A = typeof a === 'string' ? col(a) : a, B = typeof b === 'string' ? col(b) : b;
  if (!A || !B) return null;
  return dist(A.c, B.c);
}
export function lab(s) { const c = col(s); return c ? toOklab(c.c) : null; }
export function lch(s) { const c = typeof s === 'string' ? col(s) : s; return c ? toOklch(c.c) : null; }
export function isDark(s) { const l = lab(s); return l ? l.l < 0.5 : null; }
export const tone = (s) => { const d = isDark(s); return d == null ? null : d ? 'dark' : 'light'; };
export function hueDist(a, b) { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; }

// ------------------------------------------------------------------ alignment
/**
 * Needleman-Wunsch global alignment of two sequences.
 * sim(a, b) in [0,1]; pair value = sim - pairOffset; a gap costs `gap`.
 * Returns [{a: index|null, b: index|null, sim}] in order.
 */
export function align(A, B, sim, { pairOffset = 0.5, gap = 0.3 } = {}) {
  const n = A.length, m = B.length;
  const S = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  const T = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1)); // 1 diag, 2 up (gap in B), 3 left
  const sims = Array.from({ length: n }, (_, i) => B.map((_, j) => sim(A[i], B[j], i, j)));
  for (let i = 1; i <= n; i++) { S[i][0] = -gap * i; T[i][0] = 2; }
  for (let j = 1; j <= m; j++) { S[0][j] = -gap * j; T[0][j] = 3; }
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const d = S[i - 1][j - 1] + sims[i - 1][j - 1] - pairOffset;
      const u = S[i - 1][j] - gap, l = S[i][j - 1] - gap;
      if (d >= u && d >= l) { S[i][j] = d; T[i][j] = 1; } else if (u >= l) { S[i][j] = u; T[i][j] = 2; } else { S[i][j] = l; T[i][j] = 3; }
    }
  }
  const out = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    const t = T[i][j];
    if (t === 1) { out.push({ a: i - 1, b: j - 1, sim: sims[i - 1][j - 1] }); i--; j--; }
    else if (t === 2) { out.push({ a: i - 1, b: null, sim: 0 }); i--; }
    else { out.push({ a: null, b: j - 1, sim: 0 }); j--; }
  }
  return out.reverse();
}

/**
 * Needleman-Wunsch with runs: besides 1:1 pairs and gaps, one item of A may pair with a run of 2..maxRun
 * adjacent items of B (and vice versa) when merge(side, start, len, single) returns a merged item
 * (null = not allowed). A merged pair scores like a 1:1 pair of the single item and the merged item.
 * Returns [{a, b, sim, A, B, aRun, bRun}] in order: a/b = first index of the side (null for a gap),
 * A/B = the item or merged item, aRun/bRun = all indices covered.
 * mergeBoth(startA, lenA, startB, lenB) (optional) may return [mergedA, mergedB] for an n:m unit (runs of
 * 2..maxBoth on both sides cut at different places); it scores as ONE pair, so it only wins where the 1:1
 * pairs of the two runs fit badly.
 */
export function alignRuns(A, B, sim, { pairOffset = 0.5, gap = 0.3, maxRun = 3, merge = null, mergeBoth = null, maxBoth = 3 } = {}) {
  const n = A.length, m = B.length;
  const S = Array.from({ length: n + 1 }, () => new Float64Array(m + 1).fill(-Infinity));
  const T = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(null)); // [di, dj, simValue, mergedA, mergedB]
  const cache = new Map();
  // merged item for a run on `side` starting at `start`, paired with item `other` of the other side
  const merged = (side, start, len, other) => {
    const key = `${side}:${start}:${len}:${other}`;
    if (!cache.has(key)) cache.set(key, merge(side, start, len, side === 'a' ? B[other] : A[other]));
    return cache.get(key);
  };
  S[0][0] = 0;
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      if (i === 0 && j === 0) continue;
      let best = -Infinity, tb = null;
      const consider = (v, t) => { if (v > best) { best = v; tb = t; } };
      if (i > 0 && j > 0) { const s = sim(A[i - 1], B[j - 1], i - 1, j - 1); consider(S[i - 1][j - 1] + s - pairOffset, [1, 1, s, null, null]); }
      if (i > 0) consider(S[i - 1][j] - gap, [1, 0, 0, null, null]);
      if (j > 0) consider(S[i][j - 1] - gap, [0, 1, 0, null, null]);
      if (merge && i > 0 && j > 0) {
        for (let k = 2; k <= maxRun; k++) {
          if (j >= k) { const mb = merged('b', j - k, k, i - 1); if (mb) { const s = sim(A[i - 1], mb, i - 1, j - k); consider(S[i - 1][j - k] + s - pairOffset, [1, k, s, null, mb]); } }
          if (i >= k) { const ma = merged('a', i - k, k, j - 1); if (ma) { const s = sim(ma, B[j - 1], i - k, j - 1); consider(S[i - k][j - 1] + s - pairOffset, [k, 1, s, ma, null]); } }
        }
      }
      if (mergeBoth && i > 1 && j > 1) {
        for (let ka = 2; ka <= Math.min(maxBoth, i); ka++) {
          for (let kb = 2; kb <= Math.min(maxBoth, j); kb++) {
            const key = `ab:${i - ka}:${ka}:${j - kb}:${kb}`;
            if (!cache.has(key)) cache.set(key, mergeBoth(i - ka, ka, j - kb, kb));
            const mm = cache.get(key);
            if (mm) { const s = sim(mm[0], mm[1], i - ka, j - kb); consider(S[i - ka][j - kb] + s - pairOffset, [ka, kb, s, mm[0], mm[1]]); }
          }
        }
      }
      S[i][j] = best; T[i][j] = tb;
    }
  }
  const out = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    const [di, dj, s, ma, mb] = T[i][j];
    const aRun = di ? Array.from({ length: di }, (_, k) => i - di + k) : [];
    const bRun = dj ? Array.from({ length: dj }, (_, k) => j - dj + k) : [];
    out.push({ a: di ? i - di : null, b: dj ? j - dj : null, sim: di && dj ? s : 0, A: di ? (ma || A[i - 1]) : null, B: dj ? (mb || B[j - 1]) : null, aRun, bRun });
    i -= di; j -= dj;
  }
  return out.reverse();
}

// ------------------------------------------------------------------ items -> one check
/**
 * Combines per-item scores ({s, w, what, ref, build, fix}) into one check score, and keeps
 * the items that lost points with the share of the check's loss each one caused.
 */
export function combine(items) {
  const ok = items.filter((it) => it && isNum(it.s) && isNum(it.w) && it.w > 0);
  if (!ok.length) return { s: null, items: [] };
  const W = ok.reduce((a, it) => a + it.w, 0);
  const s = ok.reduce((a, it) => a + it.s * it.w, 0) / W;
  const lossTot = ok.reduce((a, it) => a + (1 - it.s) * it.w, 0);
  const lossy = ok.filter((it) => it.s < 0.999 && it.fix)
    .map((it) => ({ ...it, share: lossTot > 0 ? ((1 - it.s) * it.w) / lossTot : 0 }))
    .sort((a, b) => b.share - a.share);
  return { s, items: lossy };
}

// ------------------------------------------------------------------ area accumulator
export class Area {
  constructor(name, weight) {
    this.name = name; this.weight = weight; this.checks = []; this.penalties = []; this.notes = [];
  }
  /**
   * Adds a check. s = null removes it (reference value missing). absent = true marks a
   * "both sides lack this feature" agreement, counted at BOTH_ABSENT_WEIGHT.
   * finding: {what, ref, build, fix} for the whole check, or items: [...] from combine().
   */
  add(name, weight, s, { detail = '', finding = null, items = null, absent = false } = {}) {
    this.checks.push({ name, weight: absent ? weight * BOTH_ABSENT_WEIGHT : weight, s: isNum(s) ? clamp(s, 0, 1) : null, detail, finding, items });
  }
  penalty(name, pts, finding) { this.penalties.push({ name, pts, finding }); }

  /** areaShare = this area's weight / sum of weights of scored areas (for points lost on the total). */
  result(areaShare) {
    const live = this.checks.filter((c) => c.s != null);
    const W = live.reduce((a, c) => a + c.weight, 0);
    const pen = this.penalties.reduce((a, p) => a + p.pts, 0);
    const raw = W > 0 ? (10 * live.reduce((a, c) => a + c.s * c.weight, 0)) / W : null;
    const score = raw == null ? (this.penalties.length ? clamp(10 - pen, 0, 10) : null) : clamp(raw - pen, 0, 10);
    const findings = [];
    const push = (f, lost) => {
      if (!f || !f.fix || !(lost > 0.004)) return;
      findings.push({
        area: this.name, severity: lost >= SEVERITY.high ? 'high' : lost >= SEVERITY.medium ? 'medium' : 'low',
        what: f.what, ref: f.ref ?? null, build: f.build ?? null, fix: f.fix, lost: r3(lost),
      });
    };
    for (const c of live) {
      const checkLoss = W > 0 ? ((1 - c.s) * c.weight / W) * 10 * areaShare : 0;
      if (checkLoss <= 0) continue;
      if (c.items && c.items.length) for (const it of c.items.slice(0, 3)) push(it, checkLoss * it.share);
      else if (c.finding) push(c.finding, checkLoss);
    }
    for (const p of this.penalties) push(p.finding, p.pts * areaShare);
    findings.sort((a, b) => b.lost - a.lost);
    const subs = this.checks.map((c) => ({ name: c.name, score: c.s == null ? null : r2(c.s * 10), weight: r2(c.weight), detail: c.detail }));
    for (const p of this.penalties) subs.push({ name: `penalty: ${p.name}`, score: null, weight: 0, detail: `-${r2(p.pts)} area points` });
    return { score: score == null ? null : r2(score), weight: this.weight, subs, findings, ...(this.notes.length ? { notes: this.notes } : {}) };
  }
}

/** Presence check helper: returns {s, absent, kind} for a feature seen (or not) on each side. */
export function presence(refHas, buildHas) {
  if (refHas && buildHas) return { s: 1, absent: false, kind: 'both' };
  if (!refHas && !buildHas) return { s: 1, absent: true, kind: 'none' };
  return { s: 0, absent: false, kind: refHas ? 'missing' : 'extra' };
}

export const fmtList = (arr) => (arr && arr.length ? arr.join(', ') : 'none');
