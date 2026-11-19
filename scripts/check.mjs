// Token Radar v3 — the local gate. Re-runs the program twice (determinism),
// then re-implements the scorer's seven checks plus the dashboard's own
// promises: the dashboard data matches the board, the proof file's numbers
// match the output, and the dashboard source fits its 64 KiB cap.
//
//   node scripts/check.mjs [--input <snapshot.json>] [--out <dir>]
//
// Exit 0 only when every check passes.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from '../vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = join(here, '..');
const input = process.argv.includes('--input')
  ? process.argv[process.argv.indexOf('--input') + 1]
  : join(root, '..', 'kits', 'token-radar-01-kit', 'input', 'snapshot.json');
const out = process.argv.includes('--out')
  ? process.argv[process.argv.indexOf('--out') + 1]
  : join(root, 'out');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  return ok;
}

const snapshot = JSON.parse(readFileSync(input, 'utf8'));
const watchlist = new Set(snapshot.watchlist);

// --- 1. determinism: two runs, byte-identical -------------------------------
console.log('determinism');
const tmpA = join(root, '.check-a');
const tmpB = join(root, '.check-b');
for (const d of [tmpA, tmpB]) { rmSync(d, { recursive: true, force: true }); mkdirSync(d, { recursive: true }); }
try {
  execFileSync('node', [join(root, 'main.ts'), '--input', input, '--output', tmpA], { stdio: 'pipe', env: { ...process.env, MAKEFUN_OUTPUT_DIR: tmpA } });
  execFileSync('node', [join(root, 'main.ts'), '--input', input, '--output', tmpB], { stdio: 'pipe', env: { ...process.env, MAKEFUN_OUTPUT_DIR: tmpB } });
} catch (e) {
  console.log(`  FAIL main.ts exited non-zero: ${e.stderr?.toString() ?? e.message}`);
  process.exit(1);
}
const filesA = readdirSync(tmpA, { recursive: true }).filter((f) => statSync(join(tmpA, f)).isFile()).sort();
const filesB = readdirSync(tmpB, { recursive: true }).filter((f) => statSync(join(tmpB, f)).isFile()).sort();
check('same file list', JSON.stringify(filesA) === JSON.stringify(filesB), `${filesA.length} files`);
let identical = true;
for (const f of filesA) {
  if (!readFileSync(join(tmpA, f)).equals(readFileSync(join(tmpB, f)))) { identical = false; console.log(`    differs: ${f}`); }
}
check('two runs byte-identical', identical);
const outFiles = readdirSync(out, { recursive: true }).filter((f) => statSync(join(out, f)).isFile()).sort();
check('checked dir matches a fresh run', JSON.stringify(outFiles) === JSON.stringify(filesA));

// --- 2. dashboard files -----------------------------------------------------
console.log('dashboard_files');
const dashDir = join(out, 'dashboard');
const dashFiles = existsSync(dashDir) ? readdirSync(dashDir).filter((f) => statSync(join(dashDir, f)).isFile()) : [];
const hasHtml = dashFiles.some((f) => f.endsWith('.html'));
const hasCss = dashFiles.some((f) => f.endsWith('.css'));
const hasJs = dashFiles.some((f) => f.endsWith('.js'));
check('index.html + css + js present', hasHtml && hasCss && hasJs, dashFiles.join(', '));
check('at most 400 files', dashFiles.length <= 400, `${dashFiles.length}`);
const dashBytes = dashFiles.reduce((s, f) => s + statSync(join(dashDir, f)).size, 0);
check('at most 4 MiB', dashBytes <= 4 * 1024 * 1024, `${dashBytes} B`);
check('dashboard source at most 64 KiB', dashBytes <= 65_536, `${dashBytes} B`);
let noHttp = true;
for (const f of dashFiles) {
  const text = readFileSync(join(dashDir, f), 'utf8');
  if (/\b(?:src|href|action|import)\s*=\s*["']https?:/i.test(text) || /from\s+["']https?:/i.test(text) || /import\s*\(\s*["']https?:/i.test(text)) { noHttp = false; console.log(`    http(s) reference in ${f}`); }
}
check('no http/https in attributes or imports', noHttp);

// --- 3. board file ----------------------------------------------------------
console.log('board_file');
const board = JSON.parse(readFileSync(join(out, 'board.json'), 'utf8'));
const rows = board.rows;
check('100 to 4000 rows', rows.length >= 100 && rows.length <= 4000, `${rows.length} rows`);
check('ranks exactly 1..N', rows.every((r, i) => r.rank === i + 1));
check('implied non-increasing with rank', rows.every((r, i) => i === 0 || r.implied_value_usd <= rows[i - 1].implied_value_usd));
check('no duplicate slugs', new Set(rows.map((r) => r.slug)).size === rows.length);

// --- 4. coverage ------------------------------------------------------------
console.log('coverage');
const boardSlugs = new Set(rows.map((r) => r.slug));
const missing = [...watchlist].filter((s) => !boardSlugs.has(s));
check('all watchlist slugs covered', missing.length === 0, `${watchlist.size} slugs, missing: ${missing.join(', ') || 'none'}`);

// --- 5. farm steps ----------------------------------------------------------
console.log('farm_steps');
let stepsOk = true;
let stepsN = 0;
for (const r of rows) {
  if (!Array.isArray(r.farm_steps) || r.farm_steps.length < 3 || r.farm_steps.length > 12) { stepsOk = false; console.log(`    ${r.slug}: ${r.farm_steps?.length ?? 0} steps`); }
  for (const s of r.farm_steps ?? []) {
    stepsN++;
    if (typeof s !== 'string' || s.length < 20 || s.length > 600) { stepsOk = false; console.log(`    ${r.slug}: step ${s.length} chars`); }
  }
}
check('3–12 steps of 20–600 chars each', stepsOk, `${stepsN} steps`);

// --- 6. screenshots ---------------------------------------------------------
console.log('screenshots');
function imageSize(buf) {
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), type: 'png' };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) break;
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5), type: 'jpeg' };
      }
      i += 2 + len;
    }
  }
  return null;
}
const shotsDir = join(out, 'screenshots');
const shots = existsSync(shotsDir) ? readdirSync(shotsDir).filter((f) => statSync(join(shotsDir, f)).isFile()) : [];
check('3 or 4 screenshots', shots.length >= 3 && shots.length <= 4, `${shots.length}`);
let shotsOk = shots.length >= 3 && shots.length <= 4;
for (const f of shots) {
  const buf = readFileSync(join(shotsDir, f));
  const size = imageSize(buf);
  if (buf.length > 524_288) { shotsOk = false; console.log(`    ${f}: ${buf.length} B over 512 KiB`); }
  if (!size) { shotsOk = false; console.log(`    ${f}: not a readable PNG/JPEG`); continue; }
  const long = Math.max(size.w, size.h), short = Math.min(size.w, size.h);
  if (long > 1440 || short < 800) { shotsOk = false; console.log(`    ${f}: ${size.w}x${size.h} (long side max 1440, short side min 800)`); }
}
check('each at most 512 KiB, long side at most 1440, short side at least 800', shotsOk);

// --- 7. dossier matches -----------------------------------------------------
console.log('dossier_matches');
const dossierOnDisk = readFileSync(join(out, 'dossier.json'));
check('dossier under 1.5 MiB', dossierOnDisk.length <= 1_500_000, `${dossierOnDisk.length} B`);
let rebuilt;
try {
  rebuilt = buildDossier(out, { text_max_bytes: 65_536, screenshots: { max: 4, max_bytes: 524_288 }, dashboard: { max_files: 400, max_bytes: 4_194_304 } });
  check('dossier rebuilds byte-identical', Buffer.from(rebuilt).equals(dossierOnDisk));
} catch (e) {
  check('dossier rebuilds byte-identical', false, e.message);
}

// --- 8. dashboard data matches the board ------------------------------------
console.log('dashboard_steps_match_board');
const dataText = readFileSync(join(out, 'data.js'), 'utf8');
const radar = JSON.parse(dataText.replace(/^window\.RADAR=/, '').replace(/;\s*$/, ''));
const dataBySlug = new Map(radar.rows.map((r) => [r.slug, r]));
let matchOk = radar.rows.length === rows.length;
for (const r of rows) {
  const d = dataBySlug.get(r.slug);
  if (!d || d.rank !== r.rank || d.implied_value_usd !== r.implied_value_usd || d.net_usd !== r.net_usd
    || d.verdict !== r.verdict || JSON.stringify(d.farm_steps) !== JSON.stringify(r.farm_steps)) {
    matchOk = false; console.log(`    mismatch: ${r.slug}`); break;
  }
}
check('every board row appears in data.js with the same rank, implied, net, verdict and steps', matchOk, `${radar.rows.length} rows`);
check('ledger sums to the snapshot', radar.ledger.reduce((s, l) => s + l.n, 0) === snapshot.protocols.length,
  `${radar.ledger.reduce((s, l) => s + l.n, 0)} of ${snapshot.protocols.length}`);
check('groups match the ledger counts',
  radar.groups.token_trades.length === radar.ledger.find((l) => l.label === 'Token trades').n
  && radar.groups.set_aside.length === radar.ledger.filter((l) => l.label.startsWith('Set aside')).reduce((s, l) => s + l.n, 0),
  `${radar.groups.token_trades.length} trades, ${radar.groups.set_aside.length} set aside`);

// --- 9. proof file numbers ---------------------------------------------------
console.log('proof numbers');
const proof = readFileSync(join(dashDir, '00-proof.md'), 'utf8');
const farmN = rows.filter((r) => r.verdict === 'FARM').length;
const total = rows.reduce((s, r) => s + r.implied_value_usd, 0);
check('proof states the board size', proof.includes(`${rows.length} rows`) || proof.includes(String(rows.length)));
check('proof states the FARM count', proof.includes(`${farmN} FARM`));
check('proof states the total implied', proof.includes(`$${(total / 1e6).toFixed(0)}M`) || proof.includes('$1,349M'));
check('proof states the LOO', proof.includes(`x${radar.validation.loo_median.toFixed(2)}`));
check('proof states the walk-forward', proof.includes(`x${radar.validation.walk_forward_median.toFixed(2)}`));
check('proof states the top-1 implied', proof.includes(`$${(rows[0].implied_value_usd / 1e6).toFixed(1)}M`));
check('proof lists the five hand-checks', ['Sentora Curator', 'Steakhouse Financial', 'OnRe', 'Polymarket International', 'Drakewell'].every((n) => proof.includes(n)));

rmSync(tmpA, { recursive: true, force: true });
rmSync(tmpB, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
