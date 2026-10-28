/* npm test (node --test). Fault injection for scripts/fetch-availability.mjs through its --fixture replay (no network,
   no tokens): one shop failing while the other works, per-barber failures, bad previous files, write failures
   (QA 2026-10-28, docs/QA-2026-10-28-full-surface.md row 6). Behaviour as it is today. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const JOB = fileURLToPath(new URL('../../scripts/fetch-availability.mjs', import.meta.url));
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
const inTwoDays = new Date(Date.now() + 2 * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z');

const item = (id: string, tm: string) => ({
  type: 'ITEM', id, present_at_all_locations: true,
  item_data: { name: id, product_type: 'APPOINTMENTS_SERVICE', variations: [{ id: `${id}-HC`, present_at_all_locations: true, item_variation_data: { name: 'Haircut', price_money: { amount: 4500, currency: 'USD' }, service_duration: 2700000, team_member_ids: [tm] } }] },
});
const open = (v: string, tm: string) => ({ availabilities: [{ start_at: inTwoDays, appointment_segments: [{ team_member_id: tm, service_variation_id: v }] }] });
const shop = (loc: string, ids: string[], extra: Record<string, unknown> = {}) => ({
  location_id: loc,
  catalog: ids.map((id) => item(id, `TM_${id}`)),
  profiles: ids.map((id) => ({ team_member_id: `TM_${id}`, is_bookable: true })),
  availability: Object.fromEntries(ids.map((id) => [`${id}-HC`, open(`${id}-HC`, `TM_${id}`)])),
  ...extra,
});
const ADDISON = () => shop('D11BVA91E8V3N', ['A1', 'A2']);
const ELMHURST = () => shop('L65DF5AG5BDAN', ['E1']);
const PREV_FETCHED = '2026-10-28T17:00:00Z';
const PREV = { shops: {
  addison: { fetched_at: PREV_FETCHED, ok: true, barbers: { A1: { next: null, soon: [] } } },
  elmhurst: { fetched_at: PREV_FETCHED, ok: true, barbers: { E1: { next: null, soon: [] } } },
} };

function run(shops: Record<string, unknown>, previous: string | object = PREV, out?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'st-resil-'));
  const fx = join(dir, 'fixture.json'), prev = join(dir, 'previous.json'), dest = out ?? join(dir, 'out.json');
  writeFileSync(fx, JSON.stringify({ anchor_date: today, shops }));
  writeFileSync(prev, typeof previous === 'string' ? previous : JSON.stringify(previous));
  const r = spawnSync(process.execPath, [JOB, '--fixture', fx, '--previous', prev, '--out', dest], { encoding: 'utf8', timeout: 60000 });
  let file: any = null;
  try { file = JSON.parse(readFileSync(dest, 'utf8')); } catch { /* not written */ }
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, file };
}

test('job: one shop failing (catalog 503) while the other works: exit 0, good shop fresh, failed shop keeps its last good block', () => {
  const r = run({ addison: ADDISON(), elmhurst: { ...ELMHURST(), catalog_status: 503, errors: [{ code: 'SERVICE_UNAVAILABLE' }] } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.file.shops.addison.ok, true);
  assert.equal(r.file.shops.addison.barbers.A1.next, inTwoDays);
  assert.equal(r.file.shops.elmhurst.ok, false);
  assert.equal(r.file.shops.elmhurst.fetched_at, PREV_FETCHED, 'fetched_at carried over, so the site hides it after 2 h');
  assert.deepEqual(r.file.shops.elmhurst.barbers, PREV.shops.elmhurst.barbers);
  assert.match(r.file.shops.elmhurst.error, /^catalog: .*HTTP 503/);
});

test('job: one barber\'s search failing only costs that barber (error, no next/soon); the shop stays ok', () => {
  const a = ADDISON();
  (a.availability as Record<string, unknown>)['A2-HC'] = { status: 400, errors: [{ code: 'BAD_REQUEST', detail: 'injected' }] };
  const r = run({ addison: a, elmhurst: ELMHURST() });
  assert.equal(r.code, 0);
  const b = r.file.shops.addison.barbers;
  assert.equal(r.file.shops.addison.ok, true);
  assert.equal(b.A1.next, inTwoDays);
  assert.match(b.A2.error, /HTTP 400/);
  assert.equal('next' in b.A2, false);
  assert.equal('soon' in b.A2, false);
});

test('job: every search failing with 401 is a shop failure (previous block kept) but not an AUTH FAILURE exit', () => {
  const a = ADDISON();
  for (const k of Object.keys(a.availability)) (a.availability as Record<string, unknown>)[k] = { status: 401, errors: [{ code: 'UNAUTHORIZED' }] };
  const r = run({ addison: a, elmhurst: ELMHURST() });
  assert.equal(r.code, 0, 'spec §3: only catalog/profiles 401/403 exit 2');
  assert.equal(r.file.shops.addison.ok, false);
  assert.deepEqual(r.file.shops.addison.barbers, PREV.shops.addison.barbers);
  assert.equal(r.stderr.includes('AUTH FAILURE'), false);
});

test('job: a missing, corrupt or odd --previous file still writes the file (failed shop then has no block)', () => {
  for (const prev of ['', 'not json {', '[1,2]', '{"shops":"x"}', '{"shops":{"addison":null}}']) {
    const r = run({ addison: { ...ADDISON(), catalog_status: 500, errors: [{ code: 'INTERNAL_SERVER_ERROR' }] }, elmhurst: ELMHURST() }, prev);
    assert.equal(r.code, 0, prev);
    assert.equal(r.file.shops.addison.ok, false, prev);
    assert.equal('barbers' in r.file.shops.addison, false, prev);
    assert.equal('fetched_at' in r.file.shops.addison, false, prev);
    assert.equal(r.file.shops.elmhurst.ok, true, prev);
  }
});

test('job: the file cannot be written = exit 1 (the workflow publishes nothing)', () => {
  const r = run({ addison: ADDISON(), elmhurst: ELMHURST() }, PREV, '/dev/null/cannot/availability.json');
  assert.equal(r.code, 1);
  assert.equal(r.file, null);
  assert.match(r.stderr, /could not write/);
});


/* ---------- Fix round (QA 2026-10-28): deadline, previous-file logging, auth lines on a write failure ---------- */

function runEnv(shops: Record<string, unknown>, env: Record<string, string>, previous: string | object = PREV, out?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'st-resil-'));
  const fx = join(dir, 'fixture.json'), prev = join(dir, 'previous.json'), dest = out ?? join(dir, 'out.json');
  writeFileSync(fx, JSON.stringify({ anchor_date: today, shops }));
  writeFileSync(prev, typeof previous === 'string' ? previous : JSON.stringify(previous));
  const r = spawnSync(process.execPath, [JOB, '--fixture', fx, '--previous', prev, '--out', dest], { encoding: 'utf8', timeout: 60000, env: { ...process.env, ...env } });
  let file: any = null;
  try { file = JSON.parse(readFileSync(dest, 'utf8')); } catch { /* not written */ }
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, file };
}

test('fix 8 deadline: a spent budget before a shop keeps its previous block (error "deadline"), file written, exit 0', () => {
  const r = runEnv({ addison: ADDISON(), elmhurst: ELMHURST() }, { AVAILABILITY_DEADLINE_MS: '0' });
  assert.equal(r.code, 0, r.stderr);
  for (const s of ['addison', 'elmhurst']) {
    assert.equal(r.file.shops[s].ok, false);
    assert.equal(r.file.shops[s].error, 'deadline');
    assert.deepEqual(r.file.shops[s].barbers, (PREV.shops as any)[s].barbers);
  }
  assert.match(r.stdout, /time budget \(0 ms\) spent/);
});

test('fix 8 deadline: searches already running finish; barbers not yet started get error "deadline"; later shops are skipped', () => {
  // Four slow searches fill the four workers past a 300 ms budget, so the fifth barber never starts.
  const ids = ['A1', 'A2', 'A3', 'A4', 'A5'];
  const a = shop('D11BVA91E8V3N', ids);
  for (const id of ids.slice(0, 4)) (a.availability as Record<string, any>)[`${id}-HC`].delay_ms = 700;
  const r = runEnv({ addison: a, elmhurst: ELMHURST() }, { AVAILABILITY_DEADLINE_MS: '300' });
  assert.equal(r.code, 0, r.stderr);
  const b = r.file.shops.addison.barbers;
  assert.equal(r.file.shops.addison.ok, true);
  for (const id of ids.slice(0, 4)) assert.equal(b[id].next, inTwoDays, id);
  assert.equal(b.A5.error, 'deadline');
  assert.equal(r.file.shops.elmhurst.error, 'deadline');
});

test('fix 8 deadline + auth failure: still exit 2 after writing', () => {
  const r = runEnv({ addison: { ...ADDISON(), catalog_status: 401 }, elmhurst: ELMHURST() }, { AVAILABILITY_DEADLINE_MS: '600000' });
  assert.equal(r.code, 2);
  assert.ok(r.file);
});

test('fix 8 write failure after an auth failure: exit 1, and the AUTH FAILURE line is still printed', () => {
  const r = runEnv({ addison: { ...ADDISON(), catalog_status: 401 }, elmhurst: ELMHURST() }, {}, PREV, '/dev/null/cannot/availability.json');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /could not write/);
  assert.match(r.stderr, /AUTH FAILURE addison: token rejected \(HTTP 401\)/);
});

test('fix 9 previous file: unreadable or not an availability file is logged; damaged blocks are never carried over', () => {
  const corrupt = runEnv({ addison: ADDISON(), elmhurst: ELMHURST() }, {}, 'not json {');
  assert.match(corrupt.stdout, /previous file .* is unreadable/);
  const notFile = runEnv({ addison: ADDISON(), elmhurst: ELMHURST() }, {}, '{"shops":"x"}');
  assert.match(notFile.stdout, /is not an availability file/);
  // A previous block with junk inside: only well-formed fields survive into the failed shop's block.
  const junk = { shops: { elmhurst: { ok: true, fetched_at: 5, barbers: { E1: { next: 99, soon: 'x' }, E2: null, E3: { next: null, soon: [] } } } } };
  const r = runEnv({ addison: ADDISON(), elmhurst: { ...ELMHURST(), catalog_status: 503, errors: [{ code: 'SERVICE_UNAVAILABLE' }] } }, {}, junk);
  assert.equal(r.code, 0);
  assert.equal('fetched_at' in r.file.shops.elmhurst, false, 'a non-string fetched_at is dropped');
  assert.deepEqual(r.file.shops.elmhurst.barbers, { E1: {}, E3: { next: null, soon: [] } });
});
