// Screencast recording (CDP Page.startScreencast) and fixed-fps resampling for motion frames.
import fs from 'node:fs';
import path from 'node:path';

// Load strip: recorded for LOAD_WINDOW_MS after first contentful paint at 12 fps (61 frames), so a load
// sequence that settles late (up to LOAD_SETTLE_CAP_MS after first paint) is inside the strip with a
// confirmation margin after it.
export const LOAD_FPS = 12;
export const LOAD_WINDOW_MS = 5000;
export const LOAD_SETTLE_CAP_MS = 4000;
// the first 1.5 s of the load frames: the window the load-time hero media activity is measured over
export const LOAD_MEDIA_MS = 1500;

// Frame pump: headless Chrome's screencast can send no frame for several hundred ms while only compositor-run
// animations change the page (an opacity fade right after a scroll arrives late, or as a single step). While a
// screencast runs, a 2x2 px box at the bottom-right corner, outside <body> and at opacity 0.01 (at most ~3 RGB
// levels on 4 pixels: below every frame measure's threshold), repaints every animation frame, so the compositor
// produces a frame every vsync and the strips show the motion as it happens. Removed when the screencast stops.
const PUMP = `(() => { try { if (window.top !== window || window.__rcPump) return; let stop = false, el = null, k = 0;
  const tick = () => { if (stop) { if (el) el.remove(); return; } if (!el && document.documentElement) { el = document.createElement('div'); el.setAttribute('data-rc-pump', ''); el.setAttribute('aria-hidden', 'true');
    el.style.cssText = 'position:fixed;right:0;bottom:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:2147483647;contain:strict'; document.documentElement.appendChild(el); }
    if (el) el.style.background = (k++ % 2) ? 'black' : 'white'; requestAnimationFrame(tick); };
  window.__rcPump = () => { stop = true; if (el) el.remove(); }; requestAnimationFrame(tick); } catch (e) {} })();`;

export async function startScreencast(page, { width, height, quality = 55, max = 1200 } = {}) {
  // the pump for the current document and for a navigation that follows (load strips start before goto)
  // (the init-script copy stops itself after 12 s: a later navigation of the same page never keeps a pump running)
  await page.addInitScript({ content: `${PUMP}; setTimeout(() => { try { window.__rcPump && window.__rcPump(); } catch (e) {} }, 12000);` }).catch(() => {});
  await page.evaluate(PUMP).catch(() => {});
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  let stopped = false;
  const rec = { frames, capped: false };
  cdp.on('Page.screencastFrame', (ev) => {
    const ts = ev.metadata && ev.metadata.timestamp ? ev.metadata.timestamp * 1000 : Date.now();
    if (!stopped) { if (frames.length < max) frames.push({ ts, recv: Date.now(), data: ev.data }); else rec.capped = true; }
    cdp.send('Page.screencastFrameAck', { sessionId: ev.sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality, maxWidth: width, maxHeight: height, everyNthFrame: 1 });
  return Object.assign(rec, {
    async stop() {
      stopped = true;
      await cdp.send('Page.stopScreencast').catch(() => {});
      await cdp.detach().catch(() => {});
      await page.evaluate(() => { try { if (window.__rcPump) window.__rcPump(); } catch {} }).catch(() => {});
      return frames;
    },
  });
}

// Writes `count` frames at `fps` starting at t0 (epoch ms) to dir as f-00.jpg ...
// Picks, for each tick, the latest screencast frame at or before that tick.
export function writeFrames(frames, t0, dir, { fps = 12, durationMs = 1500 } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const picked = pickFrames(frames, t0, { fps, durationMs });
  const files = [];
  let distinct = 0, last = null;
  picked.forEach((pick, k) => {
    if (pick !== last) distinct++;
    last = pick;
    const file = path.join(dir, `f-${String(k).padStart(2, '0')}.jpg`);
    fs.writeFileSync(file, Buffer.from(pick.data, 'base64'));
    files.push(file);
  });
  return { n: files.length, distinct, sourceFrames: frames.filter((f) => f.ts >= t0 - 1).length };
}
// For each tick t0 + k/fps the latest screencast frame at or before it (frames arrive only on change).
export function pickFrames(frames, t0, { fps = 12, durationMs = 1500 } = {}) {
  const usable = frames.filter((f) => f.ts >= t0 - 1).sort((a, b) => a.ts - b.ts);
  const before = frames.filter((f) => f.ts < t0).sort((a, b) => b.ts - a.ts)[0];
  const n = Math.round(durationMs / 1000 * fps) + 1;
  const out = [];
  for (let k = 0; k < n; k++) {
    const t = t0 + k * 1000 / fps;
    let pick = null;
    for (const f of usable) { if (f.ts <= t + 1) pick = f; else break; }
    if (!pick) pick = before || usable[0];
    if (!pick) break;
    out.push(pick);
  }
  return out;
}

// Start instant of a load strip: the screencast frame that shows first contentful paint. fcpEpoch =
// performance.timeOrigin + FCP startTime (renderer clock, epoch ms); frame ts = compositor frame swap
// time (epoch ms). The strip starts at the first frame swapped at or after FCP, so a page that paints at
// once shows its content in frame 0 and blank pre-paint frames (fast local pages) are never part of it.
// When the two clocks disagree (median recv - ts beyond 400 ms) the receive time is used instead.
// The frame that shows FCP carries a compositor time up to a frame or two BEFORE the FCP time, and a page
// that stays still after its first paint sends no further frame until something changes (possibly seconds
// later), so the strip starts at the first frame from 40 ms before FCP on, and never later than 40 ms after
// FCP (then the frame on screen at that instant, the FCP frame, is frame 0).
// Without an FCP the first frame after navigation commit is used (t0: 'commit').
export function loadStart(frames, commitTs, fcpEpoch) {
  const post = frames.filter((f) => f.recv >= commitTs).sort((a, b) => a.ts - b.ts);
  if (!post.length) return null;
  if (fcpEpoch) {
    const off = post.map((f) => f.recv - f.ts).sort((a, b) => a - b)[Math.floor(post.length / 2)];
    const useRecv = Math.abs(off) > 400;
    const at = (f) => (useRecv ? f.recv : f.ts);
    const fcpTs = useRecv ? fcpEpoch - off : fcpEpoch;
    const hit = post.find((f) => at(f) >= fcpEpoch - 40);
    const before = post.filter((f) => f.ts <= fcpTs + 40);
    if (hit || before.length) return { t0: hit ? Math.min(hit.ts, fcpTs + 40) : fcpTs + 40, how: useRecv ? 'fcp (receive clock)' : 'fcp', fcpAfterCommitMs: Math.round(fcpEpoch - commitTs) };
  }
  return { t0: post[0].ts, how: 'commit', fcpAfterCommitMs: null };
}

// A Node-side instant (Date.now() epoch ms, e.g. the moment an input was sent) on the screencast's
// compositor clock: frame ts = compositor frame time, recv = Date.now() when the frame arrived; the median
// recv - ts over the recorded frames is the clock offset (plus delivery latency, a few ms).
export function epochToTs(frames, epoch) {
  if (!frames.length) return epoch;
  const off = frames.map((f) => f.recv - f.ts).sort((a, b) => a - b)[Math.floor(frames.length / 2)];
  return epoch - off;
}

// Activity inside boxes across a frame sequence (JPEG frames, base64, `fps` apart): the one media measure
// (capture.mjs and inspect.mjs activity both reach it through sampleMedia). Per box:
//   rate     mean share of its pixels that differ by > 24 (sum of RGB differences) between frames 1 s apart:
//            how much of the box changes per second. A slow sweep of a large smooth shape (a gradient
//            ribbon, footage) changes little between two frames but most of the box within a second, so
//            `rate` separates it from a subtle drift; the activity level comes from it alone (rateLevel)
//   diff     mean changed share between consecutive frames; active = share of consecutive pairs with any
//            change (> 0.2% of the box): a moving box below INTERMITTENT_ACTIVE changes in bursts
//   hot      the half-width x half-height window of the box that changes most over 1 s (frame px)
//   motion   how it moves (pairs ~1/3 s apart, column / row luma profiles of strips of the box, shifted to
//            match): 'lateral' (most changing strips are explained by one shift along an axis, in one
//            direction, >= travelPx px/s: a track or picture sliding across the box; axis, dir, pxPerSec),
//            'drift' (shift-explained change over most of the box, slow or without one direction: a pan or
//            zoom of the whole picture), 'cut' (change not explained by a shift, in bursts that swap a
//            large part of the box: cuts, cross-fades, a card stack cycling), else 'in-place' (items change,
//            turn or scale where they are). null when nothing moves.
//   shifted  frame pairs compensated for a whole-page vertical shift (a bar inserted above pushes the page
//            down): the luma row profiles of both frame halves match at one offset, and the box is
//            compared with its content where it moved to, so a layout shift never reads as media activity.
// Decoded in a blank page of ctx. boxes: [[x, y, w, h]] in frame pixels. kinds: false skips `motion`.
export const MOTION_KIND = { tf: 0.5, agree: 0.7, travelPx: 12, driftCover: 0.6, driftPx: 40, wholeCover: 0.5, cutActive: 0.4, cutPeak: 0.15 };
export async function boxActivity(ctx, frames, boxes, { fps = 12, kinds = true } = {}) {
  if (!frames || frames.length < 3 || !boxes.length) return boxes.map(() => null);
  const p = await ctx.newPage();
  try {
    return await p.evaluate(async ({ frames, boxes, fps, lag, gap, kinds, T }) => {
      const imgs = [];
      for (const b64 of frames) { const img = new Image(); img.src = 'data:image/jpeg;base64,' + b64; await img.decode(); imgs.push(img); }
      const W = imgs[0].naturalWidth, H = imgs[0].naturalHeight, n = imgs.length;
      const r2 = (v) => Math.round(v * 100) / 100, r4 = (v) => Math.round(v * 10000) / 10000;
      // whole-page vertical shift between two frames: luma row profiles of the left and right frame halves
      const PH = Math.max(40, Math.min(H, 450)), PW = 48;
      const pcv = document.createElement('canvas'); pcv.width = PW * 2; pcv.height = PH;
      const pcx = pcv.getContext('2d', { willReadFrequently: true });
      const prof = imgs.map((img) => {
        pcx.drawImage(img, 0, 0, W, H, 0, 0, PW * 2, PH);
        const d = pcx.getImageData(0, 0, PW * 2, PH).data, L = new Float32Array(PH), R = new Float32Array(PH);
        for (let y = 0; y < PH; y++) for (let xx = 0; xx < PW * 2; xx++) { const i = (y * PW * 2 + xx) * 4, v = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / PW; if (xx < PW) L[y] += v; else R[y] += v; }
        return [L, R];
      });
      const perr = (a, b, s) => { let e = 0, k = 0; for (let y = Math.max(0, -s); y < PH && y + s < PH; y++) { e += Math.abs(a[y] - b[y + s]); k++; } return k >= PH * 0.6 ? e / k : Infinity; };
      const spread = (a) => { let m = 0; for (const v of a) m += v; m /= a.length; let q = 0; for (const v of a) q += (v - m) * (v - m); return Math.sqrt(q / a.length); };
      const maxS = Math.round(PH * 0.2), memo = new Map();
      // frame px by which frame j shows frame i's content lower down (0 = no whole-page shift)
      const shiftOf = (i, j) => {
        const key = i * 10000 + j;
        if (memo.has(key)) return memo.get(key);
        let dy = 0;
        const halves = [0, 1].filter((h) => spread(prof[i][h]) > 3);
        const e0 = halves.map((h) => perr(prof[i][h], prof[j][h], 0)), e0s = e0.reduce((q, v) => q + v, 0);
        if (halves.length && e0s > 1) {
          let best = Infinity, bs = 0;
          for (let s = -maxS; s <= maxS; s++) { if (!s) continue; let e = 0; for (const h of halves) e += perr(prof[i][h], prof[j][h], s); if (e < best) { best = e; bs = s; } }
          if (best <= 0.35 * e0s && halves.every((h, q) => e0[q] >= 0.5 && perr(prof[i][h], prof[j][h], bs) <= 0.4 * e0[q])) dy = Math.round((bs * H) / PH);
        }
        memo.set(key, dy);
        return dy;
      };
      const c = document.createElement('canvas');
      const x = c.getContext('2d', { willReadFrequently: true });
      return boxes.map(([bx, by, bw, bh]) => {
        const sx = Math.max(0, Math.round(bx)), sy = Math.max(0, Math.round(by));
        const sw = Math.min(W - sx, Math.round(bw)), sh = Math.min(H - sy, Math.round(bh));
        if (sw < 8 || sh < 8) return null;
        const s = Math.min(1, 240 / Math.max(sw, sh));
        const cw = Math.max(4, Math.round(sw * s)), ch = Math.max(4, Math.round(sh * s)), N = cw * ch;
        c.width = cw; c.height = ch;
        // the box's pixels in frame k, its content followed dy frame px down (rows v0..v1 inside the frame)
        const grab = (k, dy = 0) => {
          x.clearRect(0, 0, cw, ch);
          const y0 = sy + dy, top = Math.max(0, y0), bot = Math.min(H, y0 + sh);
          if (bot - top < 4) return null;
          const v0 = Math.round((top - y0) * s), v1 = Math.min(ch, v0 + Math.max(1, Math.round((bot - top) * s)));
          x.drawImage(imgs[k], sx, top, sw, bot - top, 0, v0, cw, v1 - v0);
          return { d: x.getImageData(0, 0, cw, ch).data, v0, v1 };
        };
        const px = imgs.map((_, k) => grab(k).d);
        let shifted = 0;
        const pairOf = (i, j) => {
          const dy = shiftOf(i, j);
          if (!dy) return { a: px[i], b: px[j], v0: 0, v1: ch, dy };
          const g = grab(j, dy);
          return g ? { a: px[i], b: g.d, v0: g.v0, v1: g.v1, dy } : null;
        };
        const changedIn = (P, cnt) => {
          let m = 0;
          for (let y = P.v0; y < P.v1; y++) for (let xx = 0, j = y * cw, i = j * 4; xx < cw; xx++, j++, i += 4) if (Math.abs(P.a[i] - P.b[i]) + Math.abs(P.a[i + 1] - P.b[i + 1]) + Math.abs(P.a[i + 2] - P.b[i + 2]) > 24) { m++; if (cnt) cnt[j]++; }
          return m / Math.max(1, (P.v1 - P.v0) * cw);
        };
        const diffs = [];
        for (let k = 1; k < n; k++) { const P = pairOf(k - 1, k); if (!P) continue; if (P.dy) shifted++; diffs.push(changedIn(P)); }
        const mean = diffs.length ? diffs.reduce((q, v) => q + v, 0) / diffs.length : 0;
        const active = diffs.length ? diffs.filter((v) => v > 0.002).length / diffs.length : 0;
        const L = Math.min(lag, n - 1), per = [], cnt = new Uint16Array(N);
        for (let k = 0; k + L < n; k++) { const P = pairOf(k, k + L); if (!P) continue; if (P.dy) shifted++; per.push(changedIn(P, cnt)); }
        const rate = per.length ? per.reduce((q, v) => q + v, 0) / per.length : null;
        // the half-width x half-height window of the box that changes most over 1 s (frame px): where a zoomed
        // crop of a large box shows the motion
        const ww = Math.max(2, Math.round(cw / 2)), wh = Math.max(2, Math.round(ch / 2));
        const I = new Float64Array((cw + 1) * (ch + 1));
        for (let y = 0; y < ch; y++) for (let xx = 0; xx < cw; xx++) I[(y + 1) * (cw + 1) + xx + 1] = cnt[y * cw + xx] + I[y * (cw + 1) + xx + 1] + I[(y + 1) * (cw + 1) + xx] - I[y * (cw + 1) + xx];
        let best = -1, hx = 0, hy = 0;
        for (let y = 0; y + wh <= ch; y += 2) for (let xx = 0; xx + ww <= cw; xx += 2) { const v = I[(y + wh) * (cw + 1) + xx + ww] - I[y * (cw + 1) + xx + ww] - I[(y + wh) * (cw + 1) + xx] + I[y * (cw + 1) + xx]; if (v > best) { best = v; hx = xx; hy = y; } }
        const hot = best > 0 ? [Math.round(sx + hx / s), Math.round(sy + hy / s), Math.round(ww / s), Math.round(wh / s)] : null;
        const out = { diff: r4(mean), active: r2(active), rate: rate === null ? null : r4(rate), hot, shifted: shifted || undefined };
        if (!kinds) return out;
        // how it moves: pairs G frames (~1/3 s) apart; per strip the best 1-D shift of its luma profile
        const G = Math.max(1, Math.min(gap, n - 1));
        const luma = (d) => { const o = new Float32Array(N); for (let j = 0, i = 0; j < N; j++, i += 4) o[j] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; return o; };
        // best 1-D shift of profile pa onto pb, smallest shifts first: a larger one wins only when clearly
        // better (a repeating row of tiles matches every period; the nearest is the travel)
        const best1d = (pa, pb, R) => {
          let e0 = 0; for (let q = 0; q < pa.length; q++) e0 += Math.abs(pa[q] - pb[q]); e0 /= pa.length;
          const es = [];
          let min = e0;
          for (let sh1 = -R; sh1 <= R; sh1++) {
            if (!sh1) continue;
            let e = 0, k = 0;
            for (let q = Math.max(0, -sh1); q < pa.length && q + sh1 < pa.length; q++) { e += Math.abs(pa[q] - pb[q + sh1]); k++; }
            if (k < pa.length * 0.5) continue;
            e /= k; es.push([sh1, e]); if (e < min) min = e;
          }
          if (min >= e0) return { e0, e: e0, s: 0 };
          const near = es.filter(([, e]) => e <= min + 0.15 * (e0 - min) + 0.2).sort((a, b) => Math.abs(a[0]) - Math.abs(b[0]))[0];
          return { e0, e: near[1], s: near[0] };
        };
        const NH = Math.min(8, Math.max(3, Math.round(ch / 24))), NV = Math.min(8, Math.max(3, Math.round(cw / 24)));
        const Rx = Math.max(2, Math.round(cw * 0.3)), Ry = Math.max(2, Math.round(ch * 0.3));
        let movPairs = 0, cover = 0, peak = 0, movH = 0, trH = 0, movV = 0, trV = 0;
        const dxs = [], dys = [];
        for (let k = 0; k + G < n; k++) {
          const P = pairOf(k, k + G); if (!P) continue;
          const chg = changedIn(P);
          peak = Math.max(peak, chg);
          if (chg < 0.01) continue;
          movPairs++; cover += chg;
          const A = luma(P.a), B = luma(P.b);
          for (let t = 0; t < NH; t++) {
            const y0 = Math.max(P.v0, Math.floor((t * ch) / NH)), y1 = Math.min(P.v1, Math.floor(((t + 1) * ch) / NH));
            if (y1 - y0 < 2) continue;
            const pa = new Float32Array(cw), pb = new Float32Array(cw);
            for (let y = y0; y < y1; y++) for (let xx = 0; xx < cw; xx++) { pa[xx] += A[y * cw + xx] / (y1 - y0); pb[xx] += B[y * cw + xx] / (y1 - y0); }
            const r = best1d(pa, pb, Rx);
            if (r.e0 < 1) continue;
            movH++;
            if (r.s && r.e <= 0.4 * r.e0) { trH++; dxs.push(r.s); }
          }
          for (let t = 0; t < NV; t++) {
            const x0 = Math.floor((t * cw) / NV), x1 = Math.floor(((t + 1) * cw) / NV), len = P.v1 - P.v0;
            if (x1 - x0 < 2 || len < 4) continue;
            const pa = new Float32Array(len), pb = new Float32Array(len);
            for (let y = P.v0; y < P.v1; y++) for (let xx = x0; xx < x1; xx++) { pa[y - P.v0] += A[y * cw + xx] / (x1 - x0); pb[y - P.v0] += B[y * cw + xx] / (x1 - x0); }
            const r = best1d(pa, pb, Ry);
            if (r.e0 < 1) continue;
            movV++;
            if (r.s && r.e <= 0.4 * r.e0) { trV++; dys.push(r.s); }
          }
        }
        if (!movPairs) return Object.assign(out, { motion: null });
        const horiz = trH >= trV;
        const shs = horiz ? dxs : dys, tf = horiz ? (movH ? trH / movH : 0) : (movV ? trV / movV : 0);
        // agreement = share of the shifts in the dominant direction; speed = their median size
        const neg = shs.filter((v) => v < 0).length, pos = shs.length - neg, sum = pos >= neg ? 1 : -1;
        const agree = shs.length ? Math.max(neg, pos) / shs.length : 0;
        const dom = shs.filter((v) => (sum < 0 ? v < 0 : v > 0)).map(Math.abs).sort((a, b) => a - b);
        const med = dom.length ? dom[dom.length >> 1] : 0;
        const speed = (med / s) * (fps / G), cov = cover / movPairs;
        let motion;
        if (tf >= T.tf && agree >= T.agree && speed >= T.travelPx && !(cov >= T.driftCover && speed < T.driftPx)) motion = 'lateral';
        else if (tf >= T.tf && cov >= T.wholeCover) motion = 'drift';
        else if (active < T.cutActive && peak >= T.cutPeak) motion = 'cut';
        else motion = 'in-place';
        return Object.assign(out, { motion, axis: motion === 'lateral' ? (horiz ? 'x' : 'y') : undefined,
          dir: motion === 'lateral' ? (horiz ? (sum < 0 ? 'left' : 'right') : (sum < 0 ? 'up' : 'down')) : undefined,
          pxPerSec: motion === 'lateral' || motion === 'drift' ? Math.round(speed) : undefined,
          motionWhy: { tf: r2(tf), agree: r2(agree), cover: r2(cov), speed: Math.round(speed), peak: r2(peak) } });
      });
    }, { frames, boxes, fps, lag: Math.max(1, Math.round(fps)), gap: Math.max(1, Math.round(fps / 3)), kinds, T: MOTION_KIND });
  } finally { await p.close().catch(() => {}); }
}
// The settled-page media sample, one code path for capture.mjs (motion.load.media[].rateCont, the media
// strip) and inspect.mjs activity: a `ms` screencast of the page as it is (nothing scrolls, no input), then
// boxActivity on 12 fps picks over the first 1.25 s (`diff` only) and on MEDIA_FPS picks over the whole
// sample (rate, active, hot, motion). With framesDir the MEDIA_FPS picks are written there (f-00.jpg ...).
export const MEDIA_SAMPLE_MS = 4000, MEDIA_FPS = 6;
export async function sampleMedia(page, boxes, { framesDir = null, ms = MEDIA_SAMPLE_MS } = {}) {
  const none = { results: boxes.map(() => null), frames: null };
  if (!boxes.length) return none;
  const vp = page.viewportSize() || { width: 1440, height: 900 };
  const rec = await startScreencast(page, { width: vp.width, height: vp.height }).catch(() => null);
  if (!rec) return none;
  await new Promise((r) => setTimeout(r, ms + 100));
  const fr = await rec.stop();
  if (!fr.length) return none;
  const t0 = fr.reduce((m, f) => Math.min(m, f.ts), Infinity);
  const ctx = page.context();
  const fast = await boxActivity(ctx, pickFrames(fr, t0, { fps: 12, durationMs: 1250 }).map((f) => f.data), boxes, { fps: 12, kinds: false }).catch(() => []);
  const slow = await boxActivity(ctx, pickFrames(fr, t0, { fps: MEDIA_FPS, durationMs: ms }).map((f) => f.data), boxes, { fps: MEDIA_FPS }).catch(() => []);
  const results = boxes.map((_, i) => (slow[i] ? Object.assign({}, slow[i], { diff: fast[i] ? fast[i].diff : slow[i].diff }) : null));
  let frames = null;
  if (framesDir) { const w = writeFrames(fr, t0, framesDir, { fps: MEDIA_FPS, durationMs: ms }); frames = { n: w.n, fps: MEDIA_FPS, durationMs: ms, distinct: w.distinct }; }
  return { results, frames };
}
// Activity level from `rate` alone (share of the box that changes per second): static < 0.004 <= low < 0.04
// <= medium < 0.4 <= high. Older captures (no rate) used the per-frame diff: static < 0.003 <= low < 0.03 <=
// medium < 0.12 <= high.
export const RATE_LEVELS = { low: 0.004, medium: 0.04, high: 0.4 };
export const INTERMITTENT_ACTIVE = 0.5;
export const rateLevel = (r) => (r === null || r === undefined ? null : r < RATE_LEVELS.low ? 'static' : r < RATE_LEVELS.medium ? 'low' : r < RATE_LEVELS.high ? 'medium' : 'high');
export const activityLevel = (d) => (d === null || d === undefined ? null : d < 0.003 ? 'static' : d < 0.03 ? 'low' : d < 0.12 ? 'medium' : 'high');
// level of a boxActivity result: from `rate` alone (results without rate: from the per-frame diff)
export const boxLevel = (r) => (!r ? null : typeof r.rate === 'number' ? rateLevel(r.rate) : activityLevel(r.diff));
// load phase only: moving when the change is sustained (>= 30% of the consecutive frame pairs change), so an
// image arriving or swapping once while the page loads is not media motion
export const sustained = (r) => { const l = boxLevel(r); return !!l && l !== 'static' && (typeof r.active === 'number' ? r.active : 1) >= 0.3; };
// a moving box that changes in bursts (fewer than INTERMITTENT_ACTIVE of the consecutive frame pairs change):
// a card stack cycling, a cursor or avatar moving now and then inside a product mock-up
export const intermittentOf = (r) => { const l = boxLevel(r); return !!l && l !== 'static' && typeof r.active === 'number' && r.active < INTERMITTENT_ACTIVE; };

// One motion.load.media entry from a media box (page side: kind, desc, box, band/docY, continuous =
// sampleMedia result of the settled page, playing, pieces, keyframes), its boxActivity in the load frames
// (onLoad) and its arrival in the load strip (mediaArrival). One number: `rate` = the continuous (settled
// page) rate whenever the settled page was sampled: a box that only changes during the load (an image or
// art fading in, a poster swapped for the first frame) is static media after it, its load-phase change is
// its arrival (appearsMs / withLoad), never activity; the load-phase rate (sustained change) only when the
// settled page was not sampled. activity = rateLevel(rate), nothing else (pieces seen
// moving, `keyframes`, never raise it); intermittent = it changes in bursts (intermittentOf); motion = how it
// moves (boxActivity); appearsMs / withLoad = when the box first looks loaded in the load strip and whether
// that is after first paint (it arrives with the load staging) or at it (painted from frame 0).
export function mediaEntry(m, onLoad, bandAt = () => null, arrival = null) {
  const cont = m.continuous || null;
  const cL = boxLevel(cont), lL = onLoad ? (sustained(onLoad) ? boxLevel(onLoad) : 'static') : null;
  const contMoves = !!cL && cL !== 'static', loadMoves = !!lL && lL !== 'static';
  const num = (v) => (typeof v === 'number' ? v : null);
  const rL = num(onLoad && onLoad.rate), rC = num(cont && cont.rate);
  const src = cont ? cont : loadMoves ? onLoad : null;
  const rate = src ? num(src.rate) : rC;
  const activity = src ? boxLevel(src) : cL || (lL ? 'static' : null);
  const moving = !!activity && activity !== 'static';
  const when = moving ? (contMoves && loadMoves ? 'both' : contMoves ? 'continuous' : 'load') : null;
  const how = moving && src ? src : null;
  return { kind: m.kind, el: m.desc, box: m.box, band: m.band ?? bandAt(m.docY), activity, intermittent: (how && intermittentOf(how)) || undefined, rate, rateLoad: rL, rateCont: rC,
    motion: how ? how.motion || null : null, axis: how ? how.axis : undefined, dir: how ? how.dir : undefined, pxPerSec: how ? how.pxPerSec : undefined,
    appearsMs: arrival ? arrival.appearsMs : undefined, withLoad: arrival ? arrival.withLoad : undefined,
    diff: Math.max(onLoad ? onLoad.diff : 0, cont ? cont.diff : 0), moving, when, load: onLoad ? onLoad.diff : null, continuous: cont ? cont.diff : null,
    active: src ? src.active : Math.max(onLoad ? onLoad.active : 0, cont ? cont.active : 0), shifted: (onLoad && onLoad.shifted) || (cont && cont.shifted) || undefined,
    hot: (cont && cont.hot) || (onLoad && onLoad.hot) || null, playing: m.playing, pieces: m.pieces, keyframes: m.keyframes };
}
// The rate and level of a motion.load.media entry of any capture version (compare, sheets, digest), the
// same rule as mediaEntry: the continuous rate whenever it was measured (captures before round 7 stored
// `rate` = the higher of the load and continuous phases, so a rate is only compared like with like; a box
// that moved during the load only is static after it), the load-phase rate only for media whose settled
// page was not measured (`when: 'load'`, no rateCont); level = rateLevel(rate).
export function mediaRate(m) {
  if (!m) return { rate: null, level: null, phase: null };
  const num = (v) => (typeof v === 'number' ? v : null);
  const rC = num(m.rateCont), rL = num(m.rateLoad);
  let rate = num(m.rate), phase = null;
  if (rC !== null) { rate = rC; phase = 'continuous'; }
  else if (rL !== null && m.when === 'load') { rate = rL; phase = 'load'; }
  return { rate, level: rate !== null ? rateLevel(rate) : (m.activity || null), phase };
}
const MOTION_TXT = { 'in-place': 'in-place change (items change, turn or scale where they are)', lateral: 'lateral travel (content slides across the box)', cut: 'cuts or cross-fades (the picture swaps, then holds)', drift: 'whole-box drift (the whole picture pans or zooms slowly)' };
export const motionKindText = (k) => MOTION_TXT[k] || null;
// One wording for a media entry (digest, sheets): "medium activity (intermittent), 7.1% of its box changes per
// second; lateral travel (content slides across the box), left at ~40 px/s; appears with the load staging
// (~650 ms after first paint)".
export function mediaNote(m) {
  if (!m) return 'no media box';
  const { rate, level } = mediaRate(m);
  const parts = [`${level || 'unmeasured'} activity${m.intermittent ? ' (intermittent)' : ''}${typeof rate === 'number' ? `, ${Math.round(rate * 1000) / 10}% of its box changes per second` : ''}`];
  if (m.motion && MOTION_TXT[m.motion]) parts.push(`${MOTION_TXT[m.motion]}${m.dir ? `, ${m.dir}` : ''}${typeof m.pxPerSec === 'number' ? ` at ~${m.pxPerSec} px/s` : ''}`);
  if (typeof m.appearsMs === 'number') parts.push(m.withLoad ? `appears with the load staging (~${m.appearsMs} ms after first paint)` : 'painted from first paint (no load staging)');
  return parts.join('; ');
}

// When each media box first looks like its loaded self in a load strip (dir of f-NN.jpg at fps): per frame
// the mean luma distance (0-1) of a 16x10 grid of the box to the per-cell median of the strip's last second
// (robust to motion), d0 = frame 0's, dTail = the median over the last second. Frame 0 within
// max(0.035, 2 x dTail + 0.015) = painted from first paint (appearsMs 0, withLoad false); else appearsMs = the
// first frame (of two in a row) within dTail + 0.35 x (d0 - dTail), withLoad = appearsMs >= 120 ms (it
// arrives with the load staging). boxes: [[x, y, w, h]] frame px; null per box when not measurable.
export async function mediaArrival(ctx, dir, boxes, { fps = LOAD_FPS } = {}) {
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => /^f-\d+\.jpg$/.test(x)).sort() : [];
  if (files.length < 15 || !boxes.length) return boxes.map(() => null);
  const data = files.map((x) => fs.readFileSync(path.join(dir, x)).toString('base64'));
  const p = await ctx.newPage();
  try {
    const series = await p.evaluate(async ({ frames, boxes }) => {
      const GW = 16, GH = 10;
      const c = document.createElement('canvas'); c.width = GW; c.height = GH;
      const x = c.getContext('2d', { willReadFrequently: true });
      x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
      const imgs = [];
      for (const b64 of frames) { const img = new Image(); img.src = 'data:image/jpeg;base64,' + b64; await img.decode(); imgs.push(img); }
      const W = imgs[0].naturalWidth, H = imgs[0].naturalHeight;
      return boxes.map(([bx, by, bw, bh]) => {
        const sx = Math.max(0, Math.round(bx)), sy = Math.max(0, Math.round(by)), sw = Math.min(W - sx, Math.round(bw)), sh = Math.min(H - sy, Math.round(bh));
        if (sw < 8 || sh < 8) return null;
        const g = imgs.map((img) => { x.drawImage(img, sx, sy, sw, sh, 0, 0, GW, GH); const d = x.getImageData(0, 0, GW, GH).data; const o = new Float32Array(GW * GH); for (let j = 0; j < o.length; j++) o[j] = 0.299 * d[j * 4] + 0.587 * d[j * 4 + 1] + 0.114 * d[j * 4 + 2]; return o; });
        const tail = g.slice(-12), ref = new Float32Array(GW * GH);
        for (let j = 0; j < ref.length; j++) { const v = tail.map((t) => t[j]).sort((a, b) => a - b); ref[j] = v[v.length >> 1]; }
        return g.map((t) => { let e = 0; for (let j = 0; j < t.length; j++) e += Math.abs(t[j] - ref[j]); return Math.round((e / t.length / 255) * 1000) / 1000; });
      });
    }, { frames: data, boxes });
    return series.map((d) => {
      if (!d) return null;
      const tail = d.slice(-12).slice().sort((a, b) => a - b), dTail = tail[tail.length >> 1], d0 = d[0];
      if (d0 <= Math.max(0.035, 2 * dTail + 0.015)) return { appearsMs: 0, withLoad: false, d0, dTail };
      const thr = dTail + 0.35 * (d0 - dTail);
      let k = -1;
      for (let i = 1; i < d.length; i++) if (d[i] <= thr && (i + 1 >= d.length || d[i + 1] <= thr)) { k = i; break; }
      const appearsMs = k < 0 ? null : Math.round((k * 1000) / fps);
      return { appearsMs, withLoad: appearsMs === null || appearsMs >= 120, d0, dTail };
    });
  } finally { await p.close().catch(() => {}); }
}

// How the first screen builds up in the load frames (what the eye sees, whatever drives it): per frame
// the share of pixels that differ from the settled page's background (content area) and from the
// previous frame. A build-up step = a frame where the content area grows by >= 15% of its final size
// (and >= 0.5% of the viewport). staged = >= 2 steps spread over >= 150 ms; live = still changing in
// the last 3 frames (continuous motion, not a load sequence). JPEG frames are decoded in a blank page.
// masks: [[x, y, w, h]] in frame px (hero media that moves by itself): left out, so a playing video or
// a changing canvas never reads as a staged build-up (its motion is reported as hero media instead).
export async function visualLoad(ctx, dir, masks = []) {
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => /^f-\d+\.jpg$/.test(x)).sort() : [];
  if (files.length < 3) return null;
  const data = files.map((x) => fs.readFileSync(path.join(dir, x)).toString('base64'));
  const p = await ctx.newPage();
  try {
    const r = await p.evaluate(async ({ frames, masks, fps }) => {
      const W = 160, H = 100;
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const x = c.getContext('2d', { willReadFrequently: true });
      const px = [];
      let fw = 0, fh = 0;
      for (const b64 of frames) { const img = new Image(); img.src = 'data:image/jpeg;base64,' + b64; await img.decode(); fw = img.naturalWidth; fh = img.naturalHeight; x.drawImage(img, 0, 0, W, H); px.push(x.getImageData(0, 0, W, H).data); }
      const keep = new Uint8Array(W * H).fill(1);
      for (const [mx, my, mw, mh] of masks || []) {
        const x0 = Math.floor(mx / fw * W), y0 = Math.floor(my / fh * H), x1 = Math.ceil((mx + mw) / fw * W), y1 = Math.ceil((my + mh) / fh * H);
        for (let yy = Math.max(0, y0); yy < Math.min(H, y1); yy++) for (let xx = Math.max(0, x0); xx < Math.min(W, x1); xx++) keep[yy * W + xx] = 0;
      }
      const N = Math.max(1, keep.reduce((s, v) => s + v, 0));
      const last = px[px.length - 1], bins = new Map();
      for (let i = 0, j = 0; i < last.length; i += 4, j++) { if (!keep[j]) continue; const k = ((last[i] >> 3) << 10) | ((last[i + 1] >> 3) << 5) | (last[i + 2] >> 3); bins.set(k, (bins.get(k) || 0) + 1); }
      let bk = 0, bn = -1; for (const [k, n] of bins) if (n > bn) { bn = n; bk = k; }
      const br = ((bk >> 10) & 31) * 8 + 4, bgc = ((bk >> 5) & 31) * 8 + 4, bb = (bk & 31) * 8 + 4;
      const fg = px.map((d) => { let n = 0; for (let i = 0, j = 0; i < d.length; i += 4, j++) if (keep[j] && Math.abs(d[i] - br) + Math.abs(d[i + 1] - bgc) + Math.abs(d[i + 2] - bb) > 36) n++; return n / N; });
      const diff = px.map((d, k) => { if (!k) return 0; const q = px[k - 1]; let n = 0; for (let i = 0, j = 0; i < d.length; i += 4, j++) if (keep[j] && Math.abs(d[i] - q[i]) + Math.abs(d[i + 1] - q[i + 1]) + Math.abs(d[i + 2] - q[i + 2]) > 36) n++; return n / N; });
      // change over 3 frames (250 ms): a slow low-contrast fade changes too little between two frames to
      // count, but not over 250 ms
      const L = 3;
      // continuous motion outside the masks (a marquee, a cycling logo row, a loop): 5x5 px blocks that change
      // in the last second of the strip AND already changed 2.5-1.5 s before the end, i.e. motion that repeats
      // rather than a load step that is still running; left out of the settle time
      const S = 5, BX = W / S, BY = H / S, F = Math.round(fps);
      const blockChanged = (a, b) => { const out = new Uint8Array(BX * BY); for (let yy = 0; yy < H; yy++) for (let xx = 0; xx < W; xx++) { const j = yy * W + xx; if (!keep[j]) continue; const i = j * 4; if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 36) out[Math.floor(yy / S) * BX + Math.floor(xx / S)] = 1; } return out; };
      const cont = new Uint8Array(W * H);
      let contN = 0;
      if (px.length > 3 * F) {
        const n = px.length, tail = new Uint8Array(BX * BY), early = new Uint8Array(BX * BY);
        for (let k = n - F; k < n; k++) { const c = blockChanged(px[k - 1], px[k]); for (let q = 0; q < c.length; q++) if (c[q]) tail[q] = 1; }
        for (let k = Math.max(1, n - 2.5 * F); k < n - 1.5 * F; k++) { const c = blockChanged(px[k - 1], px[k]); for (let q = 0; q < c.length; q++) if (c[q]) early[q] = 1; }
        for (let j = 0; j < W * H; j++) { const q = Math.floor(Math.floor(j / W) / S) * BX + Math.floor((j % W) / S); if (keep[j] && tail[q] && early[q]) { cont[j] = 1; contN++; } }
      }
      const lag = px.slice(0, Math.max(0, px.length - L)).map((d, k) => { const q = px[k + L]; let n = 0; for (let i = 0, j = 0; i < d.length; i += 4, j++) if (keep[j] && !cont[j] && Math.abs(d[i] - q[i]) + Math.abs(d[i + 1] - q[i + 1]) + Math.abs(d[i + 2] - q[i + 2]) > 36) n++; return n / N; });
      return { fg, diff, lag, L, masked: Math.round((1 - N / (W * H)) * 100) / 100, contShare: Math.round((contN / N) * 1000) / 1000 };
    }, { frames: data, masks, fps: LOAD_FPS });
    const v = visualFromSeries(r.fg, r.diff, 1000 / LOAD_FPS);
    // last visible change (moving hero media and continuous motion masked): the last 250 ms window whose
    // content changed on >= 0.4% of the unmasked frame ends there; null = nothing changed after the first frame
    let lc = -1;
    r.lag.forEach((d, k) => { if (d > 0.004) lc = k; });
    v.lastChangeMs = lc >= 0 ? Math.round((lc + r.L) * 1000 / LOAD_FPS) : null;
    // share of the unmasked first screen that keeps moving to the end (continuous motion outside the media)
    if (r.contShare) v.contShare = r.contShare;
    v.windowMs = Math.round((files.length - 1) * 1000 / LOAD_FPS);
    if (r.masked) v.masked = r.masked;
    // when moving media covers most of the first screen, the rest is too little to read a staged build-up
    // from (load animations of text over the media are still seen by the DOM load sampler)
    if (r.masked >= 0.5) v.staged = false;
    return v;
  } finally { await p.close().catch(() => {}); }
}
export function visualFromSeries(fg, diff, ms) {
  const fin = Math.max(...fg.slice(-3));
  const first = fg.findIndex((v) => v > Math.max(0.005, fin * 0.1));
  const steps = [];
  let shrink = 0;
  for (let k = 1; k < fg.length; k++) {
    if (fg[k] - fg[k - 1] >= Math.max(0.005, fin * 0.15)) steps.push(k);
    // content that disappears again (a toast, a carousel, a video cut) is not a build-up
    if (fg[k - 1] - fg[k] >= Math.max(0.005, fin * 0.15)) shrink++;
  }
  const lastGrow = steps.length ? steps[steps.length - 1] : (first >= 0 ? first : 0);
  const live = diff.slice(-3).every((v) => v > 0.005);
  const firstContentMs = first >= 0 ? Math.round(first * ms) : null;
  const span = steps.length ? (steps[steps.length - 1] - steps[0]) * ms : 0;
  return { firstContentMs, growSteps: steps.length, shrinkSteps: shrink, lastGrowMs: Math.round(lastGrow * ms), staged: steps.length >= 2 && span >= 150 && shrink === 0, live,
    fg: fg.map((v) => Math.round(v * 1000) / 1000), diff: diff.map((v) => Math.round(v * 1000) / 1000) };
}

// When the first screen stopped changing, in ms after the strip start (first contentful paint): the later
// of the last visible change in the frames (visual.lastChangeMs, moving hero media masked) and the end of
// the load animations the DOM sampler saw (domEndMs). Frames still changing in the last 500 ms of the
// window = continuous motion (ambient, a carousel): then the load animations' end is used when there are
// any, else the load never settled inside the window (settleMs null). settled = settleMs <= cap.
// Motion that keeps going after the content settled is the same on any page: `keepsMoving` = { media:
// [{el, kind, activity, rate}] (moving first-screen media, masked out of the frames above), other: share of
// the rest of the first screen that keeps changing to the end (marquee, cycling row, loop; visual.contShare) }
// or null when nothing keeps moving.
export function loadSettle(visual, domEndMs, windowMs, capMs = LOAD_SETTLE_CAP_MS, media = []) {
  const mv = (media || []).filter((m) => m && m.moving).map((m) => ({ el: m.el, kind: m.kind, activity: m.activity, rate: m.rate ?? null, intermittent: m.intermittent || undefined, motion: m.motion || undefined }));
  const other = visual && visual.contShare ? visual.contShare : 0;
  const keepsMoving = mv.length || other ? { media: mv, other } : null;
  if (!visual) return { settleMs: domEndMs ?? null, settleHow: domEndMs != null ? 'load animations' : null, settled: domEndMs != null && domEndMs <= capMs, keepsMoving };
  const vis = visual.lastChangeMs ?? 0;
  const moving = visual.lastChangeMs != null && visual.lastChangeMs >= windowMs - 500;
  const dom = typeof domEndMs === 'number' && domEndMs > 0 ? Math.round(domEndMs) : null;
  if (!moving) {
    const settleMs = Math.max(vis, dom ?? 0);
    return { settleMs, settleHow: dom !== null && dom > vis ? 'load animations' : 'frames', settled: settleMs <= capMs, keepsMoving };
  }
  if (dom !== null) return { settleMs: dom, settleHow: 'load animations; the frames keep changing after (continuous motion)', settled: dom <= capMs, keepsMoving };
  return { settleMs: null, settleHow: 'still changing at the end of the window (continuous motion)', settled: false, keepsMoving };
}
// One line for a load strip's settle state, the same wording on any page (sheets, digest):
// "content settled ~X ms after first paint; media keeps moving (canvas, medium activity, 7% of its box per
// second); other motion keeps moving (3% of the first screen)".
export function settleNote(L) {
  if (!L) return 'no load strip';
  const parts = [];
  if (typeof L.settleMs === 'number') parts.push(`content settled ~${L.settleMs} ms after first paint${L.settled === false ? ' (later than the 4 s cap)' : ''}`);
  else if (L.settled === false) parts.push('content still changing at the end of the recording');
  else parts.push('settle time not recorded (older capture)');
  const k = L.keepsMoving;
  if (k && k.media && k.media.length) parts.push(`media keeps moving (${k.media.map((m) => `${m.kind || 'media'}, ${m.activity || 'moving'} activity${m.intermittent ? ' (intermittent)' : ''}${typeof m.rate === 'number' ? `, ${Math.round(m.rate * 1000) / 10}% of its box per second` : ''}${m.motion ? `, ${m.motion}` : ''}`).join('; ')})`);
  if (k && k.other) parts.push(`other motion keeps moving (${Math.round(k.other * 1000) / 10}% of the rest of the first screen)`);
  if (!k && typeof L.settleMs === 'number' && /continuous/.test(L.settleHow || '')) parts.push('continuous motion after it');
  return parts.join('; ');
}

// Lead-in of a load strip: frames after first contentful paint in which a large part of the first screen
// does not look like it does once loaded (blank page, a placeholder, media not painted yet). Per frame the
// mean colour distance (0-1) of 32x20 blocks to the per-block median of the last second of the strip (the
// loaded look, robust to video motion), over the whole frame and split inside / outside `boxes` (hero
// media, frame px). paintedMs = the first frame (of two in a row) within 35% of frame 0's distance, i.e.
// where the first screen is painted; null when frame 0 already looks loaded (distance < 0.12) or the
// strip never gets there. inShare = share of the lead-in's distance that lies inside the boxes.
export async function leadInSeries(ctx, dir, boxes = []) {
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => /^f-\d+\.jpg$/.test(x)).sort() : [];
  if (files.length < 15) return null;
  const data = files.map((x) => fs.readFileSync(path.join(dir, x)).toString('base64'));
  const p = await ctx.newPage();
  try {
    return await p.evaluate(async ({ frames, boxes }) => {
      const W = 160, H = 100, BX = 32, BY = 20, S = 5;
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const x = c.getContext('2d', { willReadFrequently: true });
      let fw = 1, fh = 1;
      const blocks = [];
      for (const b64 of frames) {
        const img = new Image(); img.src = 'data:image/jpeg;base64,' + b64; await img.decode();
        fw = img.naturalWidth; fh = img.naturalHeight; x.drawImage(img, 0, 0, W, H);
        const d = x.getImageData(0, 0, W, H).data, b = new Float32Array(BX * BY * 3);
        for (let yy = 0; yy < H; yy++) for (let xx = 0; xx < W; xx++) { const i = (yy * W + xx) * 4, k = (Math.floor(yy / S) * BX + Math.floor(xx / S)) * 3; b[k] += d[i]; b[k + 1] += d[i + 1]; b[k + 2] += d[i + 2]; }
        for (let k = 0; k < b.length; k++) b[k] /= S * S;
        blocks.push(b);
      }
      const tail = blocks.slice(-12), ref = new Float32Array(BX * BY * 3);
      for (let k = 0; k < ref.length; k++) { const v = tail.map((t) => t[k]).sort((a, b) => a - b); ref[k] = v[Math.floor(v.length / 2)]; }
      const inBox = new Uint8Array(BX * BY);
      for (let by = 0; by < BY; by++) for (let bx = 0; bx < BX; bx++) {
        const cx = (bx + 0.5) / BX * fw, cy = (by + 0.5) / BY * fh;
        if ((boxes || []).some(([x0, y0, w, h]) => cx >= x0 && cx < x0 + w && cy >= y0 && cy < y0 + h)) inBox[by * BX + bx] = 1;
      }
      const nIn = inBox.reduce((s, v) => s + v, 0), nOut = BX * BY - nIn;
      const D = [], Din = [], Dout = [];
      for (const b of blocks) {
        let a = 0, ai = 0, ao = 0;
        for (let q = 0; q < BX * BY; q++) { const k = q * 3; const v = (Math.abs(b[k] - ref[k]) + Math.abs(b[k + 1] - ref[k + 1]) + Math.abs(b[k + 2] - ref[k + 2])) / 765; a += v; if (inBox[q]) ai += v; else ao += v; }
        D.push(a / (BX * BY)); Din.push(nIn ? ai / nIn : 0); Dout.push(nOut ? ao / nOut : 0);
      }
      const r3 = (v) => Math.round(v * 1000) / 1000;
      return { D: D.map(r3), Din: Din.map(r3), Dout: Dout.map(r3), inArea: r3(nIn / (BX * BY)) };
    }, { frames: data, boxes });
  } finally { await p.close().catch(() => {}); }
}
export function leadInOf(series, ms = 1000 / LOAD_FPS) {
  if (!series || !series.D || series.D.length < 3) return null;
  const { D, Din, Dout, inArea } = series;
  const d0 = D[0];
  if (d0 < 0.12) return null;
  const thr = d0 * 0.35;
  let p = null;
  for (let k = 1; k < D.length; k++) if (D[k] <= thr && (k + 1 >= D.length || D[k + 1] <= thr)) { p = k; break; }
  const end = p ?? D.length;
  let mi = 0, mo = 0;
  for (let k = 0; k < end; k++) { mi += Din[k] * inArea; mo += Dout[k] * (1 - inArea); }
  const paintedMs = p === null ? null : Math.round(p * ms);
  if (paintedMs !== null && paintedMs < 250) return null;
  return { paintedMs, d0, inShare: mi + mo > 0 ? Math.round((mi / (mi + mo)) * 100) / 100 : 0 };
}

// ---------- reveal strip: when the content in view is in place ----------
// Reveal strips start at the wheel input. The scroll moves nearly every pixel until it stops; after that,
// anything that still changes (outside regions that keep moving to the end: media, loops) is a reveal or
// another entrance playing in view. stripGrids decodes the JPEG frames in a blank page into luma grids
// (STRIP_W x STRIP_H, area-averaged); stripContent (pure, testable) reads them.
export const STRIP_W = 120, STRIP_H = 75;
export async function stripGrids(ctx, dir) {
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => /^f-\d+\.jpg$/.test(x)).sort() : [];
  if (files.length < 4) return null;
  const data = files.map((x) => fs.readFileSync(path.join(dir, x)).toString('base64'));
  const p = await ctx.newPage();
  try {
    return await p.evaluate(async ({ frames, W, H }) => {
      const S = 3, c = document.createElement('canvas'); c.width = W * S; c.height = H * S;
      const x = c.getContext('2d', { willReadFrequently: true });
      x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
      const out = [];
      for (const b64 of frames) {
        const img = new Image(); img.src = 'data:image/jpeg;base64,' + b64; await img.decode();
        x.drawImage(img, 0, 0, W * S, H * S);
        const d = x.getImageData(0, 0, W * S, H * S).data, g = new Array(W * H).fill(0);
        for (let yy = 0; yy < H * S; yy++) for (let xx = 0; xx < W * S; xx++) { const i = (yy * W * S + xx) * 4; g[Math.floor(yy / S) * W + Math.floor(xx / S)] += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; }
        out.push(g.map((v) => Math.round(v / (S * S))));
      }
      return out;
    }, { frames: data, W: STRIP_W, H: STRIP_H });
  } finally { await p.close().catch(() => {}); }
}
// grids: per frame a luma array (row-major, W wide); scrollSettleMs: when the page's scroll position stopped
// (motion.frames.reveals[].scroll.settleMs), else estimated from the frames (the first frame after which no
// frame-to-frame change covers >= 25% of the view). Cells that change between consecutive frames in >= 2 of
// the last 4 frame pairs keep moving to the end (media, loops): left out. Returns
//   settledMs  first frame time after which every frame matches the last one (< 0.4% of the kept cells
//              differ by > 14 luma levels): fully still
//   visibleMs  first frame time after which every frame is within 1.5% of the kept cells of the last one:
//              the content in view is visibly in place (small slow changes, a counter, a chart, are ignored)
//   scrollMs   the first frame time at or after the scroll stopped
//   lagMs      visibleMs - scrollMs (>= 0): how long content in view kept visibly changing after the scroll
//              stopped
//   changed    largest share of the kept cells still differing from the last frame after the scroll stopped
//   inPlace    lagMs <= one frame: the content in view arrived in its final state (nothing visibly animates
//              in this strip)
export function stripContent(grids, { fps = 12, scrollSettleMs = null, W = STRIP_W, thr = 14, cellsMin = 0.004, visibleMin = 0.015 } = {}) {
  if (!Array.isArray(grids) || grids.length < 4) return null;
  const n = grids.length, N = grids[0].length, H = Math.round(N / W), fm = 1000 / fps, last = grids[n - 1];
  const moving = new Uint8Array(N), hits = new Uint8Array(N);
  for (let k = Math.max(1, n - 4); k < n; k++) for (let j = 0; j < N; j++) if (Math.abs(grids[k][j] - grids[k - 1][j]) > thr) hits[j]++;
  for (let j = 0; j < N; j++) if (hits[j] >= 2) { const y = Math.floor(j / W), x = j % W; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const yy = y + dy, xx = x + dx; if (yy >= 0 && yy < H && xx >= 0 && xx < W) moving[yy * W + xx] = 1; } }
  let kept = 0; for (let j = 0; j < N; j++) if (!moving[j]) kept++;
  if (kept < N * 0.2) return { settledMs: null, visibleMs: null, scrollMs: null, lagMs: null, changed: null, inPlace: null, movingShare: Math.round((1 - kept / N) * 100) / 100 };
  const share = (a, b) => { let c = 0; for (let j = 0; j < N; j++) if (!moving[j] && Math.abs(a[j] - b[j]) > thr) c++; return c / kept; };
  const vsLast = grids.map((g) => share(g, last));
  let si = n - 1; while (si > 0 && vsLast[si - 1] < cellsMin) si--;
  let vi = n - 1; while (vi > 0 && vsLast[vi - 1] < visibleMin) vi--;
  let scrollIdx;
  if (typeof scrollSettleMs === 'number' && scrollSettleMs >= 0) scrollIdx = Math.min(n - 1, Math.ceil(scrollSettleMs / fm - 0.05));
  else { scrollIdx = 0; for (let k = 1; k < n; k++) if (share(grids[k], grids[k - 1]) >= 0.25) scrollIdx = k; }
  const changed = Math.max(0, ...vsLast.slice(scrollIdx));
  const lagMs = Math.max(0, Math.round((vi - scrollIdx) * fm));
  return { settledMs: Math.round(si * fm), visibleMs: Math.round(vi * fm), scrollMs: Math.round(scrollIdx * fm), lagMs, changed: Math.round(changed * 1000) / 1000,
    inPlace: lagMs <= fm + 1, movingShare: Math.round((1 - kept / N) * 100) / 100 || undefined };
}

// ---------- appearance: one step vs a fade / slide ----------
// How content arrives in a strip (luma grids from stripGrids), whatever drives it: `step` = it goes from
// absent to (nearly) complete within one or two frames (<= 167 ms at 12 fps: network or lazy arrival, an
// instant class switch; build it with no transition), `fade` = it eases in over more frames, `slide` = a
// fade during which the arriving content also moves (its luma-mass centroid half-way is >= APPEAR_SLIDE_PX
// from where it ends), `none` = nothing arrives.
export const APPEAR_STEP_FRAMES = 2, APPEAR_MIN_DROP = 1.5, APPEAR_STEP_SHARE = 0.7, APPEAR_SLIDE_PX = 6;
// d[k] = mean luma distance (0-255) of a region to its final look in frame k; fm = ms per frame. Progress
// p = how far the region has come from its most distant frame (the peak) to its end level. The rise is cut
// into runs of rising frames (gaps of one still frame merged: a dropped screencast frame); a run whose best
// two consecutive frame steps carry >= 80% of it is step-like (the rest is a tail). kind = step when
// step-like runs carry >= 70% of the total rise (`steps` = how many, a staged arrival in separate jumps),
// else fade: `ms` = 5% -> 95% of its largest eased run (the visible duration; an ease-out's long tail is not
// seen), `open` = still rising at the end of the strip. `atMs` = the first frame of the largest run (step:
// the frame it appears in). kMid / k0 = frame indices for the slide test (removed by the callers).
export function appearOf(d, fm, { minDrop = APPEAR_MIN_DROP } = {}) {
  if (!Array.isArray(d) || d.length < 3 || !d.every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  const n = d.length, r1 = (v) => Math.round(v * 10) / 10;
  let km = 0;
  for (let k = 1; k < n; k++) if (d[k] > d[km] + 1e-9) km = k;
  const end = Math.min(d[n - 1], d[n - 2]);
  const drop = d[km] - end;
  if (!(drop >= minDrop)) return { kind: 'none', drop: r1(Math.max(0, drop)) };
  const p = d.map((v) => (d[km] - v) / drop);
  const eps = Math.max(0.02, 0.4 / drop);
  const runs = [];
  let cur = null;
  for (let k = km + 1; k < n; k++) {
    const dp = p[k] - p[k - 1];
    if (dp > eps) {
      if (cur && k - cur.end <= 2) cur.end = k; else { cur = { start: k, end: k }; runs.push(cur); }
    }
  }
  if (!runs.length) return { kind: 'none', drop: r1(drop) };
  let total = 0, stepAmt = 0;
  for (const R of runs) {
    R.amt = p[R.end] - p[R.start - 1];
    let best = 0, bk = R.start;
    for (let k = R.start; k <= R.end; k++) { const w = p[Math.min(R.end, k + 1)] - p[k - 1]; if (w > best) { best = w; bk = k; } }
    R.best = best; R.bk = bk;
    R.stepLike = R.end - R.start <= 1 || best >= 0.8 * R.amt;
    total += Math.max(0, R.amt);
    if (R.stepLike) stepAmt += Math.max(0, best);
  }
  const big = runs.slice().sort((a, b) => b.amt - a.amt)[0];
  if (total > 0 && stepAmt >= APPEAR_STEP_SHARE * total) {
    const S = runs.filter((R) => R.stepLike && R.amt >= 0.1);
    const main = S.slice().sort((a, b) => b.best - a.best)[0] || big;
    const frames = main.end - main.start <= 1 ? main.end - main.start + 1 : 2;
    return { kind: 'step', atMs: Math.round(main.bk * fm), ms: Math.round(frames * fm), steps: Math.max(1, S.length), drop: r1(drop) };
  }
  const E = runs.filter((R) => !R.stepLike).sort((a, b) => b.amt - a.amt)[0] || big;
  const base = p[E.start - 1], at = (q) => { for (let k = E.start; k <= E.end; k++) if (p[k] - base >= q * E.amt) return k; return E.end; };
  const ks = Math.max(E.start - 1, at(0.05) - 1), ke = at(0.95);
  const open = E.end >= n - 2 && p[n - 1] - p[n - 2] > eps;
  return { kind: 'fade', atMs: Math.round(E.start * fm), ms: Math.round(Math.max(1, ke - ks) * fm), open: open || undefined, drop: r1(drop), k0: E.start - 1, kMid: at(0.35) };
}
// Does the arriving content move while it fades in? Row and column profiles of what has arrived (cells
// differing from frame k0 by > 4 levels, weighted by the difference, normalised to unit sum: opacity drops
// out) in frame kMid vs the last frame; the integer cell shift that best aligns them must cut the profile
// difference to <= 75% of the unshifted one (a staggered arrival changes the profile's shape, not its
// position, and stays unshifted). px, or null when too little arrives.
function slideOf(grids, cells, W, k0, kMid, cellW, cellH) {
  const H = Math.round(grids[0].length / W), b = grids[k0];
  const prof = (g) => { const ry = new Float64Array(H), rx = new Float64Array(W); let s = 0; for (const j of cells) { const m = Math.abs(g[j] - b[j]); if (m <= 4) continue; s += m; ry[Math.floor(j / W)] += m; rx[j % W] += m; } if (s <= 20) return null; for (let i = 0; i < H; i++) ry[i] /= s; for (let i = 0; i < W; i++) rx[i] /= s; return { ry, rx }; };
  const a = prof(grids[kMid]), z = prof(grids[grids.length - 1]);
  if (!a || !z) return null;
  const best = (p, q, len) => {
    const err = (sh) => { let e = 0; for (let i = 0; i < len; i++) { const v = i + sh >= 0 && i + sh < len ? p[i + sh] : 0; e += Math.abs(v - q[i]); } return e; };
    const e0 = err(0); let bs = 0, be = e0;
    for (let sh = -8; sh <= 8; sh++) { const e = err(sh); if (e < be - 1e-9) { be = e; bs = sh; } }
    return bs && be <= 0.75 * e0 ? bs : 0;
  };
  return { dx: Math.round(best(a.rx, z.rx, W) * cellW), dy: Math.round(best(a.ry, z.ry, H) * cellH) };
}
function finishAppear(a, grids, cells, W, cellW, cellH, off, fm, slideCells = cells) {
  if (!a) return null;
  if (a.kind === 'fade' && typeof a.kMid === 'number' && a.kMid > a.k0) {
    const s = slideOf(grids, slideCells, W, a.k0 + off, a.kMid + off, cellW, cellH);
    if (s && Math.hypot(s.dx, s.dy) >= APPEAR_SLIDE_PX) Object.assign(a, { kind: 'slide' }, Math.abs(s.dy) >= APPEAR_SLIDE_PX / 2 ? { y: s.dy } : {}, Math.abs(s.dx) >= APPEAR_SLIDE_PX / 2 ? { x: s.dx } : {});
  }
  delete a.k0; delete a.kMid;
  if (off && typeof a.atMs === 'number') a.atMs += Math.round(off * fm);
  return a;
}
const meanDist = (g, ref, cells) => { let s = 0; for (const j of cells) s += Math.abs(g[j] - ref[j]); return cells.length ? s / cells.length : 0; };
// What has arrived by frame k: mean luma distance from the frame before anything arrives (`base`), so
// opaque content that appears and then settles a few px is complete when it appears, while a fade grows
// with its opacity. Returned as "still to arrive" (plateau = median of the last `tailN` frames, minus it),
// the distance-to-final series appearOf reads.
const toArrive = (grids, from, base, cells, tailN) => {
  const e = [];
  for (let k = from; k < grids.length; k++) e.push(meanDist(grids[k], base, cells));
  const t = e.slice(-tailN).sort((a, b) => a - b), P = t[t.length >> 1];
  return e.map((v) => P - v);
};

// Reveal strip (frames from the wheel input): how the content in view arrives after the scroll stopped
// (scroll index as stripContent; cells that keep moving to the end left out), measured from the frame at
// the scroll stop; `none` also when the last frame differs visibly (> 14 levels) from that frame on < 1.5%
// of the kept cells. atMs = ms after the wheel input. `y`/`x` (slide) = how far the content still was from
// its rest position half-way through (px; negative y = it comes down from above).
export function stripAppear(grids, { fps = 12, scrollSettleMs = null, W = STRIP_W, frameW = 1440, frameH = 900, thr = 14 } = {}) {
  if (!Array.isArray(grids) || grids.length < 4) return null;
  const n = grids.length, N = grids[0].length, H = Math.round(N / W), fm = 1000 / fps, last = grids[n - 1];
  const moving = new Uint8Array(N), hits = new Uint8Array(N);
  for (let k = Math.max(1, n - 4); k < n; k++) for (let j = 0; j < N; j++) if (Math.abs(grids[k][j] - grids[k - 1][j]) > thr) hits[j]++;
  for (let j = 0; j < N; j++) if (hits[j] >= 2) { const y = Math.floor(j / W), x = j % W; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const yy = y + dy, xx = x + dx; if (yy >= 0 && yy < H && xx >= 0 && xx < W) moving[yy * W + xx] = 1; } }
  const cells = [];
  for (let j = 0; j < N; j++) if (!moving[j]) cells.push(j);
  if (cells.length < N * 0.2) return null;
  let s;
  if (typeof scrollSettleMs === 'number' && scrollSettleMs >= 0) s = Math.min(n - 1, Math.ceil(scrollSettleMs / fm - 0.05));
  else { s = 0; for (let k = 1; k < n; k++) { let c = 0; for (const j of cells) if (Math.abs(grids[k][j] - grids[k - 1][j]) > thr) c++; if (c / cells.length >= 0.25) s = k; } }
  if (n - s < 3) return { kind: 'none', drop: 0 };
  const a = appearOf(toArrive(grids, s, grids[s], cells, 3), fm);
  if (!a) return null;
  if (a.kind !== 'none') {
    let vis = 0; for (const j of cells) if (Math.abs(grids[s][j] - last[j]) > thr) vis++;
    if (vis / cells.length < 0.015) return { kind: 'none', drop: a.drop };
  }
  return finishAppear(a, grids, cells, W, frameW / W, frameH / H, s, fm);
}

// Load strip (frames from first contentful paint): how the first screen and each box (load groups'
// final rects, [x, y, w, h] in frame px) arrive, measured from frame 0 (what first paint showed) to the
// last 12 frames; left out: `masks` (moving hero media boxes) and cells that change in the last second AND
// 2.5-1.5 s before the end (repeating motion: a cycling card stack, a marquee). A box with < 6 kept cells
// (or < 30% of its cells) is null. atMs = ms after first paint.
export function loadAppear(grids, { fps = LOAD_FPS, W = STRIP_W, frameW = 1440, frameH = 900, boxes = [], masks = [], thr = 14 } = {}) {
  if (!Array.isArray(grids) || grids.length < 6) return null;
  const n = grids.length, N = grids[0].length, H = Math.round(N / W), fm = 1000 / fps, F = Math.round(fps);
  const cw = frameW / W, ch = frameH / H;
  const skip = new Uint8Array(N);
  if (n > 3 * F) {
    const late = new Uint8Array(N), early = new Uint8Array(N);
    for (let k = n - F; k < n; k++) for (let j = 0; j < N; j++) if (Math.abs(grids[k][j] - grids[k - 1][j]) > thr) late[j] = 1;
    for (let k = Math.max(1, n - Math.round(2.5 * F)); k < n - Math.round(1.5 * F); k++) for (let j = 0; j < N; j++) if (Math.abs(grids[k][j] - grids[k - 1][j]) > thr) early[j] = 1;
    for (let j = 0; j < N; j++) if (late[j] && early[j]) { const y = Math.floor(j / W), x = j % W; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const yy = y + dy, xx = x + dx; if (yy >= 0 && yy < H && xx >= 0 && xx < W) skip[yy * W + xx] = 1; } }
  }
  const inBox = (j, b) => { const cx = ((j % W) + 0.5) * cw, cy = (Math.floor(j / W) + 0.5) * ch; return cx >= b[0] && cx < b[0] + b[2] && cy >= b[1] && cy < b[1] + b[3]; };
  for (let j = 0; j < N; j++) if (!skip[j] && (masks || []).some((b) => Array.isArray(b) && inBox(j, b))) skip[j] = 1;
  const measure = (cells, slideCells) => finishAppear(appearOf(toArrive(grids, 0, grids[0], cells, 12), fm), grids, cells, W, cw, ch, 0, fm, slideCells || cells);
  const all = [];
  for (let j = 0; j < N; j++) if (!skip[j]) all.push(j);
  const screen = all.length >= N * 0.2 ? measure(all) : null;
  const per = (boxes || []).map((b) => {
    if (!Array.isArray(b) || b.length < 4 || !(b[2] > 0 && b[3] > 0)) return null;
    let tot = 0; const cells = [];
    for (let j = 0; j < N; j++) if (inBox(j, b)) { tot++; if (!skip[j]) cells.push(j); }
    // the slide test reads the box with a 60 px margin: content still on its way sits partly outside it
    const m = 60, bm = [b[0] - m, b[1] - m, b[2] + 2 * m, b[3] + 2 * m], wide = [];
    for (let j = 0; j < N; j++) if (!skip[j] && inBox(j, bm)) wide.push(j);
    return cells.length >= 6 && cells.length >= tot * 0.3 ? measure(cells, wide) : null;
  });
  return { screen, boxes: per, masked: Math.round((1 - all.length / N) * 100) / 100 };
}
// The first screen's load entrance as the load strip shows it, for any capture version: the one decision
// compare (cmp-motion loadState) and the digest (summary.mjs) both read. Per sampled load group
// (motion.load.groups), left out: repeating (its element is an auto-advance element of the same capture),
// tiny (area x n < tinyShare of the viewport), a media box's entrance (kind 'media') that the strip shows
// painted from first paint (its motion.load.media entry has withLoad false: the fade is not visible), and a
// box in which the strip shows nothing arriving (appear 'none'). Timing: where the strip measured the group
// (`appear`) the strip wins: start = appear.atMs after first paint, duration = appear.ms, from-state none for
// a step (no transition), opacity 0 for a fade, opacity 0 + the half-way offset for a slide; a media entrance
// ends when its box first looks loaded (media appearsMs); else the sampled t0 - first paint, ms (+ stagger)
// and from-state. A media box drawn in place (canvas, svg, illustration, mock-up, Lottie) that the strip shows
// arriving with the load (withLoad) is the box's entrance even with no sampled element animation (content
// drawn in; unless a kept group holds >= 80% of the box: a wrapper entering with it); network media (image,
// video, iframe, background image) arriving late is network timing unless a load animation carried it.
// designed = some kept group eases in (fade / slide, or a sampled from-state the
// strip did not measure) or the kept groups arrive at >= 2 moments >= stepGapMs apart; a first screen whose
// kept groups all appear in one step at one moment (skeleton placeholders swapped for content, a page shown
// at once) is content arriving, not a designed entrance (do not copy). staged = designed and either the
// content outside the media boxes animates (load.summary.textShare, older captures areaShare, >= stagedShare
// with a kept non-media group) or the kept media entrances cover >= stagedShare of the viewport.
export const LOAD_ENTRANCE = { tinyShare: 0.003, stepGapMs: 150, stageGapMs: 60, stagedShare: 0.15, drawn: /^(canvas|svg|art|panel|lottie)$/ };
export function loadEntrance(motion) {
  const M = motion || {}, L = M.load || {}, sum = L.summary || null, E = LOAD_ENTRANCE;
  const VP = 1440 * 900, num = (v) => typeof v === 'number' && isFinite(v);
  const fcp = num(L.fcpMs) ? L.fcpMs : sum && sum.staging && num(sum.staging.firstContentMs) ? sum.staging.firstContentMs : 0;
  const media = (L.media || []).filter((m) => m && Array.isArray(m.box) && m.box.length >= 4);
  const inter = (a, b) => Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
  const near = (a, b) => inter(a, b) >= 0.5 * Math.min(a[2] * a[3], b[2] * b[3]);
  const car = M.carousels || {};
  const rep = new Set([...(car.autoAdvance || []), ...(car.autoAdvanceCandidates || [])].map((a) => a && a.el).filter(Boolean));
  const parse = (v) => { if (typeof v !== 'string') return v || {}; try { return JSON.parse(v); } catch { return {}; } };
  const visFrom = (f) => !!f && ((num(f.opacity) && f.opacity < 0.95) || (num(f.y) && Math.abs(f.y) >= 2) || (num(f.x) && Math.abs(f.x) >= 2) || (num(f.scale) && Math.abs(f.scale - 1) >= 0.02) || (num(f.clipVisible) && f.clipVisible < 0.95) || (num(f.blur) && f.blur > 0.5));
  const skipped = {}, skip = (w) => { skipped[w] = (skipped[w] || 0) + 1; };
  const groups = [];
  for (const g of L.groups || []) {
    if (!g) continue;
    const n = g.n || 1, box = Array.isArray(g.box) && g.box.length >= 4 ? g.box : null;
    if (g.el && rep.has(g.el)) { skip('repeating'); continue; }
    if (((g.area || 0) * n) / VP < E.tinyShare) { skip('tiny'); continue; }
    const mb = g.kind === 'media' && box ? media.find((m) => near(box, m.box)) : null;
    if (mb && mb.withLoad === false) { skip('mediaFromFirstPaint'); continue; }
    const ap = g.appear || null;
    if (ap && ap.kind === 'none') { skip('stripNone'); continue; }
    let start, ms, from, how = 'strip';
    if (ap && num(ap.atMs) && /^(step|fade|slide)$/.test(ap.kind)) {
      start = ap.atMs; ms = num(ap.ms) ? ap.ms : 0;
      from = ap.kind === 'step' ? {} : Object.assign({ opacity: 0 }, ap.kind === 'slide' && num(ap.y) ? { y: ap.y } : {}, ap.kind === 'slide' && num(ap.x) ? { x: ap.x } : {});
    } else {
      ms = (g.ms || 0) + (g.stagger || 0) * Math.max(0, n - 1); from = parse(g.from);
      if (mb && mb.withLoad === true && num(mb.appearsMs)) start = Math.max(0, mb.appearsMs - ms);
      else { start = Math.max(0, (g.t0 || 0) - fcp); how = 'sampled'; }
    }
    groups.push({ el: g.el || null, kind: g.kind || 'other', n, box, area: g.area || 0, start: Math.round(start), ms: Math.round(ms), from, how, appear: ap ? ap.kind : null, media: !!mb });
  }
  for (const m of media) {
    if (m.withLoad !== true || !num(m.appearsMs) || !E.drawn.test(m.kind || '')) continue;
    // already entering: a media group over it, or a kept group holding >= 80% of it (a wrapper fading in with it)
    if (groups.some((g) => g.box && ((g.media && near(g.box, m.box)) || inter(g.box, m.box) >= 0.8 * m.box[2] * m.box[3]))) continue;
    groups.push({ el: m.el || null, kind: 'media', n: 1, box: m.box, area: inter(m.box, [0, 0, 1440, 900]), start: Math.round(m.appearsMs), ms: 0, from: null, how: 'strip', appear: null, media: true, drawn: true });
  }
  groups.sort((a, b) => a.start - b.start || b.area - a.area);
  const eased = groups.some((g) => !g.drawn && (g.appear ? g.appear === 'fade' || g.appear === 'slide' : visFrom(g.from)));
  const moments = [];
  for (const g of groups) if (!moments.length || g.start - moments[moments.length - 1] >= E.stepGapMs) moments.push(g.start);
  const designed = groups.length > 0 && (eased || moments.length >= 2);
  const textS = sum && num(sum.textShare) ? sum.textShare : sum && num(sum.areaShare) ? sum.areaShare : Math.min(1, groups.filter((g) => !g.media).reduce((s, g) => s + (g.area * g.n) / VP, 0));
  const mediaBoxes = [];
  for (const g of groups) if (g.media && g.box && !mediaBoxes.some((b) => near(b, g.box))) mediaBoxes.push(g.box);
  const mediaS = Math.min(1, mediaBoxes.reduce((s, b) => s + inter(b, [0, 0, 1440, 900]) / VP, 0));
  const nonMedia = groups.some((g) => !g.media);
  const staged = designed && ((nonMedia && textS >= E.stagedShare) || mediaS >= E.stagedShare);
  const share = Math.min(1, Math.max(nonMedia ? textS : 0, mediaS));
  const why = !groups.length ? ((L.groups || []).length ? `no load group shows in the strip (${Object.entries(skipped).map(([k, v]) => `${v} ${k}`).join(', ')})` : 'no load animation')
    : !designed ? `the first screen arrives in one step at ~${moments[0]} ms after first paint (content arriving, not a designed entrance; do not copy)`
    : !staged ? `load animations cover only ${Math.round(share * 100)}% of the first screen (a flourish, not a staged load)`
    : `${groups.length} group(s) arrive ${eased ? 'easing in' : 'in steps'} at ${moments.length} moment(s) from ~${moments[0]} ms after first paint`;
  if (!groups.length) return { designed: false, staged: false, why, groups, skipped, share: 0, textShare: textS, mediaShare: 0, summary: null };
  // staging of the kept groups (the shape of motion.load.summary): order of arrival by kind, start delay
  // after first paint, total duration, modal from-state (by area) of the groups with a from-state
  const firstOf = new Map();
  for (const g of groups) if (g.kind !== 'other' && !firstOf.has(g.kind)) firstOf.set(g.kind, g.start);
  const order = [];
  for (const [k, t] of [...firstOf].sort((a, b) => a[1] - b[1])) { const last = order[order.length - 1]; if (last && t - last.t <= E.stageGapMs) last.kinds.push(k); else order.push({ t, kinds: [k] }); }
  const fw = new Map();
  for (const g of groups) if (g.from) { const k = JSON.stringify(g.from); fw.set(k, (fw.get(k) || 0) + (g.area || 1) * g.n); }
  const fromK = fw.size ? [...fw.entries()].sort((a, b) => b[1] - a[1])[0][0] : '{}';
  const t0 = groups[0].start, t1 = Math.max(...groups.map((g) => g.start + g.ms));
  const mss = groups.map((g) => g.ms).sort((a, b) => a - b);
  const summary = { groups: groups.length, from: JSON.parse(fromK), ms: mss[mss.length >> 1], family: sum ? sum.family : undefined,
    staging: { delayMs: t0, order: order.map((o) => o.kinds.join('+')), steps: moments.length, totalMs: t1 - t0 }, strip: groups.filter((g) => g.how === 'strip').length };
  return { designed, staged, why, groups, skipped, share, textShare: textS, mediaShare: mediaS, summary };
}
// One phrase for an appearance record (sheets, digest): "appears in one step at ~1000 ms",
// "fades in over ~600 ms from ~750 ms", "slides in (y 24 px) over ~500 ms from ~300 ms".
export function appearNote(a, { at = 'ms' } = {}) {
  if (!a || !a.kind) return null;
  if (a.kind === 'none') return 'nothing arrives (in place)';
  if (a.kind === 'step') return `appears in one step at ~${a.atMs} ${at}${a.steps > 1 ? ` (${a.steps} separate jumps)` : ''}: no transition`;
  const mv = a.kind === 'slide' ? ` (${[a.y != null ? `y ${a.y}` : '', a.x != null ? `x ${a.x}` : ''].filter(Boolean).join(', ')} px half-way)` : '';
  return `${a.kind === 'slide' ? 'slides' : 'fades'} in${mv} over ~${a.ms} ms from ~${a.atMs} ${at}${a.open ? ', still changing at the end' : ''}`;
}
