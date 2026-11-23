#!/usr/bin/env node
/**
 * Screenshot a page in headless Chromium at phone size.
 *
 *   node scripts/shot.mjs --url http://localhost:5173/ --out /tmp/x.png
 *     [--w 390] [--h 844] [--dpr 1] [--wait 1200] [--full]
 *     [--click "css selector"]...   click these (in order) after load, 250 ms apart
 *     [--eval "js expression"]      run in the page after the clicks
 *     [--wait2 600]                 extra wait after clicks/eval
 *     [--touch]                     emulate a touch device (default: on)
 *
 * Prints console errors and page errors to stderr; exits 1 if the page threw.
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const args = process.argv.slice(2);
const opt = { w: 390, h: 844, dpr: 1, wait: 1200, wait2: 600, click: [], full: false };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--full') opt.full = true;
  else if (a === '--click') opt.click.push(args[++i]);
  else if (a.startsWith('--')) opt[a.slice(2)] = args[++i];
}
if (!opt.url || !opt.out) {
  console.error('usage: node scripts/shot.mjs --url <url> --out <file.png> [options]');
  process.exit(2);
}

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const context = await browser.newContext({
  viewport: { width: Number(opt.w), height: Number(opt.h) },
  deviceScaleFactor: Number(opt.dpr),
  hasTouch: true,
  isMobile: true,
});
const page = await context.newPage();
let threw = false;
page.on('console', (m) => {
  if (m.type() === 'error') console.error('[console.error]', m.text());
});
page.on('pageerror', (e) => {
  threw = true;
  console.error('[pageerror]', e.message);
});

await page.goto(opt.url, { waitUntil: 'load' });
await page.waitForTimeout(Number(opt.wait));
for (const sel of opt.click) {
  await page.locator(sel).first().click({ timeout: 5000 });
  await page.waitForTimeout(250);
}
if (opt.eval) await page.evaluate(opt.eval);
if (opt.click.length || opt.eval) await page.waitForTimeout(Number(opt.wait2));
await page.screenshot({ path: opt.out, fullPage: opt.full });
await browser.close();
console.log(`saved ${opt.out}`);
process.exit(threw ? 1 : 0);
