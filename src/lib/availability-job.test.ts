/* npm test (node --test). End-to-end runs of scripts/fetch-availability.mjs against small replay fixtures
   (--fixture: no network, no tokens used): the bookable flag, the auth-failure exit code, the degrade paths. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const JOB = fileURLToPath(new URL('../../scripts/fetch-availability.mjs', import.meta.url));
const LOC = 'D11BVA91E8V3N';
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
const inTwoDays = new Date(Date.now() + 2 * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z');

const item = (id: string, tm: string | null) => ({
  type: 'ITEM', id, present_at_all_locations: true,
  item_data: {
    name: id, product_type: 'APPOINTMENTS_SERVICE',
    variations: [{ id: `${id}-HC`, present_at_all_locations: true, item_variation_data: { name: 'Haircut', price_money: { amount: 4500, currency: 'USD' }, service_duration: 2700000, team_member_ids: tm ? [tm] : [] } }],
  },
});
const open = (variation: string, tm: string) => ({ availabilities: [{ start_at: inTwoDays, location_id: LOC, appointment_segments: [{ team_member_id: tm, service_variation_id: variation }] }] });

/** A one-shop fixture: ON is bookable, OFF is not (its search would 400 if it were made), FREE is missing from the profiles list. */
const shop = (extra: Record<string, unknown> = {}) => ({
  location_id: LOC,
  catalog: [item('ON', 'TM_ON'), item('OFF', 'TM_OFF'), item('FREE', 'TM_FREE')],
  profiles: [
    { team_member_id: 'TM_ON', display_name: 'On', is_bookable: true },
    { team_member_id: 'TM_OFF', display_name: 'Off', is_bookable: false },
  ],
  availability: { 'ON-HC': open('ON-HC', 'TM_ON'), 'OFF-HC': { status: 400, errors: [{ code: 'BAD_REQUEST', detail: 'searched a barber who is not bookable' }] }, 'FREE-HC': open('FREE-HC', 'TM_FREE') },
  ...extra,
});

function run(fixtureShop: Record<string, unknown>, previous: unknown = { shops: {} }, extraArgs: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'st-avail-'));
  const fx = join(dir, 'fixture.json'), prev = join(dir, 'previous.json'), out = join(dir, 'out.json');
  writeFileSync(fx, JSON.stringify({ anchor_date: today, shops: { addison: fixtureShop } }));
  writeFileSync(prev, JSON.stringify(previous));
  const r = spawnSync(process.execPath, [JOB, '--fixture', fx, '--previous', prev, '--out', out, ...extraArgs], { encoding: 'utf8', timeout: 60000 });
  let file: any = null;
  try { file = JSON.parse(readFileSync(out, 'utf8')); } catch { /* not written */ }
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, file };
}

const PREV = { shops: { addison: { fetched_at: '2026-10-28T17:00:00Z', ok: true, barbers: { ON: { variation_id: 'ON-HC', team_member_id: 'TM_ON', next: null, soon: [], slots_today: 0, slots_7d: 0 } } } } };

test('job: bookable:false barbers are not searched and get the empty block without an error', () => {
  const r = run(shop());
  assert.equal(r.code, 0, r.stderr);
  const b = r.file.shops.addison.barbers;
  assert.equal(r.file.shops.addison.ok, true);
  assert.deepEqual(b.OFF, { variation_id: 'OFF-HC', team_member_id: 'TM_OFF', bookable: false, next: null, soon: [], slots_today: 0, slots_7d: 0 });
  assert.equal(b.ON.bookable, true);
  assert.equal(b.ON.next, inTwoDays);
  assert.equal(b.FREE.bookable, true, 'not in the profiles list = bookable');
  assert.equal(b.FREE.next, inTwoDays);
  assert.match(r.stdout, /1 not bookable online/);
  assert.equal(r.file.shops.elmhurst.ok, false, 'shop not in the fixture = missing');
});

test('job: a barber with no team member carries no bookable flag (still the no-data error)', () => {
  const r = run(shop({ catalog: [item('ON', 'TM_ON'), item('NOBODY', null)] }));
  assert.equal(r.code, 0);
  assert.equal('bookable' in r.file.shops.addison.barbers.NOBODY, false);
  assert.match(r.file.shops.addison.barbers.NOBODY.error, /no team member assigned/);
});

test('job: every barber offline is still a good shop (nothing searched, nothing failed)', () => {
  const r = run(shop({ catalog: [item('OFF', 'TM_OFF')] }));
  assert.equal(r.code, 0);
  assert.equal(r.file.shops.addison.ok, true);
  assert.equal(r.file.shops.addison.barbers.OFF.bookable, false);
});

test('job: catalog 401 = AUTH FAILURE: file written with the previous block kept, then exit 2', () => {
  const r = run(shop({ catalog_status: 401 }), PREV);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /^AUTH FAILURE addison: token rejected \(HTTP 401\)\. Rotate /m);
  assert.equal(r.file.shops.addison.ok, false);
  assert.equal(r.file.shops.addison.fetched_at, PREV.shops.addison.fetched_at);
  assert.deepEqual(r.file.shops.addison.barbers, PREV.shops.addison.barbers);
  assert.match(r.file.shops.addison.error, /^catalog: .*HTTP 401/);
  assert.ok(r.stdout.indexOf('wrote ') >= 0, 'the file is written before the exit');
});

test('job: profiles 403 = AUTH FAILURE too', () => {
  const r = run(shop({ profiles_status: 403 }), PREV);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /AUTH FAILURE addison: token rejected \(HTTP 403\)/);
  assert.match(r.file.shops.addison.error, /^booking profiles: /);
  assert.deepEqual(r.file.shops.addison.barbers, PREV.shops.addison.barbers);
});

test('job: --dry-run reports an auth failure with exit 2 and writes nothing', () => {
  const r = run(shop({ catalog_status: 401 }), PREV, ['--dry-run']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /AUTH FAILURE addison/);
  assert.equal(r.file, null);
  const ok = run(shop(), PREV, ['--dry-run']);
  assert.equal(ok.code, 0);
  assert.match(ok.stdout, /OFF .*NOT BOOKABLE ONLINE/);
});

test('job: other failures stay exit 0 (catalog 503; profiles 400 only drops the flag)', () => {
  const outage = run(shop({ catalog_status: 503, errors: [{ code: 'SERVICE_UNAVAILABLE' }] }), PREV);
  assert.equal(outage.code, 0);
  assert.equal(outage.stderr.includes('AUTH FAILURE'), false);
  assert.equal(outage.file.shops.addison.ok, false);
  assert.deepEqual(outage.file.shops.addison.barbers, PREV.shops.addison.barbers);

  const noProfiles = run(shop({ profiles_status: 400, errors: [{ code: 'BAD_REQUEST' }], catalog: [item('ON', 'TM_ON'), item('FREE', 'TM_FREE')] }));
  assert.equal(noProfiles.code, 0);
  assert.equal(noProfiles.file.shops.addison.ok, true);
  assert.equal('bookable' in noProfiles.file.shops.addison.barbers.ON, false, 'unknown, not guessed');
  assert.equal(noProfiles.file.shops.addison.barbers.ON.next, inTwoDays, 'searched as before');
  assert.match(noProfiles.stdout, /continuing without the bookable flag/);
});
