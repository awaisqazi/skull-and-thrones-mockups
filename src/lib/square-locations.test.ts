/* npm test  (node --test; no network: Square is faked). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchLocation, hoursShort, periodsToHours, resolveHours, type HoursRow, type SquarePeriod } from './square-locations.ts';

const p = (day: string, a: string, b: string): SquarePeriod => ({ day_of_week: day, start_local_time: a, end_local_time: b });

/** The real GET /v2/locations/L65DF5AG5BDAN business_hours (Elmhurst), recorded 2026-10-29, in Square's order (Sunday first). */
const ELMHURST: SquarePeriod[] = [
  p('SUN', '09:00:00', '15:00:00'), p('MON', '10:00:00', '19:00:00'), p('TUE', '10:00:00', '19:00:00'), p('WED', '10:00:00', '19:00:00'),
  p('THU', '10:00:00', '19:00:00'), p('FRI', '10:00:00', '19:00:00'), p('SAT', '08:00:00', '15:00:00'),
];
const FILE_HOURS: HoursRow[] = [
  { label: 'Mon – Fri', days: [1, 2, 3, 4, 5], opens: '10:00', closes: '19:00' },
  { label: 'Saturday', days: [6], opens: '08:00', closes: '16:00' },
  { label: 'Sunday', days: [0], opens: '09:00', closes: '15:00' },
];

test('real Elmhurst periods: Mon – Fri, Saturday, Sunday, Monday-first, days numbered from Sunday = 0', () => {
  const { hours, warnings } = periodsToHours(ELMHURST, 'America/Chicago');
  assert.deepEqual(hours, [
    { label: 'Mon – Fri', days: [1, 2, 3, 4, 5], opens: '10:00', closes: '19:00' },
    { label: 'Saturday', days: [6], opens: '08:00', closes: '15:00' },
    { label: 'Sunday', days: [0], opens: '09:00', closes: '15:00' },
  ]);
  assert.deepEqual(warnings, []);
});

test('the output shape is exactly what locations.json uses', () => {
  const { hours } = periodsToHours(ELMHURST);
  for (const h of hours) {
    assert.deepEqual(Object.keys(h).sort(), ['closes', 'days', 'label', 'opens']);
    assert.match(h.opens, /^\d{2}:\d{2}$/);
    assert.match(h.closes, /^\d{2}:\d{2}$/);
  }
});

test('days with identical times group only when consecutive; labels follow the site style', () => {
  const { hours } = periodsToHours([
    p('MON', '10:00:00', '19:00:00'), p('TUE', '10:00:00', '19:00:00'), p('WED', '10:00:00', '19:00:00'), p('THU', '10:00:00', '19:00:00'),
    p('FRI', '12:00:00', '20:00:00'), p('SAT', '08:00:00', '16:00:00'), p('SUN', '08:00:00', '16:00:00'),
  ]);
  assert.deepEqual(hours.map((h) => [h.label, h.days]), [['Mon – Thu', [1, 2, 3, 4]], ['Fri', [5]], ['Sat – Sun', [6, 0]]]);
});

test('a lone weekday is abbreviated, a lone Saturday or Sunday is spelled out, a gap splits a run', () => {
  const { hours } = periodsToHours([p('MON', '10:00:00', '19:00:00'), p('WED', '10:00:00', '19:00:00'), p('THU', '10:00:00', '19:00:00'), p('TUE', '12:00:00', '18:00:00')]);
  assert.deepEqual(hours.map((h) => [h.label, h.days]), [['Mon', [1]], ['Tue', [2]], ['Wed – Thu', [3, 4]]]);
  assert.deepEqual(periodsToHours([p('SAT', '09:00:00', '14:00:00')]).hours.map((h) => h.label), ['Saturday']);
});

test('same times on Sunday and Monday do not wrap into one row (Sunday is last in the week)', () => {
  const { hours } = periodsToHours([p('SUN', '10:00:00', '19:00:00'), p('MON', '10:00:00', '19:00:00')]);
  assert.deepEqual(hours.map((h) => [h.label, h.days]), [['Mon', [1]], ['Sunday', [0]]]);
});

test('split shifts: earliest open to latest close, with a warning naming the day and shifts', () => {
  const { hours, warnings } = periodsToHours([
    p('MON', '10:00:00', '13:00:00'), p('MON', '14:00:00', '19:00:00'),
    p('TUE', '10:00:00', '19:00:00'), p('WED', '10:00:00', '19:00:00'),
  ]);
  assert.deepEqual(hours, [{ label: 'Mon – Wed', days: [1, 2, 3], opens: '10:00', closes: '19:00' }]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /Monday has split shifts \(10:00–13:00, 14:00–19:00\)/);
});

test('split shifts given out of order still use the true earliest open and latest close', () => {
  const { hours } = periodsToHours([p('FRI', '15:00:00', '20:00:00'), p('FRI', '09:00:00', '12:00:00')]);
  assert.deepEqual(hours, [{ label: 'Fri', days: [5], opens: '09:00', closes: '20:00' }]);
});

test('accepts HH:MM and one-digit hours, ignores seconds, case-insensitive day codes', () => {
  const { hours } = periodsToHours([p('mon', '9:00', '17:30:45')]);
  assert.deepEqual(hours, [{ label: 'Mon', days: [1], opens: '09:00', closes: '17:30' }]);
});

test('midnight close is shown as 23:59 with a warning; a close before the open is skipped with a warning', () => {
  const a = periodsToHours([p('FRI', '12:00:00', '00:00:00')]);
  assert.deepEqual(a.hours, [{ label: 'Fri', days: [5], opens: '12:00', closes: '23:59' }]);
  assert.match(a.warnings[0]!, /Friday: closes at midnight/);
  const b = periodsToHours([p('FRI', '20:00:00', '02:00:00'), p('SAT', '10:00:00', '10:00:00')]);
  assert.deepEqual(b.hours, []);
  assert.equal(b.warnings.length, 2);
  assert.match(b.warnings[0]!, /Friday: closes \(02:00\) before it opens \(20:00\), skipped/);
});

test('bad day codes and unreadable times are skipped with warnings, the rest survives', () => {
  const { hours, warnings } = periodsToHours([p('FUNDAY', '10:00:00', '19:00:00'), p('MON', 'soon', '19:00:00'), p('TUE', '25:00:00', '26:00:00'), p('WED', '10:00:00', '19:00:00'), {}]);
  assert.deepEqual(hours, [{ label: 'Wed', days: [3], opens: '10:00', closes: '19:00' }]);
  assert.equal(warnings.length, 4);
  assert.match(warnings[0]!, /unknown day "FUNDAY"/);
});

test('empty, null and undefined periods give no hours and no warnings', () => {
  for (const x of [[], null, undefined]) assert.deepEqual(periodsToHours(x), { hours: [], warnings: [], skipped: 0 });
});

test('a timezone other than America/Chicago adds a warning but still converts', () => {
  const { hours, warnings } = periodsToHours([p('MON', '10:00:00', '19:00:00')], 'America/New_York');
  assert.equal(hours.length, 1);
  assert.match(warnings[0]!, /America\/New_York/);
  assert.deepEqual(periodsToHours([p('MON', '10:00:00', '19:00:00')], 'America/Chicago').warnings, []);
});

test('hoursShort: every day covered keeps the current text', () => {
  assert.equal(hoursShort(periodsToHours(ELMHURST).hours), 'Open 7 days');
  assert.equal(hoursShort(periodsToHours(ELMHURST).hours, 'Open daily'), 'Open daily');
});

test('hoursShort: closed days', () => {
  const day = (...d: number[]): HoursRow => ({ label: 'x', days: d, opens: '10:00', closes: '19:00' });
  assert.equal(hoursShort([day(0, 2, 3, 4, 5, 6)]), 'Closed Mondays');
  assert.equal(hoursShort([day(2, 3, 4, 5, 6)]), 'Closed Mondays & Sundays');
  assert.equal(hoursShort([day(3, 4, 5, 6)]), 'Closed Mon, Tue & Sun');
  assert.equal(hoursShort([day(1, 2, 3, 4, 5)]), 'Closed Saturdays & Sundays');
});

test('hoursShort: no hours at all never claims "closed"', () => {
  assert.equal(hoursShort([]), 'Open 7 days');
});

test('resolveHours: Square periods win and replace hours + hours_short', () => {
  const r = resolveHours({ hours: FILE_HOURS, hours_short: 'Open 7 days' }, { id: 'L65DF5AG5BDAN', timezone: 'America/Chicago', business_hours: { periods: ELMHURST } });
  assert.equal(r.hours_source, 'square');
  assert.equal(r.hours[1]!.closes, '15:00');
  assert.equal(r.hours_short, 'Open 7 days');
  assert.deepEqual(r.warnings, []);
});

test('resolveHours: Square closed one weekday → "Closed Mondays"', () => {
  const periods = ELMHURST.filter((x) => x.day_of_week !== 'MON');
  const r = resolveHours({ hours: FILE_HOURS, hours_short: 'Open 7 days' }, { id: 'x', business_hours: { periods } });
  assert.equal(r.hours_source, 'square');
  assert.equal(r.hours_short, 'Closed Mondays');
});

test('resolveHours: the real Addison answer (business_hours {}) keeps the file hours', () => {
  for (const loc of [{ id: 'D11BVA91E8V3N', timezone: 'America/Chicago', business_hours: {} }, { id: 'D11', business_hours: { periods: [] } }, { id: 'D12' }]) {
    const r = resolveHours({ hours: FILE_HOURS, hours_short: 'Open 7 days' }, loc);
    assert.equal(r.hours_source, 'site');
    assert.equal(r.hours, FILE_HOURS);
    assert.equal(r.hours_short, 'Open 7 days');
    assert.equal(r.note, 'no business hours set in Square');
    assert.deepEqual(r.warnings, []);
  }
});

test('resolveHours: periods that all turn out unusable keep the file hours and warn', () => {
  const r = resolveHours({ hours: FILE_HOURS, hours_source: 'x' } as never, { id: 'x', business_hours: { periods: [p('MON', 'bad', 'worse')] } });
  assert.equal(r.hours_source, 'site');
  assert.equal(r.hours, FILE_HOURS);
  assert.ok(r.warnings.some((w) => /keeping the file hours/.test(w)));
});

test('resolveHours: no Square location (failed fetch / no token) keeps the file untouched', () => {
  const r = resolveHours({ hours: FILE_HOURS, hours_short: 'Open 7 days' }, null);
  assert.deepEqual([r.hours_source, r.hours === FILE_HOURS, r.warnings], ['site', true, []]);
});

test('resolveHours: a foreign timezone keeps the file hours (the "Open now" clock is Chicago) and carries the warning', () => {
  const r = resolveHours({ hours: FILE_HOURS, hours_short: 'Open 7 days' }, { id: 'x', timezone: 'America/Denver', business_hours: { periods: ELMHURST } });
  assert.equal(r.hours_source, 'site');
  assert.equal(r.hours, FILE_HOURS);
  assert.match(r.warnings[0]!, /America\/Denver/);
});

/* ---------- fetchLocation ---------- */

const reply = (status: number, body: unknown): typeof fetch => (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as never;

test('fetchLocation: GET /v2/locations/<id> with the shared headers, returns the location', async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  const f = (async (url: string, init: RequestInit) => {
    seen = { url, init };
    return new Response(JSON.stringify({ location: { id: 'L1', timezone: 'America/Chicago', business_hours: { periods: ELMHURST } } }), { status: 200 });
  }) as never;
  const loc = await fetchLocation('tok_test', 'L1', { fetch: f, apiBase: 'https://example.test' });
  assert.equal(seen!.url, 'https://example.test/v2/locations/L1');
  assert.equal(seen!.init.method, 'GET');
  const h = seen!.init.headers as Record<string, string>;
  assert.equal(h.Authorization, 'Bearer tok_test');
  assert.match(h['Square-Version']!, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(loc.business_hours!.periods!.length, 7);
});

test('fetchLocation: HTTP and API errors throw with the status, never the token', async () => {
  await assert.rejects(
    fetchLocation('tok_secret', 'L1', { fetch: reply(401, { errors: [{ category: 'AUTHENTICATION_ERROR', code: 'UNAUTHORIZED', detail: 'This request could not be authorized.' }] }) }),
    (e: Error) => /HTTP 401\): UNAUTHORIZED: This request could not be authorized\./.test(e.message) && !e.message.includes('tok_secret'),
  );
  await assert.rejects(fetchLocation('t', 'L1', { fetch: reply(200, { errors: [{ code: 'ODD' }] }) }), /ODD/);
  await assert.rejects(fetchLocation('t', 'L1', { fetch: reply(200, {}) }), /no location in response/);
  await assert.rejects(fetchLocation('t', 'L1', { fetch: (async () => new Response('<html>', { status: 502, statusText: 'Bad Gateway' })) as never, retries: 0 }), /HTTP 502\): Bad Gateway/);
});

test('fetchLocation: encodes the location id', async () => {
  let url = '';
  await fetchLocation('t', 'a/b', { fetch: (async (u: string) => { url = u; return new Response(JSON.stringify({ location: { id: 'x' } })); }) as never });
  assert.match(url, /\/v2\/locations\/a%2Fb$/);
});
