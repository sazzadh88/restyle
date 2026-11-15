// Palette building for capture.mjs (culori). Input: raw painted areas from the page
// (background boxes minus occluding children, glyph area for text, border length x width,
// svg fills; logo / brand marks already left out) plus screenshot histograms. Output: merged palette
// with OKLCH, shares, roles, minor colours and the brand-mark colours that were left out.
import { converter, differenceEuclidean } from 'culori';

// a null or unparsable colour (an entry whose colour could not be read) converts to undefined, never throws
const safe = (conv) => (c) => { if (c === null || c === undefined || c === '') return undefined; try { return conv(c); } catch { return undefined; } };
const toLab = safe(converter('oklab'));
const toLch = safe(converter('oklch'));
const dLab = differenceEuclidean('oklab');
const r3 = (v) => Math.round(v * 1000) / 1000;

export function oklch(hex) {
  const c = toLch(hex);
  if (!c) return null;
  return [r3(c.l), r3(c.c), c.c < 0.02 || c.h === undefined || isNaN(c.h) ? null : Math.round(c.h)];
}
export const labDist = (a, b) => dLab(a, b);

// ctx.bands: the capture's 1440 bands (sections[], index = band index: y, h, role, bg) and ctx.vh, for the
// band-area page background vote and the "text on the page background" test. weak{role: why} marks a role
// whose evidence is split or thin (the digest prints it as WEAK; compare weighs it less).
export function buildPalette(raw, shot, ctx = {}) {
  const notes = [];
  const weak = {};
  const bandsIn = Array.isArray(ctx.bands) && ctx.bands.length ? ctx.bands : null;
  const vh = ctx.vh || 900;
  const entries = (raw.entries || []).filter((e) => e.area > 0).sort((a, b) => b.area - a.area);
  const totals = { bg: 0, text: 0, border: 0, graphic: 0 };
  for (const e of entries) totals[e.kind] = (totals[e.kind] || 0) + e.area;
  const clusters = [];
  for (const e of entries) {
    const lab = toLab(e.hex);
    let c = clusters.find((k) => dLab(k.lab, lab) < 0.025);
    if (!c) { c = { hex: e.hex, lab, area: 0, kinds: {}, ctx: {}, top: {}, hexes: new Map(), ex: {} }; clusters.push(c); }
    if (e.ex && (!c.ex[e.kind] || e.area > c.ex[e.kind][1])) c.ex[e.kind] = [e.ex, e.area];
    e._c = c;
    c.area += e.area;
    c.kinds[e.kind] = (c.kinds[e.kind] || 0) + e.area;
    c.hexes.set(e.hex, (c.hexes.get(e.hex) || 0) + e.area);
    const tk = c.top[e.kind] || (c.top[e.kind] = new Map());
    tk.set(e.hex, (tk.get(e.hex) || 0) + e.area);
    const ck = `${e.kind}:${e.ctx}`;
    c.ctx[ck] = (c.ctx[ck] || 0) + e.area;
  }
  const total = clusters.reduce((s, c) => s + c.area, 0) || 1;
  for (const c of clusters) { const l = toLch(c.hex); c.L = l.l; c.C = l.c; c.H = l.h; }
  const kindSorted = (k) => clusters.filter((c) => c.kinds[k]).sort((a, b) => b.kinds[k] - a.kinds[k]);
  const roles = {};
  // page background (CSS): largest painted background, but the html/body colour wins when its
  // cluster has at least half the area of the largest; cross-checked against the full screenshot
  const bgs = kindSorted('bg');
  const clusterFor = (hex, k = 'bg') => {
    const lab = toLab(hex);
    let c = (k ? kindSorted(k) : clusters).find((q) => dLab(q.lab, lab) < 0.03) || clusters.find((q) => dLab(q.lab, lab) < 0.03);
    if (!c) { c = { hex, lab, area: 0, kinds: { [k || 'bg']: 0 }, ctx: {}, fromShot: true }; const l = toLch(hex); c.L = l.l; c.C = l.c; c.H = l.h; clusters.push(c); }
    return c;
  };
  // Page background = what most band area and the first screens show: every band but the nav votes its
  // background colour by its height, rows inside the first two screens count again (double), the footer
  // counts half, and bands whose background is a picture (image, video, canvas) do not vote. A footer or one
  // dark band never outweighs a page that is mostly light, and the reverse. Split evidence (a colour of the
  // opposite lightness with >= 60% of the winner's vote) marks the role WEAK. Without bands: the largest
  // painted CSS background (html/body colour preferred), cross-checked against the full screenshot.
  let bandVote = null;
  if (bandsIn) {
    const votes = [];
    for (const s of bandsIn) {
      if (!s || s.role === 'nav' || !s.bg || !(s.h > 0)) continue;
      const hex = s.bg.type === 'color' ? s.bg.color : s.bg.type === 'gradient' && s.bg.sampled && s.bg.sampledShare >= 0.5 ? s.bg.sampled : null;
      const lab = hex && toLab(hex);
      if (!lab) continue;
      const w = (s.h + Math.max(0, Math.min((s.y || 0) + s.h, vh * 2) - Math.max(s.y || 0, 0))) * (s.role === 'footer' ? 0.5 : 1);
      let v = votes.find((x) => dLab(x.lab, lab) < 0.03);
      if (!v) { v = { hex, lab, w: 0, top: 0 }; votes.push(v); }
      v.w += w;
      if (w > v.top) { v.top = w; v.hex = hex; }
    }
    if (votes.length) bandVote = votes.sort((a, b) => b.w - a.w);
  }
  let pageBg = bgs[0] || null;
  if (bandVote) {
    const win = bandVote[0];
    pageBg = clusterFor(win.hex);
    pageBg.voteHex = win.hex;
    const tot = bandVote.reduce((s, v) => s + v.w, 0) || 1;
    const wl = toLch(win.hex).l;
    const opp = bandVote.find((v) => Math.abs(toLch(v.hex).l - wl) >= 0.3);
    if (opp && opp.w >= win.w * 0.6) weak.pageBg = `split: ${win.hex} on ${Math.round(win.w / tot * 100)}% of the weighted band area, ${opp.hex} on ${Math.round(opp.w / tot * 100)}%`;
  } else if (raw.rootBg && pageBg) {
    const rootC = bgs.find((c) => dLab(c.lab, toLab(raw.rootBg)) < 0.025);
    if (rootC && rootC !== pageBg && rootC.kinds.bg >= pageBg.kinds.bg * 0.5) pageBg = rootC;
  }
  if (!bandVote && shot && shot.full && shot.full.length) {
    const sTop = shot.full[0];
    const cssShare = pageBg ? shareIn(shot.full, pageBg.hex) : 0;
    if (sTop.share >= 0.4 && cssShare < 0.15 && (!pageBg || dLab(toLab(sTop.hex), pageBg.lab) > 0.05)) {
      notes.push(`page background from screenshot (${sTop.hex}, ${Math.round(sTop.share * 100)}% of pixels) instead of CSS (${pageBg ? pageBg.hex : 'none'})`);
      let c = clusters.find((k) => dLab(k.lab, toLab(sTop.hex)) < 0.03);
      if (!c) { c = { hex: sTop.hex, lab: toLab(sTop.hex), area: 0, kinds: { bg: 0 }, ctx: {}, fromShot: true }; const l = toLch(sTop.hex); c.L = l.l; c.C = l.c; c.H = l.h; clusters.push(c); }
      pageBg = c;
    }
  }
  if (pageBg) roles.pageBg = pageBg;
  // surface: raised panels; card backgrounds count double
  const surfScore = (c) => (c.ctx['bg:card'] || 0) * 2 + (c.kinds.bg || 0);
  const surf = kindSorted('bg').filter((c) => c !== pageBg && dLab(c.lab, pageBg ? pageBg.lab : c.lab) >= 0.015 && (c.C < 0.1 || (c.ctx['bg:card'] || 0) > c.kinds.bg * 0.5) && c.kinds.bg >= (totals.bg || 1) * 0.005)
    .sort((a, b) => surfScore(b) - surfScore(a))[0];
  if (surf) roles.surface = surf;
  // primary/muted text: text painted on the page background and contrasting with it (headlines on
  // dark image tiles of a light page must not become the page's text colour)
  for (const c of clusters) c.textPage = 0;
  const pageL = pageBg ? pageBg.L : null;
  // Running text (page-analyze raw.runText: no buttons, nav, controls, mock-ups, media boxes, text over
  // pictures, near-invisible text) votes by glyph area when it is drawn on the page background: the colour
  // behind it and its band's background within 0.15 lightness of pageBg (a white card on a cream page still
  // counts; a dark band or footer of a light page does not), contrasting with it by >= 0.3 lightness.
  // text = the leading colour, or, when that is grey prose (contrast <= 0.65), a neutral that contrasts more
  // by > 0.1 with >= 15% of its area (headings over grey prose); mutedText = a secondary neutral with >= 4% of
  // the area whose contrast is at least 0.15 lower than text's.
  const runRole = (() => {
    const rt = Array.isArray(raw.runText) ? raw.runText : null;
    if (!rt || pageL === null) return null;
    const lOf = (hex) => { if (typeof hex !== 'string' || !hex) return null; let l = null; try { l = toLch(hex); } catch { l = null; } return l ? l.l : null; };
    const bandOk = (b) => { const s = bandsIn && bandsIn[b]; if (!s || !s.bg) return true; const hx = s.bg.type === 'color' ? s.bg.color : null; if (!hx) return true; const l = lOf(hx); return l === null || Math.abs(l - pageL) < 0.15; };
    const tv = [];
    for (const e of rt) {
      const l = lOf(e.hex), lo = e.on ? lOf(e.on) : pageL;
      if (l === null || Math.abs(l - pageL) < 0.3 || (lo !== null && Math.abs(lo - pageL) >= 0.15) || !bandOk(e.b)) continue;
      const lab = toLab(e.hex);
      let v = tv.find((x) => dLab(x.lab, lab) < 0.025);
      if (!v) { v = { hex: e.hex, lab, area: 0, top: 0, ex: e.ex }; tv.push(v); }
      v.area += e.area;
      if (e.area > v.top) { v.top = e.area; v.hex = e.hex; v.ex = e.ex; }
    }
    if (!tv.length) return null;
    tv.sort((a, b) => b.area - a.area);
    const tot = tv.reduce((s, v) => s + v.area, 0) || 1;
    for (const v of tv) { const l = toLch(v.hex); v.L = l.l; v.C = l.c; v.con = Math.abs(l.l - pageL); }
    let text = tv[0];
    // the swap is for grey prose (the leading colour contrasts <= 0.65 with the page): near-black prose
    // (#111, #1d1d1f) stays the text colour even where headings or links are pure black
    const stronger = text.con <= 0.65 ? tv.filter((v) => v !== text && v.C < 0.1 && v.area >= tot * 0.04 && v.area >= text.area * 0.15 && dLab(v.lab, text.lab) >= 0.04 && v.con > text.con + 0.1).sort((a, b) => b.area - a.area)[0] : null;
    if (stronger && text.C < 0.1) text = stronger;
    // muted = visibly lighter than text (contrast at least 0.15 lower), never a second near-black
    const muted = tv.find((v) => v !== text && v.C < 0.1 && v.area >= tot * 0.04 && dLab(v.lab, text.lab) >= 0.04 && v.con < text.con - 0.15 && (!pageBg || dLab(v.lab, pageBg.lab) > 0.1)) || null;
    const all = raw.textArea || tot;
    if (tot < all * 0.1) weak.text = `little running text on the page background (${Math.round(tot / all * 100)}% of the text area)`;
    return { text, muted };
  })();
  for (const e of entries) {
    if (e.kind !== 'text' || !e._c) continue;
    const contrast = pageL === null || Math.abs(e._c.L - pageL) >= 0.3;
    // "on the page" = painted over a surface of similar lightness to the page background
    const onPage = !e.on || pageL === null || Math.abs((toLch(e.on) || { l: pageL }).l - pageL) < 0.15;
    if (contrast && onPage) e._c.textPage += e.area;
  }
  let txt = clusters.filter((c) => c.textPage > 0).sort((a, b) => b.textPage - a.textPage);
  const tkey = txt.length ? 'textPage' : 'text';
  if (!txt.length) txt = kindSorted('text').filter((c) => pageL === null || Math.abs(c.L - pageL) >= 0.3);
  if (!txt.length) txt = kindSorted('text');
  const tArea = (c) => c[tkey] || c.kinds.text || 0;
  const tTotal = txt.reduce((s, c) => s + tArea(c), 0) || 1;
  let muted = txt.find((c) => c !== txt[0] && dLab(c.lab, txt[0].lab) >= 0.04 && tArea(c) >= tTotal * 0.04 && c.C < 0.1 && (!pageBg || dLab(c.lab, pageBg.lab) > 0.1));
  let primary = txt[0];
  // primary text is the stronger-contrast one when the two leading greys are of comparable use
  if (primary && muted && pageL !== null && Math.abs(muted.L - pageL) > Math.abs(primary.L - pageL) && tArea(muted) >= tArea(primary) * 0.4 && primary.C < 0.1) [primary, muted] = [muted, primary];
  const roleOver = {};   // role -> [hex, where] when the role comes from running text or actions
  if (runRole) {
    primary = clusterFor(runRole.text.hex, 'text'); roleOver.text = [runRole.text.hex, runRole.text.ex];
    muted = runRole.muted ? clusterFor(runRole.muted.hex, 'text') : null;
    if (runRole.muted) roleOver.mutedText = [runRole.muted.hex, runRole.muted.ex];
    if (muted === primary) muted = null;
  }
  if (primary) roles.text = primary;
  if (muted) roles.mutedText = muted;
  const brd = clusters.filter((c) => c.kinds.border).sort((a, b) => ((b.ctx['border:hairline'] || 0) * 1.5 + b.kinds.border) - ((a.ctx['border:hairline'] || 0) * 1.5 + a.kinds.border))[0];
  if (brd) roles.border = brd;
  // accent: a chromatic colour used on interactive fills and links (button backgrounds, link text) first,
  // then headings and other non-page surfaces. Never a neutral, never near-black or near-white (dark
  // navy bands and pale tints are surfaces, not accents) unless nothing else qualifies. Variable names
  // are not used.
  const btnHexes = (raw.buttonBgs || []);
  const score = (c) => {
    const btn = btnHexes.filter((h) => dLab(toLab(h), c.lab) < 0.03).length;
    const interactive = (c.ctx['bg:button'] || 0) / Math.max(1, totals.bg) * 40 + btn * 0.05 + (c.ctx['text:link'] || 0) / Math.max(1, totals.text) * 4 + (c.ctx['text:button'] || 0) / Math.max(1, totals.text) * 1;
    const other = (c.ctx['text:heading'] || 0) / Math.max(1, totals.text) * 1 + ((c.kinds.bg || 0) - (c.ctx['bg:page'] || 0)) / Math.max(1, totals.bg) * 0.4 +
      (c.kinds.graphic || 0) / Math.max(1, totals.graphic || 1) * 0.05 + (c.kinds.border || 0) / Math.max(1, totals.border || 1) * 0.1;
    return interactive + other * 0.5;
  };
  const painted = (c) => ((c.kinds.bg || 0) + (c.kinds.text || 0) + (c.kinds.border || 0)) > 0;
  const midL = (c) => c.L >= 0.28 && c.L <= 0.93;
  // svg-only colours (icons inside product shots) only qualify when nothing else is chromatic
  const tiers = [
    clusters.filter((c) => c.C >= 0.06 && c !== pageBg && painted(c) && midL(c)),
    clusters.filter((c) => c.C >= 0.06 && c !== pageBg && painted(c)),
    clusters.filter((c) => c.C >= 0.06 && c !== pageBg),
  ];
  const pool = tiers.find((t) => t.some((c) => score(c) > 0)) || [];
  const chromatic = pool.map((c) => [c, score(c)]).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]);
  // Accent from visible actions (page-analyze raw.actions: filled buttons with a visible label or an icon, text links
  // outside nav / footer lists, never inside media, art, mock-up or stand-in boxes, never hidden, never a brand
  // mark). Score = 2 x share of button fill area + share of buttons + share of link glyph area + 0.5 when used
  // in the first 1.5 screens. A chromatic action colour (chroma >= 0.06, on >= 1 button or >= 2 links) is the
  // accent and the next one of another hue accent2; with none, the page is monochrome and the accent is its
  // primary button fill (black, white or grey); with no filled button, its link colour (WEAK). A button
  // filled with the page background is not an accent.
  const actRole = (() => {
    const acts = Array.isArray(raw.actions) ? raw.actions : null;
    if (!acts) return null;
    const ac = [];
    for (const a of acts) {
      const lab = toLab(a.hex);
      if (!lab || (a.kind === 'fill' && pageBg && dLab(lab, pageBg.lab) < 0.02)) continue;
      let k = ac.find((x) => dLab(x.lab, lab) < 0.03);
      if (!k) { k = { hex: a.hex, lab, fillN: 0, fillA: 0, linkN: 0, linkA: 0, first: 0, top: 0, ex: a.ex }; ac.push(k); }
      if (a.kind === 'fill') { k.fillN += a.n; k.fillA += a.area; } else { k.linkN += a.n; k.linkA += a.area; }
      k.first += a.first || 0;
      const w = a.kind === 'fill' ? a.area * 4 : a.area;
      if (w > k.top) { k.top = w; k.hex = a.hex; k.ex = a.ex; }
    }
    if (!ac.length) return { accent: null, accent2: null };
    const fT = ac.reduce((s, k) => s + k.fillA, 0), fN = ac.reduce((s, k) => s + k.fillN, 0), lT = ac.reduce((s, k) => s + k.linkA, 0);
    for (const k of ac) { const l = toLch(k.hex); k.C = l.c; k.H = l.h; k.s = (fT ? 2 * k.fillA / fT : 0) + (fN ? k.fillN / fN : 0) + (lT ? k.linkA / lT : 0) + (k.first ? 0.5 : 0); }
    const chrom = ac.filter((k) => k.C >= 0.06 && (k.fillN >= 1 || k.linkN >= 2)).sort((a, b) => b.s - a.s);
    if (chrom.length) {
      const a1 = chrom[0];
      const a2 = chrom.find((k) => k !== a1 && (hueDiff(k.H, a1.H) >= 25 || dLab(k.lab, a1.lab) >= 0.1)) || null;
      if (!a1.fillN && ac.some((k) => k.fillN)) weak.accent = `chromatic links only (${a1.linkN}); filled buttons are ${ac.filter((k) => k.fillN).map((k) => k.hex).slice(0, 2).join(', ')}`;
      return { accent: a1, accent2: a2 };
    }
    const fills = ac.filter((k) => k.fillN).sort((a, b) => b.s - a.s);
    if (fills.length) { notes.push('no chromatic action colour; accent = primary button fill (achromatic)'); return { accent: fills[0], accent2: null }; }
    const links = ac.filter((k) => k.linkN).sort((a, b) => b.s - a.s);
    if (links.length) { weak.accent = 'no filled button: accent = the link colour'; return { accent: links[0], accent2: null }; }
    return { accent: null, accent2: null };
  })();
  if (actRole) {
    for (const k of ['accent', 'accent2']) {
      const a = actRole[k];
      if (a) { roles[k] = clusterFor(a.hex, null); roleOver[k] = [a.hex, a.ex]; }
    }
    if (!actRole.accent) weak.accent = 'no visible primary button or link';
    if (roles.accent2 && roles.accent2 === roles.accent) { delete roles.accent2; delete roleOver.accent2; }
  } else if (chromatic.length) {
    roles.accent = chromatic[0][0];
    const a2 = chromatic.find(([c]) => c !== roles.accent && (hueDiff(c.H, roles.accent.H) >= 25 || dLab(c.lab, roles.accent.lab) >= 0.1));
    if (a2) roles.accent2 = a2[0];
  } else if (btnHexes.length) {
    const m = modeOf(btnHexes);
    const c = clusters.find((k) => dLab(k.lab, toLab(m)) < 0.03);
    if (c && c !== pageBg) { roles.accent = c; notes.push('no chromatic accent; accent = primary button fill (achromatic)'); }
  }
  // assemble palette (role colours first, then by share), max 12
  const roleOf = new Map();
  for (const [k, c] of Object.entries(roles)) { const a = roleOf.get(c) || []; a.push(k); roleOf.set(c, a); }
  const ordered = [...new Set([...Object.values(roles), ...clusters.slice().sort((a, b) => b.area - a.area)])];
  const keep = [];
  for (const c of ordered) {
    if (keep.length >= 12) break;
    if (roleOf.has(c) || c.area / total >= 0.002 || (c.C >= 0.06 && score(c) > 0.01)) keep.push(c);
  }
  const palette = keep.map((c) => {
    const uses = {};
    for (const k of ['bg', 'text', 'border', 'graphic']) if (c.kinds[k] && totals[k]) { const v = r3(c.kinds[k] / totals[k]); if (v > 0) uses[k] = v; }
    const variants = c.hexes ? [...c.hexes.entries()].filter(([h, a]) => h !== c.hex && a >= c.area * 0.1).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([h]) => h) : [];
    return { hex: c.hex, oklch: oklch(c.hex), share: r3(c.area / total), uses, roles: roleOf.get(c) || [], shot: shot && shot.full ? shareIn(shot.full, c.hex) : null, variants: variants.length ? variants : undefined };
  });
  // role colour = the most-used exact hex of the relevant kind inside the merged cluster
  const rep = (c, kind) => { const m = c.top && c.top[kind]; if (!m || !m.size) return c.hex; return [...m.entries()].sort((a, b) => b[1] - a[1])[0][0]; };
  const KIND = { pageBg: 'bg', surface: 'bg', text: 'text', mutedText: 'text', border: 'border', accent: 'bg', accent2: 'bg' };
  const roleHex = {};
  for (const k of ['pageBg', 'surface', 'text', 'mutedText', 'border', 'accent', 'accent2']) roleHex[k] = roleOver[k] && roles[k] ? roleOver[k][0] : roles[k] ? rep(roles[k], KIND[k]) : null;
  // where each role colour is used (example element @band index), for actionable findings
  const roleWhere = {};
  for (const k of Object.keys(roles)) { const c = roles[k]; const ex = c.ex && (c.ex[KIND[k]] || c.ex.bg || c.ex.text || c.ex.border); if (roleOver[k] && roleOver[k][1]) roleWhere[k] = roleOver[k][1]; else if (ex) roleWhere[k] = ex[0]; }
  const theme = roles.pageBg ? (roles.pageBg.L < 0.5 ? 'dark' : 'light') : null;
  // logo / brand marks (header/footer home-link marks, logo-named elements, logo strips) never feed the
  // accent or minor colours: page-analyze leaves them out of raw.entries and raw.minor and lists their
  // chromatic colours in raw.brandMarks (kept here as a record and a note)
  const brandMarks = (raw.brandMarks || []).filter((b) => { const l = toLch(b.hex); return l && l.c >= 0.06; }).slice(0, 8);
  if (brandMarks.length) notes.push(`brand-mark colours left out of accent and minor colours: ${brandMarks.map((b) => `${b.hex} (${b.ex})`).join(', ')}`);
  for (const k of Object.keys(weak)) if (!roleHex[k] && k !== 'accent') delete weak[k];
  return { palette, roles: roleHex, roleWhere, theme, clusters: clusters.length, notes, minor: minorColors(raw.minor || [], raw.textArea), brandMarks, weak };
}

// Chromatic colours used on text, tags/badges, icons and SVG graphics, ranked by element count regardless of
// area; up to 16 (compare requires the reference's first 8 that are not graphic-only and used enough, and looks
// for them in all of the build's). share = painted area / the page's text glyph area (when known).
export function minorColors(list, textArea) {
  const cl = [];
  for (const m of list) {
    const lch = toLch(m.hex);
    if (!lch || lch.c < 0.06 || lch.l < 0.2 || lch.l > 0.97) continue;
    const lab = toLab(m.hex);
    let c = cl.find((k) => dLab(k.lab, lab) < 0.04);
    if (!c) { c = { hex: m.hex, lab, n: 0, area: 0, uses: new Map(), ex: m.ex, band: m.band, top: 0 }; cl.push(c); }
    c.n += m.n;
    c.area += m.area || 0;
    c.uses.set(m.use, (c.uses.get(m.use) || 0) + m.n);
    if (m.n > c.top) { c.top = m.n; c.hex = m.hex; c.ex = m.ex; c.band = m.band; }
  }
  return cl.sort((a, b) => b.n - a.n).slice(0, 16).map((c) => ({ hex: c.hex, oklch: oklch(c.hex), n: c.n, share: textArea > 0 ? r3(c.area / textArea) : undefined, uses: [...c.uses.entries()].sort((a, b) => b[1] - a[1]).map(([u]) => u), ex: c.ex, band: c.band }));
}

function shareIn(list, hex) {
  const lab = toLab(hex);
  let s = 0;
  for (const t of list) if (dLab(toLab(t.hex), lab) < 0.04) s += t.share;
  return r3(s);
}
function hueDiff(a, b) { if (a === undefined || b === undefined || isNaN(a) || isNaN(b)) return 180; const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; }
function modeOf(arr) { const m = new Map(); for (const a of arr) m.set(a, (m.get(a) || 0) + 1); return [...m.entries()].sort((a, b) => b[1] - a[1])[0][0]; }
