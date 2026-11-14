/**
 * Browser smoke test (audit F-11, F-23, F-39, F-46). Drives a real browser against a running server that serves the built app
 * and has the demo workspace seeded. It checks, on every main screen, at desktop and at phone width:
 *   - the page loads without a script error or a failed request,
 *   - it shows real content (not an error panel or an endless "Loading"),
 *   - nothing makes the page scroll sideways.
 * It is a smoke test: it does not replace tests of behaviour (the backend suite does that) or a human looking at the screens.
 *
 *   BASE_URL=http://localhost:8123 BROWSER=msedge node smoke.mjs        (CI uses BROWSER=chrome)
 */
import process from 'node:process';
import console from 'node:console';
import { chromium } from 'playwright-core';

const BASE = process.env.BASE_URL ?? 'http://localhost:8123';
const CHANNEL = process.env.BROWSER ?? 'chrome';
const DEMO = { workspace: process.env.DEMO_WORKSPACE ?? 'casa-verde-demo', email: process.env.DEMO_EMAIL ?? 'demo@erpatio.app', password: process.env.DEMO_PASSWORD ?? 'ERPatio-Demo-2026' };

// path, a heading or text the screen must show
const SCREENS = [
  ['/', 'Overview'], ['/dashboards', 'Dashboards'], ['/accounts', 'Chart of accounts'], ['/journal', 'Journal'], ['/periods', 'Fiscal periods'],
  ['/trial-balance', 'Trial balance'], ['/reports/income-statement', 'Income statement'], ['/reports/balance-sheet', 'Balance sheet'], ['/reports/vat', 'Tax report'],
  ['/reports/profitability', 'Profitability'], ['/customers', 'Customers'], ['/invoices', 'Invoices'], ['/credit-notes', 'Credit notes'], ['/reports/aging/receivables', 'Receivables aging'],
  ['/suppliers', 'Suppliers'], ['/bills', 'Bills'], ['/debit-notes', 'Debit notes'], ['/reports/aging/payables', 'Payables aging'], ['/bank', 'Bank reconciliation'],
  ['/items', 'Items'], ['/purchase-orders', 'Purchase orders'], ['/sales-orders', 'Sales orders'], ['/reports/stock-valuation', 'Stock valuation'],
  ['/boms', 'Bills of materials'], ['/work-orders', 'Work orders'], ['/reports/wip', 'Work in progress'],
  ['/employees', 'Employees'], ['/attendance', 'Attendance'], ['/payroll', 'Payroll'], ['/payroll/rules', 'Rates and brackets'],
  ['/data', 'Data'], ['/audit', 'Audit'],
];
const VIEWPORTS = [['desktop', { width: 1280, height: 800 }], ['phone', { width: 390, height: 780 }]];

const failures = [];
const fail = (msg) => { failures.push(msg); console.log(`  FAIL ${msg}`); };

const browser = await chromium.launch({ channel: CHANNEL, headless: true });
try {
  for (const [vpName, viewport] of VIEWPORTS) {
    console.log(`\n== ${vpName} ${viewport.width}px`);
    const ctx = await browser.newContext({ viewport, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(`script error: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 160)}`); });
    page.on('response', (r) => { if (r.url().includes('/api/') && r.status() >= 500) errors.push(`server error ${r.status()} ${new URL(r.url()).pathname}`); });

    await page.goto(`${BASE}/login`);
    await page.fill('#ws', DEMO.workspace);
    await page.fill('#em', DEMO.email);
    await page.fill('#pw', DEMO.password);
    await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20_000 }), page.click('button[type=submit]')]);

    for (const [path, expected] of SCREENS) {
      errors.length = 0;
      // The phone layout hides the menu, so go by address, which is what a bookmark would do.
      await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' }).catch(() => undefined);
      try { await page.waitForSelector('main h1, main h2', { timeout: 15_000 }); } catch { fail(`${vpName} ${path}: no heading appeared`); continue; }
      await page.waitForFunction(() => !document.querySelector('main .loading'), null, { timeout: 15_000 }).catch(() => fail(`${vpName} ${path}: still loading after 15 s`));
      const text = await page.locator('main').innerText();
      if (!text.toLowerCase().includes(expected.toLowerCase())) fail(`${vpName} ${path}: did not show "${expected}"`);
      if (/could not reach the server|something went wrong|nothing at this address/i.test(text)) fail(`${vpName} ${path}: shows an error: ${text.slice(0, 120).replace(/\n/g, ' ')}`);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (overflow > 1) fail(`${vpName} ${path}: the page scrolls sideways by ${overflow}px`);
      for (const e of errors) fail(`${vpName} ${path}: ${e}`);
      if (!failures.some((f) => f.startsWith(`${vpName} ${path}`))) console.log(`  ok   ${path}`);
    }
    await ctx.close();
  }

  // One real round trip: the demo trial balance must say it balances.
  const ctx = await browser.newContext({ viewport: VIEWPORTS[0][1] });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`);
  await page.fill('#ws', DEMO.workspace); await page.fill('#em', DEMO.email); await page.fill('#pw', DEMO.password);
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login')), page.click('button[type=submit]')]);
  await page.goto(`${BASE}/trial-balance`, { waitUntil: 'networkidle' });
  const tb = await page.locator('main').innerText();
  if (!/balanced|in balance|agree/i.test(tb)) fail('trial balance does not say it balances');
  await page.goto(`${BASE}/reports/stock-valuation`, { waitUntil: 'networkidle' });
  if (!/agrees with the inventory account/i.test(await page.locator('main').innerText())) fail('stock valuation does not agree with the ledger');
  await page.goto(`${BASE}/payroll`, { waitUntil: 'networkidle' });
  if (!/agree with the ledger/i.test(await page.locator('main').innerText())) fail('payroll liabilities do not agree with the ledger');
  await ctx.close();
} finally {
  await browser.close();
}

console.log(`\n${failures.length === 0 ? 'Smoke test passed.' : `${failures.length} problem(s).`}`);
process.exit(failures.length === 0 ? 0 : 1);
