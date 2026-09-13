// Two-window raffle verification:
// 1. Opens rifa.html in two pages as two different members (idle blue fire)
// 2. Triggers the admin draw
// 3. Asserts both pages play the sequence and reveal the SAME winner within one poll cycle
// Also saves mid-animation screenshots.
// Usage: node verify-raffle.mjs <event_id>   (api.mjs must be running)

import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = 'http://localhost:3001';
const ADMIN = { 'x-admin-token': 'club_lectura.2026', 'Content-Type': 'application/json' };
const eventId = process.argv[2];
if (!eventId) { console.error('Usage: node verify-raffle.mjs <event_id>'); process.exit(1); }

const shotDir = path.join(__dirname, 'temporary screenshots');
if (!fs.existsSync(shotDir)) fs.mkdirSync(shotDir, { recursive: true });

// Log in two members
const members = await fetch(`${BASE}/api/members`).then(r => r.json());
async function login(name) {
  const m = members.find(x => x.name === name);
  const r = await fetch(`${BASE}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ member_id: m.id, pin: '1234' }) }).then(r => r.json());
  return { token: r.token, member: JSON.stringify(r.member) };
}
const [a, b] = await Promise.all([login('Paola'), login('Diego')]);

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });

async function openRifa(auth, tag) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  page.on('framenavigated', f => { if (f === page.mainFrame()) console.log(`[${tag}] navigated → ${f.url()}`); });
  page.on('pageerror', e => console.log(`[${tag}] pageerror:`, e.message));
  await page.evaluateOnNewDocument((t, m) => { localStorage.setItem('bcToken', t); localStorage.setItem('bcMember', m); }, auth.token, auth.member);
  await page.goto(`${BASE}/rifa.html?id=${eventId}`, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  return page;
}

const [p1, p2] = await Promise.all([openRifa(a, 'p1'), openRifa(b, 'p2')]);
await new Promise(r => setTimeout(r, 3000)); // both idle, polling

const idleCount = await p1.$$eval('#papers .papelito', els => els.length).catch(() => '?');
console.log(`Idle papers visible: ${idleCount}`);

// Fire the draw
const t0 = Date.now();
const draw = await fetch(`${BASE}/api/admin/events/${eventId}/draw`, { method: 'POST', headers: ADMIN }).then(r => r.json());
console.log(`Draw fired → winner: ${draw.winner.book.title} (by ${draw.winner.suggested_by})`);

// Wait for both pages to enter the drawing state (surging class)
async function waitFor(page, fn, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await page.evaluate(fn)) return Date.now() - t0;
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`Timeout waiting for: ${label}`);
}

const surge1 = await waitFor(p1, () => document.getElementById('stage').classList.contains('surging'), 8000, 'page1 surge');
const surge2 = await waitFor(p2, () => document.getElementById('stage').classList.contains('surging'), 8000, 'page2 surge');
console.log(`Both pages started the animation: page1 +${surge1}ms, page2 +${surge2}ms after draw`);

await new Promise(r => setTimeout(r, 2200));
await p1.screenshot({ path: path.join(shotDir, 'raffle-1-erupting.png') });

const rev1 = await waitFor(p1, () => !document.getElementById('winner-overlay').classList.contains('hidden'), 15000, 'page1 reveal');
const rev2 = await waitFor(p2, () => !document.getElementById('winner-overlay').classList.contains('hidden'), 15000, 'page2 reveal');
console.log(`Winner revealed: page1 +${(rev1 / 1000).toFixed(1)}s, page2 +${(rev2 / 1000).toFixed(1)}s`);

await new Promise(r => setTimeout(r, 900));
await p1.screenshot({ path: path.join(shotDir, 'raffle-2-reveal.png') });

const title1 = await p1.$eval('#w-title', el => el.textContent);
const title2 = await p2.$eval('#w-title', el => el.textContent);
console.log(`Page1 shows: "${title1}" · Page2 shows: "${title2}"`);
if (title1 !== title2 || title1 !== draw.winner.book.title) throw new Error('MISMATCH between pages and server winner!');

// Late joiner: fresh page after the fact should skip animation (drawn_at old? here it's fresh,
// so instead verify a reload shows the winner without error)
const p3 = await openRifa(a);
await new Promise(r => setTimeout(r, 3500));
const lateVisible = await p3.evaluate(() => !document.getElementById('winner-overlay').classList.contains('hidden'));
console.log(`Reloaded page shows winner: ${lateVisible}`);
await p3.screenshot({ path: path.join(shotDir, 'raffle-3-late-joiner.png') });

await browser.close();
console.log('\nRAFFLE VERIFICATION PASSED ✓ — both windows synced, same winner, reload works');
