// Page-side static analysis for capture.mjs. Installed after pageCore in the same init script:
// `(${pageCore})();(${pageAnalyze})();`. MUST stay self-contained (no imports / module refs);
// it only uses helpers that pageCore put on window.__rc.
// rc.analyze(opts) measures the page at its current scroll (expected: top, after the scroll
// pass) and returns sections, raw colour areas, type roles, spacing, components, hover targets,
// static motion inventory, fonts, libraries and overflow. Elements needed later (components,
// hover targets) are kept on rc.comp / rc.hoverTargets.
// The module also exports probeInk (Node side): role ink from a screenshot of the DOM probes.
import { decodePng } from './images.mjs';

export function pageAnalyze() {
  if (window.top !== window) return;
  const rc = window.__rc;
  if (!rc || rc.analyze) return;
  const { r1, r2, r3, half, median, SKIP } = rc;
  // advance width per em of 'Hamburgefonstiv' at weight 400: below = condensed, above = extended
  const WIDTH_CLASS = [0.44, 0.58];
  // fixed samples for role ink (visual heaviness) and advance width
  const INK_SAMPLE = 'Hamburgefonstiv 0123', ADV_SAMPLE = 'Hamburgefonstiv';
  // Every computed property that changes which glyphs are drawn or how heavy they render. Probes copy
  // them from the role's example element with !important over `all: initial`, in custom elements that
  // no site selector targets, so the probe text renders exactly as the role does on the page.
  const FONT_PROPS = ['font-family', 'font-size', 'font-weight', 'font-style', 'font-stretch', 'font-variation-settings', 'font-optical-sizing', 'font-feature-settings', 'font-kerning', 'font-variant-ligatures', 'font-variant-caps', 'font-variant-numeric', 'font-variant-east-asian', 'font-variant-position', 'font-variant-alternates', 'font-size-adjust', 'font-synthesis-weight', 'font-synthesis-style', 'font-synthesis-small-caps', 'font-palette', 'text-rendering', '-webkit-font-smoothing', 'font-smooth'];
  const fontCss = (cs, over) => {
    let s = 'all:initial!important;';
    for (const p of FONT_PROPS) { if (over && over[p] !== undefined) continue; const v = cs.getPropertyValue(p); if (v) s += `${p}:${v}!important;`; }
    for (const [k, v] of Object.entries(over || {})) if (v !== undefined && v !== '') s += `${k}:${v}!important;`;
    return s;
  };

  const firstFam = (s) => (s || '').split(',')[0].trim().replace(/^["']|["']$/g, '');
  const px = (s) => { const v = parseFloat(s); return isNaN(v) ? 0 : v; };
  const ms = (s) => (s || '').split(',').map((x) => { x = x.trim(); return x.endsWith('ms') ? parseFloat(x) : parseFloat(x) * 1000; });
  const splitList = (s) => { const out = []; let depth = 0, cur = ''; for (const ch of s || '') { if (ch === '(') depth++; if (ch === ')') depth--; if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch; } if (cur.trim()) out.push(cur.trim()); return out; };
  const mode = (arr, wfn) => { const m = new Map(); for (const a of arr) { const k = a.k; m.set(k, (m.get(k) || 0) + (wfn ? wfn(a) : 1)); } let best = null, bw = -1; for (const [k, w] of m) if (w > bw) { bw = w; best = k; } return best; };
  const blend = (c, under) => { if (!c) return null; if (c[3] >= 0.995 || !under) return c; const a = c[3]; return [c[0] * a + under[0] * (1 - a), c[1] * a + under[1] * (1 - a), c[2] * a + under[2] * (1 - a), 1]; };
  const chroma = (c) => c ? (Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2])) / 255 : 0;
  const lum = (c) => c ? (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255 : 0;
  // mean colour of a gradient's opaque-ish stops (computed values serialise colours as rgb()/rgba())
  const gradMean = (g) => {
    const cs = (String(g || '').match(/rgba?\([^)]*\)|#[0-9a-f]{3,8}\b/gi) || []).map((s) => rc.rgba(s)).filter((c) => c && c[3] >= 0.3);
    if (!cs.length) return null;
    return [0, 1, 2].map((k) => cs.reduce((s, c) => s + c[k], 0) / cs.length).concat([1]);
  };

  rc.maxTrans = (cs) => {
    const d = ms(cs.transitionDuration), dl = ms(cs.transitionDelay);
    let m = 0; d.forEach((v, i) => { m = Math.max(m, (v || 0) + (dl[i % dl.length] || 0)); });
    return m;
  };
  rc.transSummary = (cs) => {
    const p = splitList(cs.transitionProperty), d = ms(cs.transitionDuration), f = splitList(cs.transitionTimingFunction), dl = ms(cs.transitionDelay);
    const out = [];
    p.forEach((prop, i) => { const dur = d[i % d.length] || 0; if (dur > 0 && out.length < 4) out.push(`${prop} ${Math.round(dur)}ms ${f[i % f.length] || 'ease'}${dl[i % dl.length] ? ' ' + Math.round(dl[i % dl.length]) + 'ms' : ''}`); });
    return out.length ? out.join(', ') : null;
  };

  // Content clipped past the viewport edge (see overflow.clipped in rc.analyze; also used by inspect.mjs
  // overflow). o.R: optional Map el -> rec (rc.analyze's records) to skip re-measuring every element;
  // o.canX: the page scrolls sideways. Returns {n (all hits), items: up to 6 outermost hits
  // {sel, kind: text|media, side, cut px, w, x, by (clipping ancestor or 'viewport'), band?}, largest cut first}.
  rc.viewportClipsX = () => { const h = getComputedStyle(document.documentElement).overflowX; return /hidden|clip/.test(h !== 'visible' ? h : getComputedStyle(document.body).overflowX); };
  const CAROUSEL_RE =/carousel|slider|swiper|marquee|ticker|slick|splide|glide|embla|flickity|keen-slider|scroller/i;
  rc.clippedEdge = (o) => {
    o = o || {};
    const vw = o.vw || innerWidth, canX = !!o.canX, t0 = performance.now();
    const MIN_CUT = 6, MIN_VIS = 4;
    const designedCache = new Map();
    // why an element's horizontal cut is designed (or null): walks el and its ancestors once, cached
    const designed = (el) => {
      if (designedCache.has(el)) return designedCache.get(el);
      let why = null;
      for (let a = el; a && a !== document.documentElement && !why; a = a.parentElement) {
        if (designedCache.has(a) && a !== el) { why = designedCache.get(a); break; }
        const cs = getComputedStyle(a);
        if (a.getAttribute('aria-hidden') === 'true' || a.hasAttribute('inert')) why = 'aria-hidden/inert';
        else if (a !== document.body && /(auto|scroll)/.test(cs.overflowX) && a.scrollWidth > a.clientWidth + 1) why = 'scroller';
        else if (cs.scrollSnapType && cs.scrollSnapType !== 'none') why = 'scroll-snap';
        else if (/gradient/.test(cs.maskImage || cs.webkitMaskImage || '')) why = 'edge fade mask';
        else if (cs.transform && cs.transform !== 'none') { try { const m = new DOMMatrixReadOnly(cs.transform); if (Math.abs(m.m41) >= 1) why = 'translated track'; } catch { /* unparsable */ } }
        if (!why && a.getAnimations) { try { if (a.getAnimations().some((an) => an.playState === 'running' && an.effect && an.effect.getKeyframes && an.effect.getKeyframes().some((k) => k.transform || k.translate))) why = 'animated track'; } catch { /* ignore */ } }
        if (!why) {
          const rd = a.getAttribute('aria-roledescription') || '', role = a.getAttribute('role') || '';
          const nm = `${typeof a.className === 'string' ? a.className : (a.className && a.className.baseVal) || ''} ${a.id || ''}`;
          if (/carousel|slide/i.test(rd) || role === 'marquee' || CAROUSEL_RE.test(nm)) why = 'carousel';
        }
        if (!why && (cs.position === 'fixed' || cs.position === 'absolute') && a !== el) {
          const b = a.getBoundingClientRect();
          if (b.width > 0 && (Math.min(b.right, vw) - Math.max(b.left, 0)) < b.width * 0.5) why = 'off-canvas';
        }
      }
      designedCache.set(el, why);
      return why;
    };
    // horizontal visible window of el's content: its own and its ancestors' horizontal clips (html/body
    // clip only when the page cannot scroll sideways: then the viewport itself is the window)
    const windowOf = (el) => {
      let l = 0, r = canX ? 1e9 : vw, by = canX ? null : 'viewport';
      for (let a = el; a && a !== document.documentElement; a = a.parentElement) {
        if (a === document.body) break;
        const cs = getComputedStyle(a);
        if (cs.overflowX !== 'visible') {
          const b = a.getBoundingClientRect();
          if (b.left > l) l = b.left;
          if (b.right < r - 0.5 || (b.right <= r + 0.5 && by === 'viewport')) { r = Math.min(r, b.right); by = rc.desc ? rc.desc(a).slice(0, 60) : a.tagName.toLowerCase(); }
        }
      }
      return { l: Math.max(l, 0), r, by };
    };
    const MEDIA = /^(IMG|VIDEO|CANVAS|IFRAME|svg|OBJECT|EMBED)$/;
    const items = [];
    let n = 0;
    const src = o.R ? o.R.values() : document.body.getElementsByTagName('*');
    for (const x of src) {
      if (performance.now() - t0 > 4000) break;
      const el = o.R ? x.el : x;
      if (SKIP.has(el.tagName) || el.ownerSVGElement) continue;
      if (rc.isTp && rc.isTp(el)) continue;
      const b = el.getBoundingClientRect();
      if (b.width < 1 || b.height < 1 || (b.left >= -2 && b.right <= vw + 2)) continue;
      const cs = o.R ? x.cs : getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      // the content box to test: the element's own text (line boxes of its direct text nodes) or media
      let box = null, kind = null;
      if (MEDIA.test(el.tagName) || (cs.backgroundImage && cs.backgroundImage.includes('url(') && !el.firstElementChild)) {
        if (b.width < 24 || b.height < 24) continue;
        if (b.left <= 1 && b.right >= vw - 1) continue; // spans both edges: a cropped bleed
        let ab = false; for (let a = el; a && a !== document.body; a = a.parentElement) { const p = a === el ? cs.position : getComputedStyle(a).position; if (p === 'absolute' || p === 'fixed') { ab = true; break; } }
        if (ab) continue; // absolutely positioned art bleeding off an edge is a layout choice
        box = { l: b.left, r: b.right }; kind = 'media';
      } else {
        for (const t of el.childNodes) {
          if (t.nodeType !== 3 || !t.textContent.trim()) continue;
          const rg = document.createRange(); rg.selectNodeContents(t);
          for (const q of rg.getClientRects()) { if (q.width < 1) continue; box = box ? { l: Math.min(box.l, q.left), r: Math.max(box.r, q.right) } : { l: q.left, r: q.right }; }
        }
        kind = 'text';
      }
      if (!box || (box.l >= -2 && box.r <= vw + 2)) continue;
      const w = windowOf(el);
      // the cut must be at a viewport edge: the window ends at the edge the content crosses (within 4 px);
      // content cropped by a box that ends inside the viewport (media cropped by its card) is a crop, not a clip
      const cutR = box.r > vw + 2 && w.r <= vw + 1 && w.r >= vw - 4 ? box.r - w.r : 0;
      const cutL = box.l < -2 && w.l <= 4 ? Math.max(0, w.l) - box.l : 0;
      const visW = Math.min(box.r, w.r) - Math.max(box.l, w.l);
      if (Math.max(cutR, cutL) < MIN_CUT || visW < MIN_VIS) continue;
      const why = designed(el);
      if (why) continue;
      n++;
      if (items.length < 40) items.push({ el, sel: rc.selPath ? rc.selPath(el) : el.tagName.toLowerCase(), kind, side: cutR >= cutL ? 'right' : 'left', cut: Math.round(Math.max(cutR, cutL)), w: Math.round(box.r - box.l), x: Math.round(box.l), by: cutR >= cutL ? w.by || 'viewport' : 'viewport', band: o.R ? x.b : undefined });
    }
    items.sort((a, b) => b.cut - a.cut);
    // a row that runs past the LEFT edge is a designed bleed (a centred carousel, a ticker, a translated
    // track): a row that does not reflow overflows to the right. Left cuts are dropped, and so are right cuts
    // in a row (an ancestor up to 5 levels up) that also holds a left-cut element
    const lefts = items.filter((it) => it.side === 'left').map((it) => it.el);
    const bleedRow = (el) => { for (let a = el.parentElement, d = 0; a && a !== document.body && d < 5; a = a.parentElement, d++) if (lefts.some((l) => a.contains(l))) return true; return false; };
    const kept = items.filter((it) => it.side !== 'left' && !bleedRow(it.el));
    if (items.length < 40) n = kept.length;
    // keep the outermost reported element of nested hits
    const outer = kept.filter((it) => !kept.some((q) => q !== it && q.el.contains(it.el)));
    return { n, items: outer.slice(0, 6).map((it) => { const { el, ...rest } = it; return rest; }) };
  };

  rc.analyze = (opts) => {
    const o = opts || {};
    const vw = innerWidth, vh = innerHeight, sy = scrollY, sx = scrollX;
    const docH = rc.docH();
    const notes = [];
    const tStart = performance.now();
    rc.tpScan();
    // ---------- 1. element records ----------
    // geo: every displayed, sized element outside third-party chrome (layout geometry, card rows).
    // recs: the subset actually visible in the settled page: not clipped away by an overflow ancestor,
    // not off-screen horizontally (carousel slides), not an aria-hidden/inert inactive slide, not
    // transparent/hidden. Type roles, components, colours, media and counts use recs only.
    // disp: every displayed element incl. transparent ones (transition inventory).
    const recs = [], R = new Map(), disp = [];
    const all = document.body.getElementsByTagName('*');
    const CAP = 150000, BUDGET_MS = 30000;
    let N = Math.min(all.length, CAP);
    const clipOf = new Map(), absOf = new Map(), slideCache = new Map();
    const isect = (a, b) => (!a ? b : !b ? a : [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])]);
    // an aria-hidden / inert subtree is an inactive slide when it has a same-kind sibling that is not hidden
    const inactiveSlide = (el) => {
      let h = null;
      try { h = el.closest('[aria-hidden="true"],[inert]'); } catch { h = null; }
      if (!h) return false;
      if (slideCache.has(h)) return slideCache.get(h);
      // slides are same-tag siblings of about the same size (a 1x1 screen-reader copy next to an aria-hidden
      // visual heading is not a slide); the active slide is shown (an invisible hover overlay next to an
      // aria-hidden fill layer of a card does not make that layer an inactive slide)
      const hb = h.getBoundingClientRect();
      const sib = hb.width >= 8 && hb.height >= 8 && h.parentElement ? [...h.parentElement.children].some((s) => { if (s === h || s.tagName !== h.tagName || s.getAttribute('aria-hidden') === 'true' || s.hasAttribute('inert')) return false; if (s.checkVisibility && !s.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false; const sb = s.getBoundingClientRect(); return sb.width >= hb.width * 0.5 && sb.width <= hb.width * 2 && sb.height >= hb.height * 0.5 && sb.height <= hb.height * 2; }) : false;
      slideCache.set(h, sib);
      return sib;
    };
    let hiddenN = 0;
    for (let i = 0; i < N; i++) {
      if ((i & 1023) === 0 && performance.now() - tStart > BUDGET_MS) { N = i; notes.push(`element walk stopped after ${BUDGET_MS / 1000}s at element ${i} of ${all.length}`); break; }
      const el = all[i];
      if (SKIP.has(el.tagName)) continue;
      if (el.ownerSVGElement) continue;
      const parent = el.parentElement;
      const pc = clipOf.get(parent);
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) {
        if (el.firstElementChild) {
          const cs0 = getComputedStyle(el);
          if (cs0.display === 'none') continue;
          // a zero-size clipping wrapper hides its children (collapsed accordions)
          if (cs0.overflowX !== 'visible' || cs0.overflowY !== 'visible') clipOf.set(el, [0, 0, 0, 0]); else if (pc) clipOf.set(el, pc);
          if (absOf.has(parent)) absOf.set(el, absOf.get(parent));
        }
        continue;
      }
      const cs = getComputedStyle(el);
      if (cs.display === 'none') continue;
      const box = [r.left + sx, r.top + sy, r.right + sx, r.bottom + sy];
      let my = pc;
      // visually hidden (screen-reader-only) boxes: clip: rect(0 0 0 0), clip-path: inset(50%), or a
      // 1-2 px clipping box; they and everything inside are invisible
      const srOnly = (cs.clip && cs.clip !== 'auto' && /rect\(\s*0(px)?[\s,]+0(px)?[\s,]+0(px)?[\s,]+0(px)?\s*\)/.test(cs.clip)) ||
        (cs.clipPath && cs.clipPath !== 'none' && rc.clipFrac(cs.clipPath, el) < 0.05) ||
        ((r.width < 3 || r.height < 3) && (cs.overflowX !== 'visible' || cs.overflowY !== 'visible'));
      if (srOnly) my = [0, 0, 0, 0];
      else if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
        const cx = cs.overflowX !== 'visible', cy = cs.overflowY !== 'visible';
        my = isect(pc, [cx ? box[0] : -1e9, cy ? box[1] : -1e9, cx ? box[2] : 1e9, cy ? box[3] : 1e9]);
      }
      if (my) clipOf.set(el, my);
      const absRoot = cs.position === 'absolute' || cs.position === 'fixed' ? el : absOf.get(parent) || null;
      if (absRoot) absOf.set(el, absRoot);
      const tp = rc.isTp(el);
      const rec = { el, cs, x: box[0], y: box[1], w: r.width, h: r.height, i, tag: el.tagName, absRoot };
      disp.push(rec);
      if (tp) continue;
      // visible fraction: intersect with the clip region and the horizontal viewport
      let v = isect(pc, [0, -1e9, vw, 1e9]);
      v = isect(v, box);
      rec.vis = Math.max(0, v[2] - v[0]) * Math.max(0, v[3] - v[1]) / (r.width * r.height);
      R.set(el, rec);
      let hid = srOnly || rec.vis < 0.5 || cs.visibility === 'hidden';
      if (!hid && el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) hid = true;
      if (!hid && inactiveSlide(el)) { hid = true; rec.hidSlide = true; } // on screen, hidden from assistive tech only
      rec.hid = hid;
      if (hid) { hiddenN++; continue; }
      recs.push(rec);
    }
    const cutEl = N < all.length ? all[N] : null;
    if (all.length > CAP) notes.push(`DOM has ${all.length} elements; analysed the first ${N}; bands after that are marked analysed:false`);
    const inDoc = (rec) => Math.max(0, Math.min(rec.x + rec.w, vw) - Math.max(rec.x, 0)) * Math.max(0, Math.min(rec.y + rec.h, docH) - Math.max(rec.y, 0));
    // ---------- 1b. painted ::before/::after layers ----------
    // Visible pseudo-element boxes that paint a fill, gradient or image (content not none, >= 4x4 px,
    // opacity > 0). Their box is placed from the computed (used) size and insets relative to the
    // containing block, clipped like their owner. They feed band backgrounds, gradients, component fills
    // and palette areas exactly like a child box would.
    const pseudoL = [], pseudoOf = new Map();
    {
      const tP = performance.now();
      const NOPS = /^(IMG|INPUT|VIDEO|CANVAS|IFRAME|svg|TEXTAREA|SELECT|BR|HR|PICTURE|OBJECT|EMBED)$/;
      // containing block of an absolutely positioned pseudo: the owner or the nearest positioned /
      // transformed / filtered / contained ancestor (null = the initial containing block)
      const cbOf = (el) => { for (let e = el; e && e !== document.documentElement; e = e.parentElement) { const s = (R.get(e) || {}).cs || getComputedStyle(e); if (s.position !== 'static' || s.transform !== 'none' || (s.filter && s.filter !== 'none') || /paint|layout|strict|content/.test(s.contain || '')) return e; } return null; };
      const bodyRec = { el: document.body, cs: getComputedStyle(document.body), x: 0, y: 0, w: vw, h: docH, tag: 'BODY', b: -1 };
      for (const rec of [bodyRec].concat(recs)) {
        if (NOPS.test(rec.tag)) continue;
        if (performance.now() - tP > 6000) { notes.push('pseudo-element scan stopped after 6 s'); break; }
        for (const ps of ['::before', '::after']) {
          const p = getComputedStyle(rec.el, ps);
          const ct = p.content;
          if (!ct || ct === 'none' || ct === 'normal' || p.display === 'none' || p.visibility === 'hidden') continue;
          const op = parseFloat(p.opacity);
          if (!(op > 0.02)) continue;
          let c = rc.rgba(p.backgroundColor);
          const bi = p.backgroundImage && p.backgroundImage !== 'none' ? p.backgroundImage : null;
          const grad = bi && bi.includes('gradient') ? bi : null, img = !!(bi && bi.includes('url('));
          if (c && op < 1) c = [c[0], c[1], c[2], c[3] * op];
          if (!(c && c[3] >= 0.05) && !grad && !img) continue;
          const w = px(p.width), h = px(p.height);
          if (!(w >= 4 && h >= 4)) continue;
          let x, y;
          if (p.position === 'fixed') { x = px(p.left); y = px(p.top) + sy; }
          else if (p.position === 'absolute') {
            const cb = cbOf(rec.el);
            const cr = cb ? cb.getBoundingClientRect() : { left: -sx, top: -sy };
            const ccs = cb ? getComputedStyle(cb) : null;
            x = cr.left + sx + (ccs ? px(ccs.borderLeftWidth) : 0) + px(p.left);
            y = cr.top + sy + (ccs ? px(ccs.borderTopWidth) : 0) + px(p.top);
          } else {
            const ocs = rec.cs;
            x = rec.x + px(ocs.borderLeftWidth) + px(ocs.paddingLeft);
            y = ps === '::before' ? rec.y + px(ocs.borderTopWidth) + px(ocs.paddingTop) : rec.y + rec.h - px(ocs.borderBottomWidth) - px(ocs.paddingBottom) - h;
          }
          // clip like the owner (its overflow ancestors and its own overflow clip) and to the viewport width
          let bx = [x, y, x + w, y + h];
          bx = isect(bx, clipOf.get(rec.el) || null);
          bx = isect(bx, [0, -1e9, vw, 1e9]);
          const cw = bx[2] - bx[0], ch = bx[3] - bx[1];
          if (!(cw >= 4 && ch >= 4)) continue;
          const L = { owner: rec, ps, x: bx[0], y: bx[1], w: cw, h: ch, c: c && c[3] >= 0.05 ? c : null, grad, img };
          pseudoL.push(L);
          const a = pseudoOf.get(rec.el) || []; a.push(L); pseudoOf.set(rec.el, a);
        }
      }
    }
    // a pseudo layer of el that covers it (fill painted on ::before/::after instead of the element)
    const coverLayer = (el, fw, fh) => { const r = R.get(el); const ls = pseudoOf.get(el); if (!r || !ls) return null; return ls.filter((L) => L.w >= r.w * fw && L.h >= r.h * fh).sort((a, b) => b.w * b.h - a.w * a.h)[0] || null; };
    // colour behind an element: its own solid background, a solid pseudo layer covering it, else its parent's
    const rootBg = (() => { const b = rc.rgba(getComputedStyle(document.body).backgroundColor); const h = rc.rgba(getComputedStyle(document.documentElement).backgroundColor); return blend(b, h || [255, 255, 255, 1]) || h || [255, 255, 255, 1]; })();
    const colorAtCache = new Map();
    const colorAt = (e) => {
      if (!e) return rootBg;
      if (colorAtCache.has(e)) return colorAtCache.get(e);
      const c = rc.rgba(((R.get(e) || {}).cs || getComputedStyle(e)).backgroundColor);
      // a solid ::before/::after layer covering the element paints its background too
      const L = c && c[3] >= 0.5 ? null : coverLayer(e, 0.9, 0.85);
      const v = c && c[3] >= 0.5 ? blend(c, rootBg) : L && L.c && L.c[3] >= 0.5 ? blend(L.c, colorAt(e.parentElement)) : colorAt(e.parentElement);
      colorAtCache.set(e, v);
      return v;
    };
    const underOf = (el) => colorAt(el && el.parentElement);

    // ---------- 2. bands (each viewport segmented on its own, then linked to primary bands) ----------
    const seg = rc.segment();
    const segInfo = { root: seg.root, cover: seg.cover, capped: seg.capped };
    let bands = seg.bands.map((b) => ({ el: b.el, els: b.els || [b.el], top: b.top, bot: b.bot, ot: b.ot ?? b.top, ob: b.ob ?? b.bot }));
    if (cutEl) for (const b of bands) b.unanalysed = b.el === cutEl || b.el.contains(cutEl) || !!(b.el.compareDocumentPosition(cutEl) & Node.DOCUMENT_POSITION_PRECEDING);
    // link to primary bands: o.bandSigs = per primary band, the signatures of its elements (main last)
    let hiddenPrimary = null;
    if (o.bandSigs && o.bandSigs.length) {
      const sigIdx = new Map();
      o.bandSigs.forEach((sigs, pi) => { for (const s of sigs) if (!sigIdx.has(s)) sigIdx.set(s, pi); });
      const peCache = new Map();
      for (const b of bands) {
        b.link = null;
        for (const e of b.els) { const s = rc.sig(e); if (sigIdx.has(s)) { b.link = sigIdx.get(s); break; } }
        if (b.link !== null) continue;
        // a primary band element inside this band, or this band inside a primary band element
        for (const [s, pi] of sigIdx) {
          if (!peCache.has(s)) peCache.set(s, rc.bySig(s));
          const pe = peCache.get(s);
          if (pe && (b.el.contains(pe) || pe.contains(b.el))) { b.link = pi; break; }
        }
      }
      hiddenPrimary = [];
      o.bandSigs.forEach((sigs, pi) => {
        const els = sigs.map((s) => rc.bySig(s)).filter(Boolean);
        const shown = els.some((e) => { const r = e.getBoundingClientRect(); return r.width >= 1 && r.height >= 1 && getComputedStyle(e).display !== 'none'; });
        if (!shown) hiddenPrimary.push(pi);
      });
    }
    // nav
    const navF = rc.findNav();
    let navEl = navF ? navF.el : null;
    let navSection = null;
    if (navEl) {
      const nr = R.get(navEl) || { y: 0, h: navEl.getBoundingClientRect().height, x: 0, w: vw };
      const own = bands.slice(0, 3).find((b) => b.el === navEl || navEl.contains(b.el) || (b.el.contains(navEl) && (b.bot - b.top) <= nr.h + 40));
      if (own) {
        navSection = own; own.isNav = true;
      } else {
        const host = bands.find((b) => b.el.contains(navEl));
        if (host) host.navOverlay = true;
        navSection = { el: navEl, top: nr.y, bot: nr.y + nr.h, isNav: true, virtual: true };
        bands.unshift(navSection);
      }
      navSection.pos = navF.pos;
    }
    const bandIdx = new Map();
    bands.forEach((b, i) => { for (const e of (b.els || [b.el])) bandIdx.set(e, i); bandIdx.set(b.el, i); });
    const bandOf = (el) => { let e = el; while (e && e !== document.body) { const i = bandIdx.get(e); if (i !== undefined) return i; e = e.parentElement; } return -1; };
    for (const rec of R.values()) rec.b = bandOf(rec.el);
    const lastBand = bands.length - 1;
    // elements with visible text somewhere inside (art boxes are media without text)
    const hasText = new Set();

    // ---------- 3. classify elements ----------
    const boxy = (cs) => {
      const bg = rc.rgba(cs.backgroundColor);
      if (bg && bg[3] >= 0.1) return 'fill';
      if (cs.backgroundImage && cs.backgroundImage.includes('gradient')) return 'fill';
      const bw = px(cs.borderTopWidth);
      const bc = rc.rgba(cs.borderTopColor);
      if (bw >= 1 && cs.borderTopStyle !== 'none' && bc && bc[3] > 0.15) return 'outline';
      return null;
    };
    // Not part of the visible design: boxes parked above or below the page until focused (skip links: more
    // than half of the box outside the document vertically; horizontally off-screen and visually hidden
    // boxes are already out of recs), and in-page "skip to / jump to" links positioned out of the flow.
    // Their text is never a type role or sample and they are never a button or component.
    const offPage = (rec) => Math.min(rec.y + rec.h, docH) - Math.max(rec.y, 0) < rec.h * 0.5;
    const skipCtl = (el) => {
      const a = el.closest ? el.closest('a[href^="#"],button,[role=button]') : null;
      const ar = a && R.get(a);
      return !!ar && (offPage(ar) || (/^\s*(skip|jump)\s+(to|navigation|nav)\b/i.test(a.textContent || '') && /absolute|fixed/.test(ar.cs.position)));
    };
    const btns = new Map();
    for (const rec of recs) {
      const el = rec.el, t = rec.tag;
      if (rec.h < 24 || rec.h > 84 || rec.w < 36 || rec.w > 460) continue;
      if (offPage(rec) || skipCtl(el)) continue;
      const isBtn = t === 'BUTTON' || el.getAttribute('role') === 'button' || (t === 'INPUT' && /^(submit|button)$/i.test(el.type));
      if (!isBtn && t !== 'A') continue;
      const txt = (el.textContent || el.value || '').trim();
      if (!txt || txt.length > 42) continue;
      let kind = boxy(rec.cs), boxEl = el;
      if (!kind && el.children.length === 1) {
        const cr = R.get(el.children[0]);
        if (cr && cr.w >= rec.w * 0.9 && cr.h >= rec.h * 0.8) { kind = boxy(cr.cs); if (kind) boxEl = cr.el; }
      }
      // fill painted by a ::before/::after layer covering the button (3D/"pressable" button styles); a
      // gradient layer counts with the mean of its colour stops
      let pseudo = null;
      if (!kind) {
        const L = (pseudoOf.get(el) || []).filter((l) => l.w >= rec.w * 0.8 && l.h >= rec.h * 0.7 && ((l.c && l.c[3] >= 0.3) || (l.grad && gradMean(l.grad)))).sort((a, b) => b.w * b.h - a.w * a.h)[0];
        if (L) { kind = 'fill'; pseudo = L.c && L.c[3] >= 0.3 ? L.c : gradMean(L.grad); }
      }
      if (!kind) continue;
      if (t === 'A' && boxEl === el && !pseudo && px(rec.cs.paddingLeft) < 6) continue;
      btns.set(el, { rec, kind, boxEl, pseudo });
    }
    // the colour a button is filled with (own/child background, or its ::before/::after layer)
    const btnFill = (x) => x.pseudo || rc.rgba(getComputedStyle(x.boxEl).backgroundColor);
    const inBtn = (el) => { let e = el; for (let d = 0; e && d < 5; d++, e = e.parentElement) if (btns.has(e)) return btns.get(e); return null; };
    const closest = (el, re, depth) => { let e = el; for (let d = 0; e && d < depth; d++, e = e.parentElement) if (re.test(e.tagName)) return e; return null; };
    const isNavEl = (el) => (navEl && navEl.contains(el)) || !!closest(el, /^NAV$/, 12);
    // the page footer: the last <footer> / contentinfo element that is not a component's footer (inside an
    // article, blockquote, figure, aside, list item, dialog or form) and ends in the lower 40% of the page; a
    // <footer> inside a content band (a card's or a section's footer row) is not the page footer
    const pageFooter = (f) => { if (f.parentElement && f.parentElement.closest('article,blockquote,figure,aside,li,dialog,form')) return false; const fr = f.getBoundingClientRect(); return fr.height >= 1 && fr.bottom + sy >= docH * 0.6; };
    const footerEl = [...document.querySelectorAll('footer,[role=contentinfo]')].filter(pageFooter).pop() || null;
    const isFooter = (rec) => (footerEl && footerEl.contains(rec.el)) || (rec.b === lastBand && lastBand > 0 && bands[lastBand].footerLike);

    // declared font faces per family: the weight a text is actually rendered in is the nearest declared
    // face by CSS font matching (a face that is declared but not loaded yet still wins the match: the
    // browser loads it); a declared weight > 200 above that face is synthesised bold when allowed. Faces
    // that failed to load and unicode-range subsets that do not cover Latin letters are left out; weight
    // ranges (variable faces) count as ranges; italic faces only match italic text when the family has any.
    const faceW = new Map();
    const coversLatin = (ur) => {
      if (!ur) return true;
      return String(ur).split(',').some((p) => {
        const m = p.trim().match(/^U\+([0-9A-F?]+)(?:-([0-9A-F]+))?$/i);
        if (!m) return true;
        const lo = parseInt(m[1].replace(/\?/g, '0'), 16), hi = m[2] ? parseInt(m[2], 16) : parseInt(m[1].replace(/\?/g, 'F'), 16);
        return lo <= 0x65 && hi >= 0x65;
      });
    };
    try {
      for (const f of document.fonts) {
        if (f.status === 'error' || !coversLatin(f.unicodeRange)) continue;
        const fam = f.family.replace(/["']/g, '').trim().toLowerCase();
        const ws = String(f.weight).split(/\s+/).map((x) => (x === 'normal' ? 400 : x === 'bold' ? 700 : +x)).filter((x) => x > 0);
        if (!ws.length) continue;
        const a = faceW.get(fam) || []; a.push([Math.min(...ws), Math.max(...ws), /italic|oblique/.test(f.style || '')]); faceW.set(fam, a);
      }
    } catch {}
    const matchWeight = (want, ranges) => {
      for (const [lo, hi] of ranges) if (want >= lo && want <= hi) return want;
      const pts = [...new Set(ranges.flatMap(([lo, hi]) => [lo, hi]))].sort((a, b) => a - b);
      const above = pts.filter((w) => w > want), below = pts.filter((w) => w < want).reverse();
      if (want >= 400 && want <= 500) { const upTo500 = above.filter((w) => w <= 500); if (upTo500.length) return upTo500[0]; if (below.length) return below[0]; return above[0]; }
      if (want < 400) return below.length ? below[0] : above[0];
      return above.length ? above[0] : below[0];
    };
    const GENERIC_F = /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-sans-serif|ui-serif|ui-monospace|ui-rounded|-apple-system|blinkmacsystemfont|emoji|math|fangsong)$/i;
    const famCache = new Map(), availCache = new Map();
    const cvs0 = document.createElement('canvas').getContext('2d');
    const avail = (n) => {
      if (availCache.has(n)) return availCache.get(n);
      const s = 'mmmmmmmmmmlli 0123 WQgy';
      const w = (f) => { cvs0.font = `64px ${f}`; return cvs0.measureText(s).width; };
      const ok = w(`"${n}", monospace`) !== w('monospace') || w(`"${n}", serif`) !== w('serif');
      availCache.set(n, ok);
      return ok;
    };
    // the family a stack actually renders in: first loaded web font face, else first installed local
    // font, else the generic fallback
    const famOfStack = (stack) => {
      if (famCache.has(stack)) return famCache.get(stack);
      const names = String(stack || '').split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
      let f = null;
      for (const n of names) {
        if (GENERIC_F.test(n)) { f = n; break; }
        if (faceW.has(n.toLowerCase()) || avail(n)) { f = n; break; }
      }
      if (!f) f = names[0] || '';
      famCache.set(stack, f);
      return f;
    };
    const rwCache = new Map();
    const renderedWeight = (fam, declared, cs) => {
      const it = /italic|oblique/.test(cs.fontStyle || '');
      const k = fam + '|' + declared + '|' + it + '|' + (cs.fontSynthesisWeight || cs.fontSynthesis || '');
      if (rwCache.has(k)) return rwCache.get(k);
      const all = faceW.get(String(fam).toLowerCase()) || [];
      const sameStyle = all.filter((f) => f[2] === it);
      const ranges = (sameStyle.length ? sameStyle : all).map((f) => [f[0], f[1]]);
      let out = { w: declared, face: null, synth: false };
      if (ranges && ranges.length) {
        const face = matchWeight(declared, ranges);
        const allowed = !/none/.test(cs.fontSynthesisWeight || '') && !/^none$/.test(cs.fontSynthesis || '');
        const synth = allowed && declared - face > 200;
        out = { w: synth ? Math.min(900, face + 300) : face, face, synth };
      }
      rwCache.set(k, out);
      return out;
    };
    // text items
    const texts = [];
    for (const rec of recs) {
      let chars = 0;
      for (const n of rec.el.childNodes) if (n.nodeType === 3) { const s = n.data.trim(); if (s) chars += s.length; }
      if (rec.tag === 'INPUT' && /^(submit|button)$/i.test(rec.el.type)) chars = (rec.el.value || '').length;
      if (!chars) continue;
      for (let e = rec.el; e && e !== document.body && !hasText.has(e); e = e.parentElement) hasText.add(e);
      if (offPage(rec) || skipCtl(rec.el)) continue;   // skip links / text parked off the page
      const cs = rec.cs;
      const size = px(cs.fontSize);
      if (size < 6) continue;
      const lhv = cs.lineHeight === 'normal' ? null : px(cs.lineHeight) / size;
      const ls = cs.letterSpacing === 'normal' ? 0 : px(cs.letterSpacing) / size;
      const hEl = closest(rec.el, /^H[1-6]$/, 4);
      const btn = inBtn(rec.el);
      const link = closest(rec.el, /^A$/, 4);
      // block ancestor (split-text spans collapse into their block)
      let blk = rec.el;
      for (let d = 0; d < 6 && blk && /^inline/.test(getComputedStyle(blk).display) && blk.parentElement; d++) blk = blk.parentElement;
      // line spans set display:block inside one heading element are one heading: the heading tag is the block
      if (hEl && blk !== hEl && hEl.contains(blk)) blk = hEl;
      const declW = +cs.fontWeight || 400;
      const fam = famOfStack(cs.fontFamily);
      const rw = renderedWeight(fam, declW, cs);
      texts.push({
        rec, chars, size: r1(size), weight: rw.w, declW, synth: rw.synth, lh: lhv === null ? null : r2(lhv), ls: r3(ls), tt: cs.textTransform, fst: cs.fontStyle,
        fam, stack: cs.fontFamily, color: rc.rgba(cs.color), align: cs.textAlign,
        h: hEl ? hEl.tagName.toLowerCase() : null, hEl, btn: !!btn, link: !!link, nav: isNavEl(rec.el), b: rec.b, blk,
        small: !!closest(rec.el, /^(SMALL|FIGCAPTION|CAPTION|LABEL|TIME)$/, 2),
        // own text (direct text nodes, space-joined): only used by the numeral/price patterns, never output
        txt: [...rec.el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.data.trim()).filter(Boolean).join(' ').slice(0, 200),
      });
    }
    // block-level groups
    const blocks = new Map();
    for (const t of texts) {
      let g = blocks.get(t.blk);
      if (!g) { g = { el: t.blk, size: 0, chars: 0, ts: [], b: t.b, h: t.h, nav: t.nav, btn: t.btn }; blocks.set(t.blk, g); }
      g.ts.push(t); g.chars += t.chars; if (t.size > g.size) g.size = t.size;
      g.h = g.h || t.h; g.nav = g.nav || t.nav; g.btn = g.btn || t.btn;
    }
    for (const g of blocks.values()) { const r = R.get(g.el) || g.ts[0].rec; g.x = r.x; g.y = r.y; g.w = r.w; g.hh = r.h; }

    // ---------- 4. typography ----------
    // footer band: a band that is itself a page-footer element, or one holding the page footer when it is the
    // last band or the footer fills >= 60% of its own box; a <footer> inside any other band never makes it one
    const footerIdx = (() => {
      for (let i = bands.length - 1; i >= 0; i--) {
        const b = bands[i], el = b.el;
        if (b.isNav || b.virtual) continue;
        if ((el.tagName === 'FOOTER' || el.getAttribute('role') === 'contentinfo') && pageFooter(el)) return i;
        if (footerEl && el.contains(footerEl) && (i === bands.length - 1 || footerEl.getBoundingClientRect().height >= (b.ob - b.ot) * 0.6)) return i;
      }
      return -1;
    })();
    if (footerIdx >= 0) bands[footerIdx].footerLike = true;
    for (const t of texts) t.footer = (footerEl && footerEl.contains(t.rec.el)) || (footerIdx >= 0 && t.b === footerIdx);
    // numerals: 98%, 10x, $1.2M+, 10 min, 24/7, 4.9/5, #1, 3 days
    const NUM = /^[\s$€£¥#+\-–~<>≈]*\d[\d.,]*(\s*\/\s*\d+)?\s*(%|\+|x|×|k|m|b|bn|mn|ms|s|sec|secs|min|mins|h|hr|hrs|hours?|days?|wks?|weeks?|mos?|months?|yrs?|years?|tb|gb|mb|kb|k\+|m\+|b\+|★|\*)?\+?\*?$/i;
    // stat figures: a block whose whole text is one short numeral ("98%", "2.4M", "$12k", "24/7"); never a
    // heading tier or the display text, recorded as type.stats
    const blockTxt = (g) => g.ts.map((t) => t.txt).join(' ').trim();
    const statCache = new Map();
    const isStat = (g) => { if (!g) return false; if (!statCache.has(g)) { const s = blockTxt(g); statCache.set(g, s.length > 0 && s.length <= 14 && NUM.test(s)); } return statCache.get(g); };
    // text wordmarks (<= 30 chars), never a heading tier: a text logo in the header (the nav band, a header /
    // banner box near the top, or the top 120 px of the page) that links home (/, #, this page) or is named as a
    // logo / brand (class, id, aria-label, title, up to 4 levels up); one in the footer that links home; and one
    // anywhere in a box <= 400x160 px named as a logo (a class token with logo (not "logos") / wordmark /
    // brand-mark, a token "brand" or "*-brand", or an id / aria-label / title with logo, up to 3 levels up)
    const LOGO = /logo|brand|wordmark/i;
    const homeLink = (el) => { const a = el.closest && el.closest('a[href]'); if (!a) return false; try { const u = new URL(a.getAttribute('href'), location.href); return u.origin === location.origin && (u.pathname === '/' || u.pathname === location.pathname) && u.hash.length <= 1 && !u.search; } catch { return false; } };
    const logoNamed = (el) => { for (let e = el, d = 0; e && e !== document.body && d < 5; e = e.parentElement, d++) { const cl = typeof e.className === 'string' ? e.className : (e.className && e.className.baseVal) || ''; if (LOGO.test(`${cl} ${e.id || ''} ${e.getAttribute('aria-label') || ''} ${e.getAttribute('title') || ''}`)) return true; } return false; };
    const LOGO_TOK = /logo(?!s)|wordmark|brand-?mark|^brand$|[-_]brand$/i;
    const logoTok = (el) => { for (let e = el, d = 0; e && e !== document.body && d < 4; e = e.parentElement, d++) { const cl = typeof e.className === 'string' ? e.className : (e.className && e.className.baseVal) || ''; if (cl.split(/\s+/).some((x) => x && LOGO_TOK.test(x)) || /logo|wordmark/i.test(`${e.id || ''} ${e.getAttribute('aria-label') || ''} ${e.getAttribute('title') || ''}`)) return true; } return false; };
    const inHeader = (g) => (bands[g.b] && bands[g.b].isNav) || g.y + g.hh <= 120 || (() => { const h = g.el.closest && g.el.closest('header,[role=banner]'); const hr = h && R.get(h); return !!hr && hr.y < vh * 0.5 && hr.h <= 260; })();
    const wordmark = (g) => g.chars <= 30 && ((inHeader(g) && (logoNamed(g.el) || g.ts.some((t) => homeLink(t.rec.el))))
      || (g.ts.every((t) => t.footer) && g.ts.some((t) => homeLink(t.rec.el))) || (g.w <= 400 && g.hh <= 160 && logoTok(g.el)));
    // a row of text logos, never a heading tier: >= 4 short (<= 24 chars) heading-like blocks outside heading tags,
    // one size (within 10%), in one band, siblings or cousins (same parent or grandparent: a wrapped logo grid or a
    // marquee's repeated sets count), at least two of them side by side on one line, and at most a quarter of them
    // with other text (not another logo) within 1.5x their height below (card titles have their text below them;
    // logos stand alone)
    const markRowCache = new Map();
    const inMarkRow = (g) => {
      if (markRowCache.has(g)) return markRowCache.get(g);
      let ok = false;
      const cand = (p) => p.chars <= 24 && !p.h && !p.nav && !p.btn && p.el.parentElement;
      if (cand(g)) {
        const gp = g.el.parentElement, ggp = gp.parentElement;
        const peers = [...blocks.values()].filter((p) => p.b === g.b && cand(p) && Math.abs(p.size - g.size) <= g.size * 0.1 && (p.el.parentElement === gp || (ggp && p.el.parentElement.parentElement === ggp)));
        const side = peers.some((p) => peers.some((q) => q !== p && Math.abs(q.y + q.hh / 2 - p.y - p.hh / 2) <= Math.max(8, p.hh / 2) && (q.x >= p.x + p.w - 1 || p.x >= q.x + q.w - 1)));
        if (peers.length >= 4 && side) {
          const ps = new Set(peers);
          const below = (p) => [...blocks.values()].some((q) => q !== p && !ps.has(q) && q.y >= p.y + p.hh - 2 && q.y <= p.y + p.hh * 2.5 && q.x < p.x + p.w && q.x + q.w > p.x);
          ok = peers.filter(below).length <= peers.length * 0.25;
        }
        if (ok) for (const p of peers) markRowCache.set(p, true);
      }
      markRowCache.set(g, ok);
      return ok;
    };
    // keycap / kbd-like labels, never a heading tier: a block of <= 4 visible characters (a digit, a symbol, "esc")
    // inside <kbd> or drawn in its own box (the element or an ancestor up to 2 levels up, at most 5x the font size
    // tall and 12x wide, has a fill, outline or shadow, or a covering ::before/::after fill)
    const keycap = (g) => {
      const s = g.ts.map((t) => t.txt).join('').replace(/\s+/g, '');
      if (!s || [...s].length > 4) return false;
      if (g.el.closest && g.el.closest('kbd')) return true;
      for (let e = g.el, d = 0; e && e !== document.body && d < 3; e = e.parentElement, d++) {
        const r = R.get(e);
        if (!r) continue;
        if (r.h > g.size * 5 || r.w > g.size * 12) break;
        if (boxy(r.cs) || r.cs.boxShadow !== 'none' || coverLayer(e, 0.9, 0.85)) return true;
      }
      return false;
    };
    const styleKey = (t) => `${t.size}|${t.weight}|${t.lh}|${t.ls}|${t.tt}|${t.fst}|${t.fam}`;
    // Visual heaviness (ink), advance (adv) and the rendered line box (lhr) of a role's exact font are
    // measured with DOM probes, never with canvas (canvas cannot apply font-variation-settings,
    // font-stretch or optical sizing): adv and lhr below, ink by capture.mjs from one screenshot of the
    // probes rc.probeShow() lays out (see probeInk at the end of this file).
    const roleEx = new Map();   // role object -> { t: example text, members: same style key, document order }
    const styleOf = (arr, wfn) => {
      if (!arr.length) return null;
      const k = mode(arr.map((t) => ({ k: styleKey(t), t })), wfn ? (a) => wfn(a.t) : null);
      const members = arr.filter((x) => styleKey(x) === k);
      const t = members[0];
      const o = { px: t.size, weight: t.weight, declared: t.declW !== t.weight ? t.declW : undefined, synth: t.synth || undefined, lh: t.lh, ls: t.ls, tt: t.tt === 'none' ? null : t.tt, style: t.fst === 'normal' ? null : t.fst, family: t.fam, color: rc.hex(t.color), n: arr.length, ex: rc.desc(t.rec.el), band: t.b, ink: null, adv: null };
      roleEx.set(o, { t, members });
      return o;
    };
    const roles = {};
    // Body = running text: the char-weighted modal size of prose. Prose = text in blocks holding >= 40
    // characters (split-text spans and two-tone runs collapse into their block), 11-30 px, any tag (the same
    // statement set as <p> on one page and <h2> on another is the same text), outside nav, footer and
    // buttons. Left out when other prose remains, so one design measures the same whatever its DOM:
    //   mock-up text: inside a UI mock-up panel (a filled, outlined or shadowed box, or one covered by a
    //     ::before/::after fill, >= 120 px tall, >= 15% of its band's width, < 85% of the band's area,
    //     holding >= 3 nested filled/outlined boxes and >= 6 text elements; a panel that is one of a group of
    //     same-tag siblings counts like a single one) or inside an aria-hidden subtree (decorative copies);
    //   small print: text under 13 px that trails the page (below the last >= 20 px text outside nav and
    //     footer: legal copy outside a <footer>), or any under 13 px when the larger prose holds >= 25% as
    //     many characters (tile grids, UI text);
    //   lead paragraphs: a size used by at most one block per band in >= 2 bands, each <= 260 chars,
    //     >= 1.15x another prose size that has >= 3 blocks in >= 2 bands, at least as many blocks, and >= 25%
    //     of its characters.
    const panelCache = new Map();
    const textEls = new Set(texts.map((t) => t.rec.el));
    const isPanel = (a, band) => {
      if (panelCache.has(a)) return panelCache.get(a);
      let ok = false;
      const ar = R.get(a);
      if (ar && band && !(band.els && band.els.includes(a))) {
        const bw = Math.min(vw, (R.get(band.el) || { w: vw }).w), bh = Math.max(1, band.ob - band.ot);
        if (ar.h >= 120 && ar.w >= bw * 0.15 && Math.min(ar.w, vw) * ar.h < bw * bh * 0.85 && (boxy(ar.cs) || ar.cs.boxShadow !== 'none' || coverLayer(a, 0.9, 0.9))) {
          let n = 0, nt = 0, k = 0;
          for (const d of a.querySelectorAll('*')) {
            if (++k > 800) break;
            if (textEls.has(d)) nt++;
            const dr = R.get(d); if (dr && dr.w * dr.h >= 300 && boxy(dr.cs)) n++;
            if (n >= 3 && nt >= 6) break;
          }
          ok = n >= 3 && nt >= 6;
        }
      }
      panelCache.set(a, ok);
      return ok;
    };
    const ariaHidden = (el) => { try { return !!el.closest('[aria-hidden="true"]'); } catch { return false; } };
    const inPanel = (t) => { const band = bands[t.b]; if (!band) return false; for (let a = t.rec.el.parentElement, d = 0; a && a !== band.el && a !== document.body && d < 12; a = a.parentElement, d++) if (isPanel(a, band)) return true; return false; };
    const mockText = (t) => ariaHidden(t.rec.el) || inPanel(t);
    const proseBlk = (t) => { const g = blocks.get(t.blk); return !!g && g.chars >= 40; };
    const paraAll = texts.filter((t) => proseBlk(t) && !t.nav && !t.btn && !t.footer && t.size >= 11 && t.size <= 30);
    let para = paraAll.filter((t) => !mockText(t));
    const panelOut = para.length && para.length < paraAll.length;
    if (!para.length) para = paraAll;
    let microOut = null;
    {
      const MICRO = 13;
      const lastBigY = texts.reduce((m, t) => (t.size >= 20 && !t.nav && !t.footer && !t.btn && t.chars >= 2 ? Math.max(m, t.rec.y) : m), -1);
      const trailing = (t) => t.rec.y > lastBigY;
      const micro = para.filter((t) => t.size < MICRO);
      const big = para.filter((t) => t.size >= MICRO);
      const sum = (a) => a.reduce((s, t) => s + t.chars, 0);
      if (micro.length && big.length) {
        const share = sum(big) >= sum(micro) * 0.25;
        const out = micro.filter((t) => share || trailing(t));
        if (out.length) { const os = new Set(out); para = para.filter((t) => !os.has(t)); microOut = share ? 'small print and tile/UI text under 13px' : 'small print under 13px below the last heading'; }
      }
    }
    let leadOut = null;
    {
      const bySize = new Map();
      for (const t of para) {
        const g = bySize.get(t.size) || { size: t.size, chars: 0, blocks: new Map() };
        g.chars += t.chars;
        const bk = g.blocks.get(t.blk) || { b: t.b, chars: 0 }; bk.chars += t.chars; g.blocks.set(t.blk, bk);
        bySize.set(t.size, g);
      }
      const G = [...bySize.values()];
      const nBands = (g) => new Set([...g.blocks.values()].map((bk) => bk.b)).size;
      const lead = new Set(G.filter((g) => {
        const perBand = new Map(); for (const bk of g.blocks.values()) perBand.set(bk.b, (perBand.get(bk.b) || 0) + 1);
        if (perBand.size < 2 || Math.max(...perBand.values()) > 1 || [...g.blocks.values()].some((bk) => bk.chars > 260)) return false;
        // the smaller size must be the running text: at least as many blocks as the would-be leads (on a page
        // whose paragraphs are mostly one description per band, with a few smaller blocks, those descriptions
        // are the body)
        return G.some((o) => o !== g && o.size * 1.15 <= g.size && o.blocks.size >= Math.max(3, g.blocks.size) && nBands(o) >= 2 && o.chars >= g.chars * 0.25);
      }).map((g) => g.size));
      if (lead.size && para.some((t) => !lead.has(t.size))) { para = para.filter((t) => !lead.has(t.size)); leadOut = [...lead]; }
    }
    const bodyPool = para.length ? para : texts.filter((t) => !t.nav && !t.btn);
    const bodySize = +mode(bodyPool.map((t) => ({ k: t.size, t })), (a) => a.t.chars) || 16;
    roles.body = styleOf(bodyPool.filter((t) => t.size === bodySize), (t) => t.chars);
    if (roles.body) roles.body.how = (para.length ? 'char-weighted modal size of prose (blocks >= 40 chars, any tag, outside nav/footer/buttons)' : 'char-weighted modal size of all text (no prose found)')
      + (panelOut ? '; text in UI mock-up panels left out' : '') + (microOut ? `; ${microOut} left out` : '') + (leadOut ? `; lead paragraphs (${leadOut.join('/')}px, one per band) left out` : '');
    // lead: intro paragraphs larger than body (>= 1.1x body, at most one block per band, outside mock-ups),
    // recorded on the body role as body.lead; a record for the builder, never a role or scored
    if (roles.body) {
      const by = new Map();
      for (const t of paraAll) {
        if (t.size < bodySize * 1.1 || mockText(t)) continue;
        const g = by.get(t.size) || { chars: 0, ts: [], per: new Map() };
        g.chars += t.chars; g.ts.push(t);
        const s = g.per.get(t.b) || new Set(); s.add(t.blk); g.per.set(t.b, s);
        by.set(t.size, g);
      }
      const lg = [...by.values()].filter((g) => [...g.per.values()].every((s) => s.size <= 1)).sort((a, b) => b.chars - a.chars)[0];
      if (lg) {
        const o = styleOf(lg.ts, (t) => t.chars);
        roleEx.delete(o);
        roles.body.lead = { px: o.px, weight: o.weight, lh: o.lh, ls: o.ls, family: o.family, n: new Set(lg.ts.map((t) => t.blk)).size, ex: o.ex, band: o.band };
      }
    }
    const dispPool = texts.filter((t) => t.chars >= 2), dispNoStat = dispPool.filter((t) => !isStat(blocks.get(t.blk)));
    const dispT = (dispNoStat.length ? dispNoStat : dispPool).sort((a, b) => b.size - a.size)[0];
    if (dispT) { roles.display = styleOf([dispT]); roles.display.how = 'largest rendered text on the page' + (dispNoStat.length < dispPool.length && dispNoStat.length ? ' (stat figures left out)' : ''); }
    // aria-hidden text (decorative wordmarks, marquee copies) can be the display text but never a heading tier
    // footer column headings are labels, not a heading tier: blocks entirely in the footer are left out
    // (unless nothing else is heading-like); stat figures, text wordmarks, rows of text logos and keycap labels
    // are never a tier; a
    // statement-length block (>= 80 chars) under 1.25x body is running text whatever its tag (a statement
    // set as <h2> on one page and <p> on another reads the same)
    const headLike = (g) => (g.size >= bodySize * 1.25 || (g.h && g.chars < 80)) && !g.nav && !g.btn && !(g.el && g.el.closest && g.el.closest('[aria-hidden="true"]'));
    const hblocksAll = [...blocks.values()].filter((g) => headLike(g) && g.chars <= 240 && !isStat(g) && !wordmark(g) && !inMarkRow(g) && !keycap(g));
    const footerOnly = (g) => g.ts.every((t) => t.footer);
    const hblocks = hblocksAll.some((g) => !footerOnly(g)) ? hblocksAll.filter((g) => !footerOnly(g)) : hblocksAll;
    const tsOfBlocks = (gs) => gs.flatMap((g) => g.ts.filter((t) => t.size === g.size));
    // Heading roles come from size clusters and their use, never from tag counts: heading-like blocks
    // (heading tags or text >= 1.25x body; split-text spans collapsed into their block) whose sizes are
    // within 3% of the cluster's largest member form one cluster. h1 = the largest cluster (>= 1.2x body
    // when one exists); h2 / h3 = the next clusters below (each <= 0.97x the one above, >= 1.1x / 1.04x
    // body), preferring clusters used >= 2 times. `tags` = histogram of the member blocks' tags (record only).
    const clusters = [];
    for (const g of hblocks.slice().sort((a, b) => b.size - a.size)) {
      let c = clusters[clusters.length - 1];
      if (!c || g.size < c.top * 0.97) { c = { top: g.size, gs: [] }; clusters.push(c); }
      c.gs.push(g);
    }
    for (const c of clusters) {
      c.n = c.gs.length;
      c.size = +mode(c.gs.map((g) => ({ k: g.size })));
      c.tags = {};
      for (const g of c.gs) { const tg = g.h || g.el.tagName.toLowerCase(); c.tags[tg] = (c.tags[tg] || 0) + 1; }
    }
    const navI = bands.findIndex((b) => b.isNav);
    let contentBand = bands.findIndex((b, i) => !b.isNav && i > navI && (b.bot - b.top) >= 80 && !rc.isTp(b.el));
    if (contentBand < 0) contentBand = bands.findIndex((b) => !b.isNav);
    const fromCluster = (c, how) => { const o = styleOf(tsOfBlocks(c.gs)); if (!o) return null; o.n = c.n; o.tags = c.tags; o.how = how; return o; };
    const pickBelow = (above, floor, label) => {
      const below = clusters.slice(clusters.indexOf(above) + 1).filter((c) => c.size >= floor && c.size <= above.size * 0.97 + 0.01);
      const multi = below.find((c) => c.n >= 2);
      if (multi) return { c: multi, how: `next size cluster below ${label} used >= 2 times` };
      if (below.length) return { c: below[0], how: `next size cluster below ${label} (single use)` };
      return null;
    };
    const c1 = clusters.find((c) => c.size >= bodySize * 1.2) || clusters[0] || null;
    if (c1) {
      roles.h1 = fromCluster(c1, `largest heading-like size cluster (${c1.n} block${c1.n > 1 ? 's' : ''}, sizes within 3%)`);
      const p2 = pickBelow(c1, bodySize * 1.1, 'h1');
      if (p2) roles.h2 = fromCluster(p2.c, p2.how);
      const p3 = pickBelow(p2 ? p2.c : c1, bodySize * 1.04, p2 ? 'h2' : 'h1');
      if (p3) roles.h3 = fromCluster(p3.c, p3.how);
    }
    // stat figures (heading-like numeral blocks): the modal size, its modal weight + family, all of them counted
    let stats;
    {
      const sg = [...blocks.values()].filter((g) => headLike(g) && isStat(g));
      if (sg.length) {
        const k = +mode(sg.map((g) => ({ k: g.size })));
        const top = sg.filter((g) => g.size === k), ts = tsOfBlocks(top);
        const wf = mode(ts.map((t) => ({ k: `${t.weight}|${t.fam}` }))).split('|');
        stats = { px: k, weight: +wf[0], family: wf.slice(1).join('|'), n: sg.length, sample: blockTxt(top[0]).slice(0, 20), band: top[0].b, ex: rc.desc(top[0].el) };
      }
    }
    {
      const sm = texts.filter((t) => t.size < bodySize * 0.95 && t.size >= 9 && !t.btn);
      if (sm.length) {
        const k = +mode(sm.map((t) => ({ k: t.size })));
        roles.small = styleOf(sm.filter((t) => t.size === k)); roles.small.how = 'modal size among text smaller than body';
      }
    }
    {
      let nv = texts.filter((t) => t.nav && t.link && !t.btn && t.chars <= 40);
      const inNavTag = nv.filter((t) => closest(t.rec.el, /^NAV$/, 10) || t.rec.el.closest('[role=navigation]'));
      let navHow = 'modal style of links inside the nav';
      if (inNavTag.length) { nv = inNavTag; navHow = 'modal style of links inside <nav>'; }
      else if (nv.length > 1) { const mx = Math.max(...nv.map((t) => t.size)); const big = nv.filter((t) => t.size === mx); if (big.length === 1) nv = nv.filter((t) => t !== big[0]); navHow = 'modal style of header links (brand link excluded)'; }
      if (!nv.length) { nv = texts.filter((t) => t.nav && (t.link || t.btn) && t.chars <= 40); navHow = 'modal style of nav links/buttons'; }
      if (nv.length) { roles.nav = styleOf(nv); roles.nav.how = navHow; }
      const bt = texts.filter((t) => t.btn && !t.nav);
      const bt2 = bt.length ? bt : texts.filter((t) => t.btn);
      // weighted by the button's box area so large CTAs beat tiny UI-mock chips
      const bw = (t) => { const b = inBtn(t.rec.el); return b ? b.rec.w * b.rec.h : 1; };
      if (bt2.length) { roles.button = styleOf(bt2, bw); roles.button.how = 'area-weighted modal style of button-like labels' + (bt.length ? '' : ' (only nav buttons found)'); }
      const eb = texts.filter((t) => t.chars <= 40 && t.size <= bodySize * 1.15 && (t.tt === 'uppercase' || t.ls >= 0.04) && !t.nav && !t.btn && !t.footer && !t.h);
      const big = [...blocks.values()].filter((g) => g.size >= bodySize * 1.3 && !g.nav);
      const above = eb.filter((t) => big.some((g) => g.y >= t.rec.y + t.rec.h - 4 && g.y <= t.rec.y + t.rec.h + 120 && g.x < t.rec.x + t.rec.w + 40 && g.x + g.w > t.rec.x - 40));
      if (above.length) { roles.eyebrow = styleOf(above); roles.eyebrow.how = 'short uppercase/tracked label directly above a heading'; }
      else if (eb.length >= 2) { roles.eyebrow = styleOf(eb); roles.eyebrow.how = 'short uppercase/tracked label (not above a heading)'; }
    }
    // ---- per role: rendered line box (lhr, lhPx), advance (adv), ink probe spec, type sample ----
    // First rendered line of an element: characters laid out on the same line box as the first visible
    // character (Range client rects), as shown (text-transform applied), with its box in document px.
    const firstLine = (el, tt) => {
      const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const rg = document.createRange();
      let top = null, h0 = 0, txt = '', box = null, n = 0, stop = false;
      for (let node = tw.nextNode(); node && !stop; node = tw.nextNode()) {
        const pr = node.parentElement && R.get(node.parentElement);
        if (pr && pr.hid) continue;
        const s = node.data;
        for (let i = 0; i < s.length; i++) {
          if (++n > 600) { stop = true; break; }
          rg.setStart(node, i); rg.setEnd(node, i + 1);
          const r = rg.getClientRects()[0];
          const sp = /\s/.test(s[i]);
          if (!r || (r.width === 0 && r.height === 0)) { if (top !== null && sp) txt += ' '; continue; }
          if (top === null) { if (sp) continue; top = r.top; h0 = r.height || 1; }
          else if (r.top >= top + h0 * 0.6) { stop = true; break; }
          txt += s[i];
          if (!sp) box = box ? [Math.min(box[0], r.left), Math.min(box[1], r.top), Math.max(box[2], r.right), Math.max(box[3], r.bottom)] : [r.left, r.top, r.right, r.bottom];
        }
      }
      if (!box) return null;
      txt = txt.replace(/\s+/g, ' ').trim();
      if (tt === 'uppercase') txt = txt.toUpperCase(); else if (tt === 'lowercase') txt = txt.toLowerCase(); else if (tt === 'capitalize') txt = txt.replace(/(^|\s)(\S)/g, (m, a, c) => a + c.toUpperCase());
      return { text: txt.slice(0, 200), vis: txt.replace(/\s/g, '').length, bbox: [r1(box[0] + sx), r1(box[1] + sy), r1(box[2] - box[0]), r1(box[3] - box[1])] };
    };
    const samples = {}, inkSpec = [];
    {
      const meas = document.createElement('rc-measure');
      meas.setAttribute('style', 'all:initial!important;position:absolute!important;left:0!important;top:0!important;width:0!important;height:0!important;overflow:visible!important;visibility:hidden!important;pointer-events:none!important;');
      document.documentElement.appendChild(meas);
      const jobs = [];
      try {
        for (const [k, v] of Object.entries(roles)) {
          const ex = v && roleEx.get(v);
          if (!ex) continue;
          const cs = ex.t.rec.cs;
          // sample: the member whose first line is cleanest (plain background, one text colour, >= 6 visible
          // characters) with the highest text/background contrast (WCAG >= 4.5 preferred, 3-4.5 and below
          // ranked after); display / h1 prefer an occurrence in the first screen (the hero). The chosen line's
          // issues become sampleQuality {level, reason} (poor = do not trust it for font matching); the next
          // best candidates go out as alts (capture re-checks them all on the screenshot's pixels).
          const overMedia = (el, bb) => {
            if (!bb) return false;
            const [bx, by, bw, bh] = bb;
            for (let a = el, d = 0; a && a !== document.body && d < 7; a = a.parentElement, d++) {
              const acs = getComputedStyle(a);
              if (d > 0 && acs.backgroundImage && acs.backgroundImage.includes('url(')) return true;
              for (const mm of a.querySelectorAll('img,video,canvas,picture')) {
                const r = mm.getBoundingClientRect();
                const ix = Math.max(0, Math.min(r.right + scrollX, bx + bw) - Math.max(r.left + scrollX, bx)), iy = Math.max(0, Math.min(r.bottom + scrollY, by + bh) - Math.max(r.top + scrollY, by));
                if (ix * iy >= bw * bh * 0.5) return true;
              }
            }
            return false;
          };
          // a gradient is what shows behind the line (no solid fill in between); gradient-filled text excluded
          const gradBehind = (el) => {
            for (let a = el, d = 0; a && a !== document.documentElement && d < 14; a = a.parentElement, d++) {
              const acs = getComputedStyle(a), L = coverLayer(a, 0.9, 0.85);
              if ((acs.backgroundImage || '').includes('gradient') && !/text/.test(acs.backgroundClip || acs.webkitBackgroundClip || '')) return true;
              if (L && L.grad) return true;
              const c = rc.rgba(acs.backgroundColor);
              if ((c && c[3] >= 0.5) || (L && L.c && L.c[3] >= 0.5)) return false;
            }
            return false;
          };
          const wcag = (a, b) => { const f = (x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }; const l = (c) => 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); const p = l(a), q = l(b); return (Math.max(p, q) + 0.05) / (Math.min(p, q) + 0.05); };
          // the colours the line is drawn in: every element owning visible characters on the first line box
          // (fill colour, background-clip:text gradients), blended over what is behind it
          const lineInk = (el, bb) => {
            const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), rg = document.createRange();
            const top = bb[1] - sy, bot = bb[1] + bb[3] - sy, cols = [];
            let clip = false;
            for (let node = tw.nextNode(), n = 0; node && n < 80; node = tw.nextNode(), n++) {
              const pe = node.parentElement, pr = pe && R.get(pe);
              if (!pe || (pr && pr.hid) || !node.data.trim()) continue;
              rg.selectNodeContents(node);
              if (![...rg.getClientRects()].some((r) => r.width > 0 && r.top < bot - 1 && r.bottom > top + 1)) continue;
              // background-clip:text on the element or an ancestor paints its gradient through this text
              for (let a = pe, d = 0; a && a !== document.body && d < 8; a = a.parentElement, d++) { const acs = getComputedStyle(a); if (/text/.test(acs.backgroundClip || acs.webkitBackgroundClip || '') && (acs.backgroundImage || '').includes('gradient')) { clip = true; break; } }
              const ecs = getComputedStyle(pe), fill = rc.rgba(ecs.webkitTextFillColor);
              const c = blend(fill && fill[3] > 0 ? fill : rc.rgba(ecs.color), colorAt(pe));
              if (c && !cols.some((q) => Math.hypot(q[0] - c[0], q[1] - c[1], q[2] - c[2]) <= 24)) cols.push(c);
            }
            return { cols, clip };
          };
          const issuesOf = (m, fl) => {
            const out = [];   // [penalty, reason]
            if (overMedia(m.rec.el, fl.bbox)) out.push([8, 'busy background (text over an image, video or canvas)']);
            else if (gradBehind(m.rec.el)) out.push([4, 'busy background (gradient behind the line)']);
            const li = lineInk(m.rec.el, fl.bbox);
            if (li.clip) out.push([8, 'two colours in the line (gradient-filled text)']);
            else if (li.cols.length > 1) out.push([8, `two colours in the line (${li.cols.slice(0, 3).map((c) => rc.hex(c)).join(', ')})`]);
            const under = colorAt(m.rec.el), fg = blend(m.color, under), cr = fg && under ? wcag(fg, under) : 21;
            if (cr < 1.8) out.push([4, `low contrast (${Math.round(cr * 10) / 10}:1)`]);
            else if (cr < 3) out.push([2, null]);
            else if (cr < 4.5) out.push([1, null]);
            if ((k === 'display' || k === 'h1') && fl.bbox && fl.bbox[1] >= vh) out.push([1.5, null]);
            if (fl.vis < 4) out.push([2, `too few glyphs (${fl.vis})`]);
            else if (fl.vis < 6) out.push([1, null]);
            // nav: the header wordmark / logo link is drawn in the brand's lettering, not the menu's type: any
            // real nav link ranks first (a link to the site root other than a bare "#", or the element or its
            // link, up to 2 levels, named logo / brand / wordmark)
            if (k === 'nav') {
              const a = m.rec.el.closest && m.rec.el.closest('a[href]'), h = a ? (a.getAttribute('href') || '').trim() : '';
              let named = false;
              for (let e = m.rec.el, d = 0; e && e !== document.body && d < 3 && !named; e = e.parentElement, d++) { const cl = typeof e.className === 'string' ? e.className : (e.className && e.className.baseVal) || ''; named = /logo|brand|wordmark/i.test(`${cl} ${e.id || ''} ${e.getAttribute('aria-label') || ''}`); }
              if (named || (h && !h.startsWith('#') && homeLink(m.rec.el))) out.push([6, 'header wordmark or home link, not a menu link']);
            }
            return out;
          };
          const cands = [];
          for (const m of ex.members.slice(0, 40)) {
            const fl = firstLine(m.rec.el, m.tt);
            if (!fl) continue;
            const iss = issuesOf(m, fl), rk = iss.reduce((s2, x) => s2 + x[0], 0);
            cands.push({ m, fl, iss, rk });
            if (rk === 0 && fl.vis >= 6) break;
          }
          cands.sort((a, b) => a.rk - b.rk || b.fl.vis - a.fl.vis);
          const pick = cands[0] || null;
          const line = pick ? pick.fl.text : (ex.t.txt || INK_SAMPLE).slice(0, 80);
          const lsEm = cs.letterSpacing === 'normal' ? 0 : px(cs.letterSpacing) / v.px;
          const lhEl = document.createElement('rc-l');
          lhEl.setAttribute('style', fontCss(cs, { display: 'block', width: 'max-content', 'white-space': 'pre', 'line-height': cs.lineHeight, 'letter-spacing': cs.letterSpacing, 'word-spacing': cs.wordSpacing, 'text-transform': cs.textTransform }));
          lhEl.textContent = line || INK_SAMPLE;
          const adEl = document.createElement('rc-a');
          adEl.setAttribute('style', fontCss(cs, { display: 'block', width: 'max-content', 'white-space': 'pre', 'line-height': 'normal', 'letter-spacing': '0px' }));
          adEl.textContent = ADV_SAMPLE;
          meas.appendChild(lhEl); meas.appendChild(adEl);
          jobs.push({ k, v, lhEl, adEl });
          const sz0 = Math.max(6, Math.min(320, v.px));
          const sizes = sz0 <= 24 ? [sz0, sz0 * 0.94, sz0 * 1.06] : [sz0];
          inkSpec.push({ role: k, items: sizes.map((sz) => ({ sz: r2(sz), css: fontCss(cs, { 'font-size': `${r2(sz)}px`, 'letter-spacing': `${r2(lsEm * sz)}px` }) })) });
          if (o.full && pick) {
            const under = colorAt(pick.m.rec.el);
            const why = pick.iss.map((x) => x[1]).filter(Boolean);
            const q = (c) => { const w = c.iss.map((x) => x[1]).filter(Boolean); return w.length ? { level: 'poor', reason: w.join('; ') } : { level: 'good', reason: 'plain background, one text colour, readable contrast' }; };
            samples[k] = { text: pick.fl.text, bbox: pick.fl.bbox, px: v.px, weight: v.weight, declared: v.declared, ls: v.ls, color: rc.hex(blend(pick.m.color, under)), bg: rc.hex(under), family: v.family, style: /italic|oblique/.test(pick.m.fst || '') ? 'italic' : null,
              sampleQuality: q(pick),
              alts: cands.slice(1, 5).map((c) => { const u = colorAt(c.m.rec.el); return { text: c.fl.text, bbox: c.fl.bbox, color: rc.hex(blend(c.m.color, u)), bg: rc.hex(u), style: /italic|oblique/.test(c.m.fst || '') ? 'italic' : null, sampleQuality: q(c) }; }) };
          }
        }
        for (const j of jobs) {
          const lh = j.lhEl.getBoundingClientRect().height, aw = j.adEl.getBoundingClientRect().width;
          if (lh > 0) { j.v.lhPx = r1(lh); j.v.lhr = r3(lh / j.v.px); }
          if (aw > 0) j.v.adv = r3(aw / (j.v.px * ADV_SAMPLE.length));
        }
      } catch (e) { notes.push('type probes failed: ' + String(e && e.message || e).slice(0, 120)); }
      meas.remove();
    }
    rc.inkSpec = inkSpec;
    const sizes = ['display', 'h1', 'h2', 'h3', 'body', 'small'].filter((k) => roles[k]).map((k) => [k, roles[k].px]);
    const ratios = {};
    for (let i = 0; i < sizes.length - 1; i++) ratios[`${sizes[i][0]}/${sizes[i + 1][0]}`] = r2(sizes[i][1] / sizes[i + 1][1]);
    // families
    const famUse = new Map();
    for (const t of texts) {
      const f = famUse.get(t.stack) || { stack: t.stack, chars: 0, weights: new Set(), max: 0, min: 999, roles: new Set() };
      f.chars += t.chars; f.weights.add(t.weight); f.max = Math.max(f.max, t.size); f.min = Math.min(f.min, t.size);
      famUse.set(t.stack, f);
    }
    for (const [k, v] of Object.entries(roles)) { if (!v) continue; for (const f of famUse.values()) if (famOfStack(f.stack) === v.family) f.roles.add(k); }
    // measured proportions of a family: advance width of a fixed sample per em (width class) and x-height
    const famMetrics = (fam) => {
      try {
        cvs0.font = `400 100px ${GENERIC_F.test(fam) ? fam : `"${fam}"`}`;
        const s = 'Hamburgefonstiv';
        const adv = cvs0.measureText(s).width / (100 * s.length);
        const xh = cvs0.measureText('x').actualBoundingBoxAscent / 100;
        return { adv: r3(adv), xh: r3(xh), width: adv < WIDTH_CLASS[0] ? 'condensed' : adv > WIDTH_CLASS[1] ? 'extended' : 'normal' };
      } catch { return null; }
    };
    const typeOut = { roles, samples: o.full ? samples : undefined, stats, bodyPx: bodySize, ratios, families: [...famUse.values()].sort((a, b) => b.chars - a.chars).slice(0, 8).map((f) => ({ stack: f.stack.slice(0, 160), chars: f.chars, weights: [...f.weights].sort(), sizeRange: [f.min, f.max], roles: [...f.roles], rendered: famOfStack(f.stack), metrics: famMetrics(famOfStack(f.stack)) })) };

    // ---------- 5. media, controls ----------
    // Media = anything that paints a picture: <img>/<picture>/<video>/<canvas>/<iframe>, inline <svg>,
    // background-image boxes, and art boxes (no text inside, >= 48x48, a gradient or a solid fill that
    // differs from what is behind it). All kinds are equivalent and measured by painted area; nested
    // media keep only the outermost box.
    const tagMedia = recs.filter((r) => /^(IMG|VIDEO|CANVAS|IFRAME|svg|PICTURE)$/.test(r.tag) && r.w >= 12 && r.h >= 12 && !(r.tag === 'PICTURE' && r.el.querySelector('img')));
    const bgImgs = recs.filter((r) => r.cs.backgroundImage && r.cs.backgroundImage.includes('url(') && r.w >= 40 && r.h >= 40);
    const artBoxes = recs.filter((r) => {
      if (r.w < 48 || r.h < 48 || r.w >= vw * 0.95 || hasText.has(r.el) || /^(IMG|VIDEO|CANVAS|IFRAME|svg|PICTURE|INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(r.tag)) return false;
      const bi = r.cs.backgroundImage;
      if (bi && bi.includes('gradient')) return true;
      const c = rc.rgba(r.cs.backgroundColor);
      if (!c || c[3] < 0.5) return false;
      const p = r.el.parentElement ? rc.effBg(r.el.parentElement) : null;
      return !p || rc.hex(p) !== rc.hex(c);
    });
    const mediaAll = [...new Set([...tagMedia, ...bgImgs, ...artBoxes])];
    const mediaSet = new Set(mediaAll.map((m) => m.el));
    let media = mediaAll.filter((m) => { for (let p = m.el.parentElement; p && p !== document.body; p = p.parentElement) if (mediaSet.has(p)) return false; return true; });
    for (const m of media) m.mkind = /^(IMG|PICTURE)$/.test(m.tag) ? 'img' : m.tag === 'svg' ? 'svg' : /^(VIDEO|CANVAS|IFRAME)$/.test(m.tag) ? m.tag.toLowerCase() : m.cs.backgroundImage.includes('url(') ? 'bg-image' : 'art';
    // (HTML/CSS composite panels join `media` in section 6, once the repeated card grids are known)
    const mediaIn = (el) => media.some((m) => m.el === el || el.contains(m.el));
    const inputs = recs.filter((r) => (r.tag === 'INPUT' && !/^(hidden|checkbox|radio|submit|button|image|range|color|file)$/i.test(r.el.type)) || r.tag === 'TEXTAREA' || r.tag === 'SELECT');

    // ---------- 6. per-band analysis ----------
    const cardLike = (rec) => {
      const cs = rec.cs;
      const bg = rc.rgba(cs.backgroundColor);
      const parentBg = rec.el.parentElement ? rc.effBg(rec.el.parentElement) : null;
      if (bg && bg[3] > 0.05 && (!parentBg || rc.hex(bg) !== rc.hex(parentBg))) return true;
      if (px(cs.borderTopWidth) >= 1 && cs.borderTopStyle !== 'none') return true;
      if (cs.boxShadow !== 'none') return true;
      if (px(cs.borderTopLeftRadius) >= 6 && cs.overflow !== 'visible') return true;
      return false;
    };
    const sigK = (el) => { let c = ''; for (const x of el.classList) { if (!/active|visible|is-|aos|animate|reveal|show|hover/i.test(x)) { c = x; break; } } return el.tagName + '.' + c; };
    // collage: a row / card group whose items are all text-free media pieces of uneven size (largest /
    // smallest width or height >= 1.5) or overlapping each other is one media object, not columns or cards
    const mediaPiece = (k) => mediaIn(k.el) && !hasText.has(k.el);
    const spread = (v) => Math.max(...v) / Math.max(1, Math.min(...v));
    const overlapping = (g) => g.some((a, i) => g.some((b, j) => j > i && Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)) > 0.1 * Math.min(a.w * a.h, b.w * b.h)));
    const layoutOf = (bandEl, bandW, bandH) => {
      let best = null, cards = null;
      const consider = (el) => {
        const rec = R.get(el); if (!rec || rec.w < 40 || rec.h < 20) return;
        const kids = []; for (const k of el.children) { const kr = R.get(k); if (kr && kr.w >= 16 && kr.h >= 10 && kr.cs.position !== 'absolute' && kr.cs.position !== 'fixed') kids.push(kr); }
        if (kids.length < 2) return;
        const minTop = Math.min(...kids.map((k) => k.y));
        const rowAll = kids.filter((k) => Math.abs(k.y - minTop) < 14).sort((a, b) => a.x - b.x);
        // items in view: inside the viewport and not clipped away by an overflow ancestor (carousel slides)
        const row = rowAll.filter((k) => k.x + k.w > 2 && k.x < vw - 2 && !(k.vis < 0.5));
        let okRow = row.length >= 2;
        for (let i = 1; okRow && i < row.length; i++) if (row[i].x < row[i - 1].x + row[i - 1].w - 4) okRow = false;
        const fill = row.reduce((s, k) => s + Math.min(k.w, vw), 0) / Math.min(rec.w, vw);
        if (okRow && rec.w >= bandW * 0.4 && fill >= 0.6 && rec.h >= 100) {
          const area = Math.min(rec.w, vw) * rec.h;
          if (!best || area > best.area) best = { area, rec, row, overflow: rowAll.length > row.length };
        }
        // siblings group by tag + first stable class, and by tag alone (per-item class variants still group)
        const groups = new Map();
        for (const k of kids) for (const s of [sigK(k.el), 'T:' + k.el.tagName]) { const g = groups.get(s) || []; g.push(k); groups.set(s, g); }
        for (const g of groups.values()) {
          if (g.length < 3) continue;
          const mw = median(g.map((k) => k.w));
          const sim = g.filter((k) => Math.abs(k.w - mw) <= mw * 0.2);
          if (sim.length < 3 || mw < 60) continue;
          const like = sim.filter(cardLike).length >= sim.length * 0.5 || sim.filter((k) => mediaIn(k.el) && hasText.has(k.el)).length >= sim.length * 0.6;
          const score = sim.length * mw * median(sim.map((k) => k.h)) * (like ? 2 : 1);
          if (!cards || score > cards.score) cards = { score, g: sim, like };
        }
      };
      const walk = (el, d) => { consider(el); if (d > 9) return; for (const c of el.children) if (R.has(c)) walk(c, d + 1); };
      walk(bandEl, 0);
      const out = { cols: 1, ratios: [1], gap: null };
      if (best) {
        const tot = best.row.reduce((s, k) => s + k.w, 0);
        out.cols = best.row.length; out.ratios = best.row.map((k) => r2(k.w / tot));
        const gaps = []; for (let i = 1; i < best.row.length; i++) gaps.push(best.row[i].x - (best.row[i - 1].x + best.row[i - 1].w));
        out.gap = gaps.length ? Math.round(median(gaps)) : null;
        if (best.overflow) out.overflow = true;
        // main row height / band height: how much of the band this row is (a multi-screen band's largest row may be a small part)
        if (bandH > 0) out.rowCover = r2(Math.min(1, best.rec.h / bandH));
        if (best.row.every(mediaPiece) && (spread(best.row.map((k) => k.w)) >= 1.5 || spread(best.row.map((k) => k.h)) >= 1.5)) out.collage = true;
      }
      let cardsOut = null;
      if (cards) {
        const g = cards.g;
        const minTop = Math.min(...g.map((k) => k.y));
        const firstAll = g.filter((k) => Math.abs(k.y - minTop) < 14).sort((a, b) => a.x - b.x);
        const first = firstAll.filter((k) => k.x + k.w > 2 && k.x < vw - 2 && !(k.vis < 0.5));
        const tops = []; for (const k of g) if (!tops.some((t) => Math.abs(t - k.y) < 14)) tops.push(k.y);
        const gaps = []; for (let i = 1; i < first.length; i++) gaps.push(first[i].x - (first[i - 1].x + first[i - 1].w));
        // peek: the row overflows and the next item is partly visible (cut by the viewport or a clipping ancestor)
        const peek = firstAll.length > first.length && firstAll.some((k) => k.vis > 0.04 && k.vis < 0.9);
        cardsOut = { n: g.length, cols: first.length, rows: tops.length, gap: gaps.length ? Math.round(median(gaps)) : null, like: cards.like, w: Math.round(median(g.map((k) => k.w))), h: Math.round(median(g.map((k) => k.h))), overflow: firstAll.length > first.length || undefined, peek: peek || undefined, els: g.map((k) => k.el) };
        if (g.every(mediaPiece) && (out.collage || spread(g.map((k) => k.h)) >= 1.5 || overlapping(g))) cardsOut.collage = true;
      }
      return { layout: out, cards: cardsOut };
    };
    // layout of every band (main row, repeated card group), computed once
    const NOLAY = { layout: { cols: 1, ratios: [1], gap: null }, cards: null };
    const layAll = bands.map((b) => (b.isNav || b.unanalysed ? NOLAY : layoutOf(b.el, Math.min((R.get(b.el) || { w: vw }).w, vw), b.ob - b.ot)));
    // HTML/CSS composite panels (product mock-ups built from boxes) are media like images: a box with its
    // own fill / border / shadow (or a covering ::before/::after fill), >= 15% of its band's width and
    // >= 120 px tall, holding mostly small text (< body size, >= 3 text items or a nested box) and/or >= 3
    // nested filled or outlined boxes, with little heading text and no form fields; never an item of a
    // repeated card group, a button, the band itself or a box covering >= 85% of the band. Nav and footer
    // bands are left out. kind 'composite'; nested media inside a panel give way to the panel.
    {
      const gridItems = new Set(layAll.flatMap((l) => (l.cards ? l.cards.els : [])));
      const cand = new Map();
      for (const rec of recs) {
        const band = bands[rec.b];
        if (!band || band.isNav || band.unanalysed || rec.b === footerIdx) continue;
        const brec = R.get(band.el) || { w: vw };
        const bw = Math.min(vw, brec.w), bh = Math.max(1, band.ob - band.ot);
        if (rec.el === band.el || (band.els && band.els.includes(rec.el))) continue;
        if (rec.w < bw * 0.15 || rec.h < 120 || rec.w >= vw * 0.95 || rec.w * rec.h >= bw * bh * 0.85) continue;
        if (gridItems.has(rec.el) || btns.has(rec.el) || rec.cs.position === 'fixed' || /^(IMG|VIDEO|CANVAS|IFRAME|svg|PICTURE|INPUT|TEXTAREA|SELECT|BUTTON|FORM|TABLE)$/.test(rec.tag)) continue;
        if (!cardLike(rec) && !coverLayer(rec.el, 0.9, 0.9)) continue;
        cand.set(rec.el, { rec, chars: 0, small: 0, head: 0, nt: 0, boxes: 0, fields: 0 });
      }
      if (cand.size) {
        const up = (el, self, fn) => { for (let e = self ? el : el.parentElement; e && e !== document.body; e = e.parentElement) { const c = cand.get(e); if (c) fn(c); } };
        for (const t of texts) {
          const big = !!t.h || t.size >= bodySize * 1.25, small = !big && t.size < bodySize * 0.97;
          up(t.rec.el, true, (c) => { c.chars += t.chars; c.nt++; if (big) c.head += t.chars; else if (small) c.small += t.chars; });
        }
        for (const rec of recs) if (rec.w * rec.h >= 300 && boxy(rec.cs)) up(rec.el, false, (c) => { c.boxes++; });
        for (const r of inputs) up(r.el, false, (c) => { c.fields++; });
        const panels = [];
        for (const c of cand.values()) {
          if (c.fields || c.head > Math.max(12, c.chars * 0.15)) continue;
          const mostlySmall = c.chars >= 8 && c.small >= c.chars * 0.6 && (c.nt >= 3 || c.boxes >= 1);
          const boxes = c.boxes >= 3 && c.chars - c.small - c.head <= c.chars * 0.5;
          if (mostlySmall || boxes) panels.push(c.rec);
        }
        if (panels.length) {
          const all2 = [...new Set(mediaAll.concat(panels))];
          const set2 = new Set(all2.map((m) => m.el));
          const pset = new Set(panels);
          media = all2.filter((m) => { for (let p = m.el.parentElement; p && p !== document.body; p = p.parentElement) if (set2.has(p)) return false; return true; });
          for (const m of media) if (pset.has(m)) m.mkind = 'composite'; else if (!m.mkind) m.mkind = /^(IMG|PICTURE)$/.test(m.tag) ? 'img' : m.tag === 'svg' ? 'svg' : /^(VIDEO|CANVAS|IFRAME)$/.test(m.tag) ? m.tag.toLowerCase() : m.cs.backgroundImage.includes('url(') ? 'bg-image' : 'art';
        }
      }
    }
    // Stand-in boxes: media / illustration boxes whose insides are that box's media activity: the first-screen
    // media boxes (rc.heroMedia; a background-image box holding text is a band background, not one), and the
    // text-free media / art boxes and composite panels found here. A text-free element strictly inside one is
    // a piece of it: never a palette gradient, a scroll-linked animation or parallax (the same rule on any page).
    const standIn = new Set();
    for (const e of rc.heroEls || []) if (e && e.isConnected && !(hasText.has(e) && /url\(/.test(getComputedStyle(e).backgroundImage || ''))) standIn.add(e);
    for (const m of media) if (m.mkind === 'composite' || !hasText.has(m.el)) standIn.add(m.el);
    const pieceOf = (el) => { if (!el || el === document.body || rc.hasText(el)) return false; for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) if (standIn.has(p)) return true; return false; };
    const bgInfo = (cs) => {
      const c = rc.rgba(cs.backgroundColor);
      const bi = cs.backgroundImage && cs.backgroundImage !== 'none' ? cs.backgroundImage : null;
      return { c: c && c[3] >= 0.05 ? c : null, grad: bi && bi.includes('gradient') ? bi : null, img: bi && bi.includes('url(') };
    };
    // media behind content: covers >= 60% of the band and sits under its main heading (or covers ~all of it)
    const behindText = (m, head, area) => m.w * m.h >= area * 0.9 || (head && m.x <= head.x + 4 && m.x + m.w >= head.x + head.w - 4 && m.y <= head.y + 4 && m.y + m.h >= head.y + head.hh - 4);
    const bandBg = (b, area, head, M) => {
      const el = b.el;
      for (const m of M) {
        if (m.mkind === 'composite') continue;   // UI panels are content, never a band background
        if (m.w * m.h >= area * 0.6 && behindText(m, head, area)) {
          if (m.mkind === 'art') { const bi = bgInfo(m.cs); return { type: bi.grad ? 'gradient' : 'color', color: rc.hex(bi.c ? blend(bi.c, underOf(m.el)) : underOf(m.el)), gradient: bi.grad ? bi.grad.slice(0, 240) : undefined, src: 'media' }; }
          return { type: m.mkind === 'img' || m.mkind === 'bg-image' ? 'image' : m.mkind, color: rc.hex(underOf(m.el)), src: 'media' };
        }
      }
      const own = bgInfo(R.get(el) ? R.get(el).cs : getComputedStyle(el));
      const mk = (bi, src, e) => ({ type: bi.grad ? 'gradient' : bi.img ? 'image' : 'color', color: bi.c ? rc.hex(blend(bi.c, underOf(e))) : rc.hex(underOf(e)), gradient: bi.grad ? bi.grad.replace(/url\([^)]*\)/g, 'url()').slice(0, 240) : undefined, src });
      if (own.c && own.c[3] >= 0.5 || own.grad || own.img) return mk(own, 'self', el);
      // a painted ::before/::after layer covering >= 85% of the band counts like a child box
      const paints = (L) => (L.c && L.c[3] >= 0.5) || L.grad || L.img;
      const brec = R.get(el) || { x: 0, w: vw };
      const bb = [Math.max(0, brec.x), b.top, Math.min(vw, brec.x + brec.w), b.bot];
      const over = (L) => Math.max(0, Math.min(L.x + L.w, bb[2]) - Math.max(L.x, bb[0])) * Math.max(0, Math.min(L.y + L.h, bb[3]) - Math.max(L.y, bb[1]));
      const pl = (e) => (pseudoOf.get(e) || []).filter((L) => paints(L) && over(L) >= area * 0.85).sort((a, c) => c.w * c.h - a.w * a.h)[0] || null;
      const own2 = pl(el);
      if (own2) return mk({ c: own2.c, grad: own2.grad, img: own2.img }, 'pseudo', el);
      let found = null;
      const walk = (e, d) => {
        if (found || d > 4) return;
        for (const c of e.children) {
          const cr = R.get(c); if (!cr) continue;
          if (cr.w * cr.h >= area * 0.85) {
            const bi = bgInfo(cr.cs); if ((bi.c && bi.c[3] >= 0.5) || bi.grad || bi.img) { found = mk(bi, 'child', c); return; }
            const L = pl(c); if (L) { found = mk({ c: L.c, grad: L.grad, img: L.img }, 'pseudo', c); return; }
            walk(c, d + 1);
          }
        }
      };
      walk(el, 0);
      if (found) return found;
      let e = el.parentElement;
      while (e) {
        const bi = bgInfo(getComputedStyle(e)); if ((bi.c && bi.c[3] >= 0.5) || bi.grad || bi.img) return mk(bi, 'ancestor', e);
        const L = pl(e); if (L) return mk({ c: L.c, grad: L.grad, img: L.img }, 'pseudo', e);
        e = e.parentElement;
      }
      return { type: 'color', color: rc.hex(rootBg), src: 'root' };
    };
    // (numerals: NUM, section 4)
    // a price with its billing period inside one text run (never across separate nodes or SVG text)
    const PRICE = /([$€£¥]\s?\d[\d.,]*\s*(k|m)?\s*(\/\s?(mo|month|yr|year|user|seat)\b|per\s+(month|year|user|seat)\b|a\s+month\b|monthly\b|yearly\b))|(\b(free|\d+)\s*(\/\s?(mo|month)\b|per\s+month\b))/i;
    const bandRecs = new Map();
    for (const r of recs) { if (r.b < 0) continue; const a = bandRecs.get(r.b) || []; a.push(r); bandRecs.set(r.b, a); }
    const blocksOf = new Map();
    for (const g of blocks.values()) { if (g.b < 0) continue; const a = blocksOf.get(g.b) || []; a.push(g); blocksOf.set(g.b, a); }
    // in-flow: not inside a small or text-free absolutely positioned box placed within the band (slider
    // arrows, badges, decoration); absolutely positioned content blocks with text (masonry cards) still count
    const absCache = new Map();
    const inFlow = (r, bandEl) => {
      const a = r.absRoot;
      if (!a || a === bandEl || !bandEl.contains(a)) return true;
      if (!absCache.has(a)) { const ar = R.get(a) || a.getBoundingClientRect(); const w = ar.w ?? ar.width, h = ar.h ?? ar.height; absCache.set(a, w * h >= 20000 && hasText.has(a)); }
      return absCache.get(a);
    };
    // pass 1: per band content extent (own box geometry) and background
    const pre = bands.map((b, i) => {
      const el = b.el;
      const rec = R.get(el) || { x: 0, w: vw };
      const ownH = Math.max(1, b.ob - b.ot);
      const area0 = Math.max(1, Math.min(vw, rec.w) * ownH);
      const T = texts.filter((t) => t.b === i);
      const M = media.filter((m) => m.b === i);
      const G = blocksOf.get(i) || [];
      const hl = G.filter((g) => (g.h || g.size >= bodySize * 1.25) && !g.nav && !g.btn);
      const head = hl.slice().sort((a, c) => c.size - a.size)[0] || null;
      const BR = [...btns.values()].filter((x) => x.rec.b === i).map((x) => x.rec);
      const I = inputs.filter((r) => r.b === i);
      const surf = (bandRecs.get(i) || []).filter((r) => r.w >= 40 && r.h >= 20 && r.w * r.h < area0 * 0.6 &&
        (rc.rgba(r.cs.backgroundColor) || px(r.cs.borderTopWidth) >= 1 || r.cs.boxShadow !== 'none') && cardLike(r));
      // media are content (pad, contentX) unless they are the band's background: >= 60% of the band with
      // its main heading over them, or covering ~all of it; large art that is the first thing in a band counts
      const Mc = M.filter((m) => !((m.w * m.h >= area0 * 0.6 && head && m.x <= head.x + 4 && m.x + m.w >= head.x + head.w - 4 && m.y <= head.y + 4 && m.y + m.h >= head.y + head.hh - 4) || m.w * m.h >= area0 * 0.98));
      const content = T.map((t) => t.rec).concat(Mc, I, BR, surf).filter((r) => r.cs.position !== 'fixed' && inFlow(r, el));
      // art built from absolutely positioned pieces inside an in-flow, text-free box of the band (an illustration
      // wrapper that paints nothing itself): its visible pieces (clipped like they are drawn) are content for the
      // padding, so an art-led band measures to its first piece, never to an empty wrapper or to the first text
      const artHost = (m) => { let h = m.absRoot && m.absRoot.parentElement; while (h && absOf.get(h)) h = absOf.get(h).parentElement; const hr = h && R.get(h); return !!hr && h !== el && el.contains(h) && !hasText.has(h) && hr.w < vw * 0.95; };
      const pieceY = Mc.filter((m) => m.cs.position !== 'fixed' && !inFlow(m, el) && artHost(m)).map((m) => { const c = clipOf.get(m.el.parentElement); return [Math.max(m.y, c ? c[1] : -1e9), Math.min(m.y + m.h, c ? c[3] : 1e9)]; }).filter((p) => p[1] > p[0]);
      // absolutely positioned pictures are content where they are drawn (clipped like they are drawn), the same as
      // in-flow ones: a sizeable img / picture / svg / video / canvas / iframe / background-image box (>= 48 px each
      // way, >= 20000 px2) inside an absolutely positioned box of the band (not fixed), and a fill layer covering
      // >= 90% of the in-flow box it is laid over (it paints that box's surface, like a ::before fill)
      const absPic = Mc.filter((m) => {
        if (m.mkind === 'composite' || m.cs.position === 'fixed' || inFlow(m, el)) return false;
        const ar = R.get(m.absRoot);
        if (ar && ar.cs.position === 'fixed') return false;
        if (m.mkind === 'art') { const pr = m.absRoot === m.el && m.el.parentElement ? R.get(m.el.parentElement) : null; return !!pr && m.w >= pr.w * 0.9 && m.h >= pr.h * 0.9; }
        return m.w >= 48 && m.h >= 48 && m.w * m.h >= 20000;
      }).concat((bandRecs.get(i) || []).filter((r) => {
        // (a filled layer laid over an in-flow box paints that box's surface, so it is not an art box itself)
        if (r.el === el || r.absRoot !== r.el || r.cs.position !== 'absolute' || r.w < 40 || r.h < 20 || r.w * r.h >= area0 * 0.6 || boxy(r.cs) !== 'fill') return false;
        const p = r.el.parentElement, pr = p && R.get(p);
        return !!pr && !absOf.get(p) && r.w >= pr.w * 0.9 && r.h >= pr.h * 0.9;
      })).map((m) => { const c = clipOf.get(m.el.parentElement); return { y0: Math.max(m.y, c ? c[1] : -1e9), y1: Math.min(m.y + m.h, c ? c[3] : 1e9), x0: Math.max(m.x, c ? c[0] : -1e9, 0), x1: Math.min(m.x + m.w, c ? c[2] : 1e9, vw) }; }).filter((p) => p.y1 > p.y0 && p.x1 > p.x0);
      const ys = content.map((r) => [r.y, r.y + r.h]).concat(pieceY, absPic.map((p) => [p.y0, p.y1]));
      const ext = ys.length ? [Math.min(...ys.map((p) => p[0])), Math.max(...ys.map((p) => p[1]))] : null;
      const xs = content.filter((r) => r.w < vw * 0.95).map((r) => [r.x, r.x + r.w]).concat(absPic.filter((p) => p.x1 - p.x0 < vw * 0.95).map((p) => [p.x0, p.x1]));
      const lr = xs.length ? [Math.min(...xs.map((p) => p[0])), Math.max(...xs.map((p) => p[1]))] : null;
      const bg = b.isNav ? null : bandBg(b, area0, head, M);
      return { T, M, G, hl, head, BR, I, ext, lr, bg };
    });
    // pass 2: place each boundary between consecutive bands so that the same visual gap reads the same
    // whether it is margin or padding: on the same background the whitespace between the last content
    // of one band and the first content of the next is split evenly; across a background change the
    // boundary is the colour edge and any gap between the boxes goes to the band whose colour it shows.
    const sameBg = (a, c) => a && c && a.type === c.type && a.type !== 'image' && a.type !== 'video' && a.type !== 'canvas' && a.color === c.color && (a.type !== 'gradient' || a.gradient === c.gradient);
    for (let i = 1; i < bands.length; i++) {
      const A = bands[i - 1], Bn = bands[i];
      if (A.virtual || Bn.virtual) continue;
      Bn.gapBefore = Math.max(0, Math.round(Bn.ot - A.ob));
      if (A.isNav || Bn.isNav) continue; // header bands keep their own box; space below them goes to the next band
      const pa = pre[i - 1], pb = pre[i];
      let cut;
      if (pa.ext && pb.ext && sameBg(pa.bg, pb.bg)) cut = pa.ext[1] <= pb.ext[0] ? (pa.ext[1] + pb.ext[0]) / 2 : Bn.ot;
      else if (Bn.ot <= A.ob) cut = Bn.ot;
      else {
        const gapC = rc.hex(underOf(Bn.el));
        cut = pb.bg && gapC === pb.bg.color ? A.ob : pa.bg && gapC === pa.bg.color ? Bn.ot : (A.ob + Bn.ot) / 2;
      }
      A.bot = cut; Bn.top = cut;
    }
    if (bands.length) {
      const f = bands.find((b) => !b.virtual);
      if (f && f.top > 0 && f.top < vh * 1.5) f.top = 0;
      const last = bands[bands.length - 1];
      if (!last.virtual && docH > last.bot && docH - last.bot < vh) last.bot = docH;
    }
    const tpRoots = (rc.tpRoots || []).map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0).map((r) => ({ x: r.left + sx, y: r.top + sy, w: r.width, h: r.height }));
    const sections = bands.map((b, i) => {
      const el = b.el;
      const h = Math.max(1, b.bot - b.top);
      const rec = R.get(el) || { x: 0, w: vw };
      const area = Math.max(1, Math.min(vw, rec.w) * h);
      const P = pre[i];
      const { T, M, G, hl, head, I } = P;
      const BRe = [...btns.values()].filter((x) => x.rec.b === i);
      const BR = bandRecs.get(i) || [];
      const links = BR.filter((r) => r.tag === 'A').length;
      const chars = T.reduce((s, t) => s + t.chars, 0);
      const headTags = BR.filter((r) => /^H[1-6]$/.test(r.tag)).length;
      const kinds = (k) => M.filter((m) => m.mkind === k).length;
      const imgs = kinds('img') + kinds('bg-image'), svgs = kinds('svg');
      const bigNums = T.filter((t) => t.size >= bodySize * 1.6 && t.txt.length <= 14 && NUM.test(t.txt)).length;
      const prices = G.filter((g) => PRICE.test(g.ts.map((t) => t.txt).join(' '))).length;
      const quotes = BR.filter((r) => r.tag === 'BLOCKQUOTE' || r.tag === 'Q').length + G.filter((g) => g.chars >= 30 && /^[“"«„]/.test(g.ts[0] ? g.ts[0].txt : '')).length;
      const mediaArea = M.reduce((s, m) => s + Math.min(m.w * m.h, area), 0);
      const lay = layAll[i];
      let pad = null;
      if (P.ext && !b.isNav) pad = [Math.max(0, Math.round(P.ext[0] - b.top)), Math.max(0, Math.round(b.bot - P.ext[1]))];
      // alignment
      const al = { left: 0, center: 0, right: 0 };
      for (const t of T) { if (t.chars < 8 || t.nav || t.btn) continue; const a = t.align === 'center' ? 'center' : (t.align === 'right' || t.align === 'end') ? 'right' : 'left'; al[a] += t.chars; }
      const alT = al.left + al.center + al.right;
      let align = null;
      if (alT) { const top = Object.entries(al).sort((a, c) => c[1] - a[1])[0]; align = top[1] / alT >= 0.6 ? top[0] : 'mixed'; }
      // media placement (largest picture-painting box of any kind)
      let mediaPl = { place: 'none' };
      const bigM = M.filter((m) => m.w * m.h >= area * 0.04).sort((a, c) => c.w * c.h - a.w * a.h)[0];
      if (bigM) {
        const frac = Math.min(1, bigM.w * bigM.h / area);
        const cx = bigM.x + bigM.w / 2 - vw / 2;
        let place;
        if (frac >= 0.6 && behindText(bigM, head, area)) place = 'background';
        else if (bigM.w >= vw * 0.95) place = 'full-bleed';
        else if (cx < -vw * 0.08) place = 'left';
        else if (cx > vw * 0.08) place = 'right';
        else if (head && bigM.y >= head.y + head.hh - 4) place = 'below';
        else if (head && bigM.y + bigM.h <= head.y + 4) place = 'above';
        else place = 'center';
        mediaPl = { place, kind: bigM.mkind, frac: r2(frac) };
      }
      const headPx = T.length ? Math.max(...T.map((t) => t.size)) : null;
      // article list: >= 3 repeated items side by side (a grid, not stacked rows), each with sizeable media + text
      const articles = lay.cards && lay.cards.cols >= 2 ? lay.cards.els.filter((c) => { const big = media.filter((m) => c.contains(m.el) || m.el === c).sort((a, z) => z.w * z.h - a.w * a.h)[0]; return big && big.w * big.h >= 15000 && hasText.has(c); }).length : 0;
      // logo row: >= 4 marks (small media or short wordmarks) in one row, little other text, no big heading
      // (marks scrolled out of view in a marquee/overflow row still count: they are part of the row)
      const geoMarks = [...R.values()].filter((r) => r.b === i && /^(IMG|svg)$/.test(r.tag) && !r.el.parentElement.closest('svg') && r.h >= 12 && r.h <= 90 && r.w <= 280 && r.vis !== undefined && r.cs.visibility !== 'hidden');
      const marks = geoMarks.map((m) => ({ y: m.y + m.h / 2, h: m.h }))
        .concat(T.filter((t) => t.chars <= 24 && !t.nav && !t.btn && !t.h && (t.size >= bodySize * 1.1 || t.weight >= 600) && t.rec.h <= 90).map((t) => ({ y: t.rec.y + t.rec.h / 2, h: t.rec.h, chars: t.chars })));
      let rowN = 0, markChars = 0;
      for (const m of marks) { const row = marks.filter((x) => Math.abs(x.y - m.y) < 24 && x.h <= m.h * 2.2 && m.h <= x.h * 2.2); if (row.length > rowN) { rowN = row.length; markChars = row.reduce((s, x) => s + (x.chars || 0), 0); } }
      const words = chars / 6;
      // third-party chrome: the band is (or is mostly) an ad slot / embed, or is empty and above the nav
      const tpArea = tpRoots.reduce((s, r) => s + Math.max(0, Math.min(r.x + r.w, vw) - Math.max(r.x, 0)) * Math.max(0, Math.min(r.y + r.h, b.bot) - Math.max(r.y, b.top)), 0);
      const empty = !P.ext;
      const thirdParty = !b.isNav && (rc.isTp(el) || tpArea >= area * 0.6 || (empty && (tpArea > 0 || navI > i)));
      // role (structure only; class names and wording are never used)
      let role = 'other', why = 'no rule matched';
      if (b.isNav) { role = 'nav'; why = b.virtual ? `${b.pos} header outside the band flow` : 'short header band with links'; }
      else if (b.unanalysed) { role = 'other'; why = 'not analysed (element cap or time budget)'; }
      else if (thirdParty) { role = 'ad'; why = empty ? 'empty slot (ad / embed placeholder)' : 'third-party chrome (ad slot, consent, chat widget)'; }
      else if (navI > i && h < vh * 0.5) { role = 'other'; why = h < 80 ? 'thin bar above the nav (announcement)' : 'band above the nav (promo)'; }
      else if (i === footerIdx || (i === lastBand && (links >= 8 || el.tagName === 'FOOTER'))) { role = 'footer'; why = i === footerIdx ? 'footer tag / contentinfo' : 'last band with many links'; }
      else if (i === contentBand && (T.some((t) => t.h === 'h1') || (headPx && headPx >= bodySize * 2)) && h >= vh * 0.3) { role = 'hero'; why = 'first content band with the page title / largest text'; }
      else if (rowN >= 4 && (words - markChars / 6) < 45 && (!head || head.size < bodySize * 2.2)) { role = 'logos'; why = `${rowN} logo marks in one row, little text`; }
      else if (prices >= 2) { role = 'pricing'; why = `${prices} prices with a billing period`; }
      else if (bigNums >= 3) { role = 'stats'; why = `${bigNums} large numerals`; }
      else if (quotes >= 1) { role = 'testimonial'; why = 'blockquote / quoted text'; }
      else if (articles >= 3) { role = 'article-list'; why = `${articles} items side by side, each with media + text`; }
      else if (M.length >= 4 && mediaArea / area > 0.45 && words < 80) { role = 'gallery'; why = 'mostly media'; }
      else if (h < vh * 0.8 && BRe.length >= 1 && BRe.length <= 4 && hl.length <= 4 && words < 150 && i >= bands.length - 3 && head && head.size >= bodySize * 1.6 && !(lay.cards && lay.cards.n >= 3 && lay.cards.like)) { role = 'cta'; why = 'short band with a large heading + buttons near the end'; }
      else if (lay.cards && lay.cards.n >= 3) { role = 'features'; why = `${lay.cards.n} repeated cards`; }
      else if (hl.length >= 1 && M.length >= 1) { role = 'features'; why = 'heading + media'; }
      else if (hl.length >= 1 && BRe.length >= 1 && words < 70) { role = 'cta'; why = 'heading + buttons, little text'; }
      return {
        id: b.virtual ? 'nav-' + rc.idOf(el) : rc.idOf(el), sig: rc.sig(el), sigs: (b.els || [el]).filter((e) => e !== el).map((e) => rc.sig(e)).concat([rc.sig(el)]), desc: rc.desc(el), role, why,
        y: Math.round(b.top), h: Math.round(h), w: Math.round(Math.min(rec.w, vw)), gapBefore: b.gapBefore || undefined,
        bg: b.isNav ? { type: 'color', color: rc.hex(blend(rc.effBg(el), underOf(el)) || rootBg), src: 'nav' } : bandBg(b, area, head, M),
        layout: lay.layout, cards: lay.cards ? (({ els, ...c }) => c)(lay.cards) : null,
        counts: { headings: headTags, headingLike: hl.length, paragraphs: BR.filter((r) => r.tag === 'P').length, buttons: BRe.length, links, media: M.length, images: imgs, svgs, art: kinds('art'), videos: kinds('video'), canvas: kinds('canvas'), composites: kinds('composite'), inputs: I.length, words: Math.round(words) },
        align, media: mediaPl, headPx, pad, contentX: P.lr ? [Math.round(P.lr[0]), Math.round(P.lr[1])] : null,
        navOverlay: !!b.navOverlay || undefined, virtual: b.virtual || undefined, pos: b.pos,
        analysed: b.unanalysed ? false : undefined, thirdParty: thirdParty || undefined, empty: empty && !b.isNav ? true : undefined,
        link: b.link ?? undefined,
        _cards: lay.cards ? lay.cards.els : null,
      };
    });

    // ---------- 7. colours (raw areas) ----------
    const C = new Map();
    // ex = an example element (desc and band index) painting that colour, for actionable findings
    const addC = (c, kind, ctx, area, on, exEl) => { if (!c || !(area > 0)) return; const key = kind + '|' + ctx + '|' + rc.hex(c) + '|' + (on || ''); const e = C.get(key); if (e) { e.area += area; e.n++; if (exEl && area > e.exA) { e.exA = area; e.ex = exEl; } } else C.set(key, { hex: rc.hex(c), kind, ctx, area, n: 1, on: on || undefined, ex: exEl || null, exA: exEl ? area : 0 }); };
    const adBand = new Set(sections.map((s, i) => (s.role === 'ad' ? i : -1)).filter((i) => i >= 0));
    const thin = (r) => Math.min(r.w, r.h) <= 3;
    const cardSet = new Set(sections.flatMap((s) => s._cards || []));
    const bandSet = new Set(bands.map((b) => b.el));
    const btnBox = new Map([...btns.values()].map((x) => [x.boxEl, x]));
    const occ = new Set(), excl = new Map();
    for (const rec of recs) {
      if (adBand.has(rec.b)) continue;
      const bi = bgInfo(rec.cs);
      const isMedia = /^(IMG|VIDEO|CANVAS|IFRAME|PICTURE)$/.test(rec.tag);
      // 1-3 px filled boxes are rules/dividers: border colour, not a surface
      if (thin(rec) && bi.c && !bi.img && !bi.grad) { addC(blend(bi.c, underOf(rec.el)), 'border', 'hairline', Math.max(rec.w, rec.h) * Math.min(rec.w, rec.h), null, rec.el); continue; }
      if ((bi.c && bi.c[3] >= 0.5) || bi.img || bi.grad || isMedia) { occ.add(rec.el); excl.set(rec.el, inDoc(rec)); }
    }
    let topCover = 0;
    const occParent = new Map();
    for (const el of occ) {
      let p = el.parentElement;
      while (p && !occ.has(p)) p = p.parentElement;
      occParent.set(el, p);
      const a = excl.get(el);
      if (p && p !== document.documentElement) excl.set(p, Math.max(0, excl.get(p) - a)); else topCover += a;
    }
    const ctxOf = (el, rec) => el === document.body ? 'page' : btnBox.has(el) ? 'button' : cardSet.has(el) ? 'card' : bandSet.has(el) ? 'band' : (navEl && (navEl === el || navEl.contains(el))) ? 'nav' : /^(INPUT|TEXTAREA|SELECT)$/.test(rec.tag) ? 'input' : (rec.w >= vw * 0.9 && rec.h >= 120) ? 'band' : 'other';
    // painted ::before/::after layers hide what is under them like a child box: their visible area
    // (minus painted boxes inside the owner that sit over them) is taken from the owner's background or
    // the nearest painted ancestor (the page when there is none)
    const pseudoPaint = [];
    {
      const tP = performance.now();
      const ovl = (r, L) => Math.max(0, Math.min(r.x + r.w, L.x + L.w) - Math.max(r.x, L.x)) * Math.max(0, Math.min(r.y + r.h, L.y + L.h) - Math.max(r.y, L.y));
      for (const L of pseudoL) {
        const o = L.owner;
        if (adBand.has(o.b) || !((L.c && L.c[3] >= 0.5) || L.grad || L.img)) continue;
        const A = L.w * Math.max(0, Math.min(L.y + L.h, docH) - Math.max(L.y, 0));
        let covered = 0;
        if (A >= 2000 && performance.now() - tP < 3000) {
          for (const e of occ) {
            if (e === o.el || !o.el.contains(e)) continue;
            const p = occParent.get(e);
            if (p && p !== o.el && o.el.contains(p)) continue;
            covered += ovl(R.get(e), L);
          }
        }
        const eff = Math.max(0, A - covered);
        let p = o.el;
        while (p && !occ.has(p)) p = p.parentElement;
        if (p && p !== document.documentElement) excl.set(p, Math.max(0, excl.get(p) - eff)); else topCover += eff;
        pseudoPaint.push({ L, A, eff });
      }
    }
    const docArea = vw * docH;
    addC(rootBg, 'bg', 'page', Math.max(0, docArea - topCover));
    let mediaArea = 0, imgBgArea = 0;
    const gradients = new Map();
    // pictures (img/video/canvas/picture/iframe and background-image boxes): a gradient box lying over one
    // (>= 50% of the gradient box) or layered over its own url() image is an overlay on media (caption
    // scrims, photo fades); a gradient box under 64 px on its short side is a strip. Both are recorded per
    // gradient (onMedia / thin = every instance is one) so compare can leave them out of band gradients.
    const picRects = [...tagMedia.filter((r) => r.tag !== 'svg'), ...bgImgs].filter((r) => r.w * r.h >= 4000).map((r) => [r.x, r.y, r.w, r.h]);
    const onPic = (x, y, w, h) => { const A = w * h; if (!(A > 0)) return false; for (const [px0, py0, pw, ph] of picRects) { const ix = Math.min(x + w, px0 + pw) - Math.max(x, px0), iy = Math.min(y + h, py0 + ph) - Math.max(y, py0); if (ix > 0 && iy > 0 && ix * iy >= A * 0.5) return true; } return false; };
    const addGrad = (grad, area, ctx, b, box) => {
      const css = grad.replace(/url\([^)]*\)/g, 'url()').slice(0, 300);
      const g = gradients.get(css) || { css, n: 0, area: 0, ctx: new Set(), bands: new Set(), clipText: false, onMedia: 0, thin: 0 };
      g.n++; g.area += area; g.ctx.add(ctx); if (b >= 0) g.bands.add(b);
      if (box) { if (/url\(/.test(grad) || onPic(box[0], box[1], box[2], box[3])) g.onMedia++; if (Math.min(box[2], box[3]) < 64) g.thin++; }
      gradients.set(css, g);
    };
    for (const el of occ) {
      const rec = R.get(el); const bi = bgInfo(rec.cs); const a = excl.get(el);
      if (/^(IMG|VIDEO|CANVAS|IFRAME|PICTURE)$/.test(rec.tag)) { mediaArea += inDoc(rec); continue; }
      if (bi.img && !bi.grad) imgBgArea += inDoc(rec);
      const ctx = ctxOf(el, rec);
      if (bi.c && bi.c[3] >= 0.5) addC(blend(bi.c, underOf(el)), 'bg', ctx, a, null, el);
      if (bi.grad && !pieceOf(el)) addGrad(bi.grad, inDoc(rec), ctx, rec.b, [rec.x, rec.y, rec.w, rec.h]);   // a stand-in's gradient layers paint its media
    }
    // pseudo layers: fill area (composited over the owner's own background, else what is behind the
    // owner), gradients with the owner's context, image layers as image area
    for (const { L, A, eff } of pseudoPaint) {
      const o = L.owner, ctx = ctxOf(o.el, o);
      const oc = rc.rgba(o.cs.backgroundColor);
      const under = oc && oc[3] >= 0.5 ? blend(oc, rootBg) : o.el === document.body ? rootBg : colorAt(o.el.parentElement);
      if (L.c && L.c[3] >= 0.5) addC(blend(L.c, under), 'bg', ctx, eff, null, o.el === document.body ? null : o.el);
      if (L.grad) { if (!pieceOf(o.el)) addGrad(L.grad, A, ctx, o.b, [L.x, L.y, L.w, L.h]); }
      else if (L.img) imgBgArea += A;
    }
    // text-clip gradients (no box) are not occluders
    for (const rec of recs) {
      const clip = rec.cs.backgroundClip === 'text' || rec.cs.webkitBackgroundClip === 'text';
      if (clip && rec.cs.backgroundImage.includes('gradient')) {
        const css = rec.cs.backgroundImage.slice(0, 300);
        const g = gradients.get(css) || { css, n: 0, area: 0, ctx: new Set(), bands: new Set(), clipText: true };
        g.n++; g.clipText = true; g.ctx.add('text'); if (rec.b >= 0) g.bands.add(rec.b); gradients.set(css, g);
      }
    }
    // Logo / brand marks are the brand, not the palette: their colours are never an accent or a minor
    // colour, on either side of a comparison. A mark = an svg or img inside a link to the home page
    // (/, #, this page) in the header (nav band, a header/banner box near the top, the top 120 px) or the
    // footer; text of <= 30 chars in a header link to the site root or this page (a bare "#" is a
    // placeholder link, not home); an element <= 400x160 px named as a logo up to 3 levels up (class token with logo / wordmark /
    // brand-mark, a token "brand", "*-brand" or "brand-logo"; id, aria-label or title with logo); or an
    // item of a logo strip (>= 4 svg/img of similar height <= 100 px in one row under a common ancestor
    // <= 240 px tall, at least half of them wider than 1.6x their height, <= 12 text characters per item).
    // Their chromatic colours are recorded in colorsRaw.brandMarks.
    const brandCache = new Map(), stripCache = new Map(), brandHex = new Map();
    const BRAND_TOK = /logo|wordmark|brand-?mark|^brand$|[-_]brand$|^brand[-_]+(logo|mark|link|icon|name|home)/i;
    const brandNamed = (el) => {
      for (let e = el, d = 0; e && e !== document.body && d < 4; e = e.parentElement, d++) {
        const cl = typeof e.className === 'string' ? e.className : (e.className && e.className.baseVal) || '';
        if (cl.split(/\s+/).some((x) => x && BRAND_TOK.test(x)) || /logo|wordmark/i.test(`${e.id || ''} ${e.getAttribute('aria-label') || ''} ${e.getAttribute('title') || ''}`)) return true;
      }
      return false;
    };
    const headerRec = (r) => (bands[r.b] && bands[r.b].isNav) || r.y + r.h <= 120 || (() => { const h = r.el.closest && r.el.closest('header,[role=banner]'); const hr = h && R.get(h); return !!hr && hr.y < vh * 0.5 && hr.h <= 260; })();
    const logoStrip = (el) => {
      for (let a = el.parentElement, d = 0; a && a !== document.body && d < 4; a = a.parentElement, d++) {
        if (!stripCache.has(a)) {
          const ar = R.get(a);
          let ok = false;
          if (ar && ar.h <= 240) {
            const ms = [...a.querySelectorAll('svg,img')].slice(0, 80).map((m) => R.get(m)).filter((m) => m && m.h >= 8 && m.h <= 100);
            if (ms.length >= 4) {
              const mh = median(ms.map((m) => m.h)), my = median(ms.map((m) => m.y + m.h / 2));
              const row = ms.filter((m) => m.h >= mh * 0.5 && m.h <= mh * 2 && Math.abs(m.y + m.h / 2 - my) <= mh);
              ok = row.length >= 4 && row.filter((m) => m.w >= m.h * 1.6).length >= row.length * 0.5 && (a.textContent || '').trim().length <= 12 * row.length;
            }
          }
          stripCache.set(a, ok);
        }
        if (stripCache.get(a)) return true;
      }
      return false;
    };
    // a text wordmark links to the site root or this page itself (not a bare "#", which builds use for
    // placeholder links), sits in the header and is short
    const rootLink = (el) => { const a = el.closest && el.closest('a[href]'); if (!a) return false; const h = (a.getAttribute('href') || '').trim(); if (!h || h.startsWith('#')) return false; return homeLink(el); };
    const brandMark = (el) => {
      if (!el) return false;
      if (brandCache.has(el)) return brandCache.get(el);
      const r = R.get(el);
      let ok = false;
      const graphic = r && /^(svg|IMG|PICTURE)$/.test(r.tag);
      if (r) ok = (graphic && homeLink(el) && (headerRec(r) || isFooter(r) || r.b === footerIdx))
        || (!graphic && rootLink(el) && headerRec(r) && (el.textContent || '').trim().length <= 30)
        || (r.w <= 400 && r.h <= 160 && brandNamed(el)) || (graphic && logoStrip(el));
      brandCache.set(el, ok);
      return ok;
    };
    const noteBrand = (c, el) => { if (!c || chroma(c) < 0.18) return; const h = rc.hex(c); if (!brandHex.has(h)) brandHex.set(h, { hex: h, ex: rc.desc(el), band: R.get(el) ? R.get(el).b : -1 }); };
    for (const t of texts) {
      if (brandMark(t.rec.el)) { noteBrand(blend(t.color, underOf(t.rec.el)), t.rec.el); continue; }
      // footer link lists are navigation, not interactive accents: footer text counts as footer before link
      const ctx = t.btn ? 'button' : t.nav ? 'nav' : t.h || t.size >= bodySize * 1.25 ? 'heading' : t.footer ? 'footer' : t.link ? 'link' : 'body';
      const under = underOf(t.rec.el);
      addC(blend(t.color, under), 'text', ctx, t.chars * t.size * t.size * 0.5, rc.hex(under), t.rec.el);
    }
    // Running text and visible actions: the evidence for the text / mutedText and accent roles (the same rule
    // on any page, reference or build).
    //   running text = text outside buttons, nav, tab/menu controls, UI mock-up panels, media / art /
    //   stand-in boxes and aria-hidden copies, not lying over a picture (photo, video or background image under
    //   >= 50% of its box: hero captions on photos), drawn at an effective opacity >= 0.3; each entry keeps the
    //   colour behind it (on) and its band, so colors.mjs lets only text on the page background vote.
    //   actions = filled buttons with a visible label, icon-only filled controls of 28-96 px outside the footer
    //   (iconAct), and text links outside nav and footer link lists, with the
    //   same exclusions at effective opacity >= 0.5 (a swatch button with no visible label, a send button inside
    //   a mock-up, a hidden / opacity-0 / off-screen / inactive-slide control is never an action; hidden ones
    //   are not in recs at all). Brand marks are left out.
    const opCache = new Map();
    const effOp = (el) => { if (!el || el === document.documentElement || el === document) return 1; if (opCache.has(el)) return opCache.get(el); const r0 = R.get(el); const v = (+(((r0 && r0.cs) || getComputedStyle(el)).opacity) || 0) * effOp(el.parentElement); opCache.set(el, v); return v; };
    const standAnc = (el) => { for (let p = el; p && p !== document.body; p = p.parentElement) if (standIn.has(p)) return true; return false; };
    const panelAnc = (el, b) => { const band = bands[b]; if (!band) return false; for (let a = el.parentElement, d = 0; a && a !== band.el && a !== document.body && d < 12; a = a.parentElement, d++) if (isPanel(a, band)) return true; return false; };
    // an aria-hidden copy (a marquee clone, a duplicated slide) repeats text that is also shown without
    // aria-hidden; visible aria-hidden text with no such twin (a heading whose accessible copy is sr-only) is
    // the text the visitor reads and counts like any other
    const normT = (el) => String((el && el.textContent) || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    const shownT = new Set(); for (const t of texts) if (!ariaHidden(t.rec.el)) { const s = normT(t.rec.el); if (s.length >= 2) shownT.add(s); }
    const ariaCopy = (el) => ariaHidden(el) && shownT.has(normT(el));
    const mockEl = (el, b) => ariaCopy(el) || standAnc(el) || panelAnc(el, b);
    const ctlEl = (el) => { try { return !!el.closest('[role=tab],[role=tablist],[role=menuitem],[role=option],[role=switch]'); } catch { return false; } };
    const runM = new Map(), actM = new Map();
    let textAll = 0;
    for (const t of texts) {
      const A = t.chars * t.size * t.size * 0.5, el = t.rec.el;
      textAll += A;
      if (t.btn || t.nav || brandMark(el) || ctlEl(el) || mockEl(el, t.b) || effOp(el) < 0.3 || onPic(t.rec.x, t.rec.y, t.rec.w, t.rec.h)) continue;
      const under = underOf(el), hx = rc.hex(blend(t.color, under)), on = rc.hex(under);
      const ctx = t.h || t.size >= bodySize * 1.25 ? 'heading' : t.footer ? 'footer' : t.link ? 'link' : 'body';
      const k = `${hx}|${on}|${t.b}|${ctx}`;
      const e = runM.get(k) || { hex: hx, on, b: t.b, ctx, area: 0, n: 0, ex: el, exA: 0 };
      e.area += A; e.n++; if (A > e.exA) { e.exA = A; e.ex = el; }
      runM.set(k, e);
    }
    const addAct = (c, kind, el, rec, A) => {
      if (!c) return;
      const hx = rc.hex(c), k = hx + '|' + kind;
      const e = actM.get(k) || { hex: hx, kind, n: 0, area: 0, first: 0, ex: el, exA: 0 };
      e.n++; e.area += A; if (rec.y < vh * 1.5) e.first++; if (A > e.exA) { e.exA = A; e.ex = el; }
      actM.set(k, e);
    };
    // an icon-only filled control (a search or play button: a real button or link of 28-96 px drawing an svg/img
    // icon, outside the footer) is a visible action too; a labelless swatch or a decorative tile is not
    const iconAct = (el, rec) => {
      if (rec.w < 28 || rec.h < 28 || rec.w > 96 || rec.h > 96) return false;
      try { if (!el.matches('button,a[href],[role=button],input[type=submit],input[type=button]') || el.closest('footer') || !el.querySelector('svg,img')) return false; } catch { return false; }
      return true;
    };
    for (const x of btns.values()) {
      const rec = x.rec, el = rec.el;
      if (x.kind !== 'fill' || !hasText.has(el) || brandMark(el) || mockEl(el, rec.b) || effOp(el) < 0.5) continue;
      const fc = btnFill(x);
      if (fc && fc[3] >= 0.3) addAct(blend(fc, underOf(x.boxEl)), 'fill', el, rec, rec.w * rec.h);
    }
    for (const rec of recs) {
      const el = rec.el;
      if (btns.has(el) || hasText.has(el) || !iconAct(el, rec) || brandMark(el) || mockEl(el, rec.b) || effOp(el) < 0.5) continue;
      let fc = rc.rgba(rec.cs.backgroundColor), boxEl = el;
      if (!(fc && fc[3] >= 0.3) && el.children.length === 1) { const cr = R.get(el.children[0]); if (cr && cr.w >= rec.w * 0.8 && cr.h >= rec.h * 0.8) { fc = rc.rgba(cr.cs.backgroundColor); boxEl = cr.el; } }
      if (fc && fc[3] >= 0.3) addAct(blend(fc, underOf(boxEl)), 'fill', el, rec, rec.w * rec.h);
    }
    for (const t of texts) {
      const el = t.rec.el;
      if (!t.link || t.btn || t.nav || t.footer || brandMark(el) || ctlEl(el) || mockEl(el, t.b) || effOp(el) < 0.5) continue;
      addAct(blend(t.color, underOf(el)), 'link', el, t.rec, t.chars * t.size * t.size * 0.5);
    }
    const exDesc = (el) => rc.desc(el) + (R.get(el) && R.get(el).b >= 0 ? ' @band ' + R.get(el).b : '');
    // minor colours: chromatic colours used on text, tags/badges and icons, counted by element regardless
    // of area (red kicker tags, coloured category labels, icon tints); area = painted px (glyph area for text,
    // box area for tags and icons), so compare can tell a colour on a few small elements from a used one
    const minorM = new Map();
    const addMinor = (c, use, el, area) => {
      if (!c) return;
      if (brandMark(el)) { noteBrand(c, el); return; }
      const cr = chroma(c);
      if (cr < 0.18) return;
      const k = rc.hex(c) + '|' + use;
      const e = minorM.get(k) || { hex: rc.hex(c), use, n: 0, area: 0, ex: rc.desc(el), band: R.get(el) ? R.get(el).b : -1 };
      e.n++; e.area += area > 0 ? area : 0; minorM.set(k, e);
    };
    for (const t of texts) if (!t.nav || t.link) addMinor(blend(t.color, underOf(t.rec.el)), 'text', t.rec.el, t.chars * t.size * t.size * 0.5);
    for (const rec of recs) {
      if (rec.h > 44 || rec.w > 320 || rec.h < 12 || !hasText.has(rec.el) || btns.has(rec.el)) continue;
      const c = rc.rgba(rec.cs.backgroundColor);
      if (c && c[3] >= 0.5) addMinor(blend(c, underOf(rec.el)), 'tag', rec.el, rec.w * rec.h);
    }
    // SVG colours, whatever box the svg sits in (also inside composite panels and aria-hidden art): fills AND
    // strokes of up to 12 shapes per svg (an outline icon is drawn by its stroke), and the fill of <text>
    // inside it (text drawn in SVG is text). Small svgs (<= 64 px) are icons; larger ones are graphics, which
    // compare only uses as evidence that the colour is present, never as a reference requirement.
    let svgN = 0;
    for (const r of R.values()) {
      if (r.tag !== 'svg' || r.w < 4 || r.h < 4 || r.cs.visibility === 'hidden' || svgN++ > 300) continue;
      const use = r.w <= 64 && r.h <= 64 ? 'icon' : 'graphic';
      const seen = new Set();
      let k = 0;
      for (const sh of r.el.querySelectorAll('path,rect,circle,polygon,polyline,ellipse,line')) {
        if (k++ >= 12) break;
        const cs2 = getComputedStyle(sh);
        if (cs2.display === 'none' || cs2.visibility === 'hidden' || +cs2.opacity === 0) continue;
        for (const v of [cs2.fill, px(cs2.strokeWidth) > 0 ? cs2.stroke : 'none']) {
          const c = rc.rgba(v); if (!c || c[3] < 0.3) continue;
          const h = rc.hex(c); if (seen.has(h)) continue; seen.add(h);
          addMinor(blend(c, underOf(r.el)), use, r.el, r.w * r.h);
        }
      }
      for (const t of [...r.el.querySelectorAll('text')].slice(0, 12)) { const c = rc.rgba(getComputedStyle(t).fill); if (c && c[3] >= 0.3 && (t.textContent || '').trim()) addMinor(blend(c, underOf(r.el)), 'text', r.el, r.w * r.h * 0.1); }
    }
    const borders = new Map();
    for (const rec of recs) {
      const cs = rec.cs;
      const sides = [['Top', rec.w], ['Right', rec.h], ['Bottom', rec.w], ['Left', rec.h]];
      const used = [];
      for (const [s, len] of sides) {
        const w = px(cs[`border${s}Width`]);
        if (w < 0.5 || cs[`border${s}Style`] === 'none' || cs[`border${s}Style`] === 'hidden') continue;
        const c = rc.rgba(cs[`border${s}Color`]); if (!c) continue;
        const eff = blend(c, underOf(rec.el));
        addC(eff, 'border', w <= 1.5 ? 'hairline' : 'border', len * w);
        used.push([s[0].toLowerCase(), w, rc.hex(eff)]);
      }
      if (used.length) {
        const w = used[0][1], hx = used[0][2];
        const sidesStr = used.length === 4 ? 'all' : used.map((u) => u[0]).join('');
        const k = `${r1(w)}|${hx}|${sidesStr}`;
        const e = borders.get(k) || { w: r1(w), color: hx, sides: sidesStr, n: 0 }; e.n++; borders.set(k, e);
      }
    }
    for (const m of media) {
      if (m.tag !== 'svg') continue;
      const brand = brandMark(m.el);
      const shapes = m.el.querySelectorAll('path,rect,circle,polygon,ellipse');
      let k = 0;
      for (const s of shapes) { if (k >= 3) break; const scs = getComputedStyle(s); const f = rc.rgba(scs.fill) || (px(scs.strokeWidth) > 0 ? rc.rgba(scs.stroke) : null); if (f) { if (brand) noteBrand(blend(f, underOf(m.el)), m.el); else addC(blend(f, underOf(m.el)), 'graphic', 'svg', m.w * m.h * 0.3 / 3); k++; } }
    }
    // :root custom properties holding colours
    const vars = {};
    {
      const names = new Set();
      const rcs = getComputedStyle(document.documentElement);
      for (let i = 0; i < rcs.length; i++) { const n = rcs[i]; if (n.startsWith('--')) names.add(n); }
      for (const n of (rc.rootVarNames || [])) names.add(n);
      const out = [];
      for (const n of names) {
        const v = rcs.getPropertyValue(n).trim();
        if (!v || v.length > 60 || /^-?[\d.]+(px|rem|em|%|s|ms)?$/.test(v) || /var\(/.test(v)) continue;
        let ok = false; try { ok = CSS.supports('color', v); } catch {}
        if (!ok) { if (/^[\d.]+\s+[\d.]+%\s+[\d.]+%$/.test(v)) { ok = true; } else continue; }
        const c = rc.rgba(/^[\d.]+\s+[\d.]+%\s+[\d.]+%$/.test(v) ? `hsl(${v})` : v);
        if (!c) continue;
        out.push([n, rc.hexa(c)]);
      }
      const pri = (n) => /(color|colour|bg|background|text|fg|foreground|accent|brand|primary|secondary|surface|border|gray|grey|neutral|muted|ink|paper)/i.test(n) ? 0 : 1;
      out.sort((a, b) => pri(a[0]) - pri(b[0]) || a[0].localeCompare(b[0]));
      for (const [n, v] of out.slice(0, 60)) vars[n] = v;
      if (out.length > 60) notes.push(`${out.length} colour custom properties on :root; kept 60`);
    }
    const colorsRaw = {
      entries: [...C.values()].map((e) => ({ hex: e.hex, kind: e.kind, ctx: e.ctx, area: Math.round(e.area), n: e.n, on: e.on, ex: e.ex ? rc.desc(e.ex) + (R.get(e.ex) && R.get(e.ex).b >= 0 ? ' @band ' + R.get(e.ex).b : '') : undefined })),
      minor: [...minorM.values()].sort((a, b) => b.n - a.n).slice(0, 60),
      brandMarks: [...brandHex.values()].slice(0, 12),
      rootBg: rc.hex(rootBg), docArea, mediaAreaFrac: r3(Math.min(1, (mediaArea + imgBgArea) / docArea)),
      gradients: [...gradients.values()].sort((a, b) => b.area - a.area || b.n - a.n).slice(0, 10).map((g) => ({ css: g.css, n: g.n, areaFrac: r3(g.area / docArea), where: [...g.ctx].join(','), bands: [...g.bands].slice(0, 6), clipText: g.clipText || undefined, onMedia: g.onMedia && g.onMedia >= g.n ? true : undefined, thin: g.thin && g.thin >= g.n ? true : undefined })),
      gradientsTotal: gradients.size, vars,
      buttonBgs: [...btns.values()].filter((x) => x.kind === 'fill').map((x) => rc.hex(blend(btnFill(x), underOf(x.boxEl)))).filter(Boolean),
      linkColors: texts.filter((t) => t.link && !t.btn && !t.nav).map((t) => rc.hex(blend(t.color, underOf(t.rec.el)))),
      runText: [...runM.values()].sort((a, b) => b.area - a.area).slice(0, 400).map((e) => ({ hex: e.hex, on: e.on, b: e.b, ctx: e.ctx, area: Math.round(e.area), n: e.n, ex: exDesc(e.ex) })),
      textArea: Math.round(textAll),
      actions: [...actM.values()].sort((a, b) => b.area - a.area).slice(0, 60).map((e) => ({ hex: e.hex, kind: e.kind, n: e.n, area: Math.round(e.area), first: e.first, ex: exDesc(e.ex) })),
    };

    // ---------- 8. spacing ----------
    const spacing = {};
    {
      const tb = [...blocks.values()].filter((g) => g.chars >= 12 && !g.nav && !g.btn && g.b >= 0 && !(bands[g.b] && bands[g.b].isNav) && g.b !== footerIdx);
      // gutter = smallest text left edge shared by blocks in >= 2 bands (card text sits further in)
      const lb = new Map();
      for (const g of tb) { const k = Math.round(g.x / 2) * 2; if (k < 4 || k > vw * 0.45) continue; const s = lb.get(k) || new Set(); s.add(g.b); lb.set(k, s); }
      const multi = [...lb.entries()].filter(([, s]) => s.size >= 2).map(([k]) => k).sort((a, b) => a - b);
      const gutter = multi.length ? multi[0] : (lb.size ? Math.min(...lb.keys()) : null);
      const cen = recs.filter((r) => r.w >= vw * 0.4 && r.w <= vw - 4 && r.x >= 4 && Math.abs(r.x - (vw - r.x - r.w)) <= 3 && r.el.children.length && r.b >= 0);
      const cw = new Map();
      for (const r of cen) { const k = Math.round(r.w); const s = cw.get(k) || new Set(); s.add(r.b); cw.set(k, s); }
      let contentWidth = null, cwN = 0;
      for (const [k, s] of cw) if (s.size > cwN || (s.size === cwN && k > contentWidth)) { cwN = s.size; contentWidth = k; }
      // max-width of centred wrappers, counted once per band
      const mxb = new Map();
      for (const r of recs) {
        if (!r.cs.maxWidth.endsWith('px') || r.b < 0) continue;
        const v = Math.round(px(r.cs.maxWidth));
        if (v < 480 || v > 2600 || r.w < vw * 0.5 || Math.abs(r.x - (vw - r.x - r.w)) > 3) continue;
        const s = mxb.get(v) || new Set(); s.add(r.b); mxb.set(v, s);
      }
      let maxWidthCss = null, mxN = 0;
      for (const [v, s] of mxb) if (s.size > mxN || (s.size === mxN && v > maxWidthCss)) { mxN = s.size; maxWidthCss = v; }
      // Container, from FULL-WIDTH content bands only (band element spans the viewport, or the page frame
      // when all bands sit in one centred wrapper; narrow centred band elements say nothing about the page
      // inset). Per band, the outermost left/right edges of
      // (a) its running text blocks (>= 12 chars; not in buttons, nav, cards, media or UI panels; in flow;
      // not full-bleed) and (b) its rails: repeated cards, media and UI panels that are not the band
      // background, and rules (hr / 1-3 px filled dividers >= 30% of the viewport wide), counted only when
      // they span >= half the frame and lie fully inside the viewport. The modal edges
      // over bands (8 px buckets weighted by band height, median inside the bucket) = textLeft/textRight
      // and railLeft/railRight. contentLeft/contentRight = the rail edges (the text edges when no band has
      // rails: contentHow), contentWidth = their distance.
      const modeEdge = (vals) => { const m = new Map(), c = new Map(); for (const [v, w] of vals) { const k = Math.round(v / 8) * 8; m.set(k, (m.get(k) || 0) + w); c.set(k, (c.get(k) || 0) + 1); } let bk = null, bn = 0; for (const [k, n] of m) if (n > bn || (n === bn && k < bk)) { bn = n; bk = k; } return bk === null ? null : { k: bk, n: c.get(bk) }; };
      const ext = (rs) => (rs.length ? [Math.min(...rs.map((r) => r.x)), Math.max(...rs.map((r) => r.x + r.w))] : null);
      const TX = [], RL = [];
      const isContent = (s, i) => { const b = bands[i]; return !!b && !b.isNav && !b.unanalysed && !s.virtual && s.role !== 'nav' && s.role !== 'ad' && s.role !== 'footer' && !!R.get(b.el); };
      // full width = spans the viewport, or the page frame when every band sits in one centred wrapper
      // (bands as wide as the widest content band)
      const frameW = Math.min(vw, Math.max(0, ...sections.map((s, i) => (isContent(s, i) ? R.get(bands[i].el).w : 0))));
      sections.forEach((s, i) => {
        if (!isContent(s, i)) return;
        const b = bands[i];
        const br = R.get(b.el);
        if (br.w < frameW - 2) return;
        const el = b.el, P = pre[i];
        const cardEls = layAll[i] && layAll[i].cards ? layAll[i].cards.els : [];
        const bandArea = Math.max(1, vw * s.h);
        const rails = P.M.filter((m) => m.w < vw * 0.95 && !(m.w * m.h >= bandArea * 0.6 && behindText(m, P.head, bandArea)));
        const inBox = (e) => cardEls.some((c) => c.contains(e)) || rails.some((m) => m.el.contains(e));
        const txt = (P.G || []).filter((g) => g.chars >= 12 && !g.nav && !g.btn && g.w < vw * 0.95 && !inBox(g.el) && inFlow(R.get(g.el) || g.ts[0].rec, el));
        const rules = (bandRecs.get(i) || []).filter((r) => r.w >= vw * 0.3 && r.w < vw * 0.95 && (r.tag === 'HR' || (r.h <= 3 && bgInfo(r.cs).c)));
        // only boxes fully inside the viewport (carousel tracks and peeking slides run past it); a card
        // group is one unit (the union of its items); a unit lying strictly inside the band's own text
        // column (a centred illustration between wider text) is column content, not a rail
        const inVp = (r) => r.x >= -1 && r.x + r.w <= vw + 1;
        const te = ext(txt.filter(inVp).map((g) => ({ x: g.x, w: g.w })));
        const cu = ext(cardEls.map((e) => R.get(e)).filter((r) => r && inVp(r) && inFlow(r, el)));
        // the main row of a multi-column band (text column + sidebar, text + media) is one unit too: its
        // content extent, so the container of a two-column page is not read from one of its columns
        const row = s.layout && s.layout.cols >= 2 && Array.isArray(s.contentX) && s.contentX[1] > s.contentX[0] ? [{ x: s.contentX[0], w: s.contentX[1] - s.contentX[0] }] : [];
        const units = (cu ? [{ x: cu[0], w: cu[1] - cu[0] }] : []).concat(rails, rules, row).filter((r) => r.w < vw * 0.95 && inVp(r) && (r.el === undefined || inFlow(r, el)));
        const re = ext(units.filter((r) => !(te && r.x > te[0] + 4 && r.x + r.w < te[1] - 4)));
        if (te) TX.push([te, s.h]);
        // a band's rails define the container only when they span >= half the frame (a lone centred
        // illustration or a small card pair says nothing about the page inset)
        if (re && re[1] - re[0] >= frameW * 0.5) RL.push([re, s.h]);
      });
      const modal = (list) => {
        if (!list.length) return { l: null, r: null, n: 0 };
        const L0 = modeEdge(list.map(([e, w]) => [e[0], w])), R0 = modeEdge(list.map(([e, w]) => [vw - e[1], w]));
        const l = L0 ? Math.round(median(list.map(([e]) => e[0]).filter((v) => Math.abs(v - L0.k) <= 6))) : null;
        const r = R0 ? Math.round(median(list.map(([e]) => e[1]).filter((v) => Math.abs((vw - v) - R0.k) <= 6))) : null;
        return { l, r, n: L0 ? L0.n : 0 };
      };
      const T = modal(TX), RA = modal(RL);
      const useRail = RA.l !== null && RA.r !== null && RA.r > RA.l;
      const contentLeft = useRail ? RA.l : T.l, contentRight = useRail ? RA.r : T.r;
      spacing.container = {
        textLeft: T.l, textRight: T.r, textBands: T.n, railLeft: RA.l, railRight: RA.r, railBands: RA.n,
        contentLeft, contentRight, contentWidth: contentLeft !== null && contentRight !== null && contentRight > contentLeft ? contentRight - contentLeft : null,
        contentBands: useRail ? RA.n : T.n, contentHow: useRail ? 'rail' : T.l !== null ? 'text (no rails)' : null, fullWidthBands: Math.max(TX.length, RL.length),
        maxWidthCss, maxWidthBands: mxN, centredWidth: contentWidth, centredBands: cwN, gutter, gutterHow: 'smallest text-block left edge shared by >=2 content bands',
      };
      const pads = sections.filter((s) => s.pad && s.role !== 'nav').map((s) => s.pad);
      const bucket = (v) => Math.round(v / 4) * 4;
      spacing.sectionPad = { values: pads, modeTop: pads.length ? +mode(pads.map((p) => ({ k: bucket(p[0]) }))) : null, modeBottom: pads.length ? +mode(pads.map((p) => ({ k: bucket(p[1]) }))) : null, medianTop: pads.length ? Math.round(median(pads.map((p) => p[0]))) : null, medianBottom: pads.length ? Math.round(median(pads.map((p) => p[1]))) : null };
      const gaps = new Map();
      for (const r of recs) {
        if (!/flex|grid/.test(r.cs.display) || r.el.children.length < 2) continue;
        for (const g of [r.cs.rowGap, r.cs.columnGap]) { const v = px(g); if (v > 0 && g !== 'normal') gaps.set(Math.round(v), (gaps.get(Math.round(v)) || 0) + 1); }
      }
      spacing.gaps = [...gaps.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([v, n]) => ({ px: v, n }));
      const hb = [...blocks.values()].filter((g) => g.size >= bodySize * 1.25 && !g.nav && !g.btn);
      const tbs = [...blocks.values()].filter((g) => g.size < bodySize * 1.25 && g.chars >= 20 && !g.nav && !g.btn);
      const h2t = [];
      for (const h of hb) { const nx = tbs.filter((t) => t.b === h.b && t.y >= h.y + h.hh - 2 && t.x < h.x + h.w && t.x + t.w > h.x).sort((a, b) => a.y - b.y)[0]; if (nx && nx.y - (h.y + h.hh) <= 120) h2t.push({ k: Math.round(nx.y - (h.y + h.hh)), ex: rc.desc(h.el), band: h.b }); }
      const t2b = [];
      for (const bt of btns.values()) { const r = bt.rec; const pv = tbs.filter((t) => t.b === r.b && t.y + t.hh <= r.y + 2 && r.y - (t.y + t.hh) <= 120 && t.x < r.x + r.w + 200 && t.x + t.w > r.x - 200).sort((a, b) => (b.y + b.hh) - (a.y + a.hh))[0]; if (pv) t2b.push({ k: Math.round(r.y - (pv.y + pv.hh)), ex: rc.desc(r.el), band: r.b }); }
      const exOf = (arr, k) => { const m = arr.filter((x) => x.k === k); return m.length ? { el: m[0].ex, band: m[0].band, n: m.length } : null; };
      const h2tK = h2t.length ? +mode(h2t) : null, t2bK = t2b.length ? +mode(t2b) : null;
      spacing.stack = { headingToText: h2tK, textToButton: t2bK, headingToTextAt: h2tK !== null ? exOf(h2t, h2tK) : null, textToButtonAt: t2bK !== null ? exOf(t2b, t2bK) : null };
      const radOf = (el, cs, h) => { const v = cs.borderTopLeftRadius; if (v.endsWith('%')) return px(v) >= 40 ? 'pill' : Math.round(px(v) / 100 * h); const p = px(v); return p >= h / 2 - 1 && h > 0 ? 'pill' : Math.round(p); };
      const radMode = (els, byArea) => { const vals = els.map((el) => { const r = R.get(el); const cs = r ? r.cs : getComputedStyle(el); const bb = r || el.getBoundingClientRect(); return { k: radOf(el, cs, r ? r.h : bb.height), a: (r ? r.w * r.h : bb.width * bb.height) }; }); return vals.length ? mode(vals, byArea ? (v) => v.a : null) : null; };
      const imgEls = media.filter((m) => m.tag === 'IMG' || m.tag === 'VIDEO' || m.tag === 'PICTURE').map((m) => { const p = m.el.parentElement, pr = p && R.get(p); return pr && Math.abs(pr.w - m.w) < 4 && Math.abs(pr.h - m.h) < 4 && px(pr.cs.borderTopLeftRadius) > px(m.cs.borderTopLeftRadius) ? p : m.el; });
      const radTop = new Map();
      for (const r of recs) { const v = px(r.cs.borderTopLeftRadius); if (v > 0 && (r.cs.backgroundColor !== 'rgba(0, 0, 0, 0)' || px(r.cs.borderTopWidth) > 0 || r.tag === 'IMG')) { const k = radOf(r.el, r.cs, r.h); radTop.set(k, (radTop.get(k) || 0) + 1); } }
      spacing.radius = {
        button: radMode([...btns.values()].map((x) => x.boxEl), true), card: radMode([...cardSet].filter((el) => R.get(el) && cardLike(R.get(el))), true),
        input: radMode(inputs.map((r) => r.el)), image: radMode(imgEls, true),
        how: 'area-weighted mode per component kind ("pill" = radius >= half the height)',
        top: [...radTop.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([v, n]) => ({ v, n })),
      };
      const sh = new Map();
      for (const r of recs) { const s = r.cs.boxShadow; if (s && s !== 'none') { const k = s.slice(0, 160); const e = sh.get(k) || { css: k, n: 0, on: new Set() }; e.n++; e.on.add(btnBox.has(r.el) ? 'button' : cardSet.has(r.el) ? 'card' : navEl && navEl.contains(r.el) ? 'nav' : 'other'); sh.set(k, e); } }
      spacing.shadows = [...sh.values()].sort((a, b) => b.n - a.n).slice(0, 5).map((e) => ({ css: e.css, n: e.n, on: [...e.on].join(',') }));
      spacing.borders = [...borders.values()].sort((a, b) => b.n - a.n).slice(0, 6);
    }
    // nav summary
    let navOut = null;
    if (navEl) {
      const st = rc.navState(navEl);
      const host = bands.find((b) => b.navOverlay);
      const overHero = !!host || (navSection && navSection.virtual && bands[1] && bands[1].top <= 2);
      const bgC = rc.rgba(getComputedStyle(navEl).backgroundColor);
      const eff = rc.effBg(navEl);
      navOut = { pos: navF.pos, h: st.h, bg: st.bg, transparent: !eff || eff[3] < 0.1, overHero, blur: st.blur, shadow: st.shadow, border: st.border, linkCount: navEl.querySelectorAll('a').length, ownBgAlpha: bgC ? bgC[3] : 0 };
    }

    // ---------- 9. components ----------
    const comps = {}, compEls = {};
    const sample = (el) => {
      const cs = getComputedStyle(el), r = el.getBoundingClientRect();
      const bi = bgInfo(cs);
      const bw = px(cs.borderTopWidth);
      const t = texts.find((x) => el.contains(x.rec.el));
      const tcs = t ? t.rec.cs : cs;
      const radV = cs.borderTopLeftRadius.endsWith('%') ? cs.borderTopLeftRadius : (px(cs.borderTopLeftRadius) >= r.height / 2 - 1 && r.height > 0 && px(cs.borderTopLeftRadius) > 0 ? 'pill' : Math.round(px(cs.borderTopLeftRadius)));
      // fill painted by a ::before/::after layer covering the component when its own background is transparent
      let bg = bi.grad ? bi.grad.slice(0, 200) : bi.c ? rc.hexa(bi.c) : null, bgFrom;
      if (!bg) { const L = coverLayer(el, 0.8, 0.7); if (L && (L.grad || L.c)) { bg = L.grad ? L.grad.slice(0, 200) : rc.hexa(L.c); bgFrom = L.ps; } }
      return {
        desc: rc.desc(el), x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height),
        pad: [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].map((v) => Math.round(px(v))), radius: radV,
        border: bw > 0 && cs.borderTopStyle !== 'none' ? `${r1(bw)}px ${cs.borderTopStyle} ${rc.hexa(rc.rgba(cs.borderTopColor))}` : null,
        bg, bgFrom, color: rc.hexa(rc.rgba(tcs.color)),
        font: { px: r1(px(tcs.fontSize)), weight: +tcs.fontWeight || 400, family: firstFam(tcs.fontFamily), ls: r3(tcs.letterSpacing === 'normal' ? 0 : px(tcs.letterSpacing) / px(tcs.fontSize)), tt: tcs.textTransform === 'none' ? null : tcs.textTransform, lh: tcs.lineHeight === 'normal' ? null : r2(px(tcs.lineHeight) / px(tcs.fontSize)) },
        shadow: cs.boxShadow !== 'none' ? cs.boxShadow.slice(0, 160) : null, transition: rc.transSummary(cs), blur: cs.backdropFilter && cs.backdropFilter !== 'none' ? cs.backdropFilter : undefined,
      };
    };
    if (o.full) {
      if (navEl) { compEls.nav = navEl; }
      const fills = [...btns.values()].filter((x) => x.kind === 'fill');
      const scoreB = (x) => {
        const c = btnFill(x) || [0, 0, 0, 0];
        const under = underOf(x.boxEl);
        return chroma(c) * 2 + Math.abs(lum(c) - lum(under)) + (c[3] >= 0.5 ? 0.5 : 0) + (x.rec.b === contentBand ? 0.6 : 0) + (isNavEl(x.rec.el) ? -0.3 : 0) + Math.min(0.3, x.rec.w * x.rec.h / 20000);
      };
      const prim = fills.slice().sort((a, b) => scoreB(b) - scoreB(a) || a.rec.i - b.rec.i)[0];
      if (prim) compEls.primaryButton = prim.boxEl;
      const pc = prim ? btnFill(prim) : null;
      const others = [...btns.values()].filter((x) => x !== prim && (x.kind === 'outline' || !pc || rc.hex(btnFill(x)) !== rc.hex(pc)));
      const near = (x) => prim ? Math.abs(x.rec.y - prim.rec.y) + Math.abs(x.rec.x - prim.rec.x) * 0.2 + (x.kind === 'outline' ? 0 : 200) + (isNavEl(x.rec.el) && !isNavEl(prim.rec.el) ? 400 : 0) + (Math.abs(x.rec.h - prim.rec.h) > prim.rec.h * 0.3 ? 1500 : 0) : x.rec.i;
      const sec = others.filter((x) => !prim || Math.abs(x.rec.h - prim.rec.h) <= prim.rec.h * 0.35).sort((a, b) => near(a) - near(b))[0];
      if (sec) compEls.secondaryButton = sec.boxEl;
      // a valid sample of a component kind (both pages, same rule): shown (no opacity ~0 / visibility hidden on
      // it or an ancestor), at least 8x8 px, and not moved by an infinite CSS/WAAPI transform animation on it or
      // an ancestor (a marquee track, a bobbing item): such a crop changes without the pointer
      const loopRoots = new Set();
      try { for (const an of document.getAnimations()) { const t = an.effect && an.effect.target; const tm = an.effect && an.effect.getTiming ? an.effect.getTiming() : {}; if (!t || tm.iterations !== Infinity || an.playState !== 'running') continue; let kf = []; try { kf = an.effect.getKeyframes(); } catch {} if (kf.some((k) => 'transform' in k || 'translate' in k || 'left' in k || 'marginLeft' in k || 'offsetDistance' in k)) loopRoots.add(t); } } catch {}
      const inLoop = (el) => { for (let e = el; e && e !== document.body; e = e.parentElement) if (loopRoots.has(e)) return true; return false; };
      const shownEl = (el) => {
        if (!el || !el.isConnected) return false;
        try { if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false; } catch {}
        let op = 1; for (let e = el; e && e.nodeType === 1; e = e.parentElement) { op *= parseFloat(getComputedStyle(e).opacity); if (!(op >= 0.1)) return false; }
        const b = el.getBoundingClientRect(); return b.width >= 8 && b.height >= 8;
      };
      const validEl = (el) => shownEl(el) && !inLoop(el);
      // card: card-like repeated items of a reasonable size (not list rows or chips) in a static row or grid
      // (a row running past the viewport is a carousel / marquee track), the topmost such group on the page
      // (page order, so both pages pick the same component whatever their card counts), its first valid member
      const cardOk = (s) => { const c = s.cards; return c.w * c.h >= 15000 && c.w <= vw * 0.6 && c.h >= 80 && !c.overflow; };
      const cardPick = (s) => s._cards.find((el) => R.get(el) && !R.get(el).hid && validEl(el)) || null;
      const cardGroups = sections.filter((s) => s._cards && s.cards && s.cards.like && cardOk(s) && cardPick(s));
      if (cardGroups.length) compEls.card = cardPick(cardGroups[0]);
      // (controls parked off the page and skip links are never components: see offPage / skipCtl)
      const onPage = inputs.filter((r) => !offPage(r));
      const inp = onPage.filter((r) => r.tag === 'INPUT' && r.h >= 28 && r.h <= 72)[0] || onPage.filter((r) => r.h >= 28 && r.h <= 200)[0];
      if (inp) compEls.input = inp.el;
      const linkRecs = recs.filter((r) => r.tag === 'A' && !btns.has(r.el) && !isNavEl(r.el) && (r.el.textContent || '').trim().length >= 2 && !offPage(r) && !skipCtl(r.el));
      // link kinds, so both pages pick the same kind: inline (inside running text) > text (a standalone text
      // link; underlined first) > block (wraps media or a card-sized box) > control (no visible text: dots,
      // icon links); footer links last
      const linkKind = (r) => {
        if (!texts.some((t) => r.el.contains(t.rec.el))) return 'control';
        if (r.h > 60 || r.w > 600 || [...r.el.querySelectorAll('img,svg,video,picture,canvas')].some((m) => { const b = m.getBoundingClientRect(); return b.width >= 40 && b.height >= 40; })) return 'block';
        const p = closest(r.el.parentElement, /^(P|LI|SPAN|DD|TD)$/, 2);
        return p && (p.textContent || '').trim().length > (r.el.textContent || '').trim().length + 15 ? 'inline' : 'text';
      };
      const KR = { inline: 0, text: 1, block: 3, control: 4 };
      const rankL = (r) => (isFooter(r) ? 10 : 0) + KR[r.lk] + (r.lk === 'text' && !/underline/.test(r.cs.textDecorationLine) ? 1 : 0);
      for (const r of linkRecs) r.lk = linkKind(r);
      const linksRanked = linkRecs.map((r, k) => [r, k]).sort((a, b) => rankL(a[0]) - rankL(b[0]) || a[1] - b[1]).map(([r]) => r);
      const link = linksRanked[0];
      if (link) compEls.link = link.el;
      const badge = recs.find((r) => r.h >= 14 && r.h <= 36 && r.w <= 260 && r.w >= 24 && !btns.has(r.el) && !inBtn(r.el) && r.tag !== 'A' && !isNavEl(r.el) && boxy(r.cs) && px(r.cs.borderTopLeftRadius) >= 4 && px(r.cs.paddingLeft) >= 4 && (() => { const s = (r.el.textContent || '').trim(); return s.length >= 1 && s.length <= 28; })() && r.el.querySelectorAll('*').length <= 4);
      if (badge) compEls.badge = badge.el;
      for (const [k, el] of Object.entries(compEls)) {
        comps[k] = sample(el);
        const b = btns.get(el) || [...btns.values()].find((x) => x.boxEl === el);
        if (b && b.pseudo && !comps[k].bg) { comps[k].bg = rc.hexa(b.pseudo); comps[k].bgFrom = '::before/::after'; }
      }
      if (link && comps.link) comps.link.kind = isFooter(link) ? `footer ${link.lk}` : link.lk;
      rc.comp = compEls;
      // hover targets
      const ht = [];
      const addT = (el, kind) => { if (el && validEl(el) && !ht.some((h) => h.el === el || h.el.contains(el) || el.contains(h.el)) && ht.length < 12) ht.push({ el, kind }); };
      if (navEl) {
        // nav link = a menu item: a text link of the header (no icon, not a button, tab, skip link or the
        // logo / home link) styled like at least one other such link (a lone CTA link is not a menu)
        const rootHref = (a) => { const raw = (a.getAttribute('href') || '').trim(); if (!raw || raw.startsWith('#') || /^javascript:/i.test(raw)) return false; try { const u = new URL(a.href, location.href); return u.origin === location.origin && /^\/?(index\.html?)?$/.test(u.pathname) && !u.hash; } catch { return false; } };
        const logoish = (a) => /logo|brand|home/i.test(`${a.className && a.className.baseVal !== undefined ? a.className.baseVal : a.className} ${a.id} ${a.getAttribute('aria-label') || ''}`) || rootHref(a);
        let nl = [...navEl.querySelectorAll('a')].filter((a) => R.has(a) && (a.textContent || '').trim().length >= 2 && !btns.has(a) && !a.querySelector('img,svg') && !skipCtl(a)
          && !a.closest('[role=tab],[role=tablist]') && !a.hasAttribute('aria-selected') && !logoish(a) && validEl(a));
        const sigOf = (a) => { const s = getComputedStyle(a); return `${s.fontSize}|${s.fontWeight}|${s.color}`; };
        const alike = nl.filter((a) => nl.some((b) => b !== a && sigOf(b) === sigOf(a)));
        nl = alike;
        const inner = nl.filter((a) => a.closest('nav,[role=navigation]'));
        if (inner.length) nl = inner;
        nl.slice(0, 2).forEach((a) => addT(a, 'nav-link'));
      }
      addT(compEls.primaryButton && closest(compEls.primaryButton, /^(A|BUTTON)$/, 2) || compEls.primaryButton, 'primary-button');
      addT(compEls.secondaryButton && closest(compEls.secondaryButton, /^(A|BUTTON)$/, 2) || compEls.secondaryButton, 'secondary-button');
      cardGroups.slice(0, 2).forEach((s) => addT(cardPick(s), 'card'));
      // text-link hover: inline / standalone text links only (card-wrapping anchors are cards or image links)
      const inl = linksRanked.filter((r) => !isFooter(r) && (r.lk === 'inline' || r.lk === 'text')).slice(0, 2);
      inl.forEach((r) => addT(r.el, 'text-link'));
      const seenSig = new Set(ht.map((h) => getComputedStyle(h.el).backgroundColor + getComputedStyle(h.el).color));
      for (const x of btns.values()) { const s = rc.hex(btnFill(x)) + getComputedStyle(x.boxEl).color; if (!seenSig.has(s)) { seenSig.add(s); addT(x.rec.el, 'button'); } if (ht.filter((h) => h.kind === 'button').length >= 2) break; }
      const fl = linkRecs.find((r) => isFooter(r)); if (fl) addT(fl.el, 'footer-link');
      const il = recs.find((r) => r.tag === 'A' && !isNavEl(r.el) && r.el.querySelector('img') && r.w >= 80); if (il) addT(il.el, 'image-link');
      rc.hoverTargets = ht;
    }

    // ---------- 10. motion statics, fonts, libraries ----------
    let motionStatic = null, fonts = null, libs = null;
    if (o.full) {
      const tr = new Map();
      // Which transitions visibly do something. For an element seen animating in this capture (a scroll
      // reveal sampled by the step pass, or a load animation), the categories that changed are known; a
      // transitioned property of another category that no state rule (:hover/:focus/:active/:checked/
      // [aria-expanded]/[open]...) matching the element sets is a no-op on it (`noop`); one that carries the
      // observed reveal/load change is that animation's own timing (`rv`). Unobserved elements count as before.
      const TCATP = (prop) => {
        if (/^(color|background|background-color|background-image|border.*|fill|stroke|outline.*|text-decoration.*|caret-color)$/.test(prop)) return 'colour';
        if (/^(transform|translate|scale|rotate)$/.test(prop)) return 'transform';
        if (/^(opacity|visibility)$/.test(prop)) return 'opacity';
        if (/^(filter|box-shadow|backdrop-filter|text-shadow)$/.test(prop)) return 'effects';
        if (/^(width|height|max-height|max-width|min-height|padding.*|margin.*|left|right|top|bottom|inset.*|flex.*|gap|grid.*)$/.test(prop)) return 'layout';
        return null;
      };
      const STATE_SEL = /:(hover|focus|focus-visible|focus-within|active|checked|target|open)\b|\[(aria-expanded|aria-selected|aria-current|aria-pressed|data-state|open)\b/;
      const stateRules = [];
      const collectState = (rules, depth) => {
        for (const r of rules) {
          if (stateRules.length >= 4000 || depth > 4) return;
          if (r.selectorText && r.style && STATE_SEL.test(r.selectorText)) {
            const cats = new Set();
            for (let i = 0; i < r.style.length; i++) { const p = r.style[i]; const c = TCATP(p.replace(/-(top|right|bottom|left)(-|$).*/, '')) || TCATP(p); if (c) cats.add(c); }
            if (cats.size) for (const sel of splitList(r.selectorText)) {
              const s = sel.replace(/::?(before|after|placeholder|marker|selection)\b/g, '').replace(/:(hover|focus-visible|focus-within|focus|active|checked|target|open)\b/g, '').replace(/\[(aria-expanded|aria-selected|aria-current|aria-pressed|data-state|open)[^\]]*\]/g, '').replace(/([>+~])\s*$/, '').trim();
              stateRules.push({ sel: s || '*', cats });
            }
          }
          if (r.cssRules && r.type !== 7) try { collectState(r.cssRules, depth + 1); } catch {}
        }
      };
      for (const s of [...document.styleSheets].concat(document.adoptedStyleSheets || [])) { let rules = null; try { rules = s.cssRules; } catch {} if (rules) collectState(rules, 0); }
      const stateCats = (el) => { const out = new Set(); for (const r of stateRules) { if (r.cats.size && [...r.cats].every((c) => out.has(c))) continue; let m = false; try { m = el.matches(r.sel); } catch {} if (m) for (const c of r.cats) out.add(c); } return out; };
      const chCats = (a, b) => { const s = new Set(); if (!a || !b) return s; if (Math.abs(a.o - b.o) >= 0.05 || (a.v ?? 1) !== (b.v ?? 1)) s.add('opacity'); if (Math.abs(a.tx - b.tx) >= 2 || Math.abs(a.ty - b.ty) >= 2 || Math.abs((a.s ?? 1) - (b.s ?? 1)) >= 0.01 || Math.abs((a.r || 0) - (b.r || 0)) >= 1) s.add('transform'); if (Math.abs((a.b || 0) - (b.b || 0)) >= 0.5) s.add('effects'); return s; };
      const loadIdx = rc.load ? new Map(rc.load.els.map((e, k) => [e, k])) : new Map();
      const observed = (el) => {
        const S = rc.snap;
        if (S && S.idx.has(el)) { const e = S.els[S.idx.get(el)]; if (e.steps && e.steps.length) return chCats(e.m, e.cur); }
        const k = loadIdx.get(el);
        if (k !== undefined && rc.load.pts[k] && (!rc.loadKept || rc.loadKept.has(el))) return chCats(Object.assign({}, rc.load.init[k], rc.load.kf[k] || {}), rc.load.last[k]);
        return null;
      };
      let nObserved = 0;
      const addTr = (cs, el) => {
        const d = ms(cs.transitionDuration); if (!d.some((v) => v > 0)) return;
        const p = splitList(cs.transitionProperty), f = splitList(cs.transitionTimingFunction), dl = ms(cs.transitionDelay);
        const ch = el ? observed(el) : null;
        let st = null;
        if (ch) nObserved++;
        p.forEach((prop, i) => {
          const dur = d[i % d.length] || 0; if (!dur) return;
          const k = `${prop}|${Math.round(dur)}|${f[i % f.length]}`;
          const e = tr.get(k) || { prop, ms: Math.round(dur), easing: f[i % f.length], n: 0, delays: new Map(), noop: 0, rv: 0 };
          e.n++; const dly = Math.round(dl[i % dl.length] || 0); e.delays.set(dly, (e.delays.get(dly) || 0) + 1); tr.set(k, e);
          if (ch) {
            if (st === null) st = stateCats(el);
            const c = prop === 'all' ? null : TCATP(prop);
            const any = (set) => (prop === 'all' ? set.size > 0 : set.has(c));
            if (prop !== 'all' && !c) return;
            if (any(st)) return;            // a state rule changes it: a real (hover/focus/...) transition
            if (any(ch)) e.rv++;            // carries the observed reveal / load change
            else e.noop++;                  // never changes on this element
          }
        });
      };
      for (const r of disp) if (!rc.isTp(r.el)) addTr(r.cs, r.el);
      for (const x of btns.values()) for (const ps of ['::before', '::after']) addTr(getComputedStyle(x.rec.el, ps));
      const anims = new Map();
      for (const r of disp) {
        if (rc.isTp(r.el)) continue;
        const nm = r.cs.animationName; if (!nm || nm === 'none') continue;
        const names = splitList(nm), d = ms(r.cs.animationDuration), f = splitList(r.cs.animationTimingFunction), it = splitList(r.cs.animationIterationCount), dl = ms(r.cs.animationDelay);
        names.forEach((n, i) => { if (n === 'none') return; const k = n + '|' + Math.round(d[i % d.length]); const e = anims.get(k) || { name: n, ms: Math.round(d[i % d.length]), easing: f[i % f.length], iter: it[i % it.length], delay: Math.round(dl[i % dl.length] || 0), n: 0, on: rc.desc(r.el) }; e.n++; anims.set(k, e); });
      }
      const ga = new Map();
      let gaTotal = 0;
      // ambient = continuous decorative motion (infinite, running, visible, changes something you can see)
      const VISUAL = /^(opacity|transform|translate|scale|rotate|filter|backdropFilter|clipPath|background|color|fill|stroke|strokeDash|width|height|top|left|right|bottom|inset|boxShadow|border|outline|offset|d$|x$|y$|cx$|cy$|r$|letterSpacing)/;
      const amb = new Map();
      // visible on screen: aria-hidden / role=img decorative art counts (only the inactive-slide reading of
      // aria-hidden is ignored here: what is on screen and moving is ambient); size >= 2x2 px, or a hairline
      // >= 1 px thick and >= 8 px long (a 1 px text caret)
      const visibleTarget = (t) => {
        if (!t || t.nodeType !== 1 || !t.isConnected || rc.isTp(t)) return false;
        const host = t.ownerSVGElement || t;
        const rr = R.get(host);
        if (!rr || (rr.hid && !rr.hidSlide)) return false;
        const b = t.getBoundingClientRect();
        return (b.width >= 2 && b.height >= 2) || (Math.min(b.width, b.height) >= 1 && Math.max(b.width, b.height) >= 8);
      };
      try {
        for (const an of document.getAnimations()) {
          gaTotal++;
          const tm = an.effect && an.effect.getTiming ? an.effect.getTiming() : {};
          const type = an.constructor && an.constructor.name;
          let props = '', kfs = [];
          try { kfs = an.effect.getKeyframes(); props = [...new Set(kfs.flatMap((k) => Object.keys(k)))].filter((k) => !['offset', 'easing', 'composite', 'computedOffset'].includes(k)).join(','); } catch {}
          const visual = props.split(',').some((p) => p && !p.startsWith('--') && VISUAL.test(p));
          const t = type === 'CSSTransition' ? 'transition' : type === 'CSSAnimation' ? 'animation' : 'waapi';
          const name = an.animationName || an.transitionProperty || an.id || '';
          const scrollTl = !!(an.timeline && an.timeline.constructor && /Scroll|View/.test(an.timeline.constructor.name));
          const k = [t, name, Math.round(tm.duration || 0), tm.easing, tm.iterations].join('|');
          const e = ga.get(k) || { type: t, name, props: props.slice(0, 80), visual, ms: typeof tm.duration === 'number' ? Math.round(tm.duration) : null, easing: tm.easing, iter: tm.iterations === Infinity ? 'infinite' : tm.iterations, state: an.playState, n: 0, on: an.effect && an.effect.target ? rc.desc(an.effect.target) : null, scrollTimeline: scrollTl };
          e.n++; ga.set(k, e);
          const target = an.effect && an.effect.target;
          if (tm.iterations === Infinity && visual && !scrollTl && an.playState === 'running' && visibleTarget(target)) {
            const vals = JSON.stringify(kfs).slice(0, 2000);
            const kind = /rotate/.test(vals) && !/translate/.test(vals) ? 'rotate' : /translate|"(left|top|x|y|offset)/.test(vals) ? 'move' : /scale|opacity/.test(vals) ? 'pulse' : /background/.test(props) ? 'shimmer' : /color|fill|stroke/.test(props) ? 'colour' : 'loop';
            const host = target.ownerSVGElement || target;
            const band = bandOf(host);
            // inside a first-viewport media / illustration box (rc.heroMedia): that box's media activity
            const hero = rc.heroIdx ? rc.heroIdx(host) : -1;
            const ak = String(name).replace(/[0-9]+/g, '#') + '|' + band + '|' + hero;
            let a = amb.get(ak);
            if (!a) {
              const hb = host.getBoundingClientRect();
              a = { name: String(name).slice(0, 40), kind, band, n: 0, ms: typeof tm.duration === 'number' ? Math.round(tm.duration) : null, src: t, el: rc.desc(target),
                box: [Math.round(hb.left + scrollX), Math.round(hb.top + scrollY), Math.round(hb.width), Math.round(hb.height)], text: rc.hasText(host) || undefined,
                strip: kind === 'move' && rc.isStrip && (rc.isStrip(host, 'x') || rc.isStrip(host, 'y')) || undefined, hero: hero >= 0 ? hero : undefined,
                heroIn: (hero >= 0 && rc.heroIn && rc.heroIn(host) >= 0) || undefined };
            }
            a.n++; amb.set(ak, a);
          }
        }
      } catch {}
      for (const v of document.querySelectorAll('video')) {
        const rr = R.get(v);
        if (!rr || rr.hid || v.paused || rr.w < 80 || rr.h < 60) continue;
        const ak = 'video|' + rr.b;
        const a = amb.get(ak) || { name: 'video', kind: 'video', band: rr.b, n: 0, ms: isFinite(v.duration) ? Math.round(v.duration * 1000) : null, src: 'video', el: rc.desc(v) };
        a.n++; amb.set(ak, a);
      }
      // CSSOM: keyframes, font-face, root vars, scroll-timeline usage
      const sheets = [], kf = {}, ff = [], tlHits = { animationTimeline: 0, viewTimeline: 0, scrollTimeline: 0 };
      const wanted = new Set([...anims.values()].map((a) => a.name).concat([...ga.values()].filter((g) => g.type === 'animation').map((g) => g.name)));
      const rootVarNames = new Set();
      let ruleCount = 0;
      const walkRules = (rules) => {
        for (const r of rules) {
          if (++ruleCount > 60000) return;
          if (r.type === 7 /* KEYFRAMES */ || r.constructor.name === 'CSSKeyframesRule') {
            if (wanted.has(r.name) && !kf[r.name]) kf[r.name] = [...r.cssRules].slice(0, 8).map((k) => [k.keyText, k.style.cssText.slice(0, 200)]);
          } else if (r.type === 5 || r.constructor.name === 'CSSFontFaceRule') {
            if (ff.length < 60) ff.push({ family: (r.style.getPropertyValue('font-family') || '').replace(/["']/g, '').trim(), src: (r.style.getPropertyValue('src') || '').slice(0, 300), weight: r.style.getPropertyValue('font-weight'), style: r.style.getPropertyValue('font-style'), base: r.parentStyleSheet && r.parentStyleSheet.href });
          } else if (r.selectorText && /^(:root|html)\b/.test(r.selectorText) && r.style) {
            for (let i = 0; i < r.style.length; i++) if (r.style[i].startsWith('--')) rootVarNames.add(r.style[i]);
          }
          const txt = r.cssText || '';
          if (txt.includes('animation-timeline')) tlHits.animationTimeline++;
          if (txt.includes('view-timeline') || /\bview\(/.test(txt)) tlHits.viewTimeline++;
          if (txt.includes('scroll-timeline') || /\bscroll\(/.test(txt)) tlHits.scrollTimeline++;
          if (r.cssRules && r.type !== 7) walkRules(r.cssRules);
        }
      };
      const allSheets = [...document.styleSheets].concat(document.adoptedStyleSheets || []);
      for (const s of allSheets) {
        let rules = null;
        try { rules = s.cssRules; } catch { rules = null; }
        sheets.push({ href: s.href || null, readable: !!rules, rules: rules ? rules.length : 0 });
        if (rules) walkRules(rules);
      }
      rc.rootVarNames = [...rootVarNames];
      // root vars found only via CSSOM (computed-style enumeration may not list custom props)
      for (const n of rootVarNames) {
        if (colorsRaw.vars[n] !== undefined || Object.keys(colorsRaw.vars).length >= 60) continue;
        const v = getComputedStyle(document.documentElement).getPropertyValue(n).trim();
        if (!v || v.length > 60 || /var\(|^-?[\d.]+(px|rem|em|%|s|ms)?$/.test(v)) continue;
        let ok = false; try { ok = CSS.supports('color', v); } catch {}
        if (ok) { const c = rc.rgba(v); if (c) colorsRaw.vars[n] = rc.hexa(c); }
      }
      let tlEls = 0, vtEls = 0;
      const snaps = [], scrollers = [];
      for (const r of recs) {
        const cs = r.cs;
        if (cs.animationTimeline && cs.animationTimeline !== 'auto') tlEls++;
        if ((cs.viewTimelineName && cs.viewTimelineName !== 'none') || (cs.scrollTimelineName && cs.scrollTimelineName !== 'none')) vtEls++;
        if (cs.scrollSnapType && cs.scrollSnapType !== 'none' && snaps.length < 8) snaps.push({ desc: rc.desc(r.el), type: cs.scrollSnapType, band: r.b, items: [...r.el.children].filter((c) => getComputedStyle(c).scrollSnapAlign !== 'none').length });
        if (/(auto|scroll)/.test(cs.overflowX) && r.el.scrollWidth > r.el.clientWidth + 20 && r.w >= 200 && scrollers.length < 8) scrollers.push({ desc: rc.desc(r.el), id: rc.idOf(r.el), band: r.b, w: Math.round(r.w), scrollW: r.el.scrollWidth, snap: cs.scrollSnapType !== 'none' ? cs.scrollSnapType : null });
      }
      const htmlCs = getComputedStyle(document.documentElement), bodyCs = getComputedStyle(document.body);
      motionStatic = {
        transitions: [...tr.values()].sort((a, b) => (b.n - b.noop - b.rv) - (a.n - a.noop - a.rv) || b.n - a.n).slice(0, 25).map((e) => ({ prop: e.prop, ms: e.ms, easing: e.easing, delay: +[...e.delays.entries()].sort((a, b) => b[1] - a[1])[0][0], n: e.n, noop: e.noop || undefined, rv: e.rv || undefined })),
        transitionsTotal: tr.size, transitionsObserved: nObserved,
        cssAnimations: [...anims.values()].sort((a, b) => b.n - a.n).slice(0, 15),
        getAnimations: [...ga.values()].sort((a, b) => b.n - a.n).slice(0, 25), getAnimationsTotal: gaTotal,
        ambient: [...amb.values()].sort((a, b) => b.n - a.n).slice(0, 20),
        keyframes: kf, keyframesWanted: [...wanted].slice(0, 30),
        scrollTimeline: { elements: tlEls, timelineNames: vtEls, ruleHits: tlHits },
        scrollSnap: snaps, overflowScrollers: scrollers,
        scrollBehavior: { html: htmlCs.scrollBehavior, body: bodyCs.scrollBehavior },
        cursorNone: htmlCs.cursor === 'none' || bodyCs.cursor === 'none' || !!document.querySelector('main[style*="cursor: none"]'),
      };
      // fonts
      const faces = new Map();
      try { for (const f of document.fonts) { const fam = f.family.replace(/["']/g, '').trim(); const e = faces.get(fam) || { family: fam, weights: new Set(), styles: new Set(), loaded: 0, total: 0, variable: false }; e.weights.add(f.weight); e.styles.add(f.style); e.total++; if (f.status === 'loaded') e.loaded++; if (/\d+\s+\d+/.test(f.weight)) e.variable = true; faces.set(fam, e); } } catch {}
      const GENERIC = /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-sans-serif|ui-serif|ui-monospace|ui-rounded|-apple-system|blinkmacsystemfont|emoji|math|fangsong)$/i;
      const cvs = document.createElement('canvas').getContext('2d');
      const avail = (n) => { const s = 'mmmmmmmmmmlli 0123 WQgy'; const w = (f) => { cvs.font = `64px ${f}`; return cvs.measureText(s).width; }; return w(`"${n}", monospace`) !== w('monospace') || w(`"${n}", serif`) !== w('serif'); };
      const resolve = (stack) => {
        const names = stack.split(',').map((s) => s.trim().replace(/^["']|["']$/g, ''));
        const generic = names.slice().reverse().find((n) => GENERIC.test(n)) || null;
        for (const n of names) {
          if (GENERIC.test(n)) return { family: n, generic: true, fallback: generic };
          const f = faces.get(n);
          if (f && f.loaded) return { family: n, webfont: true, fallback: generic };
          if (avail(n)) return { family: n, local: true, fallback: generic };
        }
        return { family: names[0], unresolved: true, fallback: generic };
      };
      fonts = {
        used: typeOut.families.map((f) => Object.assign({}, f, { rendered: resolve(f.stack) })),
        faces: [...faces.values()].slice(0, 20).map((f) => ({ family: f.family, weights: [...f.weights].slice(0, 12), styles: [...f.styles], loaded: f.loaded, total: f.total, variable: f.variable })),
        fontFaceRules: ff,
      };
      // libraries
      const L = new Map();
      const add = (n, ev) => { const e = L.get(n) || []; if (!e.includes(ev)) e.push(ev); L.set(n, e); };
      const w = window, q = (s) => { try { return !!document.querySelector(s); } catch { return false; } };
      const html = document.documentElement;
      if (w.gsap || w.TweenMax || w.TweenLite) add('gsap', 'global');
      if (w.ScrollTrigger || (w.gsap && w.gsap.core && w.gsap.core.globals && w.gsap.core.globals().ScrollTrigger)) add('ScrollTrigger', 'global');
      if (q('.pin-spacer')) add('ScrollTrigger', 'dom .pin-spacer');
      if (w.ScrollSmoother || q('#smooth-wrapper')) add('ScrollSmoother', w.ScrollSmoother ? 'global' : 'dom #smooth-wrapper');
      if (w.Lenis || w.lenis) add('lenis', 'global');
      if (html.classList.contains('lenis') || q('.lenis')) add('lenis', 'class .lenis');
      if (w.LocomotiveScroll) add('locomotive-scroll', 'global');
      if (q('[data-scroll-container]') || html.classList.contains('has-scroll-smooth') || html.classList.contains('has-scroll-init')) add('locomotive-scroll', 'dom data-scroll-container / has-scroll-*');
      if (w.THREE || w.__THREE__) add('three', 'global');
      if (w.Swiper) add('swiper', 'global');
      if (q('.swiper-initialized, .swiper-wrapper, swiper-container')) add('swiper', 'dom .swiper');
      if (w.lottie || w.bodymovin) add('lottie', 'global');
      if (q('lottie-player, dotlottie-player, dotlottie-wc, [data-lottie], [data-animation-type="lottie"]')) add('lottie', 'dom lottie element');
      if (w.barba || q('[data-barba]')) add('barba', w.barba ? 'global' : 'dom data-barba');
      if (q('[data-framer-name], [data-framer-component-type], [data-framer-appear-id]')) add('framer', 'dom data-framer-*');
      if (q('[data-projection-id]')) add('framer-motion', 'dom data-projection-id');
      if (w.AOS || q('[data-aos]')) add('aos', w.AOS ? 'global' : 'dom data-aos');
      if (w.ScrollReveal) add('scrollreveal', 'global');
      if (w.anime) add('animejs', 'global');
      if (w.Splide || q('.splide.is-initialized')) add('splide', 'global/dom');
      if (w.Flickity || q('.flickity-enabled')) add('flickity', 'global/dom');
      if (q('.slick-initialized')) add('slick', 'dom');
      if (w.rive || q('canvas[data-rive], rive-canvas')) add('rive', 'global/dom');
      if (q('spline-viewer')) add('spline', 'dom spline-viewer');
      if (w.PIXI) add('pixi', 'global');
      if (w.Webflow || html.hasAttribute('data-wf-page')) add('webflow', 'global/dom');
      if (w.__NEXT_DATA__ || q('#__next') || w.next) add('next', 'global/dom');
      if (w.__NUXT__) add('nuxt', 'global');
      if (w.__VUE__ || w.Vue) add('vue', 'global');
      if (w.Shopify) add('shopify', 'global');
      if (w.jQuery) add('jquery', 'global');
      if (q('[data-reactroot]') || w.React || [...document.querySelectorAll('body > div')].some((d) => Object.keys(d).some((k) => k.startsWith('__reactContainer')))) add('react', 'dom/global');
      const SRC = [['gsap', /gsap|TweenMax/i], ['ScrollTrigger', /ScrollTrigger/i], ['lenis', /lenis/i], ['locomotive-scroll', /locomotive/i], ['three', /three(\.module)?(\.min)?\.js|\/three@/i], ['swiper', /swiper/i], ['lottie', /lottie|bodymovin/i], ['barba', /barba/i], ['framer-motion', /framer-motion/i], ['aos', /\baos(\.min)?\.js/i], ['splide', /splide/i], ['flickity', /flickity/i], ['slick', /slick(\.min)?\.js/i], ['animejs', /anime(\.min)?\.js|animejs/i], ['rive', /@rive-app|rive\.js/i], ['spline', /splinetool|spline-viewer/i], ['pixi', /pixi/i], ['jquery', /jquery/i]];
      for (const s of document.scripts) { if (!s.src) continue; for (const [n, re] of SRC) if (re.test(s.src)) add(n, 'script ' + (s.src.split('/').pop() || '').slice(0, 40)); }
      libs = [...L.entries()].map(([name, ev]) => ({ name, evidence: ev.slice(0, 3).join('; ') }));
      motionStatic.sheets = sheets;
    }

    // ---------- 11. overflow ----------
    const sw = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
    const bx = scrollX; window.scrollTo(100000, scrollY); const canX0 = scrollX > 0; window.scrollTo(bx, scrollY);
    // overflow-x hidden/clip on the viewport (html's value, else body's, propagates to it): a script can still
    // scroll it but a visitor cannot, so the wider content is clipped (overflow.clipped), not an overflow
    const canX = canX0 && !rc.viewportClipsX();
    const overflow = { scrollWidth: sw, vw, overflow: canX, by: canX ? sw - vw : 0 };
    if (canX0 && !canX) overflow.viewportClip = true;
    if (canX) {
      // the widest elements whose right edge passes the viewport and that no ancestor clips
      const off = [];
      for (const r of R.values()) {
        if (r.x + r.w <= vw + 1 || r.cs.position === 'fixed') continue;
        const pc = clipOf.get(r.el.parentElement);
        if (pc && pc[2] <= vw + 1) continue;
        off.push(r);
      }
      off.sort((a, b) => b.w - a.w);
      const outer = off.filter((r) => !off.some((q) => q !== r && q.el.contains(r.el) && q.x + q.w >= r.x + r.w - 1));
      overflow.offenders = outer.slice(0, 3).map((r) => ({ sel: rc.selPath(r.el), right: Math.round(r.x + r.w), w: Math.round(r.w), band: r.b }));
    }
    // clipped: visible text or media whose box crosses the left/right viewport edge and is cut there (by a
    // clipping ancestor, or by html/body when the page cannot scroll sideways), so part of it can never be
    // seen. Designed cases are excluded: horizontally scrollable or scroll-snap containers, translated or
    // animated tracks (marquees, carousels and their peeking items), edge-fade masks (mask-image gradient),
    // carousel/slider semantics or names,
    // off-canvas boxes (a fixed/absolute ancestor mostly outside the viewport), aria-hidden/inert subtrees,
    // screen-reader-only boxes, absolutely positioned media and media that spans both edges (a cropped bleed).
    { const ce = rc.clippedEdge({ R, vw, canX }); overflow.clipped = ce.items; if (ce.n) overflow.clippedN = ce.n; }

    // tracked elements of the scroll pass (rc.snapshot) that are pieces of a stand-in box: indices into
    // rc.snap.els / rc.snap.layout; capture.mjs keeps them out of scroll-linked animations and parallax
    let inMedia;
    if (o.full && rc.snap) {
      inMedia = { els: [], layout: [] };
      rc.snap.els.forEach((e, i) => { if (e.el.isConnected && pieceOf(e.el)) inMedia.els.push(i); });
      rc.snap.layout.forEach((l, j) => { if (l.el.isConnected && pieceOf(l.el)) inMedia.layout.push(j); });
    }
    for (const s of sections) {
      delete s._cards;
      if (s.h > vh * 4 && s.role !== 'footer') notes.push(`section ${sections.indexOf(s)} (${s.desc}) is ${(s.h / vh).toFixed(1)} viewport heights tall and was not subdivided (no full-width stacked children${s.layout.cols > 1 ? `; ${s.layout.cols}-column layout` : ''}); treat its role/bbox as coarse`);
    }
    return {
      vp: vw, vh, docH, scrollY: Math.round(sy), seg: segInfo, hiddenPrimary, sections, type: typeOut, colorsRaw: o.full ? colorsRaw : { rootBg: colorsRaw.rootBg, mediaAreaFrac: colorsRaw.mediaAreaFrac },
      spacing, nav: navOut, components: comps, hoverTargets: (rc.hoverTargets || []).map((h) => ({ kind: h.kind, desc: rc.desc(h.el) })),
      motionStatic, fonts, libraries: libs, overflow, inMedia, notes, counts: { elements: recs.length, hidden: hiddenN, texts: texts.length, buttons: btns.size, media: media.length, ms: Math.round(performance.now() - tStart) },
    };
  };

  // ---------- ink probes ----------
  // rc.probeShow() lays the ink samples of the last analyze() (rc.inkSpec) out black on white in a fixed
  // container at the viewport's top-left (chunks wrap at the viewport width; a sample wider than the
  // viewport is split into chunks), waits for fonts, and returns the chunk boxes for capture.mjs to
  // screenshot: {vw, vh, H, items[{role, sz, rects[[x, y, w, h, advance]]}]}. rc.probeOffset(y) shifts the
  // container up by y px (for samples below the first screen); rc.probeHide() removes it.
  rc.probeHide = () => { const b = document.getElementById('rc-ink-probes'); if (b) b.remove(); };
  rc.probeOffset = (y) => { const b = document.getElementById('rc-ink-probes'); if (b) b.style.setProperty('top', `${-y}px`, 'important'); return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))); };
  rc.probeShow = async () => {
    rc.probeHide();
    const spec = rc.inkSpec || [];
    if (!spec.length) return null;
    const vw = innerWidth, vh = innerHeight;
    const box = document.createElement('rc-ink');
    box.id = 'rc-ink-probes';
    box.setAttribute('style', `all:initial!important;position:fixed!important;left:0!important;top:0!important;z-index:2147483647!important;display:flex!important;flex-wrap:wrap!important;align-items:flex-start!important;align-content:flex-start!important;box-sizing:border-box!important;width:${vw}px!important;padding:8px!important;margin:0!important;background:#ffffff!important;opacity:1!important;visibility:visible!important;transform:none!important;filter:none!important;pointer-events:none!important;`);
    document.documentElement.appendChild(box);
    const CH = 'display:inline-block!important;white-space:pre!important;line-height:normal!important;color:#000000!important;background:#ffffff!important;padding:0.3em!important;margin:0 8px 8px 0!important;box-sizing:content-box!important;';
    const chunk = (css, text) => { const e = document.createElement('rc-c'); e.setAttribute('style', css + CH); e.textContent = text; box.appendChild(e); return e; };
    const items = [];
    for (const s of spec) {
      for (const it of s.items) {
        // halve any chunk (with its padding and margin) that does not fit the container width
        const els = [];
        const queue = [INK_SAMPLE];
        while (queue.length) {
          const t = queue.shift();
          const e = chunk(it.css, t);
          if (e.getBoundingClientRect().width + 8 > vw - 16 && t.length > 1) { e.remove(); const h = Math.ceil(t.length / 2); queue.unshift(t.slice(0, h), t.slice(h)); continue; }
          els.push(e);
        }
        items.push({ role: s.role, sz: it.sz, els });
      }
    }
    try { await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 2500))]); } catch {}
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const out = items.map((it) => ({ role: it.role, sz: it.sz, rects: it.els.map((e) => { const r = e.getBoundingClientRect(), c = getComputedStyle(e); return [r.left, r.top, r.width, r.height, r.width - px(c.paddingLeft) - px(c.paddingRight)]; }) }));
    return { vw, vh, H: box.getBoundingClientRect().height, items: out };
  };

  // ---------- hover ----------
  const HP = ['color', 'backgroundColor', 'backgroundImage', 'borderTopColor', 'borderBottomColor', 'boxShadow', 'opacity', 'textDecorationLine', 'textDecorationColor', 'filter', 'outlineStyle', 'letterSpacing'];
  const hstyle = (el, ps) => {
    const cs = getComputedStyle(el, ps || null);
    const o = {};
    for (const p of HP) o[p] = cs[p];
    // colours that only follow currentColor without being painted are noise
    if (!(px(cs.borderTopWidth) > 0) || cs.borderTopStyle === 'none') o.borderTopColor = '';
    if (!(px(cs.borderBottomWidth) > 0) || cs.borderBottomStyle === 'none') o.borderBottomColor = '';
    if (cs.textDecorationLine === 'none') o.textDecorationColor = '';
    if (cs.outlineStyle === 'none') o.outlineStyle = '';
    // fully transparent shadows paint nothing
    if (o.boxShadow && o.boxShadow !== 'none') { const cols = o.boxShadow.match(/rgba?\([^)]*\)/g) || []; if (cols.length && cols.every((c) => !rc.rgba(c))) o.boxShadow = 'none'; }
    const t = rc.tf(cs, el);
    o.transform = `${half(t.tx)},${half(t.ty)},${r3(t.sx)},${r1(t.rot)}`;
    if (ps) { o.width = cs.width; o.content = cs.content; }
    return o;
  };
  const fmt = (p, v) => {
    if (/color/i.test(p) && v) { const c = rc.rgba(v); return c ? rc.hexa(c) : 'transparent'; }
    if (p === 'transform') { const [tx, ty, s, r] = v.split(',').map(Number); return { tx, ty, s, r }; }
    if (p === 'backgroundImage' || p === 'boxShadow' || p === 'filter') return v.slice(0, 120);
    return v;
  };
  const diff = (a, b) => { const d = {}; for (const k in a) if (a[k] !== b[k]) d[k] = [fmt(k, a[k]), fmt(k, b[k])]; return Object.keys(d).length ? d : null; };
  rc.hoverScroll = (i) => {
    const t = rc.hoverTargets && rc.hoverTargets[i];
    if (!t || !t.el.isConnected) return false;
    t.el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    return true;
  };
  rc.hoverBefore = (i) => {
    const t = rc.hoverTargets[i];
    const el = t.el;
    const kids = [];
    for (const k of el.querySelectorAll('*')) { if (k.ownerSVGElement) continue; const r = k.getBoundingClientRect(); if (r.width > 0 && r.height > 0) kids.push(k); if (kids.length >= 25) break; }
    t.kids = kids;
    t.before = { self: hstyle(el), before: hstyle(el, '::before'), after: hstyle(el, '::after'), kids: kids.map((k) => hstyle(k)) };
    let maxMs = rc.maxTrans(getComputedStyle(el));
    for (const k of kids) maxMs = Math.max(maxMs, rc.maxTrans(getComputedStyle(k)));
    for (const ps of ['::before', '::after']) maxMs = Math.max(maxMs, rc.maxTrans(getComputedStyle(el, ps)));
    const r = el.getBoundingClientRect();
    const cx = Math.min(innerWidth - 2, Math.max(1, r.left + r.width / 2)), cy = Math.min(innerHeight - 2, Math.max(1, r.top + Math.min(r.height / 2, 40)));
    const hit = document.elementFromPoint(cx, cy);
    // shown = not opacity ~0 / visibility hidden on it or an ancestor once scrolled into view (capture marks
    // the entry `invalid` otherwise)
    let shown = true;
    try { if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) shown = false; } catch {}
    if (shown) { let op = 1; for (let e = el; e && e.nodeType === 1; e = e.parentElement) op *= parseFloat(getComputedStyle(e).opacity); if (!(op >= 0.1)) shown = false; }
    return { x: cx, y: cy, w: r.width, h: r.height, left: r.left, top: r.top, maxMs: Math.min(maxMs, 1500), inView: r.bottom > 0 && r.top < innerHeight, covered: !(hit && (el === hit || el.contains(hit) || hit.contains(el))), shown };
  };
  rc.hoverDiff = (i) => {
    const t = rc.hoverTargets[i];
    const el = t.el;
    // a failed read (element detached or re-rendered during the hover) returns empty computed values
    if (!el.isConnected) return { kind: t.kind, desc: rc.desc(el), skipped: 'element detached during hover' };
    const now = hstyle(el);
    const blank = Object.keys(now).filter((k) => now[k] === '' && t.before.self[k] !== '').length;
    if (blank >= 3) return { kind: t.kind, desc: rc.desc(el), skipped: `computed style unreadable after hover (${blank} empty values)` };
    const self = diff(t.before.self, now);
    const live = (b, a) => !((b.content === 'none' || b.content === 'normal') && (a.content === 'none' || a.content === 'normal'));
    const hb = hstyle(el, '::before'), ha = hstyle(el, '::after');
    const pb = live(t.before.before, hb) ? diff(t.before.before, hb) : null;
    const pa = live(t.before.after, ha) ? diff(t.before.after, ha) : null;
    const kids = [];
    t.kids.forEach((k, j) => { if (!k.isConnected) return; const d = diff(t.before.kids[j], hstyle(k)); if (d && kids.length < 6) kids.push({ desc: rc.desc(k), kind: /^(IMG|PICTURE|VIDEO)$/.test(k.tagName) ? 'image' : k.tagName.toLowerCase() === 'svg' ? 'icon' : (k.textContent || '').trim() ? 'text' : 'box', delta: d }); });
    const cs = getComputedStyle(el);
    const kidTrans = t.kids.map((k) => rc.transSummary(getComputedStyle(k))).filter(Boolean);
    return { kind: t.kind, desc: rc.desc(el), self, before: pb, after: pa, kids, transition: rc.transSummary(cs) || (kidTrans[0] ? 'child: ' + kidTrans[0] : null), cursor: cs.cursor };
  };
  // away point for the mouse: a spot not over links/buttons
  rc.awayPoint = () => {
    const pts = [[4, innerHeight / 2], [innerWidth - 24, innerHeight / 2], [innerWidth / 2, innerHeight - 4], [4, innerHeight - 4]];
    for (const [x, y] of pts) { const e = document.elementFromPoint(x, y); if (!e || !e.closest('a,button,[role=button],input,label,[onclick]')) return [Math.round(x), Math.round(y)]; }
    return [4, Math.round(innerHeight / 2)];
  };
  // cursor follower probe: small fixed/absolute, pointer-events:none elements
  rc.cursorProbe = (phase) => {
    if (phase === 0) {
      const c = [];
      for (const el of document.body.getElementsByTagName('*')) {
        if (SKIP.has(el.tagName) || el.ownerSVGElement) continue;
        const cs = getComputedStyle(el);
        if (cs.position !== 'fixed' && cs.position !== 'absolute') continue;
        const r = el.getBoundingClientRect();
        if (r.width > 120 || r.height > 120 || r.width < 2 || r.height < 2) continue;
        if (cs.pointerEvents !== 'none' && cs.position !== 'fixed') continue;
        c.push(el); if (c.length > 200) break;
      }
      rc._cur = c.map((el) => { const r = el.getBoundingClientRect(); return { el, x: r.left, y: r.top }; });
      return rc._cur.length;
    }
    const [dx, dy] = phase;
    const hits = [];
    for (const c of rc._cur || []) {
      const r = c.el.getBoundingClientRect();
      const mx = r.left - c.x, my = r.top - c.y;
      if (Math.abs(mx) > Math.abs(dx) * 0.4 && Math.abs(my) > Math.abs(dy) * 0.4 && Math.sign(mx) === Math.sign(dx) && Math.sign(my) === Math.sign(dy)) {
        const cs = getComputedStyle(c.el);
        hits.push({ desc: rc.desc(c.el), w: Math.round(r.width), h: Math.round(r.height), blend: cs.mixBlendMode !== 'normal' ? cs.mixBlendMode : null, follow: r2(Math.hypot(mx, my) / Math.hypot(dx, dy)) });
      }
    }
    return hits.slice(0, 3);
  };
}

// Role ink (visual heaviness), Node side, for every role of one analyze() result: the page lays out
// the role ink samples (rc.probeShow), one screenshot per viewport-high window of the probe area is
// taken, and ink = antialias-weighted ink sum (darkness relative to the white probe background) /
// (advance width x font px), summed over a sample's chunks and averaged over its sizes (0.94x, 1x and
// 1.06x for text <= 24 px). The same method for every role on every site. Writes A.type.roles[r].ink;
// leaves it null when the probes could not be laid out or shot. Returns the number of roles measured.
export async function probeInk(page, A) {
  const roles = A && A.type && A.type.roles;
  if (!roles) return 0;
  const lay = await page.evaluate(() => window.__rc.probeShow());
  if (!lay || !lay.items || !lay.items.length) return 0;
  try {
    const rects = [];
    lay.items.forEach((it, i) => it.rects.forEach((r) => rects.push({ i, r })));
    // viewport-high windows so that every chunk lies fully inside one
    const offs = [];
    let cur = null;
    for (const { r } of rects.slice().sort((a, b) => a.r[1] - b.r[1])) if (cur === null || r[1] + r[3] > cur + lay.vh - 2) { cur = Math.max(0, Math.floor(r[1]) - 2); offs.push(cur); }
    const sum = lay.items.map(() => ({ ink: 0, adv: 0, n: 0 }));
    const done = new Set();
    for (const off of offs) {
      await page.evaluate((y) => window.__rc.probeOffset(y), off);
      const h = Math.max(1, Math.min(lay.vh, Math.ceil(lay.H - off)));
      const png = decodePng(await page.screenshot({ clip: { x: 0, y: 0, width: lay.vw, height: h }, timeout: 20000 }));
      rects.forEach((x, k) => {
        const r = x.r;
        if (done.has(k) || r[1] < off - 0.5 || r[1] + r[3] > off + h + 0.5) return;
        done.add(k);
        const x0 = Math.max(0, Math.round(r[0])), x1 = Math.min(png.width, Math.round(r[0] + r[2]));
        const y0 = Math.max(0, Math.round(r[1] - off)), y1 = Math.min(png.height, Math.round(r[1] - off + r[3]));
        let ink = 0;
        for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
          const p = (yy * png.width + xx) * 4;
          const L = 0.2126 * png.data[p] + 0.7152 * png.data[p + 1] + 0.0722 * png.data[p + 2];
          ink += Math.max(0, 255 - L) / 255;
        }
        sum[x.i].ink += ink; sum[x.i].adv += r[4]; sum[x.i].n++;
      });
    }
    const per = new Map();
    lay.items.forEach((it, i) => {
      if (!(sum[i].adv > 0) || sum[i].n !== it.rects.length) return;
      const a = per.get(it.role) || []; a.push(sum[i].ink / (sum[i].adv * it.sz)); per.set(it.role, a);
    });
    let n = 0;
    for (const [role, v] of per) if (roles[role]) { roles[role].ink = Math.round((v.reduce((s, x) => s + x, 0) / v.length) * 10000) / 10000; n++; }
    return n;
  } finally { await page.evaluate(() => window.__rc.probeHide()).catch(() => {}); }
}
