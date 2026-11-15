// Smoke check: launch installed Chrome (fallback Edge) via playwright-core, load example.com.
import { chromium } from 'playwright-core';

for (const channel of ['chrome', 'msedge']) {
  let browser;
  try {
    browser = await chromium.launch({ channel, headless: true });
    const page = await browser.newPage();
    await page.goto('https://example.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
    console.log(JSON.stringify({ ok: true, channel, title: await page.title(), version: browser.version() }));
    await browser.close();
    process.exit(0);
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error(`check-chrome: ${channel} failed: ${err.message.split('\n')[0]}`);
  }
}
process.exit(1);
