// Shared browser settings for capture.mjs and inspect.mjs, so a page that capture.mjs can open is
// opened the same way by the builder's measuring tools (same Chrome flags, user agent, locale,
// timezone, colour scheme, motion preference, service-worker policy and headers), plus the bot-wall
// check both use.
import { chromium } from 'playwright-core';

export const LAUNCH_ARGS = ['--hide-scrollbars', '--disable-blink-features=AutomationControlled', '--autoplay-policy=no-user-gesture-required'];

/** Installed Chrome (never a downloaded browser), headless, with the capture flags. */
export function launchChrome(extraArgs = []) {
  return chromium.launch({ channel: 'chrome', headless: true, args: [...LAUNCH_ARGS, ...extraArgs] });
}

/** Desktop Chrome user agent with the installed Chrome's major version (no "HeadlessChrome"). */
export function userAgentFor(browser) {
  const major = (String(browser.version()).match(/^(\d+)/) || [0, '140'])[1];
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

/** Context options used for every capture page. */
export function contextOptions(browser, { width = 1440, height = 900 } = {}) {
  return {
    viewport: { width, height }, deviceScaleFactor: 1, userAgent: userAgentFor(browser), locale: 'en-US', timezoneId: 'America/New_York',
    colorScheme: 'light', reducedMotion: 'no-preference', serviceWorkers: 'block', extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
  };
}

export function newCaptureContext(browser, size) {
  return browser.newContext(contextOptions(browser, size));
}

const CHALLENGE = /just a moment|checking your browser|verify you are (a )?human|are you a robot|access denied|attention required|pardon our interruption|request unsuccessful|captcha|unusual traffic|enable javascript and cookies|ddos protection|press (and|&) hold/i;

/**
 * Bot wall / interstitial suspicion: HTTP 401/403/429/503, challenge text on a short page, or almost
 * no text. Returns {suspected, reasons[]}. Never throws.
 */
export async function blockedCheck(page, status) {
  let info = { title: '', text: '', len: 0 };
  try {
    info = await Promise.race([
      page.evaluate(() => { const t = (document.body && document.body.innerText) || ''; return { title: document.title || '', text: t.slice(0, 2000), len: t.length }; }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 10000)),
    ]);
  } catch { /* keep the empty default */ }
  const reasons = [];
  if ([401, 403, 429, 503].includes(status)) reasons.push(`HTTP ${status}`);
  if (info.len < 200) reasons.push(`very short page text (${info.len} chars)`);
  const m = (info.title + ' ' + info.text.slice(0, 1500)).match(CHALLENGE);
  if (m && (info.len < 3000 || status >= 400)) reasons.push(`challenge text "${m[0]}"`);
  const suspected = reasons.some((r) => /^HTTP|challenge/.test(r)) || info.len < 60;
  return { suspected, reasons };
}
