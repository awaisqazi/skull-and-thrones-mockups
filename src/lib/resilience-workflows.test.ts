/* npm test (node --test). The workflow shell steps run for real against local fakes (QA 2026-10-28 fix round):
   the token canary (needs bash + curl; jq optional), the availability shop-hours guard, the publish/annotation wiring,
   plus the build assertion that every page loads app.ts and sync-products refusing an empty feed. No network. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pagesWithoutApp } from '../../scripts/assert-app-script.mjs';

const SITE = fileURLToPath(new URL('../../', import.meta.url));
const wf = (name: string) => readFileSync(join(SITE, '.github/workflows', name), 'utf8');

/** The `run: |` block of the step whose name starts with `stepName`, dedented. */
function runBlock(yaml: string, stepName: string): string {
  const lines = yaml.split('\n');
  const at = lines.findIndex((l) => l.trim().startsWith(`- name: ${stepName}`));
  assert.ok(at >= 0, `step "${stepName}" not found`);
  const runAt = lines.findIndex((l, i) => i > at && /^\s+run: \|\s*$/.test(l));
  const indent = lines[runAt + 1]!.match(/^\s*/)![0].length;
  const body: string[] = [];
  for (let i = runAt + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.trim() && l.match(/^\s*/)![0].length < indent) break;
    body.push(l.slice(indent));
  }
  return body.join('\n');
}

const bash = (script: string, env: Record<string, string>, cwd = SITE) => new Promise<{ code: number; out: string }>((resolve) => {
  execFile('bash', ['-e', '-c', script], { cwd, env: { PATH: process.env.PATH!, HOME: process.env.HOME ?? '/tmp', ...env }, timeout: 60000 }, (err, stdout, stderr) => {
    resolve({ code: err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0, out: stdout + stderr });
  });
});

/* ---------- Fix 7: canary ---------- */

/** A fake GET /v2/locations that answers each request from `script` in turn (status or 'drop'), recording headers. */
async function fakeSquare(script: (number | 'drop')[]) {
  const seen: { version?: string; auth: boolean }[] = [];
  const server = http.createServer((req, res) => {
    seen.push({ version: req.headers['square-version'] as string | undefined, auth: Boolean(req.headers.authorization) });
    const next = script.length > 1 ? script.shift()! : script[0]!;
    if (next === 'drop') { req.socket.destroy(); return; }
    res.writeHead(next, { 'content-type': 'application/json' });
    res.end(next === 200 ? JSON.stringify({ locations: [{ id: 'A' }, { id: 'B' }] }) : JSON.stringify({ errors: [{ code: 'X', detail: 'BODY-MUST-NOT-PRINT' }] }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  return { base: `http://127.0.0.1:${port}`, seen, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const CANARY = runBlock(wf('square-canary.yml'), 'GET /v2/locations with each token');
const canary = async (script: (number | 'drop')[], tokens: Record<string, string> = { SQUARE_TOKEN: 'tok-not-real' }) => {
  const sq = await fakeSquare(script);
  const r = await bash(CANARY, { ...tokens, SQUARE_API_BASE: sq.base, CANARY_RETRY_DELAY: '0', RUNNER_TEMP: mkdtempSync(join(tmpdir(), 'st-canary-')) });
  await sq.close();
  assert.ok(!r.out.includes('BODY-MUST-NOT-PRINT') && !r.out.includes('tok-not-real'), 'never prints a body or a token');
  return { ...r, seen: sq.seen };
};

test('fix 7 canary: 200 passes and sends the Square-Version from src/lib/square.ts', async () => {
  const version = /export const SQUARE_VERSION = '([^']+)'/.exec(readFileSync(join(SITE, 'src/lib/square.ts'), 'utf8'))![1];
  const r = await canary([200]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /SQUARE_TOKEN: HTTP 200, 2 location\(s\)/);
  assert.equal(r.seen[0]!.version, version);
});

test('fix 7 canary: 401 / 403 fail at once with the rotate hint (no retry)', async () => {
  for (const status of [401, 403]) {
    const r = await canary([status]);
    assert.notEqual(r.code, 0, String(status));
    assert.match(r.out, new RegExp(`::error .*HTTP ${status} \\(token rejected\\)\\. Rotate the SQUARE_TOKEN secret`));
    assert.equal(r.seen.length, 1);
  }
});

test('fix 7 canary: 5xx / 429 / network error retry once; recovered = pass, twice = warning only, exit 0', async () => {
  const recovered = await canary([503, 200]);
  assert.equal(recovered.code, 0, recovered.out);
  assert.equal(recovered.seen.length, 2);
  for (const script of [[503], [429], ['drop'] as ('drop')[]]) {
    const r = await canary([...script]);
    assert.equal(r.code, 0, `${script}: ${r.out}`);
    assert.match(r.out, /::warning .*not a token problem/);
    assert.equal(r.out.includes('::error'), false);
    assert.equal(r.seen.length, 2, 'exactly one retry');
  }
});

test('fix 7 canary: no secret = nothing to check, exit 0; an unexpected status (404) fails without "rotate"', async () => {
  const none = await canary([200], {});
  assert.equal(none.code, 0);
  assert.match(none.out, /nothing to check/);
  const odd = await canary([404]);
  assert.notEqual(odd.code, 0);
  assert.match(odd.out, /unexpected HTTP 404/);
  assert.equal(/Rotate/.test(odd.out), false);
});

/* ---------- Fix B: shop-hours guard (cron ticks from the Worker are guarded, booking events are not) ---------- */

const GUARD = runBlock(wf('availability.yml'), 'Shop-hours guard');
async function guard(event: string, reason: string, hour: string) {
  const dir = mkdtempSync(join(tmpdir(), 'st-guard-'));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'date'), `#!/bin/sh\necho ${hour}\n`);
  chmodSync(join(dir, 'bin', 'date'), 0o755);
  const out = join(dir, 'out');
  writeFileSync(out, '');
  const r = await bash(GUARD, { PATH: `${join(dir, 'bin')}:${process.env.PATH}`, EVENT: event, REASON: reason, GITHUB_OUTPUT: out });
  assert.equal(r.code, 0, r.out);
  return readFileSync(out, 'utf8').trim();
}

test('fix B guard: Worker cron ticks and GitHub schedule respect shop hours; booking events and manual runs always go', async () => {
  assert.equal(await guard('repository_dispatch', 'cron', '03'), 'run=false');
  assert.equal(await guard('repository_dispatch', 'cron', '10'), 'run=true');
  assert.equal(await guard('repository_dispatch', '', '03'), 'run=true', 'booking.* event at night still refreshes');
  assert.equal(await guard('workflow_dispatch', '', '03'), 'run=true');
  assert.equal(await guard('schedule', '', '03'), 'run=false');
  assert.equal(await guard('schedule', '', '20'), 'run=true');
  assert.equal(await guard('schedule', '', '21'), 'run=false');
});

test('fix 9 workflows: the token annotation runs even after a failed publish; deploy runs the Worker tests', () => {
  assert.match(wf('availability.yml'), /if: always\(\) && steps\.fetch\.outputs\.code == '2'/);
  const deploy = wf('deploy.yml');
  assert.match(deploy, /run: node --test "worker\/test\/\*\.test\.mjs"/);
  assert.ok(deploy.indexOf('run: npm test') < deploy.indexOf('worker/test/'), 'after npm test');
  assert.match(deploy, /JSON\.parse\(require\("fs"\)\.readFileSync\(process\.argv\[1\], "utf8"\)\)\.shops \|\| process\.exit\(1\)/, 'bake keeps its JSON check');
});

/* ---------- Fix A: every built page loads app.ts ---------- */

test('fix A pagesWithoutApp: finds a page that loads only another bundle; redirect stubs are ignored', () => {
  const dir = mkdtempSync(join(tmpdir(), 'st-dist-'));
  mkdirSync(join(dir, '_astro'));
  mkdirSync(join(dir, 'contact'));
  writeFileSync(join(dir, '_astro', 'app.js'), 'const h = document.getElementById("st-hours");');
  writeFileSync(join(dir, '_astro', 'avail.js'), 'const a = document.getElementById("st-avail");');
  writeFileSync(join(dir, 'index.html'), '<script type="module" src="/base/_astro/app.js"></script>');
  writeFileSync(join(dir, 'contact', 'index.html'), '<script type="module" src="/base/_astro/avail.js"></script>');
  writeFileSync(join(dir, 'old.html'), '<meta http-equiv="refresh" content="0;url=/base/">');
  assert.deepEqual(pagesWithoutApp(dir, '/base'), ['contact/index.html']);
});

test('fix A astro.config wires the build assertion', () => {
  assert.match(readFileSync(join(SITE, 'astro.config.mjs'), 'utf8'), /assertAppScript\(\)/);
});

/* ---------- Fix 9: sync-products never writes an empty products.json ---------- */

test('fix 9 sync-products: a feed with 0 usable products exits 1 and writes nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'st-sync-'));
  const feed = join(dir, 'feed.json'), out = join(dir, 'products.json');
  writeFileSync(feed, JSON.stringify({ products: [] }));
  const r = spawnSync(process.execPath, [join(SITE, 'scripts/sync-products.mjs'), '--from', feed, '--out', out], { encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /0 usable products/);
  assert.equal(existsSync(out), false);
});
