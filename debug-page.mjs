// Dev helper: open a page headless, print console messages + page errors.
// node debug-page.mjs <url> [--ls=key=val;key2=val2] [--delay=MS]
import puppeteer from 'puppeteer';

const url = process.argv[2];
let ls = null, delay = 1500;
for (const a of process.argv.slice(3)) {
  if (a.startsWith('--ls=')) ls = a.slice(5);
  if (a.startsWith('--delay=')) delay = parseInt(a.split('=')[1]);
}

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
page.on('console', m => console.log(`[console.${m.type()}]`, m.text()));
page.on('pageerror', e => console.log('[pageerror]', e.message));
page.on('requestfailed', r => console.log('[reqfail]', r.url().slice(0, 120), r.failure()?.errorText));
if (ls) {
  const pairs = ls.split(';').map(p => p.split(/=(.*)/s)).filter(p => p[0]);
  await page.evaluateOnNewDocument((entries) => { for (const [k, v] of entries) localStorage.setItem(k, v); }, pairs);
}
await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
await new Promise(r => setTimeout(r, delay));
console.log('[url]', page.url());
await browser.close();
