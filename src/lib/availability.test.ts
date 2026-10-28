/* npm test (node --test). Display rules for availability.json (spec §3). */
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { barberView, firstOpenChair, newer, parseFile, shopIsFresh, slimFile, slotLabel, EMPTY_FILE, type AvailabilityFile } from './availability.ts';

// Wed 2026-10-28 1:00 PM CDT.
const NOW = new Date('2026-10-28T18:00:00Z');
const file = (shops: AvailabilityFile['shops'], generated_at = '2026-10-28T17:45:03Z'): AvailabilityFile => ({ generated_at, window_days: 7, tz: 'America/Chicago', shops });
const fresh = '2026-10-28T17:45:03Z';
const F = file({
  addison: {
    fetched_at: fresh, ok: true, barbers: {
      TODAY: { variation_id: 'V1', team_member_id: 'T1', next: '2026-10-28T20:15:00Z', soon: ['2026-10-28T20:15:00Z', '2026-10-28T21:00:00Z', '2026-10-29T15:00:00Z'], slots_today: 2, slots_7d: 30 },
      TOMORROW: { next: '2026-10-29T15:00:00Z', soon: ['2026-10-29T15:00:00Z'], slots_today: 0, slots_7d: 1 },
      FRI_46H: { next: '2026-10-30T16:30:00Z', soon: ['2026-10-30T16:30:00Z'], slots_today: 0, slots_7d: 1 },
      SAT: { next: '2026-10-31T16:30:00Z', soon: ['2026-10-31T16:30:00Z'], slots_today: 0, slots_7d: 1 },
      FULL: { next: null, soon: [], slots_today: 0, slots_7d: 0 },
      UNMAPPED: { error: 'no team member assigned to variation V9' },
      PAST: { next: '2026-10-28T17:00:00Z', soon: ['2026-10-28T17:00:00Z', '2026-10-28T17:30:00Z'], slots_today: 2, slots_7d: 2 },
    },
  },
  elmhurst: { ok: false, error: 'token missing' },
});

test('slotLabel: Today / Tomorrow / weekday / date when 6+ days out, shop-local 12 h clock', () => {
  assert.equal(slotLabel('2026-10-28T20:15:00Z', NOW), 'Today 3:15 PM');
  assert.equal(slotLabel('2026-10-29T15:00:00Z', NOW), 'Tomorrow 10:00 AM');
  assert.equal(slotLabel('2026-10-29T04:30:00Z', NOW), 'Today 11:30 PM', 'UTC says tomorrow; Chicago says today');
  assert.equal(slotLabel('2026-10-31T16:30:00Z', NOW), 'Sat 11:30 AM');
  assert.equal(slotLabel('2026-11-04T15:00:00Z', NOW), 'Wed Nov 4 9:00 AM', 'after the 2026-11-01 DST change: CST, UTC-6');
});

test('barberView: green within 48 h, amber 2–7 days, grey when booked up', () => {
  assert.deepEqual(barberView(F, 'addison', 'TODAY', NOW), {
    state: 'green', text: 'Next: Today 3:15 PM',
    next: { iso: '2026-10-28T20:15:00Z', label: 'Today 3:15 PM' },
    soon: [
      { iso: '2026-10-28T20:15:00Z', label: 'Today 3:15 PM' },
      { iso: '2026-10-28T21:00:00Z', label: 'Today 4:00 PM' },
      { iso: '2026-10-29T15:00:00Z', label: 'Tomorrow 10:00 AM' },
    ],
  });
  assert.equal(barberView(F, 'addison', 'TOMORROW', NOW)!.text, 'Next: Tomorrow 10:00 AM');
  const fri = barberView(F, 'addison', 'FRI_46H', NOW)!;
  assert.deepEqual([fri.state, fri.text], ['green', 'Next: Fri 11:30 AM'], '46.5 h away is still green');
  const sat = barberView(F, 'addison', 'SAT', NOW)!;
  assert.deepEqual([sat.state, sat.text], ['amber', 'Next: Sat 11:30 AM']);
  assert.deepEqual(barberView(F, 'addison', 'FULL', NOW), { state: 'grey', text: 'Booked up this week', next: null, soon: [] });
});

test('barberView: no data → null (unknown barber, unmapped, failed shop, all times passed)', () => {
  assert.equal(barberView(F, 'addison', 'NOPE', NOW), null);
  assert.equal(barberView(F, 'addison', 'UNMAPPED', NOW), null);
  assert.equal(barberView(F, 'elmhurst', 'ANY', NOW), null);
  assert.equal(barberView(F, 'nowhere', 'ANY', NOW), null);
  assert.equal(barberView(F, 'addison', 'PAST', NOW), null, 'we no longer know the next opening');
  assert.equal(barberView(EMPTY_FILE, 'addison', 'TODAY', NOW), null);
});

test('barberView: past times drop off as the page stays open', () => {
  // Fetched 19:00Z; at 20:30Z (1 h 30 min later, still fresh) the 3:15 PM slot has passed.
  const f = file({ addison: { ...F.shops.addison!, fetched_at: '2026-10-28T19:00:00Z' } });
  const v = barberView(f, 'addison', 'TODAY', new Date('2026-10-28T20:30:00Z'))!;
  assert.equal(v.text, 'Next: Today 4:00 PM');
  assert.equal(v.soon.length, 2);
});

test('staleness: a shop block older than 2 h is hidden; ok:false with a fresh last-good block still shows', () => {
  const at3h = new Date(Date.parse(fresh) + 3 * 3600000);
  assert.equal(barberView(F, 'addison', 'FULL', at3h), null);
  const failedRun = file({ addison: { ...F.shops.addison!, ok: false, error: 'HTTP 503' } });
  assert.equal(barberView(failedRun, 'addison', 'FULL', NOW)!.state, 'grey');
  assert.equal(shopIsFresh({ ok: true, barbers: {} }, NOW), false, 'no fetched_at = never fetched');
});

test('firstOpenChair: earliest upcoming opening among the given roster ids', () => {
  assert.equal(firstOpenChair(F, 'addison', ['SAT', 'TOMORROW', 'TODAY', 'FULL'], NOW)!.item_id, 'TODAY');
  assert.equal(firstOpenChair(F, 'addison', ['SAT', 'TOMORROW'], NOW)!.view.text, 'Next: Tomorrow 10:00 AM');
  assert.equal(firstOpenChair(F, 'addison', ['FULL', 'UNMAPPED'], NOW), null);
  assert.equal(firstOpenChair(F, 'elmhurst', ['X'], NOW), null);
});

test('parseFile / newer / slimFile', () => {
  assert.deepEqual(parseFile(null), EMPTY_FILE);
  assert.deepEqual(parseFile({ shops: [] }), EMPTY_FILE);
  assert.equal(parseFile(F).shops.addison!.ok, true);
  const old = file({}, '2026-10-28T09:00:00Z');
  assert.equal(newer(old, F), F);
  assert.equal(newer(F, old), F);
  assert.equal(newer(F, EMPTY_FILE), F);
  const slim = slimFile(F);
  assert.deepEqual(slim.shops.addison!.barbers!.TODAY, { next: '2026-10-28T20:15:00Z', soon: F.shops.addison!.barbers!.TODAY!.soon });
  assert.equal('UNMAPPED' in slim.shops.addison!.barbers!, false);
  assert.deepEqual(slim.shops.elmhurst, { ok: false, barbers: {} });
});

test('recorded sandbox output (real Square run at 23:58 Chicago on 2026-10-27) reads and renders', () => {
  const rec = parseFile(JSON.parse(readFileSync(new URL('../../scripts/fixtures/sandbox-availability-2026-10-28.json', import.meta.url), 'utf8')));
  const at = new Date('2026-10-28T04:59:30Z'); // one minute after the fetch, still Oct 27 in Chicago
  const v = barberView(rec, 'addison', 'CKE2YOEK7AGRBCKXWSOQXZF2', at)!;
  assert.deepEqual([v.state, v.text, v.soon.length], ['green', 'Next: Tomorrow 9:00 AM', 3]);
  assert.equal(barberView(rec, 'elmhurst', 'X', at), null, 'token missing → no data');
  assert.equal(firstOpenChair(rec, 'addison', ['CMBI4LGKXVAXG2AFDJTEH7HL', 'CKE2YOEK7AGRBCKXWSOQXZF2'], at)!.view.next!.label, 'Tomorrow 9:00 AM');
});
