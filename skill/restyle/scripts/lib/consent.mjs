// Cookie / consent and popup handling for capture.mjs (and inspect.mjs).
// Strategy: (1) click a reject / decline / necessary-only control of a known CMP (OneTrust,
// Cookiebot, Didomi, Usercentrics, Quantcast, Sourcepoint, TrustArc, Osano, CookieYes, ...)
// in the page or in a consent iframe; (2) otherwise click an English reject-style button that
// sits inside a container mentioning cookies/consent/privacy; (3) hide known CMP containers; (4) the
// generic popup pass (overlayPass): dialogs, backdrops, drawers and popup bars shown without user action
// are dismissed through their close/decline control when there is one, else hidden; every removed root
// is marked data-rc-overlay so the page code excludes its subtree; body scroll is unlocked.
// The page-side functions below are passed to frame.evaluate and must stay self-contained.

const REJECT_SELECTORS = [
  '#onetrust-reject-all-handler', '.ot-pc-refuse-all-handler', 'button.onetrust-close-btn-handler[aria-label*="eject" i]',
  '#CybotCookiebotDialogBodyButtonDecline', '#CybotCookiebotDialogBodyLevelButtonLevelOptinDeclineAll',
  '#didomi-notice-disagree-button', '.didomi-continue-without-agreeing', 'button[data-testid="uc-deny-all-button"]',
  '#uc-btn-deny-banner', '.qc-cmp2-summary-buttons button[mode="secondary"]', 'button.sp_choice_type_REJECT_ALL',
  'button[title="Reject All" i]', 'button[title="Reject all" i]', '#truste-consent-required', '.osano-cm-denyAll',
  '.cky-btn-reject', '.cmplz-deny', '#cookiescript_reject', '.cc-deny', 'button[data-cookiefirst-action="reject"]',
  '[data-tid="banner-decline"]', '.fc-cta-do-not-consent', '#hs-eu-decline-button', '.iubenda-cs-reject-btn',
  'button[data-action="reject-all"]', 'button[data-gdpr="reject"]', '#tarteaucitronAllDenied2', '.cm-btn-decline',
  '#axeptio_btn_dismiss', '.termly-styles-decline', '#cmpwelcomebtnno', '.evidon-banner-declinebutton',
  '.truste-button2', '#sp-cc-rejectall-link', '#gdpr-reject-all',
];
const HOST_SELECTORS = [
  '#onetrust-consent-sdk', '#onetrust-banner-sdk', '#CybotCookiebotDialog', '#didomi-host', '#usercentrics-root',
  '#usercentrics-cmp-ui', '.qc-cmp2-container', '[id^="sp_message_container"]', '.fc-consent-root', '#cmpbox', '#cmpwrapper',
  '#truste-consent-track', '#consent_blackbar', '.truste_overlay', '.truste_box_overlay', '.osano-cm-window', '#cookiescript_injected',
  '.cky-consent-container', '.cky-overlay', '#hs-eu-cookie-confirmation', '#cookie-law-info-bar', '.cc-window', '.cc-banner', '#iubenda-cs-banner',
  '#axeptio_overlay', '.termly-styles-root', '#tarteaucitronRoot', '#cookie-banner', '#cookieBanner', '.cookie-banner', '.cookie-consent',
  '#cookie-consent', '.cookies-banner', '[aria-label="cookieconsent"]', '#gdpr-consent-tool-wrapper', '#transcend-consent-manager',
];
const FRAME_HINT = /consent|cmp|cookie|privacy|gdpr|ccpa|sp_message|sourcepoint|trustarc|quantcast|didomi|onetrust|usercentrics|cookiebot|truste/i;
// Injected at document start on the page whose load is filmed, so consent banners never appear in the
// load frames (removed again before consent is handled normally).
export const CMP_HIDE_CSS = `${HOST_SELECTORS.join(',')},.grecaptcha-badge,#intercom-container,.intercom-lightweight-app,#hubspot-messages-iframe-container,#drift-widget-container{display:none!important}`;

// page-side: find the first visible element among selectors; mark it for clicking.
function findKnown(sels) {
  for (const s of sels) {
    let el = null;
    try { el = document.querySelector(s); } catch { continue; }
    if (!el) continue;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (r.width < 2 || r.height < 2 || cs.visibility === 'hidden' || cs.display === 'none') continue;
    el.setAttribute('data-rc-consent', '1');
    return s;
  }
  return null;
}
// page-side: English text match inside a consent-looking container.
function findByText() {
  const RX = /^(reject( all)?( cookies)?|decline( all)?( cookies)?|deny( all)?|refuse( all)?|disagree|i do not accept|do not accept|necessary (cookies )?only|only (strictly )?necessary( cookies)?|use necessary cookies only|essential (cookies )?only|only essential( cookies)?|reject non-essential( cookies)?|reject optional( cookies)?|reject additional cookies|continue without (accepting|agreeing)|no,? thanks)$/i;
  const CTX = /cookie|consent|privacy|gdpr|tracking|personal data|advertis/i;
  const cands = document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]');
  for (const el of cands) {
    const t = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ');
    if (!t || t.length > 48 || !RX.test(t)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    let p = el.parentElement, ok = false;
    for (let d = 0; p && d < 8; d++, p = p.parentElement) { if (CTX.test((p.innerText || '').slice(0, 3000))) { ok = true; break; } }
    if (!ok) continue;
    el.setAttribute('data-rc-consent', '1');
    return t.slice(0, 40);
  }
  return null;
}
// page-side: hide known consent hosts (CMP containers), marking them as removed overlays.
function hideOverlays(hostSels) {
  const hidden = [];
  for (const s of hostSels) {
    let els = [];
    try { els = document.querySelectorAll(s); } catch { continue; }
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0) || getComputedStyle(el).display === 'none') continue;
      el.setAttribute('data-rc-overlay', 'cmp');
      el.style.setProperty('display', 'none', 'important');
      hidden.push({ kind: 'cmp', action: 'hidden', el: el.tagName.toLowerCase() + (el.id ? '#' + el.id : el.classList[0] ? '.' + el.classList[0] : ''), sel: s, text: (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 60), why: `known consent manager container (${s})`, box: [Math.round(r.left + scrollX), Math.round(r.top + scrollY), Math.round(r.width), Math.round(r.height)] });
    }
  }
  return hidden.slice(0, 12);
}

// page-side: popups and banners that appear on load without user action, beyond known CMPs: dialogs
// (role=dialog/alertdialog, aria-modal, <dialog open>), fixed full-viewport backdrops (translucent or
// blurred) and the modal on them, side drawers, and fixed bars/boxes whose text is about cookies,
// privacy, consent, region/country/language, newsletters, subscriptions, apps or offers and that hold
// a control. Each candidate root is marked data-rc-ovl-cand=<i>; a dismiss control found inside
// (close / x / no thanks / stay / decline; never accept) is marked data-rc-ovl-close=<i>.
function findOverlays() {
  const vw = innerWidth, vh = innerHeight;
  const desc = (el) => el.tagName.toLowerCase() + (el.id && el.id.length < 30 ? '#' + el.id : '') + (el.classList.length ? '.' + [...el.classList].slice(0, 2).map((c) => c.slice(0, 28)).join('.') : '');
  const visArea = (r) => Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
  const alphaOf = (c) => { if (!c || c === 'transparent') return 0; const m = c.match(/rgba?\(([^)]*)\)/); if (!m) return 1; const p = m[1].split(/[\s,/]+/).filter(Boolean); return p.length >= 4 ? (p[3].endsWith('%') ? parseFloat(p[3]) / 100 : +p[3]) : 1; };
  const CONSENT = /cookie|consent|gdpr|your privacy|privacy (policy|settings|choices|preferences|notice)|we use|tracking technolog|personal (data|information)/i;
  const POPUP = /region|country|location|language|currency|ship(ping)? to|deliver(y|ing)? to|choose your|select your|newsletter|subscribe|sign up|signup|join (our|the)|mailing list|notifications|get the app|download (the|our) app|open (in|the) app|special offer|discount|% off|welcome to/i;
  const CLOSE_LABEL = /close|dismiss|no,? thanks|not now|maybe later|skip|cancel|hide|schlie|fermer|cerrar/i;
  const CLOSE_TEXT = /^(×|✕|✖|╳|x|close|close dialog|dismiss|no,? thanks|not now|maybe later|skip|cancel|continue( shopping| browsing| to (the )?site)?|stay( here)?( on (this|the|the current|current) (site|page|store))?|keep (browsing|shopping)|i'?m good)$/i;
  const DECLINE = /^(reject( all)?( cookies)?|decline( all)?( cookies)?|deny( all)?|refuse( all)?|disagree|necessary (cookies )?only|only (strictly )?necessary( cookies)?|use necessary cookies only|essential (cookies )?only|only essential( cookies)?|reject non-essential( cookies)?|reject optional( cookies)?|continue without (accepting|agreeing))$/i;
  const STATE = /^(is-|has-|active|open|show|visible|in$|fade|animate)/i;
  // in-flow region / language bars: the wording names a place or language and asks to choose, see or switch
  const REGION_BAR = /\b(country|countries|region|location|language|locale)\b/i;
  const REGION_VERB = /\b(choose|select|change|switch|see|view|visit|shop|available|specific to|go to)\b/i;
  const selOf = (el) => {
    if (el.id && el.id.length < 40 && !/\d{4,}/.test(el.id)) return '#' + CSS.escape(el.id);
    const cls = [...el.classList].filter((c) => !STATE.test(c) && c.length < 40).slice(0, 3);
    const own = el.tagName.toLowerCase() + cls.map((c) => '.' + CSS.escape(c)).join('');
    if (cls.length) return own;
    const p = el.parentElement;
    return p && p !== document.body ? `${selOf(p)} > ${own}` : `body > ${own}`;
  };
  const h1 = document.querySelector('h1'), main = document.querySelector('main');
  let navEl = null;
  try { const n = window.__rc && window.__rc.findNav && window.__rc.findNav(); navEl = n ? n.el : null; } catch { navEl = null; }
  const controlsOf = (el) => [...el.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]')].filter((c) => { const r = c.getBoundingClientRect(); const s = getComputedStyle(c); return r.width >= 6 && r.height >= 6 && s.visibility !== 'hidden' && s.display !== 'none'; });
  // candidate / close marks of an earlier pass would collide with this pass's indices
  for (const o of document.querySelectorAll('[data-rc-ovl-cand]')) o.removeAttribute('data-rc-ovl-cand');
  for (const o of document.querySelectorAll('[data-rc-ovl-close]')) o.removeAttribute('data-rc-ovl-close');
  const roots = [];
  const add = (el, kind, why) => {
    if (roots.some((x) => x.el === el || x.el.contains(el))) return false;
    for (let i = roots.length - 1; i >= 0; i--) if (el.contains(roots[i].el)) roots.splice(i, 1);
    roots.push({ el, kind, why });
    return true;
  };
  for (const el of document.body.querySelectorAll('*')) {
    if (el.ownerSVGElement || /^(SCRIPT|STYLE|LINK|META|NOSCRIPT|TEMPLATE|svg)$/i.test(el.tagName)) continue;
    if (el.closest('[data-rc-overlay]')) continue;
    const role = el.getAttribute('role');
    const isDialog = (el.tagName === 'DIALOG' && el.open) || role === 'dialog' || role === 'alertdialog' || el.getAttribute('aria-modal') === 'true';
    const cs = getComputedStyle(el);
    const fixed = cs.position === 'fixed';
    // a bar across the very top of the document that is not the site's header: a region / country / language
    // chooser with a control (fixed or in flow; it appears after load and pushes the whole page down)
    if (!isDialog && cs.display !== 'none' && cs.visibility !== 'hidden' && cs.position !== 'absolute') {
      const rb = el.getBoundingClientRect();
      if (rb.top + scrollY <= 8 && rb.height >= 28 && rb.height <= 200 && rb.width >= vw * 0.9 && !(h1 && el.contains(h1)) && !(main && el.contains(main)) && !(navEl && (el === navEl || el.contains(navEl) || navEl.contains(el)))) {
        const tb = (el.innerText || '').trim().replace(/\s+/g, ' ');
        const lab = el.getAttribute('aria-label') || '';
        const worded = (tb.length >= 20 && tb.length <= 400 && REGION_BAR.test(tb) && REGION_VERB.test(tb)) || (REGION_BAR.test(lab) && tb.length <= 400);
        const hasCtl = worded && (!!el.querySelector('select, [role="combobox"], [role="listbox"]') || controlsOf(el).some((c) => CLOSE_LABEL.test((c.getAttribute('aria-label') || '') + ' ' + (c.getAttribute('title') || '')) || (!(c.innerText || '').trim() && c.getBoundingClientRect().width <= 64)));
        if (worded && hasCtl) {
          if (add(el, 'banner', `${fixed ? 'fixed' : 'in-flow'} bar at the top of the page with region/language wording (${((tb + ' ' + lab).match(REGION_BAR) || [''])[0].toLowerCase()}) and a control`)) roots[roots.length - 1].inflow = true;
          continue;
        }
      }
    }
    if (!isDialog && !fixed) continue;
    if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity <= 0.05) continue;
    const r = el.getBoundingClientRect();
    const area = visArea(r);
    if (area < vw * vh * (isDialog ? 0.01 : 0.004)) continue;
    if ((h1 && el.contains(h1)) || (main && el.contains(main)) || (navEl && (el === navEl || el.contains(navEl)))) continue;
    const txt = (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 3000);
    const ctl = controlsOf(el);
    const consenty = CONSENT.test(txt) && txt.length < 2500;
    const popupy = POPUP.test(txt);
    const navLike = r.top <= 4 && r.height < 200 && !consenty && !isDialog;
    // full-viewport translucent/blurred layer: a backdrop (little text) or a modal container on one
    const cover = area >= vw * vh * 0.85;
    // a scrim dims through its background alpha or through the element's opacity (an opaque fill at opacity
    // 0.4 above the page: stacked above the content, z-index >= 1)
    const effA = alphaOf(cs.backgroundColor) * (+cs.opacity || 0);
    const dims = +cs.opacity < 0.97 && effA >= 0.08 && effA <= 0.97 && (parseInt(cs.zIndex, 10) || 0) >= 1;
    const translucent = (alphaOf(cs.backgroundColor) >= 0.08 && alphaOf(cs.backgroundColor) <= 0.97) || (cs.backdropFilter && cs.backdropFilter !== 'none') || dims;
    if (fixed && cover && translucent) { add(el, txt.length < 60 ? 'backdrop' : 'dialog', txt.length < 60 ? 'fixed translucent layer over the viewport' : 'modal on a fixed translucent layer'); continue; }
    // a fixed consent frame (a cookie banner served in an iframe: its controls are not in this document)
    if (fixed && el.tagName === 'IFRAME' && /cookie|consent|privacy|gdpr|ccpa|\bcmp\b/i.test([el.title, el.name, el.id, el.className, el.getAttribute('src') || '', el.getAttribute('aria-label') || ''].join(' '))) { add(el, 'consent', 'fixed consent frame (its title / source names cookies, consent or privacy)'); continue; }
    if (fixed && cover && ctl.length && txt.length < 1500 && (+cs.zIndex >= 10 || consenty || popupy)) {
      const top = document.elementFromPoint(vw / 2, vh / 2);
      if (top && (el === top || el.contains(top))) { add(el, consenty ? 'consent' : 'dialog', 'opaque full-viewport layer on top of the page with a control'); continue; }
    }
    if (isDialog) {
      if (ctl.length >= 8 && !consenty && !popupy) continue; // an open menu, not a popup
      const cx = (Math.max(r.left, 0) + Math.min(r.right, vw)) / 2, cy = (Math.max(r.top, 0) + Math.min(r.bottom, vh)) / 2;
      const top = document.elementFromPoint(cx, cy);
      if (top && !(el === top || el.contains(top) || top.contains(el))) continue; // covered: not showing
      add(el, consenty ? 'consent' : 'dialog', `${el.tagName === 'DIALOG' ? '<dialog open>' : role ? `role=${role}` : 'aria-modal'} shown on load`);
      continue;
    }
    if (navLike) continue;
    const drawer = r.height >= vh * 0.8 && r.width >= vw * 0.18 && r.width <= vw * 0.6 && (r.left <= 2 || r.right >= vw - 2);
    const hasClose = ctl.some((c) => CLOSE_LABEL.test((c.getAttribute('aria-label') || '') + ' ' + (c.getAttribute('title') || '')) || CLOSE_TEXT.test((c.innerText || c.value || '').trim()));
    const input = !!el.querySelector('input[type="email"], input[type="text"], input:not([type])');
    if (!ctl.length || txt.length > 1500) continue;
    if (consenty) { add(el, 'consent', 'fixed bar/box with cookie or privacy wording and a control'); continue; }
    if (popupy && (hasClose || input || (ctl.length >= 2 && txt.length >= 40))) { add(el, drawer ? 'drawer' : 'banner', `fixed ${drawer ? 'drawer' : 'bar/box'} with popup wording (${(txt.match(POPUP) || [''])[0].toLowerCase()})${hasClose ? ' and a dismiss control' : input ? ' and a form field' : ''}`); continue; }
    if (drawer && hasClose && isDialog) add(el, 'drawer', 'side drawer with a dismiss control');
  }
  return roots.map((x, i) => {
    const el = x.el;
    el.setAttribute('data-rc-ovl-cand', String(i));
    const txt = (el.innerText || '').trim().replace(/\s+/g, ' ');
    const consenty = x.kind === 'consent';
    let close = null;
    for (const c of controlsOf(el)) {
      const t = (c.innerText || c.value || '').trim().replace(/\s+/g, ' ');
      const lab = (c.getAttribute('aria-label') || '') + ' ' + (c.getAttribute('title') || '');
      const href = c.tagName === 'A' ? (c.getAttribute('href') || '') : '';
      const navigates = href && !/^(#|javascript:)/i.test(href);
      if (navigates) continue;
      const iconOnly = !t && c.querySelector('svg, img, i, span') && c.getBoundingClientRect().width <= 64;
      // an in-flow region bar is closed only through its labelled or icon close control: its "continue" or
      // "go" button switches the site to another region
      const ok = consenty ? (DECLINE.test(t) || /close|dismiss/i.test(lab) || (iconOnly && /close|dismiss/i.test(lab)))
        : x.inflow ? (!t && /close|dismiss/i.test(lab)) || /^(×|✕|✖|╳)$/.test(t) || (iconOnly && /close|dismiss|×|✕/i.test(lab + (c.textContent || '')))
        : (CLOSE_TEXT.test(t) || CLOSE_LABEL.test(lab) || (iconOnly && /close|dismiss|×|✕/i.test(lab + (c.textContent || ''))));
      if (ok) { close = c; break; }
    }
    if (!close && !consenty) {
      // an icon-only button in the top-right corner of the box
      const rr = el.getBoundingClientRect();
      close = controlsOf(el).find((c) => { const cr = c.getBoundingClientRect(); return !(c.innerText || '').trim() && cr.width <= 64 && cr.height <= 64 && cr.right >= rr.right - 80 && cr.top <= rr.top + 80 && !(c.tagName === 'A' && c.getAttribute('href') && !/^(#|javascript:)/i.test(c.getAttribute('href'))); }) || null;
    }
    if (close) close.setAttribute('data-rc-ovl-close', String(i));
    const r = el.getBoundingClientRect();
    return { i, kind: x.kind, why: x.why, el: desc(el), sel: selOf(el), text: txt.slice(0, 60), box: [Math.round(r.left + scrollX), Math.round(r.top + scrollY), Math.round(r.width), Math.round(r.height)], close: !!close, inflow: x.inflow || undefined };
  });
}
function overlayShown(i) {
  const el = document.querySelector(`[data-rc-ovl-cand="${i}"]`);
  if (!el || !el.isConnected) return false;
  const cs = getComputedStyle(el), r = el.getBoundingClientRect();
  return cs.display !== 'none' && cs.visibility !== 'hidden' && +cs.opacity > 0.05 && r.width * r.height > 0;
}
function markOverlay([i, kind, hide]) {
  const el = document.querySelector(`[data-rc-ovl-cand="${i}"]`);
  if (!el) return false;
  el.setAttribute('data-rc-overlay', kind);
  if (hide) el.style.setProperty('display', 'none', 'important');
  return true;
}
function unlockScroll() {
  let unlocked = false;
  for (const el of [document.documentElement, document.body]) {
    if (el.classList.contains('has-scroll-smooth') || el.classList.contains('lenis')) continue;
    const cs = getComputedStyle(el);
    if (cs.overflow === 'hidden' || cs.overflowY === 'hidden') { el.style.setProperty('overflow', 'visible', 'important'); el.style.setProperty('overflow-y', 'visible', 'important'); unlocked = true; }
    if (cs.position === 'fixed' && el === document.body) { el.style.setProperty('position', 'static', 'important'); unlocked = true; }
  }
  return unlocked;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Generic popup pass (beyond CMPs): finds dialogs, backdrops, drawers and popup bars shown without user
 * action, clicks their dismiss control when there is one (never "accept"), hides what is still shown,
 * and marks every root data-rc-overlay=<kind> so the page code leaves its subtree out of load motion,
 * sticky, roles, palette and components. Returns [{kind, action, el, sel, text, why, box}].
 */
export async function overlayPass(page, { allowClick = true } = {}) {
  const out = [];
  // a second round finds what the first one uncovered: the scrim left behind by a dismissed dialog, the next
  // popup in a sequence
  for (let round = 0; round < 2; round++) {
  let cands = [];
  try { cands = await page.evaluate(findOverlays); } catch { break; }
  if (!cands.length) break;
  for (const c of cands) {
    let action = 'hidden';
    await page.evaluate(markOverlay, [c.i, c.kind, false]).catch(() => {});
    if (allowClick && c.close) {
      try {
        await page.locator(`[data-rc-ovl-close="${c.i}"]`).first().click({ timeout: 2500 });
        await sleep(600);
        const still = await page.evaluate(overlayShown, c.i).catch(() => false);
        if (!still) action = 'dismissed';
      } catch { /* not clickable: hide */ }
    }
    if (action === 'hidden') await page.evaluate(markOverlay, [c.i, c.kind, true]).catch(() => {});
    // an in-flow bar is also hidden by a style rule, so a re-render of the page's header area cannot bring it back
    if (c.inflow && c.sel) await page.evaluate((s) => { try { const st = document.createElement('style'); st.setAttribute('data-rc-inflow', '1'); st.textContent = `${s}{display:none!important}`; (document.head || document.documentElement).appendChild(st); } catch {} }, c.sel).catch(() => {});
    out.push({ kind: c.kind, action, el: c.el, sel: c.sel, text: c.text, why: c.why, box: c.box, inflow: c.inflow });
  }
  }
  if (out.length) await page.evaluate(unlockScroll).catch(() => {});
  return out;
}

async function tryFrame(frame, mode) {
  try {
    const hit = mode === 'known' ? await frame.evaluate(findKnown, REJECT_SELECTORS) : await frame.evaluate(findByText);
    if (!hit) return null;
    await frame.locator('[data-rc-consent="1"]').first().click({ timeout: 3000 });
    return hit;
  } catch { return null; }
}

// Consent first (reject in a known CMP or an English reject button), then the generic popup pass.
// Returns { action: 'clicked'|'dismissed'|'hidden'|'none', detail, overlays[] } where overlays lists
// every removed popup/banner ({kind, action, el, sel, text, why, box}).
// `reject` (default: allowClick) allows the consent reject click even when popup dismiss clicks are off: a
// consent banner that appears seconds after load (often in its own frame) is declined by the later passes.
export async function handleConsent(page, { allowClick = true, reject = allowClick } = {}) {
  const frames = page.frames().filter((f) => f === page.mainFrame() || FRAME_HINT.test(f.url()) || FRAME_HINT.test(f.name()));
  let clicked = null;
  if (reject) {
    for (const mode of ['known', 'text']) {
      for (const f of frames) {
        const hit = await tryFrame(f, mode);
        if (hit) {
          await sleep(900);
          await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
          const host = f === page.mainFrame() ? 'page' : (() => { try { return new URL(f.url()).host; } catch { return 'iframe'; } })();
          clicked = `${mode === 'known' ? 'selector' : 'text'} "${hit}" in ${host}`;
          break;
        }
      }
      if (clicked) break;
    }
  }
  const cmp = await page.evaluate(hideOverlays, HOST_SELECTORS).catch(() => []);
  const generic = await overlayPass(page, { allowClick });
  const overlays = [...(cmp || []), ...generic];
  if (overlays.length) await page.evaluate(unlockScroll).catch(() => {});
  const desc = overlays.map((o) => `${o.action} ${o.kind} ${o.el}`).join(', ');
  if (clicked) return { action: 'clicked', detail: clicked + (desc ? `; also ${desc}` : ''), overlays };
  if (overlays.some((o) => o.action === 'dismissed')) return { action: 'dismissed', detail: desc, overlays };
  if (overlays.length) return { action: 'hidden', detail: desc, overlays };
  return { action: 'none', overlays };
}

/** CSS that hides the given overlay selectors from the first paint (load frames of the warm run). */
export function overlayHideCss(sels) {
  const list = [...new Set((sels || []).filter((s) => s && s.length < 200))];
  return list.length ? `${list.join(',')}{display:none!important}` : '';
}
