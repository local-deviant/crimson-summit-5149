// Token Radar v3 — screenshots from the running dashboard.
// Serves out/ on 127.0.0.1, opens the page three times (board, a detail view,
// a filtered view) and writes JPEGs into screenshots/ (the program copies
// them into /output on its next run).
//
//   node scripts/shots.mjs [--out <dir>] [--shots <dir>]
import { createRequire } from 'node:module';
// playwright-core lives in the shared harness dir, not in this entry's tree.
const { chromium } = createRequire(import.meta.url)('/home/hatch/workspace/makefun/pw/node_modules/playwright-core');
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = path.join(here, '..');
const OUT_DIR = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : path.join(root, 'out');
const SHOTS_DIR = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : path.join(root, 'screenshots');
const CHROME = '/home/hatch/workspace/makefun/chrome-linux64/chrome';
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.md': 'text/markdown' };

const dataText = fs.readFileSync(path.join(OUT_DIR, 'data.js'), 'utf8');
const radar = JSON.parse(dataText.replace(/^window\.RADAR=/, '').replace(/;\s*$/, ''));
const top1 = radar.rows[0].slug;

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0].split('#')[0]);
  const f = path.join(OUT_DIR, url === '/' ? 'dashboard/index.html' : url);
  fs.readFile(f, (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
    res.end(data);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1280,900'] });

async function shot(name, url, scrollTo) {
  // A fresh page per shot: navigating only changes the hash, which does not
  // reload the page, so a reused page would keep the previous shot's state.
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(`http://127.0.0.1:${port}${url}`, { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(400);
  if (scrollTo) {
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) el.scrollIntoView({ block: 'start' });
      window.scrollBy(0, -8);
    }, scrollTo);
    await page.waitForTimeout(200);
  }
  const out = path.join(SHOTS_DIR, name);
  await page.screenshot({ path: out, type: 'jpeg', quality: 82 });
  const size = fs.statSync(out).size;
  console.log(`${name}: ${size} bytes${size > 524_288 ? ' — OVER 512 KiB' : ''}`);
  console.log('  errors:', errors.length ? errors.join(' | ') : 'none');
  await page.close();
  return size;
}

fs.mkdirSync(SHOTS_DIR, { recursive: true });
await shot('1-board.jpg', '/dashboard/index.html');
await shot('2-detail.jpg', `/dashboard/index.html#detail=${top1}`, '#detail');
await shot('3-filtered.jpg', '/dashboard/index.html#tab=FARM');
await browser.close();
server.close();
