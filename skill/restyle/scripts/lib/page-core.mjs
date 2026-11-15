// Page-side core for capture.mjs. Installed into the top frame of every captured page with
// page.addInitScript({ content: `(${pageCore})();` }), so it runs before any site script.
// MUST stay self-contained: no imports, no references to module scope. Everything hangs off
// window.__rc (non-enumerable). Provides: value helpers, motion-state reading, a load-time
// rAF sampler, page segmentation into bands, nav detection, the pre-scroll snapshot, the
// idle (marquee) sampler and the per-scroll-step rAF sampler.
export function pageCore() {
  if (window.top !== window) return;
  if (window.__rc) return;
  const rc = {};
  try { Object.defineProperty(window, '__rc', { value: rc, configurable: true, enumerable: false, writable: true }); }
  catch { window.__rc = rc; }

  const SKIP = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'TITLE', 'BR', 'WBR',
    'SOURCE', 'TRACK', 'PARAM', 'BASE', 'OPTION', 'OPTGROUP', 'DATALIST', 'AREA', 'MAP']);
  rc.SKIP = SKIP;
  const r1 = (v) => Math.round(v * 10) / 10;
  const r2 = (v) => Math.round(v * 100) / 100;
  const r3 = (v) => Math.round(v * 1000) / 1000;
  const half = (v) => Math.round(v * 2) / 2;
  rc.r1 = r1; rc.r2 = r2; rc.r3 = r3; rc.half = half;
  const median = (a) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  rc.median = median;

  // ---------- colour ----------
  let cctx = null; const ccache = new Map();
  // Returns [r,g,b,a] (sRGB 0-255, a 0-1) or null for transparent / unparseable.
  rc.rgba = (str) => {
    if (!str || str === 'transparent' || str === 'none' || str === 'currentcolor') return null;
    if (ccache.has(str)) return ccache.get(str);
    let out = null;
    const m = str.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/);
    if (m) {
      const a = m[4] === undefined ? 1 : (m[4].endsWith('%') ? parseFloat(m[4]) / 100 : +m[4]);
      out = [+m[1], +m[2], +m[3], a];
    } else {
      try {
        if (!cctx) { const c = document.createElement('canvas'); c.width = c.height = 1; cctx = c.getContext('2d', { willReadFrequently: true }); }
        cctx.clearRect(0, 0, 1, 1); cctx.fillStyle = '#000'; cctx.fillStyle = str; cctx.fillRect(0, 0, 1, 1);
        const d = cctx.getImageData(0, 0, 1, 1).data; out = [d[0], d[1], d[2], r2(d[3] / 255)];
      } catch { out = null; }
    }
    if (out && out[3] <= 0.004) out = null;
    if (out) out[3] = r2(out[3]);
    ccache.set(str, out);
    return out;
  };
  rc.hex = (c) => c ? '#' + c.slice(0, 3).map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('') : null;
  // hex with alpha suffix when not opaque, e.g. "#ffffff@0.08"
  rc.hexa = (c) => c ? rc.hex(c) + (c[3] < 0.995 ? '@' + r2(c[3]) : '') : null;

  // ---------- transforms / motion state ----------
  rc.tf = (cs, el) => {
    let tx = 0, ty = 0, sx = 1, sy = 1, rot = 0;
    const t = cs.transform;
    if (t && t !== 'none') {
      const m = t.match(/matrix(3d)?\(([^)]+)\)/);
      if (m) {
        const v = m[2].split(',').map(Number);
        let a, b, c, d, e, f;
        if (m[1]) { a = v[0]; b = v[1]; c = v[4]; d = v[5]; e = v[12]; f = v[13]; } else { [a, b, c, d, e, f] = v; }
        sx = Math.hypot(a, b); rot = Math.atan2(b, a) * 180 / Math.PI; sy = sx ? (a * d - b * c) / sx : 0; tx = e; ty = f;
      }
    }
    const tr = cs.translate;
    if (tr && tr !== 'none') {
      const p = tr.split(/\s+/);
      const len = (s, ref) => s && s.endsWith('%') ? parseFloat(s) / 100 * ref : (parseFloat(s) || 0);
      tx += len(p[0], el ? el.offsetWidth : 0); ty += len(p[1], el ? el.offsetHeight : 0);
    }
    const sc = cs.scale;
    if (sc && sc !== 'none') { const p = sc.split(/\s+/).map(parseFloat); if (!isNaN(p[0])) { sx *= p[0]; sy *= isNaN(p[1]) ? p[0] : p[1]; } }
    const ro = cs.rotate;
    if (ro && ro !== 'none') { const mm = ro.match(/(-?[\d.]+)deg/); if (mm) rot += +mm[1]; }
    return { tx, ty, sx, sy, rot };
  };
  // Fraction (0-1) of the element box left visible by clip-path (1 = unclipped).
  rc.clipFrac = (cp, el) => {
    if (!cp || cp === 'none') return 1;
    const w = (el && el.offsetWidth) || 1, h = (el && el.offsetHeight) || 1;
    const len = (s, ref) => s.endsWith('%') ? parseFloat(s) / 100 * ref : (parseFloat(s) || 0);
    let m = cp.match(/^inset\(([^)]*)\)/);
    if (m) {
      const parts = m[1].split(/\s+round\s+/)[0].trim().split(/\s+/);
      const [t, rr = t, b = t, l = rr] = parts;
      const fh = Math.max(0, h - len(t, h) - len(b, h)) / h, fw = Math.max(0, w - len(rr, w) - len(l, w)) / w;
      return r3(Math.min(1, fh * fw));
    }
    m = cp.match(/^polygon\(([^)]*)\)/);
    if (m) {
      const pts = m[1].replace(/^\s*(nonzero|evenodd)\s*,/, '').split(',').map((p) => p.trim().split(/\s+/));
      let a = 0;
      for (let i = 0; i < pts.length; i++) {
        const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
        if (!x1 || !y1 || !x2 || !y2) continue;
        a += len(x1, w) * len(y2, h) - len(x2, w) * len(y1, h);
      }
      return r3(Math.min(1, Math.abs(a / 2) / (w * h)));
    }
    m = cp.match(/^circle\(\s*([^)\s]*)/);
    if (m) {
      const rad = m[1] && m[1] !== 'at' ? len(m[1], Math.hypot(w, h) / Math.SQRT2) : Math.min(w, h) / 2;
      return r3(Math.min(1, Math.PI * rad * rad / (w * h)));
    }
    return 1;
  };
  rc.mstate = (el, cs) => {
    cs = cs || getComputedStyle(el);
    const t = rc.tf(cs, el);
    const fm = cs.filter && cs.filter !== 'none' ? cs.filter.match(/blur\(([\d.]+)px\)/) : null;
    return { o: +cs.opacity, tx: t.tx, ty: t.ty, s: t.sx, r: t.rot, c: rc.clipFrac(cs.clipPath, el), b: fm ? +fm[1] : 0, v: cs.visibility === 'hidden' ? 0 : 1 };
  };
  // Fine thresholds: rAF can run at >60 fps headless, so per-frame steps of slow motion are tiny.
  const DIFF = (a, b) => Math.abs(a.o - b.o) > 0.002 || Math.abs(a.tx - b.tx) > 0.1 || Math.abs(a.ty - b.ty) > 0.1 ||
    Math.abs(a.s - b.s) > 0.0005 || Math.abs(a.r - b.r) > 0.05 || Math.abs(a.c - b.c) > 0.001 || Math.abs(a.b - b.b) > 0.02 || a.v !== b.v;
  const hiddenish = (m) => m.o < 0.98 || Math.abs(m.tx) > 1 || Math.abs(m.ty) > 1 || Math.abs(m.s - 1) > 0.01 ||
    Math.abs(m.r) > 0.5 || m.c < 0.98 || m.b > 0.2 || m.v === 0;
  rc.DIFF = DIFF; rc.hiddenish = hiddenish;
  const rs = (m) => ({ o: r2(m.o), tx: half(m.tx), ty: half(m.ty), s: r3(m.s), r: r1(m.r), c: r2(m.c), b: r1(m.b), v: m.v });
  rc.rs = rs;

  // ---------- element identity ----------
  rc.desc = (el) => {
    if (!el || !el.tagName) return '';
    let s = el.tagName.toLowerCase();
    if (el.id && el.id.length < 30 && !/\d{3,}/.test(el.id)) s += '#' + el.id;
    const cl = el.getAttribute && el.getAttribute('class');
    if (cl && typeof cl === 'string') {
      const cls = cl.trim().split(/\s+/).filter(Boolean).slice(0, 2);
      if (cls.length) s += '.' + cls.map((c) => c.slice(0, 28)).join('.');
    }
    return s.slice(0, 72);
  };
  const STATEFUL = /(^|[-_])(active|visible|is-|has-|in-?view|aos|animate|animated|reveal|revealed|loaded|scrolled|sticky|show|shown|hidden|open|current|enter|leave|done|fade|hover)/i;
  const keyOf = (e) => {
    const tag = e.tagName.toLowerCase();
    let cls = '';
    if (e.classList) for (const c of e.classList) { if (!STATEFUL.test(c) && c.length < 40) { cls = c; break; } }
    const id = e.id && e.id.length < 40 && !/\d{4,}/.test(e.id) ? e.id : '';
    return tag + (id ? '#' + id : '') + (cls ? '.' + cls : '');
  };
  // Stable signature: chain of tag#id.class:nth from body. Same DOM -> same sig at any viewport.
  rc.sig = (el) => {
    const parts = [];
    let e = el;
    while (e && e !== document.body && e.parentElement) {
      const key = keyOf(e);
      let nth = 0;
      for (const s of e.parentElement.children) { if (s === e) break; if (keyOf(s) === key) nth++; }
      parts.push(key + (nth ? ':' + nth : ''));
      e = e.parentElement;
    }
    return parts.reverse().join('>');
  };
  rc.bySig = (sig) => {
    if (sig === '') return document.body;
    let el = document.body;
    for (const part of sig.split('>')) {
      const mm = part.match(/^(.*?)(?::(\d+))?$/);
      const key = mm[1], nth = mm[2] ? +mm[2] : 0;
      let k = 0, found = null;
      for (const c of el.children) { if (keyOf(c) === key) { if (k === nth) { found = c; break; } k++; } }
      if (!found) return null;
      el = found;
    }
    return el;
  };
  // short selector path (up to 4 levels) for findings
  rc.selPath = (el) => { const parts = []; let e = el; for (let d = 0; e && e !== document.body && d < 4; d++, e = e.parentElement) parts.unshift(rc.desc(e).slice(0, 40)); return parts.join(' > '); };
  rc.hash = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(36).padStart(6, '0').slice(-6); };
  rc.idOf = (el) => 's-' + rc.hash(rc.sig(el));

  rc.docH = () => Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);

  // ---------- third-party chrome (consent CMPs, ad slots, chat widgets, captcha badges) ----------
  // Never part of the site's design: excluded from roles, palette, sticky, type and components.
  const TP_SEL = [
    '#onetrust-consent-sdk', '#onetrust-banner-sdk', '#CybotCookiebotDialog', '#didomi-host', '#usercentrics-root', '#usercentrics-cmp-ui',
    '.qc-cmp2-container', '[id^="sp_message_container"]', '.fc-consent-root', '#cmpbox', '#cmpwrapper', '#truste-consent-track', '#consent_blackbar',
    '.truste_overlay', '.truste_box_overlay', '.osano-cm-window', '#cookiescript_injected', '.cky-consent-container', '.cky-overlay',
    '#hs-eu-cookie-confirmation', '#cookie-law-info-bar', '.cc-window', '.cc-banner', '#iubenda-cs-banner', '#axeptio_overlay', '.termly-styles-root',
    '#tarteaucitronRoot', '#transcend-consent-manager', '#gdpr-consent-tool-wrapper', '[aria-label="cookieconsent"]',
    '.grecaptcha-badge', 'iframe[src*="recaptcha"]', 'iframe[src*="hcaptcha"]', 'iframe[src*="challenges.cloudflare"]',
    '[id^="google_ads"]', '[id*="div-gpt-ad"]', '[data-google-query-id]', 'ins.adsbygoogle', '[data-concert]', '[data-ad-slot]', '[data-adunit]',
    '[data-ad-unit]', '[data-ad]', '[id^="taboola-"]', '.OUTBRAIN', '[data-widget-id][class*="outbrain" i]', '[aria-label="Advertisement" i]',
    '#intercom-container', '.intercom-lightweight-app', '#hubspot-messages-iframe-container', '#drift-widget-container', '#drift-frame-controller',
    'iframe#launcher', '#launcher[title*="chat" i]', '.crisp-client', '#tawkchat-container', '#chat-widget-container', '#fc_frame', '.zEWidget-launcher',
  ].join(',');
  const AD_SRC = /doubleclick|googlesyndication|googleadservices|adnxs|amazon-adsystem|criteo|taboola|outbrain|pubmatic|rubiconproject|openx|adsafeprotected|moatads|adform|smartadserver|teads|sharethrough|33across|yieldmo|casalemedia|indexww/i;
  const CONSENT_TXT = /cookie|consent|gdpr|your privacy|privacy (choices|settings|preferences)/i;
  // Set of every element inside third-party chrome (recomputed on demand).
  rc.tpScan = () => {
    const set = new Set(), roots = [];
    const addTree = (root) => { if (set.has(root)) return; roots.push(root); set.add(root); for (const e of root.getElementsByTagName('*')) set.add(e); };
    try { for (const el of document.querySelectorAll(TP_SEL)) addTree(el); } catch {}
    for (const f of document.querySelectorAll('iframe')) {
      if (set.has(f)) continue;
      const src = f.src || f.getAttribute('data-src') || '';
      if (!(AD_SRC.test(src) || /google_ads|aswift|ad_?frame/i.test(f.id + ' ' + f.name))) continue;
      // climb to the slot container: ancestors that hold nothing but the ad (<= 20 chars of text such as "Advertisement")
      let r = f, p = f.parentElement;
      const fh = f.getBoundingClientRect().height;
      while (p && p !== document.body && (p.innerText || '').trim().length <= 20 && p.getBoundingClientRect().height <= fh + 140) { r = p; p = p.parentElement; }
      addTree(r);
    }
    // popups / banners removed by the capture (consent.mjs marks their roots with data-rc-overlay)
    try { for (const el of document.querySelectorAll('[data-rc-overlay]')) addTree(el); } catch {}
    // consent-like fixed/sticky containers (banner text, short)
    const vw = innerWidth, vh = innerHeight;
    for (const el of document.body.getElementsByTagName('*')) {
      if (set.has(el) || SKIP.has(el.tagName) || el.ownerSVGElement) continue;
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
      if (cs.display === 'none') continue;
      const r = el.getBoundingClientRect();
      if (r.width * r.height < vw * vh * 0.01) continue;
      const t = (el.innerText || '').slice(0, 2600);
      if (t.length < 2500 && CONSENT_TXT.test(t) && el.querySelector('button,a,[role=button]') && !el.querySelector('h1')) addTree(el);
    }
    // embeds blocked by the cookie choice ("this content is not visible due to your cookie preferences"):
    // the placeholder box (and its button) is third-party, not the site's design
    for (const root of rc.blockedEmbeds()) addTree(root);
    rc.tpSet = set; rc.tpRoots = roots;
    return set;
  };
  const BLOCKED_EMBED = /(not (be )?(visible|displayed|shown|available|loaded)|can(no|')t be (shown|displayed|loaded)|(has been |is )?blocked|requires? (your )?consent|disabled).{0,80}(cookie|consent|privacy|tracking)|(cookie|consent|privacy) (settings|preferences|choices).{0,60}(to (view|see|load|display|watch|show))|(accept|enable|allow) (all |marketing |targeting |functional |social media |third[- ]party )?(cookies|content).{0,40}(to (view|see|watch|load|display))/i;
  rc.blockedEmbeds = () => {
    const out = [...document.querySelectorAll('[data-rc-embed]')];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n, guard = 0;
    while ((n = walker.nextNode()) && guard++ < 60000 && out.length < 20) {
      const s = n.data;
      if (!s || s.length < 12 || !/cookie|consent|privacy|tracking/i.test(s)) continue;
      let el = n.parentElement;
      if (!el || el.closest('[data-rc-embed]')) continue;
      // the smallest block around the message whose whole text is still about the blocked embed
      let box = el;
      for (let d = 0; d < 6 && box.parentElement && box.parentElement !== document.body; d++) {
        const t = (box.innerText || '').trim();
        if (BLOCKED_EMBED.test(t) && t.length <= 400) break;
        box = box.parentElement;
      }
      const txt = (box.innerText || '').trim();
      if (!BLOCKED_EMBED.test(txt) || txt.length > 400) continue;
      // climb to the placeholder frame (same text, up to the size of an embed)
      let p = box.parentElement;
      while (p && p !== document.body && ((p.innerText || '').trim().length <= txt.length + 40) && p.getBoundingClientRect().height <= Math.max(box.getBoundingClientRect().height * 3, 720)) { box = p; p = p.parentElement; }
      box.setAttribute('data-rc-embed', 'blocked');
      out.push(box);
    }
    return out;
  };
  rc.isTp = (el) => !!(rc.tpSet && rc.tpSet.has(el));

  // ---------- event log (CSS transitions / animations that start) ----------
  rc.events = [];
  const onEv = (e) => {
    if (rc.events.length < 3000 && e.target && e.target.nodeType === 1) {
      rc.events.push([e.type === 'animationstart' ? 'a' : 't', Math.round(performance.now()), e.target, e.propertyName || e.animationName || '']);
    }
  };
  try { addEventListener('transitionstart', onEv, true); addEventListener('animationstart', onEv, true); } catch {}

  // Running-animation summary for one element (used at the first frame an element changes).
  rc.animInfo = (el) => {
    try {
      const list = el.getAnimations ? el.getAnimations() : [];
      if (!list.length) return null;
      return list.slice(0, 4).map((an) => {
        const tm = an.effect && an.effect.getTiming ? an.effect.getTiming() : {};
        let kfE = '', props = '';
        try {
          const kf = an.effect.getKeyframes();
          kfE = (kf[0] && kf[0].easing) || '';
          props = [...new Set(kf.flatMap((k) => Object.keys(k)))].filter((k) => !['offset', 'easing', 'composite', 'computedOffset'].includes(k)).join(',');
        } catch {}
        const type = an.constructor && an.constructor.name;
        // start = the animation's start on the document timeline (ms since navigation start, the same clock as
        // performance.now()); its visible start is start + max(0, delay), independent of frame drops
        const st = typeof an.startTime === 'number' && (!an.timeline || an.timeline === document.timeline) ? Math.round(an.startTime) : null;
        return {
          type: type === 'CSSTransition' ? 'transition' : type === 'CSSAnimation' ? 'animation' : 'waapi',
          prop: an.transitionProperty || props || '', name: an.animationName || '',
          dur: typeof tm.duration === 'number' ? Math.round(tm.duration) : null, delay: Math.round(tm.delay || 0),
          easing: tm.easing && tm.easing !== 'linear' ? tm.easing : (kfE || tm.easing || 'linear'),
          iter: tm.iterations === Infinity ? 'infinite' : tm.iterations, start: st,
        };
      });
    } catch { return null; }
  };

  // Summarise a time series of motion states. pts: [[t, m], ...] (only frames where it changed).
  // Returns the main animated run: from-state, to-state, start, duration, dominant property,
  // normalised progress curve at 10%..90% and overshoot.
  // merge = true treats every point as one run (load: frame drops during page load split one
  // animation into several runs, and the from-state must be the state before the first change).
  rc.summarize = (init, pts, frameMs, merge) => {
    if (!pts.length) return null;
    const fm = frameMs || 16.7;
    const gap = merge ? Infinity : Math.max(fm * 4.5, 90);
    // split into runs separated by pauses
    const runs = [];
    let cur = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      if (pts[i][0] - pts[i - 1][0] > gap) { runs.push(cur); cur = []; }
      cur.push(pts[i]);
    }
    runs.push(cur);
    // the run with the largest span (duration), ties -> last
    let bi = 0, bspan = -1;
    runs.forEach((r, i) => { const sp = r[r.length - 1][0] - r[0][0]; if (sp >= bspan) { bspan = sp; bi = i; } });
    const run = runs[bi];
    const before = bi === 0 ? init : runs[bi - 1][runs[bi - 1].length - 1][1];
    const from = before, to = run[run.length - 1][1];
    const dims = { o: 1, ty: 40, tx: 40, s: 0.1, r: 10, c: 0.5, b: 8 };
    let dom = 'o', best = -1;
    for (const k in dims) { const v = Math.abs(to[k] - from[k]) / dims[k]; if (v > best) { best = v; dom = k; } }
    // if the net change is ~0 (it went and came back), use the range instead
    let net = true;
    if (best < 0.05) {
      net = false; best = -1;
      for (const k in dims) { let lo = from[k], hi = from[k]; for (const p of run) { lo = Math.min(lo, p[1][k]); hi = Math.max(hi, p[1][k]); } const v = (hi - lo) / dims[k]; if (v > best) { best = v; dom = k; } }
    }
    const a0 = from[dom], a1 = to[dom], span = a1 - a0;
    // load: changes made while the element is still fully transparent (a fill-backwards animation snapping
    // to its from-state during its delay) are invisible; the visible start is the first point it shows
    let vrun = run;
    if (merge && (from.o <= 0.01 || from.v === 0)) {
      const j = run.findIndex((p) => p[1].o > 0.01 && p[1].v !== 0);
      if (j > 0) vrun = run.slice(j);
    }
    const tStart = vrun[0][0] - fm;
    let tEnd = run[run.length - 1][0];
    if (net && Math.abs(span) > 1e-6) {
      for (let j = run.length - 1; j >= 0; j--) {
        if (Math.abs(run[j][1][dom] - a1) > Math.abs(span) * 0.01) { tEnd = run[Math.min(j + 1, run.length - 1)][0]; break; }
        if (j === 0) tEnd = run[0][0];
      }
    }
    const dur = Math.max(fm, tEnd - tStart);
    let pp = null, over = 0;
    if (net && Math.abs(span) > 1e-6) {
      // progress points [t since start (ms), progress 0..1] decimated to <= 40 for curve fitting
      const P = [[0, 0]].concat(vrun.map((p) => [Math.round(p[0] - tStart), r3((p[1][dom] - a0) / span)]));
      for (const p of P) over = Math.max(over, p[1] - 1);
      const stepN = Math.max(1, Math.ceil(P.length / 40));
      pp = P.filter((p, i) => i % stepN === 0 || i === P.length - 1);
    }
    const first = run[0], last = run[run.length - 1];
    const speed = last[0] > first[0] ? Math.round(Math.abs(last[1][dom] - first[1][dom]) / ((last[0] - first[0]) / 1000) * 10) / 10 : 0;
    return { from: rs(from), to: rs(to), dom, net, t0: Math.round(tStart), dur: Math.round(dur), pp, over: r3(over), runs: runs.length, n: run.length, speed };
  };

  // ---------- load sampler (started by the 1440 page's init script) ----------
  // Start state of the element's running (finite) animations/transitions: the first keyframe of each
  // (a transition's first keyframe is its start value). Parsed without touching the DOM.
  const KF_SKIP = new Set(['offset', 'computedOffset', 'easing', 'composite']);
  const pctFix = (str, el) => str.replace(/translate(X|Y|3d)?\(([^)]*)\)/g, (m, ax, args) => {
    const parts = args.split(',').map((s) => s.trim());
    const W = el.offsetWidth || 0, H = el.offsetHeight || 0;
    const conv = (s, ref) => (s.endsWith('%') ? (parseFloat(s) / 100 * ref) + 'px' : s);
    if (ax === 'X') return `translateX(${conv(parts[0], W)})`;
    if (ax === 'Y') return `translateY(${conv(parts[0], H)})`;
    return `translate${ax || ''}(${parts.map((p, i) => conv(p, i === 0 ? W : H)).join(', ')})`;
  });
  const tfOf = (str, el) => {
    if (!str || str === 'none') return { tx: 0, ty: 0, s: 1, r: 0 };
    let M = null;
    try { M = new DOMMatrixReadOnly(str); } catch { try { M = new DOMMatrixReadOnly(pctFix(str, el)); } catch { return null; } }
    const sx = Math.hypot(M.a, M.b);
    return { tx: M.e, ty: M.f, s: sx, r: Math.atan2(M.b, M.a) * 180 / Math.PI };
  };
  rc.animStart = (el) => {
    let list; try { list = el.getAnimations ? el.getAnimations() : []; } catch { return null; }
    if (!list.length) return null;
    const out = {};
    for (const an of list) {
      const tm = an.effect && an.effect.getTiming ? an.effect.getTiming() : {};
      if (tm.iterations === Infinity) continue;
      let kfs; try { kfs = an.effect.getKeyframes(); } catch { continue; }
      if (!kfs || !kfs.length) continue;
      const k0 = kfs[0];
      for (const [p, v] of Object.entries(k0)) {
        if (KF_SKIP.has(p) || v == null) continue;
        const sv = String(v);
        if (p === 'opacity') { const o = parseFloat(sv); if (!isNaN(o)) out.o = o; }
        else if (p === 'transform') { const t = tfOf(sv, el); if (t) Object.assign(out, t); }
        else if (p === 'translate') { const q = sv.split(/\s+/); const len = (s, ref) => (s && s.endsWith('%') ? parseFloat(s) / 100 * ref : parseFloat(s) || 0); out.tx = len(q[0], el.offsetWidth); out.ty = len(q[1], el.offsetHeight); }
        else if (p === 'scale') { const q = parseFloat(sv); if (!isNaN(q)) out.s = q; }
        else if (p === 'rotate') { const mm = sv.match(/(-?[\d.]+)deg/); if (mm) out.r = +mm[1]; }
        else if (p === 'filter') { const mm = sv.match(/blur\(([\d.]+)px\)/); out.b = mm ? +mm[1] : 0; }
        else if (p === 'clipPath') out.c = rc.clipFrac(sv, el);
        else if (p === 'visibility') out.v = sv === 'hidden' ? 0 : 1;
      }
    }
    return Object.keys(out).length ? out : null;
  };
  // how far a state is from the element's rest state (`rest`, its final sample: an element centred with
  // translate(-50%, -50%) rests at a large offset, which is not hidden)
  const hiddenness = (m, rest) => {
    if (!m) return 0;
    const z = rest || { tx: 0, ty: 0, s: 1 };
    return (1 - m.o) + Math.min(1, Math.abs(m.ty - z.ty) / 40) + Math.min(1, Math.abs(m.tx - z.tx) / 40) + Math.min(1, Math.abs(m.s - z.s) / 0.1) + Math.min(1, m.b / 8) + (1 - m.c) + (1 - m.v);
  };
  // What a first-screen element is, for the load sequence order.
  const loadKind = (el) => {
    const r = el.getBoundingClientRect();
    if (r.top < 220 && el.closest('header,nav,[role=banner],[role=navigation]')) return 'nav';
    const txt = (el.innerText || '').trim();
    const tag = el.tagName;
    if (/^(IMG|PICTURE|VIDEO|CANVAS|IFRAME|svg)$/i.test(tag)) return 'media';
    if (el.closest('button,[role=button]')) return 'cta';
    if (el.querySelector('h1') && txt.length > 200) return 'group';
    if (el.closest('h1,h2') || el.querySelector('h1')) return 'headline';
    if (tag === 'A' || el.closest('a')) { const bg = rc.rgba(getComputedStyle(el).backgroundColor); if (bg && bg[3] > 0.3) return 'cta'; }
    if (txt.length < 80) {
      const btnLike = (a) => { const cs = getComputedStyle(a); const bg = rc.rgba(cs.backgroundColor); return (bg && bg[3] > 0.3) || (parseFloat(cs.borderTopWidth) >= 1 && cs.borderTopStyle !== 'none'); };
      if (el.querySelector('button,[role=button]') || [...el.querySelectorAll('a')].slice(0, 6).some(btnLike)) return 'cta';
    }
    if (txt.length) { const fs = parseFloat(getComputedStyle(el).fontSize) || 16; if (fs >= 28 && txt.length < 160) return 'headline'; return txt.length > 300 ? 'group' : 'text'; }
    if (el.querySelector('img,picture,video,canvas,svg') || r.width * r.height > 40000) return 'media';
    return 'other';
  };
  rc.startLoad = () => {
    const L = rc.load = { els: [], set: new Set(), last: [], init: [], pts: [], info: [], kf: [], seen: [], rep: [], lastStall: -1, lastScan: -1e9, dcl: null, stopAt: 9000, done: false, frames: 0, ivs: [], queue: [] };
    // runs until DCL + 5 s (cap 9 s), or earlier once nothing has moved for 1.2 s after DCL + 2.5 s
    document.addEventListener('DOMContentLoaded', () => { L.dcl = performance.now(); L.stopAt = Math.min(L.dcl + 5000, 9000); }, { once: true });
    L.lastChange = 0;
    // nodes inserted between scans are tracked from the next frame (their entry animation starts at once)
    try { new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1 && L.queue.length < 4000) L.queue.push(n); }).observe(document.documentElement, { childList: true, subtree: true }); } catch {}
    const consider = (el, vh, vw) => {
      if (L.els.length >= 600 || L.set.has(el) || SKIP.has(el.tagName) || el.ownerSVGElement || !el.isConnected) return;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8 || r.top >= vh || r.bottom <= 0 || r.left >= vw || r.right <= 0) return;
      L.set.add(el); L.els.push(el); L.last.push(null); L.init.push(null); L.pts.push(null); L.info.push(null); L.kf.push(null); L.seen.push(0); L.rep.push(0);
    };
    const scan = () => {
      const b = document.body; if (!b) return;
      const vh = innerHeight, vw = innerWidth;
      const all = b.getElementsByTagName('*');
      for (let i = 0; i < all.length && L.els.length < 600; i++) consider(all[i], vh, vw);
    };
    const drain = () => {
      if (!L.queue.length) return;
      const vh = innerHeight, vw = innerWidth;
      const q = L.queue.splice(0, L.queue.length);
      for (const n of q) { consider(n, vh, vw); const d = n.getElementsByTagName ? n.getElementsByTagName('*') : []; for (let i = 0; i < d.length && i < 200; i++) consider(d[i], vh, vw); }
    };
    let prevT = null;
    const tick = () => {
      const t = performance.now();
      if (prevT !== null) L.ivs.length < 400 && L.ivs.push(t - prevT);
      // a frame gap > 150 ms is a stall (long task): a pause in an element's changes across it is not a hold
      if (prevT !== null && t - prevT > 150) L.lastStall = t;
      prevT = t;
      const scanUntil = L.dcl ? L.dcl + 2000 : 7000;
      if (t - L.lastScan > 250 && t < scanUntil) { try { scan(); } catch {} L.lastScan = t; }
      else if (t < scanUntil) { try { drain(); } catch {} }
      for (let k = 0; k < L.els.length; k++) {
        const el = L.els[k];
        if (!el.isConnected) continue;
        let m; try { m = rc.mstate(el); } catch { continue; }
        const prev = L.last[k];
        if (!prev) { L.last[k] = m; L.init[k] = m; L.kf[k] = rc.animStart(el); continue; }
        if (DIFF(m, prev)) {
          // a new burst of change after a hold of >= 450 ms with the frame loop running (no stall since): repeating
          if (L.seen[k] && t - L.seen[k] >= 450 && !(L.lastStall > L.seen[k])) L.rep[k]++;
          if (!L.pts[k]) { L.pts[k] = []; L.info[k] = rc.animInfo(el); if (!L.kf[k]) L.kf[k] = rc.animStart(el); }
          if (L.pts[k].length < 300) L.pts[k].push([t, m]);
          L.last[k] = m;
          L.lastChange = t;
          L.seen[k] = t;
        }
      }
      L.frames++;
      const quiet = L.dcl !== null && t > L.dcl + 2500 && t - L.lastChange > 1200;
      if (t < L.stopAt && !quiet) requestAnimationFrame(tick); else { L.done = true; L.endT = t; }
    };
    requestAnimationFrame(tick);
  };
  rc.loadResult = (repeat) => {
    const L = rc.load;
    if (!L) return null;
    const endT = L.done ? L.endT : performance.now();
    L.stopAt = 0;
    const fm = median(L.ivs) || 16.7;
    const vh = innerHeight, vw = innerWidth;
    const out = [];
    let snaps = 0, continuous = 0;
    // skip rules (the same as the docs): elements removed with a popup or not part of the page any more,
    // third-party chrome and removed overlays, fade-outs (ending invisible: a poster over a video), tiny
    // elements, ticker / odometer digit rolls, anything outside the first viewport, repeating changes
    const skipped = { removed: 0, thirdParty: 0, fadeOut: 0, tiny: 0, digits: 0, offscreen: 0, media: 0, repeating: 0 };
    try { rc.tpScan(); } catch {}
    // pieces of a first-screen media box (rc.heroMedia, rc.heroIn) are its media activity, never a load
    // group: a small internal piece (a CSS animation, a state fading in a mock-up, a card of a stack). The
    // box's own content as a whole is its load entrance (kind 'media'): the media element itself, a child
    // covering >= 50% of the box, or the box's only visible content (no visible sibling on the way up)
    try { if (!rc.heroEls) rc.heroMedia(); } catch {}
    const wholeOfBox = (el, hi, r) => {
      const hb = rc.heroBoxes[hi], H = rc.heroEls[hi];
      if (r.width * r.height >= 0.5 * hb[2] * hb[3]) return true;
      for (let a = el; a && a !== H && a.parentElement; a = a.parentElement) {
        for (const s of a.parentElement.children) {
          if (s === a || SKIP.has(s.tagName)) continue;
          const sr = s.getBoundingClientRect();
          if (sr.width >= 4 && sr.height >= 4 && (!s.checkVisibility || s.checkVisibility({ opacityProperty: true, visibilityProperty: true }))) return false;
        }
      }
      return true;
    };
    // repeating elements (auto-advance, word swaps) the main run saw ({desc, x, y, w, h} page px): the element
    // has about that box (overlap >= 60% of the larger) and that identity, or its parent / only child has it
    // (a word column and its list of words)
    const repList = Array.isArray(repeat) ? repeat.filter((x) => x && x.desc && x.w > 0 && x.h > 0) : [];
    const sameBox = (r, x) => { const ax = r.left + scrollX, ay = r.top + scrollY; const w = Math.min(ax + r.width, x.x + x.w) - Math.max(ax, x.x), h = Math.min(ay + r.height, x.y + x.h) - Math.max(ay, x.y); return w > 0 && h > 0 && w * h >= 0.6 * Math.max(r.width * r.height, x.w * x.h); };
    const repeatingEl = (el) => {
      if (!repList.length) return false;
      const r = el.getBoundingClientRect();
      const ids = [el, el.parentElement, el.children.length === 1 ? el.children[0] : null].filter(Boolean).map((e) => rc.desc(e));
      return repList.some((x) => ids.includes(x.desc) && sameBox(r, x));
    };
    for (let k = 0; k < L.els.length; k++) {
      if (!L.pts[k]) continue;
      const el0 = L.els[k];
      if (!el0.isConnected) { skipped.removed++; continue; }
      if (rc.isTp(el0) || el0.closest('[data-rc-overlay],[data-rc-embed]')) { skipped.thirdParty++; continue; }
      const pts = L.pts[k];
      // animation start times read at the first change can be null (animation still pending); animations
      // that are still in effect now (fill forwards/both) give them
      let live = null;
      const info = (L.info[k] || []).map((a) => {
        if (a.start != null) return a;
        if (live === null) live = rc.animInfo(el0) || [];
        const m = live.find((b) => b.type === a.type && b.name === a.name && b.prop === a.prop && b.start != null);
        return m ? Object.assign({}, a, { start: m.start }) : a;
      });
      // infinite CSS/WAAPI animations and motion still running when sampling stopped are ambient, not load
      if (info.some((a) => a.iter === 'infinite')) { continuous++; continue; }
      // (L.seen = last change time, also after the 300-point cap)
      const lastT = Math.max(L.seen[k] || 0, pts[pts.length - 1][0]);
      const span = lastT - pts[0][0];
      if ((endT - lastT < fm * 3 && span > 2000) || (pts.length >= 300 && span > 2000)) { continuous++; continue; }
      // from-state: the most hidden of the first keyframe / transition start (merged over the first
      // observed state), the first observed state and the first sample (scripts that hide an element
      // after it was first seen and then animate it in)
      const init = L.init[k];
      const kfm = L.kf[k] ? Object.assign({}, init, L.kf[k]) : null;
      const cands = [init, kfm, pts[0][1]].filter(Boolean);
      let from = init, best = -1;
      const restM = pts[pts.length - 1][1];
      for (const c of cands) { const h = hiddenness(c, restM); if (h > best + 1e-6) { best = h; from = c; } }
      const s = rc.summarize(from, pts, fm, true);
      if (!s || !significant(s)) continue;
      // an instant visibility/position snap is not an animation
      const cssDur = info.reduce((m, a) => Math.max(m, a.dur || 0), 0);
      if (s.dur <= Math.max(fm * 2.5, 40) && cssDur <= 40) { snaps++; continue; }
      const el = L.els[k];
      if (s.to.o <= 0.05 && s.from.o - s.to.o >= 0.2) { skipped.fadeOut++; continue; }
      const r = el.getBoundingClientRect();
      if (r.width < 16 || r.height < 10 || r.width * r.height < vw * vh * 0.0015) { skipped.tiny++; continue; }
      if (r.top >= vh || r.bottom <= 0 || r.left >= vw || r.right <= 0) { skipped.offscreen++; continue; }
      const hi = rc.heroIn ? rc.heroIn(el) : -1, hb = hi >= 0 && rc.heroBoxes ? rc.heroBoxes[hi] : null;
      if (hb && !wholeOfBox(el, hi, r)) { skipped.media++; continue; }
      const own = (el.textContent || '').trim();
      if (own && own.length <= 80 && /^[\d\s.,:%$€£¥+\-–—/]+$/.test(own) && (s.dom === 'ty' || s.dom === 'tx')) { skipped.digits++; continue; }
      // repeating changes (auto-advance, word swaps, cycling states) never extend the load timeline: three or
      // more bursts of change with holds >= 450 ms between them, a change again after the sampler stopped
      // (its last change >= 1 s before the end), or an element the main run saw repeating
      if (L.rep[k] >= 2 || repeatingEl(el)) { skipped.repeating++; continue; }
      if (endT - lastT >= 1000) { try { const now = rc.mstate(el), l = L.last[k]; if (l && (Math.abs(now.o - l.o) >= 0.05 || Math.abs(now.tx - l.tx) >= 3 || Math.abs(now.ty - l.ty) >= 3 || Math.abs(now.s - l.s) >= 0.02 || Math.abs(now.c - l.c) >= 0.05)) { skipped.repeating++; continue; } } catch {} }
      // box = final viewport rect, clipped to the first viewport (the load strip measures how it appears)
      const bx = Math.max(0, r.left), by = Math.max(0, r.top);
      const box = [Math.round(bx), Math.round(by), Math.round(Math.min(vw, r.right) - bx), Math.round(Math.min(vh, r.bottom) - by)];
      out.push(Object.assign(s, { desc: rc.desc(el), parent: el.parentElement ? rc.sig(el.parentElement) : '', depthKey: depthOf(el), area: Math.round(r.width * r.height), top: r2(r.top / vh), box, css: info.length ? info : L.info[k], kind: hb || (rc.heroEls || []).includes(el) ? 'media' : loadKind(el), fromKf: !!L.kf[k] || undefined, el }));
    }
    // drop changes nested inside another changed element with the same timing
    const changed = new Map(out.map((o) => [o.el, o]));
    const res = out.filter((o) => {
      let p = o.el.parentElement;
      while (p) { const q = changed.get(p); if (q && Math.abs(q.t0 - o.t0) < 40 && q.dom === o.dom) return false; p = p.parentElement; }
      return true;
    });
    res.sort((a, b) => a.t0 - b.t0 || b.area - a.area);
    rc.loadKept = new Set(res.map((o) => o.el)); // elements with a kept load animation (page-analyze: which transitions carry it)
    let fcp = null;
    try { const e = performance.getEntriesByType('paint').find((x) => x.name === 'first-contentful-paint'); if (e) fcp = Math.round(e.startTime); } catch {}
    // share of the first viewport's content that animates in: content boxes = outermost visible boxes with
    // own text, media, inputs and buttons in the first viewport (clipped to it); a box counts as animated
    // when it is (inside) one of the kept load changes. Each first-screen media box (rc.heroMedia, not a
    // text-holding background) is one content box, animated when its own entrance (the box or its content
    // as a whole) is kept, however it is built (one canvas or a stack of painted divs). textShare = the
    // same share over the content outside the media boxes.
    let areaShare = 0, contentArea = 0, textShare = 0;
    try {
      const boxes = [];
      const kept = res.map((o) => o.el);
      const clipA = (r) => Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
      (rc.heroEls || []).forEach((H, i) => {
        if (!H || !H.isConnected || (rc.heroTexty || [])[i] || boxes.some((b) => b.el.contains(H) || H.contains(b.el))) return;
        const a = clipA(H.getBoundingClientRect());
        if (a >= 16) boxes.push({ el: H, a, media: true });
      });
      const all = document.body.getElementsByTagName('*');
      for (let i = 0; i < all.length && i < 8000; i++) {
        const e = all[i];
        if (SKIP.has(e.tagName) || e.ownerSVGElement || rc.isTp(e) || e.closest('[data-rc-overlay],[data-rc-embed]')) continue;
        const media = /^(IMG|SVG|VIDEO|CANVAS|PICTURE|IFRAME|INPUT|BUTTON|TEXTAREA|SELECT)$/i.test(e.tagName);
        let text = false;
        if (!media) for (const c of e.childNodes) if (c.nodeType === 3 && c.data.trim()) { text = true; break; }
        if (!media && !text) continue;
        if (boxes.some((b) => b.el.contains(e))) continue;
        const r = e.getBoundingClientRect();
        const w = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)), h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
        if (w < 4 || h < 4) continue;
        if (e.checkVisibility && !e.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
        boxes.push({ el: e, a: w * h });
      }
      // a kept element that holds no content box but paints (a background colour or image, or a
      // ::before/::after layer with a fill, image or border: a glow, a gradient panel; itself or, for a
      // wrapper, its painted descendants) counts with its visible box, on both sides of the share
      const fill = (c) => { const v = rc.rgba(c.backgroundColor); return (v && v[3] > 0.1) || (c.backgroundImage && c.backgroundImage !== 'none'); };
      const paints = (e) => { if (/^(CANVAS|SVG|IMG|VIDEO)$/i.test(e.tagName)) return true; const cs = getComputedStyle(e); return fill(cs) || ['::before', '::after'].some((ps) => { const p = getComputedStyle(e, ps); return p.content !== 'none' && p.content !== 'normal' && (fill(p) || parseFloat(p.borderTopWidth) > 0); }); };
      for (const k of kept) {
        if (boxes.some((b) => k === b.el || k.contains(b.el) || b.el.contains(k))) continue;
        let r = paints(k) ? k.getBoundingClientRect() : null;
        if (!r) {
          // union of the painted descendants' boxes (a wrapper fading in a glow and a mark)
          let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
          const d = k.getElementsByTagName('*');
          for (let i = 0; i < d.length && i < 200; i++) { if (SKIP.has(d[i].tagName) || d[i].ownerSVGElement || !paints(d[i])) continue; const q = d[i].getBoundingClientRect(); if (q.width < 4 || q.height < 4) continue; x0 = Math.min(x0, q.left); y0 = Math.min(y0, q.top); x1 = Math.max(x1, q.right); y1 = Math.max(y1, q.bottom); }
          if (x1 > x0) r = { left: x0, top: y0, right: x1, bottom: y1 };
        }
        if (!r) continue;
        const a = clipA(r);
        if (a >= 16) boxes.push({ el: k, a });
      }
      contentArea = boxes.reduce((s, b) => s + b.a, 0);
      const keptMedia = res.filter((o) => o.kind === 'media').map((o) => o.el);
      const isAnim = (b) => kept.some((k) => k === b.el || k.contains(b.el)) || (b.media && keptMedia.some((k) => b.el.contains(k)));
      const anim = boxes.filter(isAnim).reduce((s, b) => s + b.a, 0);
      areaShare = contentArea > 0 ? anim / Math.max(contentArea, vw * vh * 0.05) : 0;
      const tb = boxes.filter((b) => !b.media), tArea = tb.reduce((s, b) => s + b.a, 0);
      textShare = tArea > 0 ? tb.filter(isAnim).reduce((s, b) => s + b.a, 0) / Math.max(tArea, vw * vh * 0.05) : 0;
    } catch {}
    return {
      dcl: L.dcl ? Math.round(L.dcl) : null, fcp, frames: L.frames, frameMs: r1(fm), tracked: L.els.length, snaps, continuous, skipped,
      areaShare: r3(Math.min(1, areaShare)), textShare: r3(Math.min(1, textShare)), contentFrac: r3(Math.min(1, contentArea / (vw * vh))),
      changes: res.slice(0, 60).map((o) => { const { el, ...rest } = o; return rest; }),
      events: rc.events.filter((e) => e[1] < (L.dcl || 0) + 4000).length,
    };
  };
  const depthOf = (el) => { let d = 0; while (el && el.parentElement) { d++; el = el.parentElement; } return d; };
  const significant = (s) => {
    const f = s.from, t = s.to;
    return Math.abs(t.o - f.o) >= 0.05 || Math.abs(t.ty - f.ty) >= 3 || Math.abs(t.tx - f.tx) >= 3 || Math.abs(t.s - f.s) >= 0.01 ||
      Math.abs(t.r - f.r) >= 1 || Math.abs(t.c - f.c) >= 0.05 || Math.abs(t.b - f.b) >= 0.5 || t.v !== f.v || !s.net;
  };
  rc.significant = significant;

  // ---------- segmentation ----------
  const kidsOf = (el, vw) => {
    const out = [];
    const push = (parent) => {
      for (const c of parent.children) {
        if (SKIP.has(c.tagName)) continue;
        const cs = getComputedStyle(c);
        if (cs.display === 'contents') { push(c); continue; }
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        if (cs.position === 'fixed' || cs.position === 'absolute') continue;
        const r = c.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        out.push({ el: c, r, cs, top: r.top + scrollY, bot: r.bottom + scrollY });
      }
    };
    push(el);
    return out;
  };
  // Group siblings into vertical bands: overlapping (side-by-side) siblings merge into one group. The group's
  // element is its largest member that holds content (an empty layer laid over the layout, such as a resize
  // or drag layer spanning several grid areas, never stands for the band).
  const toBands = (kids) => {
    const s = kids.slice().sort((a, b) => a.top - b.top || b.r.height - a.r.height);
    const out = [];
    for (const k of s) {
      const p = out[out.length - 1];
      if (p) {
        const ov = Math.min(p.bot, k.bot) - Math.max(p.top, k.top);
        if (ov > Math.min(p.bot - p.top, k.bot - k.top) * 0.5) {
          if (k.r.width * k.r.height > p.r.width * p.r.height ? (hasContent(k.el) || !hasContent(p.el)) : (!hasContent(p.el) && hasContent(k.el))) { p.el = k.el; p.r = k.r; p.cs = k.cs; }
          p.top = Math.min(p.top, k.top); p.bot = Math.max(p.bot, k.bot); p.grouped = (p.grouped || 1) + 1;
          continue;
        }
      }
      out.push(Object.assign({}, k));
    }
    return out;
  };
  const bgKey = (cs) => {
    const c = rc.rgba(cs.backgroundColor);
    if (cs.backgroundImage && cs.backgroundImage !== 'none') return 'img:' + cs.backgroundImage.slice(0, 60);
    return c && c[3] > 0.5 ? rc.hex(c) : null;
  };
  const hasContent = (el) => {
    if ((el.innerText || '').trim().length) return true;
    return !!el.querySelector('img,svg,video,canvas,picture,button,input,iframe');
  };
  // a stacked block that reads as a section of its own: >= 0.3 viewport heights tall (minH when given) and opening
  // with a heading (an h1-h3 / role=heading element, or text >= 24 px, whose top lies in the block's first 40% or
  // first half viewport, whichever is larger); b: {el, top, bot} in document px. Returns that heading's font size
  // in px (0 = none)
  const opensWithHeading = (b, minH) => {
    const vh = innerHeight, h = b.bot - b.top;
    if (h < (minH ?? vh * 0.3)) return 0;
    const lim = b.top + Math.max(h * 0.4, Math.min(h, vh * 0.5));
    let k = 0;
    for (const e of b.el.querySelectorAll('*')) {
      if (++k > 400) break;
      if (SKIP.has(e.tagName) || e.ownerSVGElement) continue;
      if (!(/^H[1-3]$/.test(e.tagName) || e.getAttribute('role') === 'heading')) {
        let own = false;
        for (const nd of e.childNodes) if (nd.nodeType === 3 && nd.data.trim()) { own = true; break; }
        if (!own || parseFloat(getComputedStyle(e).fontSize) < 24) continue;
      }
      const r = e.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      const y = r.top + scrollY;
      if (y >= b.top - 4 && y <= lim) return parseFloat(getComputedStyle(e).fontSize) || 1;
    }
    return 0;
  };
  // largest font size of visible text directly inside el's subtree (first 600 elements)
  const maxText = (el) => {
    let m = 0, k = 0;
    for (const e of el.querySelectorAll('*')) {
      if (++k > 600) break;
      if (SKIP.has(e.tagName) || e.ownerSVGElement) continue;
      let own = false;
      for (const nd of e.childNodes) if (nd.nodeType === 3 && nd.data.trim()) { own = true; break; }
      if (!own) continue;
      const r = e.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      m = Math.max(m, parseFloat(getComputedStyle(e).fontSize) || 0);
    }
    return m;
  };
  // Spacing between bands (parent padding / margins) is assigned to the band below; the space above
  // the first band and below the last one goes to those bands. bands: sorted [{top, bot}].
  rc.fillGaps = (bands, docH, vh) => {
    if (!bands.length) return;
    if (bands[0].top > 0 && bands[0].top < vh * 1.5) bands[0].top = 0;
    for (let i = 1; i < bands.length; i++) if (bands[i].top > bands[i - 1].bot) bands[i].top = bands[i - 1].bot;
    const last = bands[bands.length - 1];
    if (docH > last.bot && docH - last.bot < vh) last.bot = docH;
  };
  rc.segment = () => {
    const vw = innerWidth, vh = innerHeight, docH = rc.docH();
    let root = document.body, guard = 0;
    let kids = kidsOf(root, vw);
    while (guard++ < 40) {
      const wide = kids.filter((k) => k.r.width >= vw * 0.5);
      const rootH = root === document.body ? docH : root.getBoundingClientRect().height;
      if (wide.length === 1 && wide[0].r.height >= 0.5 * rootH) { root = wide[0].el; kids = kidsOf(root, vw); continue; }
      break;
    }
    // Side panel beside a main column (an app layout: a library/navigation panel next to the page's content):
    // when k holds a main column M (>= 50% of k's width and height) and, beside it, a narrow panel P (<= 40% of
    // k's width and <= 75% of M's, spanning >= 70% of M's height, with content) whose largest text is smaller
    // than the column's headings (< 0.9x the median), and M (through single full-height wrappers) stacks >= 3
    // blocks of >= 120 px that each open with a heading, M's blocks are the bands (a footer at the end of the
    // column stays its own band) and P is not a band, the same as when the panel and the column are the
    // segmentation root's own children. A heading column beside stacked cards (the band's one large heading
    // in the narrow column, smaller card headings) is not a side panel and stays one band. Kids of k above or
    // below the side-by-side row (a bar across the bottom) stay bands of their own. Returns bands or null.
    const sideSplit = (k, all, depth) => {
      const kW = k.r.width, kH = k.r.height;
      if (kH < vh * 0.8 || all.length < 2) return null;
      const M = all.filter((c) => c.r.width >= kW * 0.5 && c.r.height >= kH * 0.5).sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height)[0];
      if (!M) return null;
      const P = all.find((c) => c !== M && c.r.width >= 48 && c.r.width <= kW * 0.4 && c.r.width <= M.r.width * 0.75 && (c.r.right <= M.r.left + 1 || c.r.left >= M.r.right - 1) &&
        Math.min(c.bot, M.bot) - Math.max(c.top, M.top) >= M.r.height * 0.7 && hasContent(c.el));
      if (!P) return null;
      let m = M, mk = null;
      for (let g = 0; g < 8 && !mk; g++) {
        const ks = kidsOf(m.el, vw).filter((c) => c.r.width >= m.r.width * 0.6);
        if (ks.length === 1 && ks[0].r.height >= m.r.height * 0.85) m = ks[0]; else mk = ks;
      }
      if (!mk || mk.length < 3) return null;
      const st = toBands(mk);
      const hs = st.map((b) => opensWithHeading(b, 120)).filter((x) => x > 0).sort((a, b) => a - b);
      if (hs.length < 3 || maxText(P.el) >= hs[hs.length >> 1] * 0.9) return null;
      const top = Math.min(M.top, P.top), bot = Math.max(M.bot, P.bot);
      const rest = toBands(all.filter((c) => c.bot <= top + 1 || c.top >= bot - 1));
      return st.flatMap((b) => expand(b, depth + 1)).concat(rest.flatMap((b) => expand(b, depth + 1)));
    };
    const expand = (k, depth) => {
      if (depth > 8) return [k];
      const kw = Math.min(k.r.width, vw);
      const kAll = kidsOf(k.el, vw);
      const side = sideSplit(k, kAll, depth);
      if (side) return side;
      const ks = kAll.filter((c) => c.r.width >= kw * 0.6);
      if (!ks.length) return [k];
      if (ks.length === 1) {
        const c = ks[0];
        if (c.r.height >= k.r.height * 0.85) { const sub = expand(Object.assign({}, c), depth + 1); return sub.length > 1 ? sub : [k]; }
        return [k];
      }
      const st = toBands(ks);
      if (st.length === 1) {
        // siblings that overlap merge into one group (a short bar laid over the top of the content block): the
        // group's largest member is the content block, so descend into it as for a single child
        const c = st[0];
        if (c.r.height >= k.r.height * 0.85 && c.el !== k.el) { const sub = expand(Object.assign({}, c, { top: c.r.top + scrollY, bot: c.r.bottom + scrollY }), depth + 1); return sub.length > 1 ? sub : [k]; }
        return [k];
      }
      if (st.length < 2) return [k];
      const cover = st.reduce((s, b) => s + (b.bot - b.top), 0) / Math.max(1, k.r.height);
      if (cover < 0.75) return [k];
      const isMain = k.el.tagName === 'MAIN' || k.el.getAttribute('role') === 'main';
      const full = st.filter((b) => b.r.width >= vw * 0.97);
      // (section-like children as wide as the parent allows: >= 90% of it, or all but <= 48 px gutters each side,
      // which are a larger share of a narrow column)
      const sem = st.filter((b) => /^(SECTION|HEADER|FOOTER|NAV|MAIN)$/.test(b.el.tagName) && b.r.width >= Math.min(kw * 0.9, kw - 96)).length;
      // the parent's content width (its own side padding off), for the long-stack rule below: container-wide
      // children of a padded wrapper are as wide as it allows (a 24 px gutter is 12% of a 390 px viewport)
      const kcs = k.cs || getComputedStyle(k.el);
      const cw = Math.max(1, Math.min(kw, k.r.width - (parseFloat(kcs.paddingLeft) || 0) - (parseFloat(kcs.paddingRight) || 0)));
      const bgs = new Set(full.map((b) => bgKey(b.cs)).filter(Boolean));
      const tall = k.r.height > vh * 1.3;
      // a very tall block (> 2.5 viewport heights) made of container-wide stacked blocks, at least two of them
      // >= 0.6 viewport heights: each is a band (rows of a long page inside one width-constrained wrapper; a
      // card grid stacked into one tall column at a narrow width is one block, not rows)
      const rows = st.filter((b) => b.r.width >= cw * 0.9 && b.bot - b.top >= vh * 0.6);
      const longStack = k.r.height > vh * 2.5 && st.length <= 8 && rows.length >= 2 && rows.reduce((s, b) => s + (b.bot - b.top), 0) >= k.r.height * 0.6;
      // the tall-stack and long-stack rules split only on visual evidence that the stacked blocks are sections:
      // >= 2 of them open with a heading. Width alone is not evidence: at a phone width every row of one
      // section (logo row, heading, paragraph, buttons, picture) is as wide as the viewport, whatever the DOM
      const tallFull = tall && full.length >= 2 && full.length >= st.length * 0.6;
      if (isMain || sem >= 2 || bgs.size >= 2 || ((tallFull || longStack) && st.filter((b) => opensWithHeading(b)).length >= 2)) {
        return st.flatMap((b) => expand(b, depth + 1));
      }
      return [k];
    };
    let bands = toBands(kids).flatMap((k) => expand(k, 0));
    bands.sort((a, b) => a.top - b.top);
    // merge slivers / empty spacers into the previous band
    const merged = [];
    for (const b of bands) {
      const h = b.bot - b.top, p = merged[merged.length - 1];
      if (p && (h < 24 || (h < vh * 0.12 && !hasContent(b.el)))) { p.bot = Math.max(p.bot, b.bot); p.merged = (p.merged || 0) + 1; (p.extra = p.extra || []).push(b.el); continue; }
      merged.push(b);
    }
    for (const b of merged) b.els = [b.el].concat(b.extra || []);
    if (merged.length > 1 && merged[0].bot - merged[0].top < 24) { merged[1].top = merged[0].top; merged[1].els = merged[0].els.concat(merged[1].els); merged.shift(); }
    // a row of >= 3 side-by-side marks outside headings (logos drawn as images or set as short text items, the
    // same whichever way they are made; inline runs of a sentence are not marks) is content beyond a heading
    const markRow = (el) => {
      const ms = [];
      let k = 0;
      for (const e of el.querySelectorAll('*')) {
        if (++k > 400) break;
        if (e.ownerSVGElement || e.closest('h1,h2,h3,h4,h5,h6')) continue;
        if (!/^(IMG|svg|PICTURE|CANVAS|VIDEO)$/.test(e.tagName)) {
          let t = ''; for (const nd of e.childNodes) if (nd.nodeType === 3) t += nd.data;
          t = t.trim();
          if (!t || t.length > 30 || getComputedStyle(e).display === 'inline') continue;
        }
        const r = e.getBoundingClientRect();
        if (r.width >= 8 && r.height >= 12 && r.right > 0 && r.left < vw) ms.push(r);
      }
      return ms.some((m) => {
        const row = ms.filter((x) => Math.abs(x.top + x.bottom - m.top - m.bottom) / 2 <= Math.max(8, m.height / 2)).sort((a, c) => a.left - c.left);
        let n = 0, edge = -1e9;
        for (const x of row) if (x.left >= edge - 1) { n++; edge = x.right; }
        return n >= 3;
      });
    };
    // a short heading-only band on the same background belongs to the band below it (section header)
    const headerOnly = (b) => {
      if (b.bot - b.top > vh * 0.45) return false;
      const el = b.el;
      if (el.querySelector('h1') || /^(HEADER|NAV|FOOTER)$/.test(el.tagName)) return false;
      for (const m of el.querySelectorAll('img,video,canvas,iframe,picture,svg')) { const r = m.getBoundingClientRect(); if (r.width >= 48 && r.height >= 48) return false; }
      if (markRow(el)) return false;
      const txt = (el.innerText || '').trim();
      if (!txt || txt.length > 500) return false;
      if (el.querySelectorAll('a,button,input').length > 1) return false;
      return !!el.querySelector('h2,h3,h4') || [...el.querySelectorAll('*')].slice(0, 200).some((e) => parseFloat(getComputedStyle(e).fontSize) >= 28);
    };
    for (let i = merged.length - 2; i >= 0; i--) {
      const b = merged[i], n = merged[i + 1];
      // (a <footer> inside a band that is not the last one is a section's or card's footer, not the page's)
      const nFooter = n.el.tagName === 'FOOTER' || n.el.getAttribute('role') === 'contentinfo' || (i + 1 === merged.length - 1 && !!n.el.querySelector('footer,[role=contentinfo]'));
      if (!nFooter && headerOnly(b) && !headerOnly(n) && bgKey(b.cs) === bgKey(n.cs) && n.top - b.bot < vh * 0.3) {
        n.top = b.top; n.els = b.els.concat(n.els); n.header = true; merged.splice(i, 1);
      }
    }
    const rawCover = merged.reduce((s, b) => s + (b.bot - b.top), 0) / Math.max(1, docH);
    for (const b of merged) { b.ot = b.top; b.ob = b.bot; } // own boxes, before the space between bands is assigned
    rc.fillGaps(merged, docH, vh);
    let capped = false;
    while (merged.length > 30) {
      capped = true;
      let mi = 0, mh = Infinity;
      for (let i = 0; i < merged.length - 1; i++) { const h = (merged[i].bot - merged[i].top) + (merged[i + 1].bot - merged[i + 1].top); if (h < mh) { mh = h; mi = i; } }
      merged[mi].bot = merged[mi + 1].bot; merged[mi].ob = merged[mi + 1].ob; merged[mi].els = merged[mi].els.concat(merged[mi + 1].els); merged.splice(mi + 1, 1);
    }
    return { root: rc.desc(root), bands: merged, cover: r2(rawCover), capped, docH };
  };

  // ---------- app shell: inner scroller unrolled into the document ----------
  // An app-shell page keeps the document one viewport tall and scrolls its content inside an inner box (a
  // fixed-height layout whose main region has overflow-y auto/scroll), so window scrolling, full-page shots and
  // the band segmentation see one screen. When the document does not scroll (height <= 1.15 viewports) and one
  // box with overflow-y auto/scroll/overlay whose content is well taller than it (scrollHeight >= 1.5x its height
  // and >= half a viewport more) covers most of the viewport (as wide as >= 50% of it inside the layout's width,
  // which can pass the right edge on a min-width app layout, and >= 50% of its height visible; the largest such
  // area wins; <body> counts), that box is unrolled: content-visibility is forced visible (so
  // off-screen parts have their real height), and the box and every ancestor up to <html> get height auto,
  // max-height none, overflow-y visible (a hidden/auto x axis becomes clip), absolute/fixed position becomes
  // relative, a column flex item keeps its content height, a grid ancestor's row track holding the chain
  // becomes auto (its other rows keep their used size) and size containment is lifted, so the document scrolls
  // through the content naturally; a bar the shell pins below the box at the screen bottom becomes position
  // fixed there. Nothing happens on a page whose document scrolls or that has no such box; if the document
  // does not grow, the inline styles are restored.
  // Returns null (normal page) or {ok, el, clientH, scrollH, docH: [before, after], released, cv, pinned?}.
  rc.unrollScroller = () => {
    const vw = innerWidth, vh = innerHeight, de = document.documentElement;
    const docH0 = rc.docH();
    if (!document.body || docH0 > vh * 1.15) return null;
    let best = null, k = 0;
    const cands = [document.body, ...document.body.getElementsByTagName('*')];
    for (const el of cands) {
      if (++k > 40000) break;
      const ch = el.clientHeight;
      if (ch < vh * 0.4 || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') continue;
      const sh = el.scrollHeight;
      if (sh < ch * 1.5 || sh < ch + vh * 0.5) continue;
      const cs = getComputedStyle(el);
      if (!/auto|scroll|overlay/.test(cs.overflowY) || cs.display === 'none' || cs.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      // its own width counts when it starts inside the viewport: a min-width app layout at a phone width places
      // the main scroller partly past the right edge (in a page or a box that scrolls sideways)
      const w = r.right > 0 && r.left < vw ? r.width : 0, h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
      if (w < vw * 0.5 || h < vh * 0.5) continue;
      if (!best || w * h > best.a) best = { el, a: w * h, ch, sh };
    }
    if (!best) return null;
    const S = best.el;
    let cv = 0;
    if (!document.getElementById('rc-cv')) {
      let n = 0;
      for (const e of document.getElementsByTagName('*')) { if (++n > 25000) break; const c = getComputedStyle(e).contentVisibility; if (c && c !== 'visible') cv++; }
      const st = document.createElement('style'); st.id = 'rc-cv'; st.textContent = '*{content-visibility:visible!important}';
      (document.head || de).appendChild(st);
      window.__rcCvN = cv;
    }
    try { S.scrollTop = 0; } catch { /* read-only */ }
    const chain = [];
    for (let e = S; e && e.nodeType === 1; e = e.parentElement) chain.push(e);
    const saved = chain.map((e) => [e, e.getAttribute('style')]);
    const set = (e, p, v) => e.style.setProperty(p, v, 'important');
    let released = 0;
    // a grid ancestor's rows: the track(s) the chain passes through become auto, the others keep their used size
    const gridRows = (e, cs, kid) => {
      const tracks = cs.gridTemplateRows.replace(/\[[^\]]*\]/g, ' ').trim().split(/\s+/).map(parseFloat);
      if (!tracks.length || tracks.some((t) => !(t >= 0))) return null;
      const gap = parseFloat(cs.rowGap) || 0, r = e.getBoundingClientRect(), kr = kid.getBoundingClientRect();
      let y = r.top + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.paddingTop) || 0), hit = false;
      const out = tracks.map((t) => { const a = y, b = y + t; y = b + gap; const on = kr.top < b - 1 && kr.bottom > a + 1; hit = hit || on; return on ? 'auto' : `${t}px`; });
      return hit ? out.join(' ') : null;
    };
    // every value is read before any style changes (one plan per element of the chain), then applied
    const plan = chain.map((e, ci) => {
      const cs = getComputedStyle(e);
      const par = e.parentElement ? getComputedStyle(e.parentElement) : null;
      const p = [['height', 'auto'], ['max-height', 'none']];
      if (cs.overflowY !== 'visible') p.push(['overflow-y', 'visible']);
      if (cs.overflowX !== 'visible' && cs.overflowX !== 'clip') p.push(['overflow-x', 'clip']);
      if (cs.position === 'absolute' || cs.position === 'fixed') p.push(['position', 'relative'], ['inset', 'auto']);
      if (par && /flex/.test(par.display) && /column/.test(par.flexDirection)) p.push(['flex-basis', 'auto'], ['flex-shrink', '0']);
      if (ci > 0 && /grid/.test(cs.display) && cs.gridTemplateRows && cs.gridTemplateRows !== 'none') { const gr = gridRows(e, cs, chain[ci - 1]); if (gr) p.push(['grid-template-rows', gr]); p.push(['grid-auto-rows', 'auto']); }
      // size containment (contain: size/strict, container-type: size) would keep the box at its old height
      if (/size|strict/.test(cs.contain || '')) p.push(['contain', 'none']);
      if (cs.containerType === 'size') p.push(['container-type', 'inline-size']);
      return p;
    });
    // a bar the shell pins to the bottom of the screen (a sibling of the chain below the box, <= 25% of the
    // viewport tall, >= 90% of its width, ending on screen) stays pinned to the viewport bottom, as a visitor sees
    // it and as a fixed bar would be: it becomes position fixed at the same place (not a band at the page end)
    const sr = S.getBoundingClientRect(), pins = [];
    for (const e of chain.slice(1)) {
      for (const c of e.children) {
        if (chain.includes(c) || SKIP.has(c.tagName)) continue;
        const ccs = getComputedStyle(c);
        if (ccs.position === 'fixed' || ccs.display === 'none') continue;
        const r = c.getBoundingClientRect();
        if (r.height >= 8 && r.height <= vh * 0.25 && r.width >= vw * 0.9 && r.top >= sr.bottom - 1 && r.bottom <= vh + 1) pins.push([c, r]);
      }
    }
    for (const [c] of pins) saved.push([c, c.getAttribute('style')]);
    chain.forEach((e, ci) => { for (const [k, v] of plan[ci]) set(e, k, v); released++; });
    for (const [c, r] of pins) { set(c, 'position', 'fixed'); set(c, 'top', 'auto'); set(c, 'left', `${Math.round(r.left)}px`); set(c, 'bottom', `${Math.round(vh - r.bottom)}px`); set(c, 'width', `${Math.round(r.width)}px`); set(c, 'margin', '0'); }
    const docH1 = rc.docH();
    const out = { ok: docH1 > docH0 + vh * 0.5, el: rc.desc(S).slice(0, 80), clientH: Math.round(best.ch), scrollH: Math.round(best.sh), docH: [Math.round(docH0), Math.round(docH1)], released, cv, pinned: pins.length || undefined };
    if (!out.ok) for (const [e, s] of saved) { if (s === null) e.removeAttribute('style'); else e.setAttribute('style', s); }
    return out;
  };

  // ---------- nav ----------
  rc.findNav = () => {
    const vw = innerWidth, sy = scrollY;
    const all = document.body.getElementsByTagName('*');
    const hits = [];
    for (let i = 0; i < all.length && i < 20000; i++) {
      const el = all[i];
      if (SKIP.has(el.tagName) || el.ownerSVGElement || rc.isTp(el)) continue;
      const r = el.getBoundingClientRect();
      // up to 160px from the top, or further down (below ad slots / banners) for header/nav elements
      if (r.top > 420 || r.top < -2 || r.width < vw * 0.85 || r.height < 28 || r.height > 220) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const pos = cs.position;
      const isHdr = /^(HEADER|NAV)$/.test(el.tagName) || /banner|navigation/.test(el.getAttribute('role') || '');
      const hasNav = !!el.querySelector('nav,[role=navigation]') || el.tagName === 'NAV';
      if (r.top > 160 && !isHdr && !hasNav) continue;
      const links = el.querySelectorAll('a,button').length;
      if (links < 2) continue;
      hits.push({ el, pos, isHdr, r, links, hasNav });
    }
    if (!hits.length) return null;
    const pinnedPos = (p) => p === 'fixed' || p === 'sticky';
    // a fixed/sticky header inside an in-flow wrapper of the same box (the wrapper only reserves its
    // height): the pinned element is the nav, so its position (it stays at the top) is the one reported
    const outer = hits.filter((h) => !hits.some((o) => o !== h && o.el.contains(h.el) && o.r.height >= h.r.height - 2))
      .map((h) => (pinnedPos(h.pos) ? h : hits.find((o) => o !== h && h.el.contains(o.el) && pinnedPos(o.pos) && o.r.height >= h.r.height * 0.8 && o.r.width >= h.r.width * 0.9 && Math.abs(o.r.top - h.r.top) <= 4) || h));
    // header-like elements near the top: fixed/sticky, header/nav tags, a <nav> inside, many links; a thin bar
    // above the real header (announcement) scores lower.
    const score = (h) => (h.pos === 'fixed' || h.pos === 'sticky' ? 4 : 0) + (h.isHdr ? 3 : 0) + (h.hasNav ? 2 : 0) + Math.min(h.links, 12) / 4 + (h.r.top + sy < 12 ? 1 : 0) - (h.r.height < 44 && h.links < 4 ? 3 : 0);
    outer.sort((a, b) => score(b) - score(a) || a.r.top - b.r.top);
    const h = outer[0];
    // in-flow navs only count when they sit at the top of the document
    if (h.pos !== 'fixed' && h.pos !== 'sticky' && h.r.top + sy > (h.isHdr || h.hasNav ? 420 : 160)) return null;
    return { el: h.el, pos: h.pos };
  };
  // Effective visible background of an element: itself, ::before/::after, or a child covering it.
  rc.effBg = (el) => {
    const cs = getComputedStyle(el);
    const own = rc.rgba(cs.backgroundColor);
    if (own && own[3] > 0.02) return own;
    for (const ps of ['::before', '::after']) {
      const p = getComputedStyle(el, ps);
      if (p.content !== 'none' && p.content !== 'normal') { const c = rc.rgba(p.backgroundColor); if (c) return c; }
    }
    const r = el.getBoundingClientRect();
    let found = null;
    const walk = (e, d) => {
      if (found || d > 3) return;
      for (const c of e.children) {
        const cr = c.getBoundingClientRect();
        if (cr.width >= r.width * 0.9 && cr.height >= r.height * 0.8) {
          const cc = rc.rgba(getComputedStyle(c).backgroundColor);
          if (cc && cc[3] > 0.02) { found = cc; return; }
          walk(c, d + 1);
        }
      }
    };
    walk(el, 0);
    return found;
  };
  rc.navState = (el) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const t = rc.tf(cs, el);
    return {
      pos: cs.position, top: half(r.top), h: half(r.height), bg: rc.hexa(rc.effBg(el)), shadow: cs.boxShadow !== 'none',
      blur: (cs.backdropFilter && cs.backdropFilter !== 'none') ? cs.backdropFilter.slice(0, 40) : null,
      border: parseFloat(cs.borderBottomWidth) > 0 ? rc.hexa(rc.rgba(cs.borderBottomColor)) : null,
      o: r2(+cs.opacity), ty: half(t.ty), color: rc.hexa(rc.rgba(cs.color)),
    };
  };
  // Visible controls inside a header: filled button-like elements (label + fill) and the link count.
  const headerKids = (el) => {
    const btns = [];
    let links = 0;
    for (const a of el.querySelectorAll('a,button,[role=button]')) {
      const r = a.getBoundingClientRect();
      if (r.width < 8 || r.height < 8 || r.bottom <= 0 || r.top >= innerHeight) continue;
      const cs = getComputedStyle(a);
      if (cs.visibility === 'hidden' || +cs.opacity < 0.1) continue;
      links++;
      let bg = rc.rgba(cs.backgroundColor);
      if (!(bg && bg[3] > 0.5)) for (const ps of ['::before', '::after']) { const p = getComputedStyle(a, ps); if (p.content !== 'none' && p.content !== 'normal') { const c = rc.rgba(p.backgroundColor); if (c && c[3] > 0.5 && parseFloat(p.width) >= r.width * 0.8) { bg = c; break; } } }
      const bw = parseFloat(cs.borderTopWidth) || 0;
      if ((bg && bg[3] > 0.5) || (bw >= 1 && cs.borderTopStyle !== 'none')) {
        const label = (a.innerText || a.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 24);
        if (label && btns.length < 4) btns.push({ desc: rc.desc(a), bg: bg && bg[3] > 0.5 ? rc.hex(bg) : null, outline: !(bg && bg[3] > 0.5) || undefined, h: Math.round(r.height), x: Math.round(r.left) });
      }
    }
    return { btns, links };
  };
  // The header pinned at the top of the viewport right now (fixed/sticky, wide, at the top), or null.
  const hdrState = (e) => {
    const st = rc.navState(e);
    const eff = rc.effBg(e);
    const k = headerKids(e);
    return Object.assign(st, { el: rc.desc(e), id: rc.idOf(e), transparent: !eff || eff[3] < 0.1, btns: k.btns, links: k.links });
  };
  rc.pinnedHeader = () => {
    const vw = innerWidth, seen = new Set();
    // the nav found at the top, when it is fixed/sticky and in view (content may overlap it at a point)
    const nv = rc.snap && rc.snap.nav;
    if (nv && nv.isConnected) {
      const cs = getComputedStyle(nv);
      const r = nv.getBoundingClientRect();
      if ((cs.position === 'fixed' || cs.position === 'sticky') && r.top <= 4 && r.bottom > 20 && +cs.opacity > 0.1 && cs.visibility !== 'hidden' && rc.tf(cs, nv).ty > -r.height * 0.6) return hdrState(nv);
    }
    for (const y of [6, 22, 40]) for (const x of [vw * 0.5, vw * 0.15, vw * 0.85]) {
      let e = document.elementFromPoint(x, y);
      while (e && e !== document.body && e !== document.documentElement) {
        if (seen.has(e)) break;
        seen.add(e);
        if (!rc.isTp(e)) {
          const cs = getComputedStyle(e);
          if (cs.position === 'fixed' || cs.position === 'sticky') {
            const r = e.getBoundingClientRect();
            if (r.width >= vw * 0.85 && r.height >= 28 && r.height <= 260 && r.top <= 4 && r.bottom > 20) return hdrState(e);
          }
        }
        e = e.parentElement;
      }
    }
    return null;
  };
  rc.headerKids = headerKids;
  // Scroll-driven animations (scroll / view timelines) on the nav found at the top, inside it, or on a
  // wrapper of the same box: the header's scrolled state (a shadow or hairline growing with scroll), never
  // a scroll-scrubbed content animation. [{name, props[], on}] or null without a nav.
  rc.navScrollAnims = () => {
    const n = rc.findNav();
    if (!n) return null;
    const nav = n.el, nr = nav.getBoundingClientRect();
    let list = [];
    try { list = document.getAnimations(); } catch { return null; }
    const out = [];
    for (const a of list) {
      const tl = a.timeline;
      const scrollTl = !!tl && tl !== document.timeline && ((typeof ScrollTimeline !== 'undefined' && tl instanceof ScrollTimeline) || (typeof ViewTimeline !== 'undefined' && tl instanceof ViewTimeline));
      if (!scrollTl) continue;
      const t = a.effect && a.effect.target;
      if (!t || !t.getBoundingClientRect) continue;
      const tr = t.getBoundingClientRect();
      if (!(t === nav || nav.contains(t) || (t.contains(nav) && Math.abs(tr.height - nr.height) < 4))) continue;
      let props = [];
      try { props = [...new Set(a.effect.getKeyframes().flatMap((k) => Object.keys(k).filter((p) => !KF_SKIP.has(p))))]; } catch { /* none */ }
      if (out.length < 8) out.push({ name: String(a.animationName || a.id || '').slice(0, 40), props: props.slice(0, 6), on: rc.desc(t) });
    }
    return out;
  };

  // ---------- visual scroll position ----------
  rc.vscroll = () => {
    const sy = (document.scrollingElement || document.documentElement).scrollTop;
    const S = rc.snap;
    if (!S || !S.anchors.length) return [Math.round(sy), Math.round(sy)];
    const d = S.anchors.filter((a) => a.el.isConnected).map((a) => a.top0 - a.el.getBoundingClientRect().top);
    return [Math.round(sy), Math.round(d.length ? median(d) : sy)];
  };
  rc.scrollInfo = () => { const [sy, vs] = rc.vscroll(); return { sy, vs, docH: rc.docH(), vh: innerHeight, vw: innerWidth, x: Math.round(scrollX) }; };

  // ---------- pre-scroll snapshot ----------
  rc.snapshot = () => {
    const vh = innerHeight, vw = innerWidth, sy = scrollY;
    const S = rc.snap = { sy0: sy, vh, vw, els: [], idx: new Map(), layout: [], anchors: [], nav: null };
    rc.tpScan();
    const all = document.body.getElementsByTagName('*');
    const n = Math.min(all.length, 80000);
    const hid = [], lay = [];
    for (let i = 0; i < n; i++) {
      const el = all[i];
      if (SKIP.has(el.tagName) || el.ownerSVGElement) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none') continue;
      const m = rc.mstate(el, cs);
      if (hiddenish(m)) hid.push({ el, m, top: r.top + sy, area: r.width * r.height, i });
      let score = 0, ev = '';
      const pos = cs.position;
      if (rc.isTp(el)) continue; // third-party chrome (captcha badges, chat launchers, consent bars) is never sticky design
      if (pos === 'fixed' || pos === 'sticky') score = 5;
      if (el.hasAttribute('data-speed') || el.hasAttribute('data-scroll-speed') || el.hasAttribute('data-parallax') ||
        el.hasAttribute('data-rellax-speed') || el.hasAttribute('data-lag') || el.hasAttribute('data-swiper-parallax')) { score = 10; ev = 'attr'; }
      if (cs.backgroundAttachment === 'fixed' && cs.backgroundImage !== 'none') { score = Math.max(score, 8); ev = ev || 'bg-fixed'; }
      if (r.width >= 60 && r.height >= 40) {
        if (/^(IMG|PICTURE|VIDEO|CANVAS|svg|H1|H2|H3)$/.test(el.tagName)) score = Math.max(score, 3);
        else if (Math.abs(m.tx) > 0.5 || Math.abs(m.ty) > 0.5 || Math.abs(m.s - 1) > 0.005) score = Math.max(score, 3);
        else if (pos === 'absolute' && r.width * r.height > 6000) score = Math.max(score, 2);
      }
      if (score) lay.push({ el, score, i, pos, ev });
    }
    let capped = false;
    let H = hid;
    if (H.length > 2000) { capped = true; H = H.slice().sort((a, b) => b.area - a.area).slice(0, 2000).sort((a, b) => a.i - b.i); }
    S.els = H.map((h) => ({ el: h.el, m: h.m, cur: h.m, top0: h.top, steps: [], cont: false }));
    S.els.forEach((e, k) => S.idx.set(e.el, k));
    let L = lay;
    if (L.length > 600) L = L.slice().sort((a, b) => b.score - a.score || a.i - b.i).slice(0, 600).sort((a, b) => a.i - b.i);
    S.layout = L.map((l) => ({ el: l.el, pos: l.pos, ev: l.ev }));
    const lidx = new Map(S.layout.map((l, j) => [l.el, j]));
    for (const l of S.layout) {
      l.anc = []; l.pIdx = -1;
      let e = l.el;
      while (e && e !== document.body) {
        if (S.idx.has(e)) l.anc.push(S.idx.get(e));
        if (e !== l.el && l.pIdx < 0 && lidx.has(e)) l.pIdx = lidx.get(e);
        e = e.parentElement;
      }
    }
    const seg = rc.segment();
    S.anchors = seg.bands.filter((b) => b.cs.position !== 'sticky').map((b) => ({ el: b.el, top0: b.el.getBoundingClientRect().top + sy })).slice(0, 16);
    const nav = rc.findNav();
    S.nav = nav ? nav.el : null;
    return {
      hidden: S.els.length, hiddenTotal: hid.length, capped, layout: S.layout.length, anchors: S.anchors.length,
      nav: nav ? { desc: rc.desc(nav.el), pos: nav.pos } : null,
      layoutInfo: S.layout.map((l) => [rc.desc(l.el), l.pos, l.ev, rc.idOf(l.el), l.pIdx]),
    };
  };

  // ---------- motion classification helpers ----------
  rc.hasText = (el) => ((el.textContent || '').replace(/\s+/g, '').length >= 2);
  rc.hasMedia = (el) => {
    if (/^(IMG|SVG|VIDEO|CANVAS|PICTURE|IFRAME)$/i.test(el.tagName)) return true;
    try { if (el.querySelector('img,svg,video,canvas,picture,iframe')) return true; } catch {}
    const bi = getComputedStyle(el).backgroundImage;
    return !!(bi && bi.includes('url('));
  };
  // visible window of an element along an axis: its nearest ancestor that clips along that axis (overflow not
  // visible and content overflowing it: a page wrapper with overflow-x hidden computes overflow-y auto but
  // clips nothing vertically), at most the viewport
  rc.clipExtent = (el, ax) => {
    const vp = ax === 'x' ? innerWidth : innerHeight;
    for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
      const cs = getComputedStyle(p);
      const ov = ax === 'x' ? cs.overflowX : cs.overflowY;
      const ce = ax === 'x' ? p.clientWidth : p.clientHeight;
      // a clip-path / paint-contained / masked box clips whatever its content does
      if ((cs.clipPath && cs.clipPath !== 'none') || /paint|strict|content/.test(cs.contain || '') || (cs.maskImage && cs.maskImage !== 'none') || (cs.webkitMaskImage && cs.webkitMaskImage !== 'none')) return Math.max(1, Math.min(ce || vp, vp));
      if (!ov || ov === 'visible') continue;
      const se = ax === 'x' ? p.scrollWidth : p.scrollHeight;
      if (se > ce + 1) return Math.max(1, Math.min(ce, vp));
    }
    return vp;
  };
  // A strip that scrolls past its window (marquee track): 'long' = longer than its clip along the axis by
  // >= 15%; 'keyframes' = at least half as long as its window and moved by its keyframes over >= 40% of its
  // own length (a marquee only with content: an empty element sweeping across is a gleam loop); a small
  // element drifting, bobbing or hopping by a fraction of the window is not a strip (false)
  rc.isStrip = (el, ax) => {
    const own = ax === 'x' ? Math.max(el.scrollWidth || 0, el.offsetWidth || 0) : Math.max(el.scrollHeight || 0, el.offsetHeight || 0);
    const win = rc.clipExtent(el, ax);
    if (own >= 1.15 * win) return 'long';
    const len = ax === 'x' ? (el.offsetWidth || el.getBoundingClientRect().width) : (el.offsetHeight || el.getBoundingClientRect().height);
    if (len < 0.5 * win) return false;
    let lo = Infinity, hi = -Infinity;
    try {
      for (const an of el.getAnimations()) {
        let kfs; try { kfs = an.effect.getKeyframes(); } catch { continue; }
        for (const k of kfs || []) {
          let v = null;
          if (k.transform && k.transform !== 'none') { const t = tfOf(String(k.transform), el); if (t) v = ax === 'x' ? t.tx : t.ty; }
          else if (k.translate && k.translate !== 'none') { const q = String(k.translate).split(/\s+/); const s = ax === 'x' ? q[0] : q[1]; if (s) v = s.endsWith('%') ? parseFloat(s) / 100 * len : parseFloat(s) || 0; }
          else if (k.transform === 'none') v = 0;
          if (v !== null && isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
        }
      }
    } catch {}
    return hi > lo && hi - lo >= 0.4 * len ? 'keyframes' : false;
  };

  // ---------- idle sampler: continuous motion with no input (marquees, loops, carousels) ----------
  rc.idleSample = (ms) => new Promise((resolve) => {
    const S = rc.snap;
    const cands = new Set();
    try {
      for (const a of document.getAnimations()) {
        const t = a.effect && a.effect.target;
        if (t && t.nodeType === 1 && t.isConnected) cands.add(t);
      }
    } catch {}
    if (S) for (const e of S.els) if (Math.abs(e.m.tx) > 1 || Math.abs(e.m.ty) > 1 || Math.abs(e.m.r) > 0.5) cands.add(e.el);
    // >= 4x4 px, or a hairline >= 1 px thick and >= 8 px long (a 1 px text caret)
    const list = [...cands].filter((el) => { const r = el.getBoundingClientRect(); return (r.width >= 4 && r.height >= 4) || (Math.min(r.width, r.height) >= 1 && Math.max(r.width, r.height) >= 8); }).slice(0, 600);
    const first = list.map((el) => rc.mstate(el));
    const last = first.slice();       // state at the start of the current 100 ms bucket
    const cnt = list.map(() => 0), pos = list.map(() => [0, 0, 0, 0]), bd = list.map(() => []), trav = list.map(() => 0), orng = first.map((m) => [m.o, m.o]);
    let frames = 0, buckets = 0, bucketT = performance.now();
    const t0 = performance.now();
    const tick = () => {
      frames++;
      const now = performance.now();
      if (now - bucketT >= 100) {
        const bt0 = bucketT;
        buckets++; bucketT = now;
        for (let k = 0; k < list.length; k++) {
          const m = rc.mstate(list[k]);
          const dx = m.tx - last[k].tx, dy = m.ty - last[k].ty;
          if (Math.abs(dx) > 0.3 || Math.abs(dy) > 0.3 || Math.abs(m.o - last[k].o) > 0.01 || Math.abs(m.s - last[k].s) > 0.002 || Math.abs(m.r - last[k].r) > 0.3 || Math.abs(m.c - last[k].c) > 0.005) {
            cnt[k]++;
            trav[k] += Math.max(Math.abs(dx), Math.abs(dy));
            orng[k][0] = Math.min(orng[k][0], m.o); orng[k][1] = Math.max(orng[k][1], m.o);
            bd[k].push([Math.abs(dx) / ((now - bt0) / 1000), Math.abs(dy) / ((now - bt0) / 1000)]);
            if (dx > 0.3) pos[k][0]++; else if (dx < -0.3) pos[k][1]++;
            if (dy > 0.3) pos[k][2]++; else if (dy < -0.3) pos[k][3]++;
          }
          last[k] = m;
        }
      }
      if (now - t0 < ms) requestAnimationFrame(tick); else finish();
    };
    const finish = () => {
      const dt = (performance.now() - t0) / 1000;
      const cont = [], burst = [], minor = [];
      for (let k = 0; k < list.length; k++) {
        if (cnt[k] < 2) continue;
        const el = list[k], f = first[k];
        const l = rc.mstate(el);
        const r = el.getBoundingClientRect();
        const css = rc.animInfo(el);
        const item = { desc: rc.desc(el), id: rc.idOf(el), x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height), frac: r2(cnt[k] / Math.max(1, buckets)),
          text: rc.hasText(el) || undefined, infinite: !!(css && css.some((a) => a.iter === 'infinite')) || undefined };
        const hi = rc.heroIdx ? rc.heroIdx(el) : -1;
        if (hi >= 0) item.hero = hi;
        if (rc.heroIn && rc.heroIn(el) >= 0) item.heroIn = true;
        const [xp, xn, yp, yn] = pos[k];
        if (cnt[k] >= buckets * 0.8) {
          const ax = Math.abs(l.tx - f.tx) >= Math.abs(l.ty - f.ty) ? 'x' : 'y';
          const mono = ax === 'x' ? Math.max(xp, xn) / Math.max(1, xp + xn) : Math.max(yp, yn) / Math.max(1, yp + yn);
          item.axis = ax;
          item.pxPerSec = Math.round(median(bd[k].map((v) => (ax === 'x' ? v[0] : v[1]))));
          item.dir = ax === 'x' ? (xp > xn ? 'right' : 'left') : (yp > yn ? 'down' : 'up');
          item.monotonic = mono >= 0.9;
          // a marquee is a strip that scrolls past its window: longer than its clip along the axis, or
          // translated by >= 25% of its own length per loop (CSS marquees move -50% / -100%). A slow drift,
          // bob or push-in of an ordinary element moves monotonically over a short sample too: 'drift'
          item.strip = rc.isStrip(el, ax) || undefined;
          if (Math.abs(l.r - f.r) > 2 && item.pxPerSec < 5) { item.kind = 'rotate-loop'; }
          else if (item.pxPerSec < 5) { item.kind = (Math.abs(l.s - f.s) > 0.005 || Math.abs(l.o - f.o) > 0.02) ? 'pulse-loop' : 'loop'; }
          // a strip longer than its window is a marquee whatever it shows (a scrolling pattern counts); one
          // only moved across its window by its keyframes needs content (an empty gleam sweeping across is a loop)
          else item.kind = item.monotonic ? (item.strip === 'long' || (item.strip && (item.text || rc.hasMedia(el))) ? 'marquee' : 'drift') : 'oscillate';
          item.css = css;
          cont.push({ el, item });
          if (S && S.idx.has(el)) S.els[S.idx.get(el)].cont = true;
        } else {
          // moved in a burst. An auto-advance moves content (text or media) by a visible step: >= 25% of its
          // window along the axis or an opacity swap; a burst of an empty decorative element (a sweep, a gleam
          // in a keyframe loop with holds) or a nudge of a few px is a loop, not a carousel
          const dx = Math.abs(l.tx - f.tx), dy = Math.abs(l.ty - f.ty), dmax = Math.max(dx, dy, trav[k] * 0.5);
          const ax = bd[k].reduce((s, v) => s + v[0], 0) >= bd[k].reduce((s, v) => s + v[1], 0) ? 'x' : 'y';
          const win = rc.clipExtent(el, ax);
          const step = dmax >= Math.max(12, 0.25 * Math.min(win, ax === 'x' ? (el.offsetWidth || r.width) : (el.offsetHeight || r.height))) || orng[k][1] - orng[k][0] >= 0.5;
          const content = item.text || rc.hasMedia(el);
          item.step = step || undefined;
          if (content && step) burst.push({ el, item });
          else {
            item.kind = dmax >= 2 ? 'drift' : Math.abs(l.r - f.r) > 2 ? 'rotate-loop' : (Math.abs(l.s - f.s) > 0.005 || orng[k][1] - orng[k][0] > 0.02) ? 'pulse-loop' : 'loop';
            item.paused = true; item.css = css;
            if (item.infinite) { cont.push({ el, item }); if (S && S.idx.has(el)) S.els[S.idx.get(el)].cont = true; } else minor.push({ el, item });
          }
        }
      }
      const top = (arr) => arr.filter((a) => !arr.some((b) => b !== a && b.el.contains(a.el))).map((a) => a.item);
      resolve({ frames, buckets, ms: Math.round(dt * 1000), sampled: list.length, continuous: top(cont).slice(0, 20), bursts: top(burst).slice(0, 10), minorBursts: minor.length });
    };
    requestAnimationFrame(tick);
  });

  // ---------- slow watch: auto-advance with long periods (no input, page at rest) ----------
  // A carousel that advances every few seconds is rarely caught by a 1.5 s sample. For several seconds the
  // page is left alone while every element that starts a CSS transition/animation or gets a style/class
  // change (and every horizontal scroller) is sampled every 150 ms; elements that then move by a visible
  // step (or swap opacity) in separate bursts are auto-advancing, the period is the median interval
  // between burst starts. Started before the hero-media sample, read after the idle sample.
  // text signature (a word swapping in a headline, a ticking data row) and fill / text colour (a step chip or
  // tab lighting up in turn): state changes that move nothing
  const tsig = (el) => { const t = el.textContent || ''; if (t.length > 4000) return null; let h = 0; for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0; return t.length + ':' + h; };
  const wsnap = (el) => { const cs = getComputedStyle(el); const m = rc.mstate(el, cs); const b = el.getBoundingClientRect(); return { o: m.o, tx: m.tx, ty: m.ty, s: m.s, c: m.c, v: m.v, x: b.left, sl: el.scrollLeft || 0, st: el.scrollTop || 0, t: tsig(el), bg: cs.backgroundColor, fg: cs.color }; };
  rc.watchStart = () => {
    if (rc.watch && !rc.watch.done) return true;
    const W = rc.watch = { t0: performance.now(), recs: new Map(), done: false };
    const add = (el, t, why) => {
      if (!el || el.nodeType !== 1 || el === document.documentElement || el === document.body || SKIP.has(el.tagName) || el.ownerSVGElement) return;
      let r = W.recs.get(el);
      if (!r) {
        if (W.recs.size >= 600) return;
        const b = el.getBoundingClientRect();
        if (b.width < 8 || b.height < 8) return;
        r = { el, ev: [], pts: [[t, wsnap(el)]] }; W.recs.set(el, r);
      }
      if (r.ev.length < 80) r.ev.push(Math.round(t));
    };
    W.onEv = (e) => { try { add(e.target, performance.now(), e.type); } catch {} };
    try { addEventListener('transitionstart', W.onEv, true); addEventListener('animationstart', W.onEv, true); } catch {}
    // attribute changes, and text / child changes (a swapped word, a row added to a feed: the element whose
    // text changed is watched)
    try { W.mo = new MutationObserver((ms) => { const t = performance.now(); for (const m of ms) try { add(m.type === 'attributes' ? m.target : m.target.nodeType === 1 ? m.target : m.target.parentElement, t, m.type); } catch {} }); W.mo.observe(document.body, { attributes: true, attributeFilter: ['style', 'class'], childList: true, characterData: true, subtree: true }); } catch {}
    // horizontal scrollers (auto-advancing scroll-snap carousels move by scrollLeft, with no event)
    try {
      for (const e of document.body.getElementsByTagName('*')) {
        if (W.recs.size >= 30) break;
        if (SKIP.has(e.tagName) || e.ownerSVGElement) continue;
        if (e.scrollWidth > e.clientWidth + 20 && e.clientWidth >= 200 && /(auto|scroll|hidden)/.test(getComputedStyle(e).overflowX)) add(e, performance.now(), 'scroller');
      }
    } catch {}
    W.timer = setInterval(() => { const t = performance.now(); for (const r of W.recs.values()) if (r.pts.length < 120 && r.el.isConnected) { try { r.pts.push([t, wsnap(r.el)]); } catch {} } }, 150);
    return true;
  };
  rc.watchElapsed = () => (rc.watch ? Math.round(performance.now() - rc.watch.t0) : 0);
  rc.watchResult = () => {
    const W = rc.watch;
    if (!W) return null;
    W.done = true;
    clearInterval(W.timer);
    try { W.mo && W.mo.disconnect(); removeEventListener('transitionstart', W.onEv, true); removeEventListener('animationstart', W.onEv, true); } catch {}
    const now = performance.now(), span = now - W.t0;
    try { rc.tpScan(); } catch {}
    const found = [];
    for (const r of W.recs.values()) {
      const el = r.el;
      if (!el.isConnected || rc.isTp(el) || el.closest('[data-rc-overlay],[data-rc-embed]')) continue;
      try { r.pts.push([now, wsnap(el)]); } catch { continue; }
      const P = r.pts;
      const mv = [];
      for (let i = 1; i < P.length; i++) {
        const a = P[i - 1][1], b = P[i][1];
        const d = Math.max(Math.abs(b.tx - a.tx), Math.abs(b.ty - a.ty), Math.abs(b.x - a.x), Math.abs(b.sl - a.sl), Math.abs(b.st - a.st));
        if (d >= 2 || Math.abs(b.o - a.o) >= 0.05 || Math.abs(b.s - a.s) >= 0.01 || Math.abs(b.c - a.c) >= 0.05 || a.v !== b.v || a.t !== b.t || a.bg !== b.bg || a.fg !== b.fg) mv.push(i);
      }
      if (!mv.length) continue;
      // continuous movers (marquees, loops) are the idle sampler's; here only motion with rests in between
      if (mv.length >= (P.length - 1) * 0.7) continue;
      // bursts = runs of moving samples separated by >= 450 ms of rest
      const bursts = [];
      for (const i of mv) {
        const last = bursts[bursts.length - 1];
        if (last && P[i - 1][0] - P[last.j][0] <= 450) { last.j = i; continue; }
        bursts.push({ i, j: i });
      }
      // a visible step: the largest displacement / opacity range inside a burst vs its window; a state step:
      // its text (a word swap, a new feed row) or its fill / text colour (a step chip lighting up) changed
      let dmax = 0, orange = 0, ax = 'x', stateN = 0;
      for (const bu of bursts) {
        const s0 = P[bu.i - 1][1];
        let st = false;
        for (let i = bu.i; i <= bu.j; i++) {
          const b = P[i][1];
          const dX = Math.max(Math.abs(b.tx - s0.tx), Math.abs(b.x - s0.x), Math.abs(b.sl - s0.sl)), dY = Math.max(Math.abs(b.ty - s0.ty), Math.abs(b.st - s0.st));
          if (Math.max(dX, dY) > dmax) { dmax = Math.max(dX, dY); ax = dX >= dY ? 'x' : 'y'; }
          orange = Math.max(orange, Math.abs(b.o - s0.o), b.v !== s0.v ? 1 : 0);
          if (b.t !== s0.t || b.bg !== s0.bg || b.fg !== s0.fg) st = true;
        }
        if (st) stateN++;
      }
      const rect = el.getBoundingClientRect();
      const len = ax === 'x' ? Math.min(el.clientWidth || rect.width, rc.clipExtent(el, 'x')) : Math.min(el.clientHeight || rect.height, rc.clipExtent(el, 'y'));
      const moved = dmax >= Math.max(12, 0.25 * len) || orange >= 0.5;
      // state-only changes count when they repeat (>= 2 bursts, over the element or its siblings changing in
      // turn): a one-off text or colour update is not a cycle (checked per item below)
      const state = !moved && stateN >= 1;
      if (!moved && !state) continue;
      // burst start = the event (transition start / style change) that opened it, else its first sample
      const starts = bursts.map((bu) => { const t1 = P[bu.i][0], t0 = P[bu.i - 1][0]; const e = r.ev.filter((t) => t >= t0 - 160 && t <= t1).pop(); return e !== undefined ? e : Math.round((t0 + t1) / 2); });
      found.push({ el, starts, dmax, orange, ax, fade: orange >= 0.5 && dmax < 12, state });
    }
    // one item per carousel: the outermost moving element; slides swapping opacity (or chips / tabs changing
    // state in turn) under one parent merge into it
    const outer = found.filter((f) => !found.some((g) => g !== f && g.el.contains(f.el)));
    const sib = new Map();
    for (const f of outer) if (f.state && f.el.parentElement) sib.set(f.el.parentElement, (sib.get(f.el.parentElement) || 0) + 1);
    const byParent = new Map();
    for (const f of outer) {
      const key = (f.fade || (f.state && sib.get(f.el.parentElement) >= 2)) && f.el.parentElement ? f.el.parentElement : f.el;
      const e = byParent.get(key) || { el: key, starts: [], dmax: 0, orange: 0, ax: f.ax, members: 0, state: true };
      e.starts.push(...f.starts); e.dmax = Math.max(e.dmax, f.dmax); e.orange = Math.max(e.orange, f.orange); e.members++; e.state = e.state && !!f.state;
      byParent.set(key, e);
    }
    const items = [];
    for (const e of byParent.values()) {
      if (!(rc.hasText(e.el) || rc.hasMedia(e.el))) continue;
      const st = [...new Set(e.starts)].sort((a, b) => a - b);
      const merged = [];
      for (const t of st) if (!merged.length || t - merged[merged.length - 1] > 300) merged.push(t);
      if (e.state && merged.length < 2) continue;
      const diffs = []; for (let i = 1; i < merged.length; i++) if (merged[i] - merged[i - 1] >= 800) diffs.push(merged[i] - merged[i - 1]);
      const b = e.el.getBoundingClientRect();
      items.push({ desc: rc.desc(e.el), id: rc.idOf(e.el), x: Math.round(b.left + scrollX), y: Math.round(b.top + scrollY), w: Math.round(b.width), h: Math.round(b.height),
        steps: merged.length, periodMs: diffs.length ? Math.round(median(diffs)) : null, how: e.state ? 'swap' : e.orange >= 0.5 && e.dmax < 12 ? 'fade' : 'slide', axis: e.ax, stepPx: Math.round(e.dmax), text: rc.hasText(e.el) || undefined,
        hero: rc.heroIdx && rc.heroIdx(e.el) >= 0 ? rc.heroIdx(e.el) : undefined, heroIn: (rc.heroIn && rc.heroIn(e.el) >= 0) || undefined });
      // the carousel's slides are not scroll reveals
      const S = rc.snap;
      if (S) for (const x of S.els) if (e.el === x.el || e.el.contains(x.el)) x.cont = true;
    }
    return { ms: Math.round(span), watched: W.recs.size, items: items.slice(0, 8) };
  };
  // Resolve when no finite CSS/WAAPI animation is running (or after maxMs).
  rc.waitAnimsIdle = (maxMs) => new Promise((resolve) => {
    const t0 = performance.now();
    const check = () => {
      let busy = 0;
      try { for (const a of document.getAnimations()) { if (a.playState !== 'running') continue; const tm = a.effect && a.effect.getTiming ? a.effect.getTiming() : {}; if (tm.iterations !== Infinity && !(a.timeline && a.timeline.constructor && /Scroll|View/.test(a.timeline.constructor.name))) busy++; } } catch {}
      if (!busy || performance.now() - t0 > maxMs) resolve({ busy, ms: Math.round(performance.now() - t0) }); else setTimeout(check, 50);
    };
    check();
  });

  // ---------- per-step sampler ----------
  rc.startSampler = (o) => {
    const S = rc.snap;
    const vh = innerHeight;
    const lo = -0.3 * vh, hi = 1.3 * vh + (o.aheadPx || 0);
    const near = [];
    for (let i = 0; i < S.els.length; i++) {
      const e = S.els[i];
      if (e.cont || !e.el.isConnected) continue;
      const r = e.el.getBoundingClientRect();
      if (r.bottom >= lo && r.top <= hi) near.push([i, Math.abs(r.top - vh * 0.5), r2(r.top / vh)]);
    }
    near.sort((a, b) => a[1] - b[1]);
    const kept = near.slice(0, o.cap || 400), ids = kept.map((x) => x[0]);
    const smp = rc.smp = { t0: performance.now(), ids, last: ids.map((i) => S.els[i].cur), pts: ids.map(() => null), info: ids.map(() => null), tops: ids.map(() => null),
      top0: kept.map((x) => x[2]), scrollEndT: null, tp: ids.map(() => null), scroll: [], done: false, ivs: [], frames: 0 };
    let lastChange = smp.t0, prevT = null, lastVs = null;
    const tick = () => {
      const now = performance.now();
      const t = now - smp.t0;
      if (prevT !== null && smp.ivs.length < 300) smp.ivs.push(now - prevT);
      prevT = now;
      smp.frames++;
      const [sy, vs] = rc.vscroll();
      if (o.recordScroll && smp.scroll.length < 400) smp.scroll.push([Math.round(t), sy, vs]);
      // scrollEndT: the last frame at which the scroll position moved (the step's scroll has stopped after it)
      if (lastVs === null || Math.abs(vs - lastVs) > 0.5 || Math.abs(sy - (smp.lastSy ?? sy)) > 0.5) { lastChange = now; if (lastVs !== null) smp.scrollEndT = t; }
      lastVs = vs; smp.lastSy = sy;
      for (let k = 0; k < ids.length; k++) {
        const e = S.els[ids[k]];
        let m; try { m = rc.mstate(e.el); } catch { continue; }
        if (DIFF(m, smp.last[k])) {
          if (!smp.pts[k]) {
            smp.pts[k] = []; smp.info[k] = rc.animInfo(e.el);
            smp.tops[k] = r2(e.el.getBoundingClientRect().top / vh);
            const cs = getComputedStyle(e.el);
            smp.tp[k] = [cs.transitionProperty, cs.transitionDuration, cs.transitionTimingFunction, cs.transitionDelay].map((s) => s.slice(0, 160));
          }
          if (smp.pts[k].length < 300) smp.pts[k].push([t, m]);
          smp.last[k] = m;
          lastChange = now;
        }
      }
      if ((t > o.minMs && now - lastChange > o.quietMs) || t > o.maxMs) { smp.done = true; smp.endT = t; return; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return ids.length;
  };
  rc.collectSampler = (stepIdx) => {
    const S = rc.snap, smp = rc.smp;
    const fm = median(smp.ivs) || 16.7;
    const changes = [];
    for (let k = 0; k < smp.ids.length; k++) {
      if (!smp.pts[k]) continue;
      const i = smp.ids[k], e = S.els[i];
      const prev = e.cur;
      const s = rc.summarize(prev, smp.pts[k], fm);
      e.cur = smp.last[k];
      if (!s) continue;
      const endGap = smp.endT - smp.pts[k][smp.pts[k].length - 1][0];
      s.live = endGap < fm * 3 && smp.endT >= 0; // still changing when sampling stopped
      if (!significant(s)) continue;
      e.steps.push(stepIdx);
      changes.push(Object.assign(s, { i, top: smp.tops[k], top0: smp.top0[k], css: smp.info[k], tp: smp.tp[k] }));
    }
    return { frames: smp.frames, ms: Math.round(smp.endT || 0), frameMs: r1(fm), sampled: smp.ids.length, scroll: smp.scroll, scrollEndMs: smp.scrollEndT === null ? null : Math.round(smp.scrollEndT), changes };
  };
  rc.restMeasure = (stepIdx) => {
    const S = rc.snap;
    const [sy, vs] = rc.vscroll();
    const L = S.layout.map((l) => { if (!l.el.isConnected) return null; const r = l.el.getBoundingClientRect(); return [Math.round(r.top), Math.round(r.left), Math.round(r.height), Math.round(r.width)]; });
    const rv = S.layout.map((l) => l.anc.some((i) => S.els[i].steps.includes(stepIdx)));
    let hdr = null;
    try { hdr = rc.pinnedHeader(); } catch {}
    let navKids = null;
    try { if (S.nav && S.nav.isConnected) navKids = headerKids(S.nav); } catch {}
    return { sy, vs, docH: rc.docH(), L, rv, nav: S.nav && S.nav.isConnected ? Object.assign(rc.navState(S.nav), navKids ? { btns: navKids.btns, links: navKids.links } : {}) : null, hdr };
  };
  // A slide in a stack: the element (or one of its two nearest ancestors) has a sibling occupying nearly the
  // same box (IoU >= 0.8, >= 40x40) and, after the scroll pass, one of the two is hidden again (opacity ~0 or
  // visibility hidden): cross-fading slides show one slide at a time, not content entering the viewport.
  // Stacked layers that all stay visible after fading in (a card's image and overlay revealed together)
  // are a reveal.
  const hiddenNow = (e) => { try { if (e.checkVisibility) return !e.checkVisibility({ opacityProperty: true, visibilityProperty: true }); const cs = getComputedStyle(e); return parseFloat(cs.opacity) <= 0.05 || cs.visibility === 'hidden'; } catch { return false; } };
  const stackedOf = (el) => {
    for (let a = el, d = 0; a && a.parentElement && d < 3; a = a.parentElement, d++) {
      const r = a.getBoundingClientRect();
      if (r.width < 40 || r.height < 40) continue;
      let k = 0;
      for (const s of a.parentElement.children) {
        if (s === a || SKIP.has(s.tagName) || s.tagName !== a.tagName || ++k > 24) continue;
        const q = s.getBoundingClientRect();
        const w = Math.min(r.right, q.right) - Math.max(r.left, q.left), h = Math.min(r.bottom, q.bottom) - Math.max(r.top, q.top);
        if (w <= 0 || h <= 0) continue;
        const inter = w * h, uni = r.width * r.height + q.width * q.height - inter;
        if (inter / uni >= 0.8 && (hiddenNow(s) || hiddenNow(a))) return true;
      }
    }
    return false;
  };
  // A small fixed / sticky box (a back-to-top button, a floating chip): it never scrolls into view, so its
  // fade-in on scroll is a scroll state, not a reveal. The element or its nearest fixed/sticky ancestor is
  // <= 50% of the viewport wide, <= 30% tall and <= 10% of its area.
  rc.fixedUi = (el) => {
    for (let e = el; e && e !== document.body && e !== document.documentElement; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
      const r = e.getBoundingClientRect();
      return r.width <= innerWidth * 0.5 && r.height <= innerHeight * 0.3 && r.width * r.height <= innerWidth * innerHeight * 0.1;
    }
    return false;
  };
  // The page's header bar: the nav the snapshot found, a nav / banner landmark (not in a footer), or a
  // top-level <header> (not a section's or article's own header). Its state toggles on scroll belong to
  // its scrolled state (spacing.nav.onScroll), never to the scroll reveals.
  rc.inHeader = (el) => {
    const S = rc.snap;
    if (S && S.nav && S.nav.isConnected && (S.nav === el || S.nav.contains(el))) return true;
    const n = el.closest('nav,[role=navigation],[role=banner]');
    if (n && !n.closest('footer,[role=contentinfo]')) return true;
    const h = el.closest('header');
    return !!(h && !(h.parentElement && h.parentElement.closest('article,section,aside,footer')));
  };
  // Static info about tracked elements, fetched once after the step pass.
  rc.trackedInfo = (idxs) => {
    const S = rc.snap;
    return idxs.map((i) => {
      const e = S.els[i];
      if (!e) return null;
      const el = e.el;
      const r = el.getBoundingClientRect();
      const p = el.parentElement;
      return { i, desc: rc.desc(el), parent: p ? rc.sig(p) : '', parentDesc: p ? rc.desc(p) : '', y: Math.round(r.top + scrollY), h: Math.round(r.height), w: Math.round(r.width), area: Math.round(r.width * r.height),
        init: rs(e.m), steps: e.steps, cont: e.cont, nestedIn: (() => { let q = el.parentElement; while (q) { if (S.idx.has(q) && S.els[S.idx.get(q)].steps.length) return S.idx.get(q); q = q.parentElement; } return null; })(),
        tag: el.tagName.toLowerCase(), chars: (el.textContent || '').trim().length, stacked: stackedOf(el) || undefined, fixedUi: rc.fixedUi(el) || undefined, hdr: rc.inHeader(el) || undefined, vh: innerHeight };
    }).filter(Boolean);
  };
  // Media boxes in the first viewport (page at the top): video, canvas, iframe, img/picture, inline svg,
  // Lottie / Rive / Spline players, background-image boxes and composite illustrations (kind 'art': the
  // smallest container holding >= 3 graphic pieces - images, svgs, canvases, background-image/gradient
  // boxes, empty filled or outlined shapes - with little text, not a single row of logo-like marks),
  // >= 3% of the viewport, outermost only, third-party and removed popups excluded. Boxes in viewport px
  // (for frame differencing). An illustration made of several small animated pieces is one media box.
  rc.heroMedia = () => {
    const vw = innerWidth, vh = innerHeight, cands = [];
    try { rc.tpScan(); } catch {}
    const PLAYER = /^(LOTTIE-PLAYER|DOTLOTTIE-PLAYER|DOTLOTTIE-WC|SPLINE-VIEWER|RIVE-CANVAS)$/;
    const all = document.body.getElementsByTagName('*');
    const clipBox = (r) => { const x0 = Math.max(0, r.left), y0 = Math.max(0, r.top), x1 = Math.min(vw, r.right), y1 = Math.min(vh, r.bottom); return [Math.round(x0), Math.round(y0), Math.round(x1 - x0), Math.round(y1 - y0)]; };
    const bigEnough = (b) => b[2] >= 40 && b[3] >= 40 && b[2] * b[3] >= vw * vh * 0.03;
    const away = (e) => rc.isTp(e) || !!e.closest('[data-rc-overlay],[data-rc-embed]');
    // graphic pieces in the first viewport (outermost)
    const pieces = [];
    for (let i = 0; i < all.length && i < 30000 && pieces.length < 400; i++) {
      const e = all[i];
      if (e.ownerSVGElement || SKIP.has(e.tagName)) continue;
      const r = e.getBoundingClientRect();
      if (r.width < 12 || r.height < 12 || r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) continue;
      const tag = e.tagName.toUpperCase();
      let g = /^(IMG|SVG|CANVAS|VIDEO|PICTURE)$/.test(tag) || PLAYER.test(tag);
      if (!g) {
        const cs = getComputedStyle(e);
        const small = r.width * r.height <= vw * vh * 0.4 && (e.textContent || '').replace(/\s+/g, '').length <= 3;
        if (small && cs.backgroundImage && cs.backgroundImage !== 'none') g = true;
        else if (small && !e.children.length) { const bg = rc.rgba(cs.backgroundColor); if ((bg && bg[3] > 0.3) || (parseFloat(cs.borderTopWidth) >= 1 && cs.borderTopStyle !== 'none')) g = true; }
      }
      if (!g || away(e) || pieces.some((p) => p.el.contains(e))) continue;
      if (e.checkVisibility && !e.checkVisibility({ visibilityProperty: true })) continue;
      pieces.push({ el: e, r });
    }
    const cnt = new Map();
    let hdrEl = null; try { const nv = rc.findNav && rc.findNav(); hdrEl = nv && nv.el && nv.el.getBoundingClientRect().height < vh * 0.3 ? nv.el : null; } catch { hdrEl = null; }
    for (const p of pieces) for (let a = p.el.parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) cnt.set(a, (cnt.get(a) || 0) + 1);
    const arts = [];
    for (const [a, n] of cnt) {
      // the site header's icons and logo are never a composite illustration
      if (n < 3 || away(a) || a.closest('nav,[role=navigation]') || (hdrEl && hdrEl.contains(a))) continue;
      const r = a.getBoundingClientRect(), box = clipBox(r);
      if (!bigEnough(box)) continue;
      if ((a.textContent || '').replace(/\s+/g, ' ').trim().length > 80) continue;
      const mine = pieces.filter((p) => a.contains(p.el));
      const hs = mine.map((p) => p.r.height).sort((x, y) => x - y), medH = hs[hs.length >> 1] || 1;
      const cy = mine.map((p) => p.r.top + p.r.height / 2);
      if (mine.length >= 4 && Math.max(...cy) - Math.min(...cy) <= 0.5 * medH && r.width >= 3 * r.height) continue; // a row of marks (logos)
      arts.push({ el: a, n, box, area: box[2] * box[3], r });
    }
    arts.sort((x, y) => x.area - y.area);
    const picked = [];
    for (const c of arts) {
      const inner = picked.filter((d) => c.el.contains(d.el));
      if (inner.length && inner.reduce((s, d) => s + d.n, 0) >= 0.75 * c.n) continue;
      for (const d of inner) picked.splice(picked.indexOf(d), 1);
      picked.push(c);
    }
    for (const c of picked) cands.push({ el: c.el, kind: 'art', box: c.box, docY: Math.round(c.r.top + scrollY), pieces: c.n });
    // UI mock-ups and card stacks (kind 'panel'): HTML/CSS stand-ins for product media, whatever they are
    // made of. A box with its own fill, border, shadow or background image, or a stack of >= 2 overlapping
    // child cards (>= 15% of its area each, overlapping by >= 30% of the smaller), holding >= 3 nested
    // filled / outlined boxes or graphics, with little text (<= 30 characters), mostly small text (>= half
    // under 15 px) or >= 3 graphics, little large text (>= 28 px: <= max(12, 20%) of its characters); no h1,
    // no form field, no real call-to-action button (a filled or outlined link / button 28-72 px tall), not a
    // single row of marks; >= 3% of the viewport, >= 120 px tall, narrower than 95% of the viewport and under
    // 70% of its area; never in the nav, a dialog or a fixed / sticky bar. Its insides (CSS animation, cycling
    // states, a track sliding inside it) are its media activity.
    {
      const boxyCs = (cs) => { const bg = rc.rgba(cs.backgroundColor); return (bg && bg[3] > 0.3) || (parseFloat(cs.borderTopWidth) >= 1 && cs.borderTopStyle !== 'none') || (!!cs.boxShadow && cs.boxShadow !== 'none') || /url\(|gradient/.test(cs.backgroundImage || ''); };
      const GR = /^(IMG|SVG|CANVAS|VIDEO|PICTURE)$/;
      const ovl = (a, b) => { const w = Math.min(a.right, b.right) - Math.max(a.left, b.left), h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top); return w > 0 && h > 0 ? (w * h) / Math.max(1, Math.min(a.width * a.height, b.width * b.height)) : 0; };
      const panelOf = (e, r, cs) => {
        if (e.querySelector('h1,textarea,select,input:not([type=hidden])')) return null;
        let stack = false;
        if (!boxyCs(cs)) {
          const kids = [];
          for (const k of e.children) { if (SKIP.has(k.tagName)) continue; const kr = k.getBoundingClientRect(); if (kr.width * kr.height >= r.width * r.height * 0.15 && (GR.test(k.tagName.toUpperCase()) || boxyCs(getComputedStyle(k)) || k.querySelector('img,svg,canvas,video,picture'))) kids.push(kr); if (kids.length > 12) break; }
          stack = kids.some((a, i) => kids.some((b, j) => j > i && ovl(a, b) >= 0.3));
          if (!stack) return null;
        }
        let boxes = 0, graphics = 0, chars = 0, small = 0, big = 0, n = 0;
        const gy = [];
        for (const d of e.getElementsByTagName('*')) {
          if (++n > 600) break;
          if (d.ownerSVGElement || SKIP.has(d.tagName)) continue;
          const tag = d.tagName.toUpperCase(), dr = d.getBoundingClientRect();
          if (dr.width < 4 || dr.height < 4) continue;
          const dcs = getComputedStyle(d);
          if (GR.test(tag)) { graphics++; boxes++; gy.push(dr); } else if (dr.width * dr.height >= 300 && boxyCs(dcs)) boxes++;
          if (((tag === 'A' && d.hasAttribute('href')) || tag === 'BUTTON') && dr.height >= 28 && dr.height <= 72 && dr.width <= 420 && dr.width * dr.height < r.width * r.height * 0.2 && boxyCs(dcs) && (d.textContent || '').trim().length >= 2) return null;
          const fs = parseFloat(dcs.fontSize) || 16;
          for (const t of d.childNodes) if (t.nodeType === 3) { const k = t.data.replace(/\s+/g, '').length; if (!k) continue; chars += k; if (fs < 15) small += k; else if (fs >= 28) big += k; }
        }
        if (boxes < 3 || big > Math.max(12, chars * 0.2) || !(chars <= 30 || small >= chars * 0.5 || (graphics >= 3 && chars <= 600))) return null;
        if (gy.length >= 4 && r.width >= 3 * r.height) { const hs = gy.map((g) => g.height).sort((a, b) => a - b), cy = gy.map((g) => g.top + g.height / 2); if (Math.max(...cy) - Math.min(...cy) <= 0.5 * hs[hs.length >> 1]) return null; }
        return { stack, boxes, chars };
      };
      // a composite illustration that is a stack of overlapping cards is a card stack (its cards are pieces
      // whatever they hold)
      for (const c of cands) if (c.kind === 'art') { const pn = panelOf(c.el, c.el.getBoundingClientRect(), getComputedStyle(c.el)); if (pn && pn.stack) { c.kind = 'panel'; c.stack = true; } }
      let tried = 0;
      for (let i = 0; i < all.length && i < 30000 && tried < 120; i++) {
        const e = all[i];
        if (e.ownerSVGElement || SKIP.has(e.tagName) || GR.test(e.tagName.toUpperCase()) || /^(A|BUTTON|FORM|NAV|FOOTER)$/.test(e.tagName)) continue;
        const r = e.getBoundingClientRect();
        if (r.height < 120 || r.width < vw * 0.15 || r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) continue;
        const box = clipBox(r);
        if (!bigEnough(box) || box[2] >= vw * 0.95 || box[2] * box[3] >= vw * vh * 0.7) continue;
        if (away(e) || e.closest('nav,[role=navigation],[role=dialog],dialog')) continue;
        if (cands.some((m) => m.el === e || m.el.contains(e))) continue;
        const cs = getComputedStyle(e);
        if (cs.position === 'fixed' || cs.position === 'sticky' || cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.1) continue;
        tried++;
        const pn = panelOf(e, r, cs);
        if (pn) cands.push({ el: e, kind: 'panel', box, docY: Math.round(r.top + scrollY), pieces: pn.boxes, stack: pn.stack || undefined });
      }
    }
    for (let i = 0; i < all.length && i < 30000 && cands.length < 40; i++) {
      const e = all[i];
      if (e.ownerSVGElement || SKIP.has(e.tagName)) continue;
      const tag = e.tagName.toUpperCase();
      let kind = null;
      if (tag === 'VIDEO') kind = 'video'; else if (tag === 'CANVAS') kind = 'canvas'; else if (tag === 'IFRAME') kind = 'iframe';
      else if (tag === 'IMG' || tag === 'PICTURE') kind = 'img'; else if (tag === 'SVG') kind = 'svg'; else if (PLAYER.test(tag) || e.hasAttribute('data-lottie')) kind = 'lottie';
      else if (tag.includes('-')) {
        // a custom-element player (its <video> / <canvas> lives in a shadow root the element walk never enters)
        let sv = null; try { sv = e.shadowRoot && e.shadowRoot.querySelector('video,canvas,iframe'); } catch { sv = null; }
        if (sv) kind = sv.tagName === 'VIDEO' ? 'video' : sv.tagName === 'CANVAS' ? 'canvas' : 'iframe';
        else if (/-(VIDEO|PLAYER)$/.test(tag)) kind = 'video';
      }
      if (!kind) { const bi = getComputedStyle(e).backgroundImage; if (bi && bi.includes('url(')) kind = 'bg-image'; }
      if (!kind) continue;
      if (away(e)) continue;
      if (cands.some((m) => m.el.contains(e))) continue;
      const r = e.getBoundingClientRect();
      const box = clipBox(r);
      if (!bigEnough(box)) continue;
      if (e.checkVisibility && !e.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      if (kind === 'img' && e.closest('svg')) continue;
      if (e.closest('lottie-player,dotlottie-player,dotlottie-wc,[data-lottie]') && e.closest('lottie-player,dotlottie-player,dotlottie-wc,[data-lottie]') !== e) kind = 'lottie';
      let vEl = e;
      if (kind === 'video' && tag !== 'VIDEO') { try { vEl = (e.shadowRoot && e.shadowRoot.querySelector('video')) || e; } catch { vEl = e; } }
      cands.push({ el: e, kind, box, docY: Math.round(r.top + scrollY), playing: kind === 'video' ? (typeof vEl.paused === 'boolean' ? !vEl.paused : undefined) : undefined });
    }
    // outermost only, in document order
    const out = cands.filter((m) => !cands.some((o) => o !== m && o.el.contains(m.el)))
      .sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)).slice(0, 8);
    rc.heroEls = out.map((m) => m.el);
    rc.heroBoxes = out.map((m) => [m.box[0] + scrollX, m.box[1] + scrollY, m.box[2], m.box[3]]);
    // a background-image box holding text is the band's background: what moves inside it is not its media
    rc.heroTexty = out.map((m) => m.kind === 'bg-image' && (m.el.textContent || '').replace(/\s+/g, '').length > 80);
    rc.heroKinds = out.map((m) => m.kind);
    return out.map(({ el, ...m }) => Object.assign(m, { desc: rc.desc(el) }));
  };
  // Index of the hero media box el is a piece of: strictly inside its element (DOM), not a text-holding
  // background box, and in a box other than a UI mock-up panel not (inside or holding) a heading, link or
  // button (a headline or CTA set over the art stays page content); -1 when none. Whatever moves there (a
  // track sliding, a cycling state or card, text swapping, a CSS animation) is that box's media activity.
  rc.heroIn = (el) => {
    const H = rc.heroEls || [], T = rc.heroTexty || [], K = rc.heroKinds || [];
    for (let i = 0; i < H.length; i++) {
      if (!H[i] || H[i] === el || T[i] || !H[i].isConnected || !H[i].contains(el)) continue;
      if (K[i] !== 'panel') { const c = el.closest('h1,h2,h3,a,button'); if ((c && H[i].contains(c)) || el.querySelector('h1,h2,h3,a,button')) continue; }
      return i;
    }
    return -1;
  };
  // Index of the hero media box (rc.heroMedia) an element belongs to: inside its element, or >= 50% of
  // the element's box inside the media box (page coordinates); -1 when none.
  rc.heroIdx = (el) => {
    const H = rc.heroEls || [], B = rc.heroBoxes || [];
    for (let i = 0; i < H.length; i++) if (H[i] && H[i].isConnected && (H[i] === el || H[i].contains(el))) return i;
    const r = el.getBoundingClientRect();
    const a = Math.max(1, r.width * r.height), x0 = r.left + scrollX, y0 = r.top + scrollY;
    for (let i = 0; i < B.length; i++) {
      const b = B[i];
      const w = Math.min(x0 + r.width, b[0] + b[2]) - Math.max(x0, b[0]), h = Math.min(y0 + r.height, b[1] + b[3]) - Math.max(y0, b[1]);
      if (w > 0 && h > 0 && (w * h) / a >= 0.5) return i;
    }
    return -1;
  };
  // Indices into the snapshot's layout list of elements that turned out to be popups / third-party
  // (an overlay found after the snapshot): sticky / parallax entries for them are dropped.
  rc.overlayLayoutIdx = () => {
    const S = rc.snap; if (!S) return [];
    try { rc.tpScan(); } catch {}
    const out = [];
    S.layout.forEach((l, j) => { if (!l.el.isConnected || rc.isTp(l.el) || l.el.closest('[data-rc-overlay],[data-rc-embed]')) out.push(j); });
    return out;
  };
  // Count tracked elements that changed at all between snapshot and now (light passes).
  rc.revealCount = () => {
    const S = rc.snap; if (!S) return null;
    let n = 0, groups = new Set();
    for (const e of S.els) {
      if (!e.el.isConnected) continue;
      const m = rc.mstate(e.el);
      const f = e.m;
      if ((m.o - f.o >= 0.3) || ((Math.abs(f.ty) >= 3 || Math.abs(f.tx) >= 3) && Math.abs(m.ty) + Math.abs(m.tx) < (Math.abs(f.ty) + Math.abs(f.tx)) * 0.5) || (m.c - f.c > 0.2)) {
        if (rc.fixedUi(e.el)) continue;   // a back-to-top button fading in is not a reveal
        if (rc.inHeader(e.el)) continue;  // the header's scrolled state is not a reveal
        let p = e.el.parentElement, nested = false;
        while (p) { if (S.idx.has(p) && groups.has(p)) { nested = true; break; } p = p.parentElement; }
        groups.add(e.el);
        if (!nested) n++;
      }
    }
    return n;
  };
}
