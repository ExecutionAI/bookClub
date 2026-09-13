import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const url = args[0];
if (!url) {
  console.error('Usage: node screenshot.mjs <url> [label] [--width=N] [--height=N] [--full] [--delay=MS]');
  process.exit(1);
}

let label = null;
let width = 1440;
let height = 900;
let fullPage = false;
let delay = 0;
let ls = null; // --ls="key=val;key2=val2" → injected into localStorage before load

for (const a of args.slice(1)) {
  if (a.startsWith('--width='))  width    = parseInt(a.split('=')[1]);
  else if (a.startsWith('--height=')) height = parseInt(a.split('=')[1]);
  else if (a.startsWith('--delay='))  delay  = parseInt(a.split('=')[1]);
  else if (a.startsWith('--ls='))     ls     = a.slice(5);
  else if (a === '--ls-env')          ls     = process.env.SCREENSHOT_LS || null;
  else if (a === '--full')        fullPage = true;
  else if (!a.startsWith('--'))   label    = a;
}

const screenshotDir = path.join(__dirname, 'temporary screenshots');
if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });

const existing = fs.readdirSync(screenshotDir).filter(f => f.match(/^screenshot-\d/));
const nums = existing.map(f => parseInt(f.match(/^screenshot-(\d+)/)?.[1] || '0')).filter(n => !isNaN(n));
const next = nums.length ? Math.max(...nums) + 1 : 1;
const filename = label ? `screenshot-${next}-${label}.png` : `screenshot-${next}.png`;
const outputPath = path.join(screenshotDir, filename);

// Resolve Chrome at runtime — don't hardcode version paths
let execPath;
try {
  const { executablePath } = await import('puppeteer');
  execPath = executablePath();
} catch { execPath = undefined; }

const browser = await puppeteer.launch({
  headless: true,
  executablePath: execPath,
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
});

const page = await browser.newPage();
await page.setViewport({ width, height });
if (ls) {
  const pairs = ls.split(';').map(p => p.split(/=(.*)/s)).filter(p => p[0]);
  await page.evaluateOnNewDocument((entries) => {
    for (const [k, v] of entries) localStorage.setItem(k, v);
  }, pairs);
}
try {
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
} catch (e) {
  console.warn(`(navigation timeout — capturing current state)`);
}
if (delay) await new Promise(r => setTimeout(r, delay));
await page.screenshot({ path: outputPath, fullPage });
await browser.close();

console.log(`Screenshot saved: ${outputPath}`);
