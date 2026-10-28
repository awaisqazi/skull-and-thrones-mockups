/* npm test (node --test). Fault injection for the build-time Square clients and the availability display rules
   (QA 2026-10-28, docs/QA-2026-10-28-full-surface.md rows 1-3 and 8). Behaviour as it is today; no network. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchShops, listSquareItems, readJson, squareCall, toSquareItem, type CatalogObject, type SquareItem } from './square.ts';
import { periodsToHours } from './square-locations.ts';
import { searchAvailability } from './bookings.ts';
import { slimFile, validTz } from './availability.ts';
import { isBarberItem, mergeRoster, type Row } from './roster.ts';
import { absoluteUrl, ensurePaymentLinks, fetchSquareProducts, productAlt, toProductRow, toRetailItem, type RetailItem } from './square-products.ts';
import { jsonForScript } from './safe.ts';
import { fetchLocation, resolveHours } from './square-locations.ts';
import { listTeamMemberBookingProfiles, isAuthFailure, SquareApiError } from './bookings.ts';
import { barberView, firstOpenChair, newer, parseFile, EMPTY_FILE, type AvailabilityFile } from './availability.ts';

const SHOPS = [
  { slug: 'addison', square_location_id: 'LOC_A', any_artist_item_id: 'ANY_A' },
  { slug: 'elmhurst', square_location_id: 'LOC_E', any_artist_item_id: 'ANY_E' },
];
const ENV = { SQUARE_TOKEN: 'tok-a', SQUARE_TOKEN_ELMHURST: 'tok-e' };
const barberItem = (id: string, loc: string) => ({
  type: 'ITEM', id, present_at_all_locations: false, present_at_location_ids: [loc],
  item_data: { name: id, product_type: 'APPOINTMENTS_SERVICE', variations: [{ id: `${id}-V`, present_at_all_locations: true, item_variation_data: { name: 'Haircut', price_money: { amount: 4500 }, service_duration: 2700000, team_member_ids: ['TM'] } }] },
});
const raw = (status: number, body: string, type = 'application/json') => new Response(body, { status, headers: { 'content-type': type } });
/** A fetch fake keyed by the token in the Authorization header. */
const byToken = (answers: Record<string, () => Response | Promise<Response>>) => {
  const calls: string[] = [];
  const f = (async (_url: string, init: RequestInit) => {
    const token = String((init.headers as Record<string, string>).Authorization).replace('Bearer ', '');
    calls.push(token);
    return answers[token]!();
  }) as unknown as typeof fetch;
  return { f, calls };
};

/* ---------- Row 1: roster loader client (fetchShops) ---------- */

test('fetchShops: no token at all = nothing fetched, both env names reported, no call made', async () => {
  const { f, calls } = byToken({});
  const r = await fetchShops(SHOPS, {}, { fetch: f });
  assert.deepEqual(r.missing, ['SQUARE_TOKEN_ADDISON', 'SQUARE_TOKEN_ELMHURST']);
  assert.deepEqual(r.square, {});
  assert.equal(calls.length, 0);
});

test('fetchShops: one shop failing (401/429/5xx) never affects the other, and never throws', async () => {
  for (const status of [401, 403, 429, 500, 503]) {
    const { f } = byToken({
      'tok-a': () => Response.json({ objects: [barberItem('B1', 'LOC_A')] }),
      'tok-e': () => Response.json({ errors: [{ category: 'X', code: 'FAKE', detail: 'injected' }] }, { status }),
    });
    const r = await fetchShops(SHOPS, ENV, { fetch: f });
    assert.deepEqual(Object.keys(r.square), ['addison'], String(status));
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0]!, new RegExp(`^elmhurst: .*HTTP ${status}`));
  }
});

test('fetchShops: HTML, truncated JSON, {}, null, an objects map and an empty catalog all fall back with an error line', async () => {
  const bodies: [string, () => Response][] = [
    ['html 200', () => raw(200, '<html>gateway</html>', 'text/html')],
    ['truncated 200', () => raw(200, '{"objects":[{"type":"ITEM",')],
    ['{} 200', () => Response.json({})],
    ['null 200', () => raw(200, 'null')],
    ['objects as an object', () => Response.json({ objects: {} })],
    ['only the any-artist item', () => Response.json({ objects: [barberItem('ANY_A', 'LOC_A')] })],
    ['items without item_data', () => Response.json({ objects: [{ type: 'ITEM', id: 'B1', present_at_all_locations: true }] })],
  ];
  for (const [label, body] of bodies) {
    const { f } = byToken({ 'tok-a': body, 'tok-e': body });
    const r = await fetchShops(SHOPS, ENV, { fetch: f });
    assert.deepEqual(r.square, {}, label);
    assert.equal(r.errors.length, 2, label);
  }
});

test('fetchShops: a hung Square call is cut off by the timeout and reported, not awaited forever', async () => {
  const hang = ((_url: string, init: RequestInit) => new Promise<Response>((_, reject) => {
    init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
  })) as unknown as typeof fetch;
  const r = await fetchShops(SHOPS, ENV, { fetch: hang, timeoutMs: 50 });
  assert.deepEqual(r.square, {});
  assert.equal(r.errors.length, 2);
  assert.match(r.errors[0]!, /timeout|abort/i);
});

/* ---------- Row 2: booking profiles (bios) ---------- */

test('booking profiles: a 200 with a null or non-list body fails as a non-auth error (roster builds without bios)', async () => {
  for (const body of ['null', '{"team_member_booking_profiles":{"a":1}}']) {
    const f = (async () => raw(200, body)) as unknown as typeof fetch;
    await assert.rejects(listTeamMemberBookingProfiles('t', 'L', { fetch: f, retries: 0 }), (e) => !isAuthFailure(e));
  }
  // Fix 1: an HTML 200 is an error too (the job then treats bookable as unknown), never an empty list.
  const html = (async () => raw(200, '<html></html>', 'text/html')) as unknown as typeof fetch;
  await assert.rejects(listTeamMemberBookingProfiles('t', 'L', { fetch: html, retries: 0 }), (e) => e instanceof SquareApiError && !isAuthFailure(e) && /not JSON/.test(e.message));
  // A 401 is an auth failure (the job exits 2 on it; the build only warns).
  const denied = (async () => Response.json({ errors: [{ category: 'AUTHENTICATION_ERROR', code: 'UNAUTHORIZED' }] }, { status: 401 })) as unknown as typeof fetch;
  await assert.rejects(listTeamMemberBookingProfiles('t', 'L', { fetch: denied }), (e) => e instanceof SquareApiError && isAuthFailure(e));
});

/* ---------- Row 3: locations loader (fetchLocation + resolveHours) ---------- */

const FILE_HOURS = { hours: [{ label: 'Mon – Fri', days: [1, 2, 3, 4, 5], opens: '10:00', closes: '19:00' }], hours_short: 'Open 7 days' };

test('fetchLocation: HTML, {}, and API errors throw (the loader then keeps the file hours)', async () => {
  for (const res of [() => raw(200, '<html></html>', 'text/html'), () => Response.json({}), () => Response.json({ errors: [{ code: 'NOT_FOUND' }] }, { status: 404 }), () => raw(502, 'bad gateway', 'text/plain')]) {
    const f = (async () => res()) as unknown as typeof fetch;
    await assert.rejects(fetchLocation('t', 'LOC', { fetch: f }));
  }
});

test('resolveHours: business_hours missing, {} or periods not an array keep the file hours (hours_source site)', () => {
  for (const loc of [{ id: 'L' }, { id: 'L', business_hours: {} }, { id: 'L', business_hours: { periods: [] } }, { id: 'L', business_hours: { periods: { MON: 1 } as never } }]) {
    const r = resolveHours(FILE_HOURS, loc);
    assert.equal(r.hours_source, 'site');
    assert.deepEqual(r.hours, FILE_HOURS.hours);
  }
});

/* ---------- Row 8: display rules against a malformed live file ---------- */

const NOW = new Date('2026-10-28T18:00:00Z');
const fresh = '2026-10-28T17:45:00Z';
const live = (shops: unknown, generated_at = fresh) => parseFile({ generated_at, window_days: 7, tz: 'America/Chicago', shops });

test('parseFile: anything that is not the file shape becomes the empty file (never throws)', () => {
  for (const x of [null, undefined, 42, 'str', [1, 2], {}, { shops: null }, { shops: [] }, { shops: 'x' }, { generated_at: 5, shops: 1 }]) {
    assert.deepEqual(parseFile(x), EMPTY_FILE, JSON.stringify(x));
  }
});

test('barberView: malformed shop and barber blocks mean "no data" (null), never a throw', () => {
  const cases: [string, AvailabilityFile][] = [
    ['shop null', live({ addison: null })],
    ['shop a string', live({ addison: 'x' })],
    ['shop without barbers', live({ addison: { ok: true, fetched_at: fresh } })],
    ['barbers a string', live({ addison: { ok: true, fetched_at: fresh, barbers: 'oops' } })],
    ['barber null', live({ addison: { ok: true, fetched_at: fresh, barbers: { B: null } } })],
    ['next a number', live({ addison: { ok: true, fetched_at: fresh, barbers: { B: { next: 5, soon: [5] } } } })],
    ['next an object', live({ addison: { ok: true, fetched_at: fresh, barbers: { B: { next: { a: 1 }, soon: [{ a: 1 }] } } } })],
    ['soon a string', live({ addison: { ok: true, fetched_at: fresh, barbers: { B: { next: '2026-10-28T20:00:00Z', soon: '2026-10-28T20:00:00Z' } } } })],
    ['next missing', live({ addison: { ok: true, fetched_at: fresh, barbers: { B: { soon: [] } } } })],
    ['fetched_at not a date', live({ addison: { ok: true, fetched_at: 'yesterday', barbers: { B: { next: '2026-10-28T20:00:00Z', soon: ['2026-10-28T20:00:00Z'] } } } })],
  ];
  for (const [label, f] of cases) {
    assert.equal(barberView(f, 'addison', 'B', NOW), null, label);
    assert.equal(firstOpenChair(f, 'addison', ['B'], NOW), null, label);
  }
});

test('clock skew: a block fetched more than 2 h in the visitor\'s future or past is hidden; within 2 h it shows', () => {
  const block = (fetched_at: string) => live({ addison: { ok: true, fetched_at, barbers: { B: { next: '2026-10-31T15:00:00Z', soon: ['2026-10-31T15:00:00Z'] } } } });
  assert.equal(barberView(block('2026-10-28T20:30:00Z'), 'addison', 'B', NOW), null, '2.5 h ahead of the visitor');
  assert.equal(barberView(block('2026-10-28T15:30:00Z'), 'addison', 'B', NOW), null, '2.5 h behind the visitor');
  assert.equal(barberView(block('2026-10-28T19:30:00Z'), 'addison', 'B', NOW)?.state, 'amber', '1.5 h ahead still shows');
});

test('newer: an unparsable generated_at never replaces a good file; a parsable newer one does', () => {
  const good = live({}, '2026-10-28T17:00:00Z');
  assert.equal(newer(good, live({}, 'not a date')), good);
  assert.equal(newer(good, parseFile({ shops: {} })), good);
  const later = live({}, '2026-10-28T17:15:00Z');
  assert.equal(newer(good, later), later);
});

/* =====================================================================================================
   Fix round (QA 2026-10-28, Fable review). Each block names the fix it covers.
   ===================================================================================================== */

const noSleep = { sleep: async () => {} };
const countCalls = (make: (n: number) => Response | Promise<Response>) => {
  let n = 0;
  const f = (async () => make(++n)) as unknown as typeof fetch;
  return { f, calls: () => n };
};

/* ---------- Fix 1: strict bodies + one retry policy ---------- */

test('fix 1 readJson: a body that is not a JSON object throws; an object is returned', async () => {
  for (const [body, type] of [['<html>hi</html>', 'text/html'], ['{"a":', 'application/json'], ['[1,2]', 'application/json'], ['null', 'application/json'], ['', 'application/json']] as const) {
    await assert.rejects(readJson(raw(200, body, type), 'x'), (e) => e instanceof SquareApiError && e.status === 200, body);
  }
  assert.deepEqual(await readJson(raw(200, '{"ok":1}'), 'x'), { ok: 1 });
});

test('fix 1 squareCall: a 2xx with a broken body is retried (twice), then fails; never an empty result', async () => {
  const { f, calls } = countCalls(() => raw(200, '<html>proxy</html>', 'text/html'));
  await assert.rejects(squareCall('probe', 'https://x.test', { method: 'GET', token: 't' }, { fetch: f, ...noSleep }), /probe failed \(HTTP 200\): response is not JSON/);
  assert.equal(calls(), 3);
  const flaky = countCalls((n) => (n === 1 ? raw(200, '{"trunc') : Response.json({ fine: true })));
  assert.deepEqual(await squareCall('probe', 'https://x.test', { method: 'GET', token: 't' }, { fetch: flaky.f, ...noSleep }), { fine: true });
});

test('fix 1 squareCall: timeouts are retried at most once (2 attempts), 401 never, 429 honours Retry-After', async () => {
  const timeout = countCalls(() => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); });
  await assert.rejects(squareCall('slow', 'https://x.test', { method: 'GET', token: 't' }, { fetch: timeout.f, ...noSleep }), (e) => e instanceof SquareApiError && e.timeout && e.status === 0);
  assert.equal(timeout.calls(), 2);
  const denied = countCalls(() => Response.json({ errors: [{ code: 'UNAUTHORIZED' }] }, { status: 401 }));
  await assert.rejects(squareCall('auth', 'https://x.test', { method: 'GET', token: 't' }, { fetch: denied.f, ...noSleep }), (e) => isAuthFailure(e));
  assert.equal(denied.calls(), 1);
  const waits: number[] = [];
  const limited = countCalls((n) => (n === 1 ? Response.json({}, { status: 429, headers: { 'retry-after': '4' } }) : Response.json({ ok: true })));
  await squareCall('rl', 'https://x.test', { method: 'GET', token: 't' }, { fetch: limited.f, sleep: async (ms) => { waits.push(ms); } });
  assert.deepEqual(waits, [4000]);
});

test('fix 1 listSquareItems: retries a 503 like every other call, and a non-list `objects` is an error', async () => {
  const item = barberItem('B1', 'LOC_A');
  const flaky = countCalls((n) => (n === 1 ? Response.json({ errors: [{ code: 'SERVICE_UNAVAILABLE' }] }, { status: 503 }) : Response.json({ objects: [item] })));
  assert.deepEqual((await listSquareItems('t', 'LOC_A', { fetch: flaky.f, ...noSleep })).map((i) => i.item_id), ['B1']);
  assert.equal(flaky.calls(), 2);
  const odd = (async () => Response.json({ objects: { a: 1 } })) as unknown as typeof fetch;
  await assert.rejects(listSquareItems('t', 'LOC_A', { fetch: odd, ...noSleep }), /"objects" is not a list/);
});

test('fix 1 searchAvailability: {}, HTML or a non-list body is an error (never "booked up"); Square\'s real empty answer is []', async () => {
  const w = { start: new Date(), end: new Date(Date.now() + 86400000) };
  for (const res of [() => Response.json({}), () => raw(200, '<html></html>', 'text/html'), () => Response.json({ availabilities: { a: 1 } }), () => Response.json({ availabilities: null })]) {
    await assert.rejects(searchAvailability('t', 'L', 'V', 'T', w, { fetch: (async () => res()) as unknown as typeof fetch, ...noSleep }), SquareApiError);
  }
  // The exact body production sends for a barber with nothing open (read-only check, 2026-10-28).
  const empty = (async () => raw(200, '{"availabilities":[],"errors":[]}')) as unknown as typeof fetch;
  assert.deepEqual(await searchAvailability('t', 'L', 'V', 'T', w, { fetch: empty }), []);
});

test('fix 1 products: an inventory call with a broken 200 body fails the shop (the loader then keeps Bodega)', async () => {
  const shops = [{ slug: 'addison', square_location_id: 'LOC_A' }];
  const catalog = { objects: [{ type: 'ITEM', id: 'P1', present_at_all_locations: true, item_data: { name: 'STMNT Pomade', product_type: 'REGULAR', image_ids: ['I1'], variations: [{ id: 'PV1', present_at_all_locations: true, item_variation_data: { price_money: { amount: 2000 }, track_inventory: true } }] } }], related_objects: [{ type: 'IMAGE', id: 'I1', image_data: { url: 'https://img.test/a.jpg' } }] };
  const f = (async (url: string) => (String(url).includes('/inventory/') ? raw(200, '<html>oops</html>', 'text/html') : Response.json(catalog))) as unknown as typeof fetch;
  const r = await fetchSquareProducts(shops, { SQUARE_TOKEN: 't' }, undefined, { fetch: f, ...noSleep });
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0]!, /inventory.*not JSON/);
});

/* ---------- Fix 2: builds never fail on Square data ---------- */

const svc = (ms: unknown, extra: Record<string, unknown> = {}): CatalogObject => ({
  type: 'ITEM', id: 'S1', present_at_all_locations: true,
  item_data: { name: 'Nick', product_type: 'APPOINTMENTS_SERVICE', variations: [{ id: 'V1', present_at_all_locations: true, item_variation_data: { name: 'Haircut', price_money: { amount: 4500 }, service_duration: ms as number, team_member_ids: ['TM'], ...extra } }] },
});

test('fix 2 durations: under a minute, negative or not a number become null (the schema needs a positive integer)', () => {
  for (const ms of [1000, 29999, 0, -60000, 'abc', NaN]) {
    const item = toSquareItem(svc(ms), 'LOC')!;
    assert.equal(item.duration_minutes, null, String(ms));
    assert.equal(item.variations[0]!.duration_minutes, null, String(ms));
  }
  assert.equal(toSquareItem(svc(2700000), 'LOC')!.duration_minutes, 45);
  assert.equal(toSquareItem(svc(30000), 'LOC')!.duration_minutes, 1, '30 s rounds to one minute');
});

const retail = (img: string, ecom?: string): RetailItem => toRetailItem(
  { type: 'ITEM', id: 'R1', present_at_all_locations: true, item_data: { name: 'STMNT Pomade', product_type: 'REGULAR', image_ids: ['I1'], ...(ecom ? { ecom_uri: ecom } : {}), variations: [{ id: 'RV1', present_at_all_locations: true, item_variation_data: { price_money: { amount: 2000 } } }] } },
  { locationId: 'LOC', images: new Map([['I1', { url: img, caption: '' }]]), categories: new Map() },
)!;

test('fix 2 products: a relative or non-http image URL is "no photo" (skipped), a relative store URL is no buy link', () => {
  for (const img of ['/files/a.jpg', 'files/a.jpg', 'javascript:alert(1)', 'ftp://x/a.jpg', '']) {
    assert.deepEqual(toProductRow(retail(img), new Map()), { skip: 'no photo' }, img);
  }
  const ok = toProductRow(retail('https://img.test/a.jpg', '/shop/pomade'), new Map());
  assert.ok('row' in ok);
  if ('row' in ok) { assert.equal(ok.row.buy_url, null); assert.equal(ok.row.url, null); }
  assert.equal(absoluteUrl(' https://a.test/x '), 'https://a.test/x');
  assert.equal(absoluteUrl('mailto:a@b.c'), null);
});

/* ---------- Fix C: Square location overrides (shop price) ---------- */

test('fix C prices: a location override for the shop wins over the base price and duration; other shops keep the base', () => {
  const o = svc(3600000, { price_money: { amount: 6500 }, location_overrides: [{ location_id: 'LOC_A', price_money: { amount: 6000 }, service_duration: 2700000 }, { location_id: 'LOC_E', price_money: { amount: 7000 } }] });
  const a = toSquareItem(o, 'LOC_A')!;
  assert.equal(a.variations[0]!.price, 60);
  assert.equal(a.variations[0]!.duration_minutes, 45);
  assert.equal(a.price_from, 60);
  const other = toSquareItem(o, 'LOC_X')!;
  assert.equal(other.variations[0]!.price, 65, 'no override for this location: base price');
  assert.equal(other.variations[0]!.duration_minutes, 60);
  const priceOnly = toSquareItem(o, 'LOC_E')!;
  assert.deepEqual([priceOnly.variations[0]!.price, priceOnly.variations[0]!.duration_minutes], [70, 60], 'override without a duration keeps the base duration');
});

/* ---------- Fix 3: script-safe JSON ---------- */

test('fix 3 jsonForScript: </script>, <!--, &, U+2028/2029 cannot break out of a <script> tag and round-trip intact', () => {
  const name = 'Evil</script><script>window.__xss=1</script><!-- & ' + String.fromCharCode(0x2028, 0x2029);
  const out = jsonForScript({ name });
  for (const c of ['<', '>', '&', String.fromCharCode(0x2028), String.fromCharCode(0x2029)]) assert.ok(!out.includes(c), out);
  assert.equal(JSON.parse(out).name, name);
  assert.equal(jsonForScript(undefined), 'null');
});

/* ---------- Fix 4: roster valves ---------- */

const sqItem = (item_id: string, extra: Partial<SquareItem> = {}): SquareItem => ({ item_id, name: item_id, price_from: 45, duration_minutes: 45, description: '', product_type: 'APPOINTMENTS_SERVICE', is_archived: false, variations: [], image_ids: [], ...extra });
const rosterRow = (slug: string, item_id: string): Row => ({ slug, name: slug, location: 'addison', item_id, tier: 'barber', role: 'Barber', is_active: true });

test('fix 4 isBarberItem: only APPOINTMENTS_SERVICE items are barbers (a missing product_type is retail)', () => {
  assert.equal(isBarberItem(sqItem('A'), new Set()), true);
  assert.equal(isBarberItem(sqItem('B', { product_type: null }), new Set()), false);
  assert.equal(isBarberItem(sqItem('C', { product_type: 'REGULAR' }), new Set()), false);
});

test('fix 4 newcomer cap: more than 5 new barbers in one shop ignores Square for that shop; 5 are accepted', () => {
  const rows = ['a', 'b', 'c', 'd'].map((s) => rosterRow(s, s.toUpperCase()));
  const base = rows.map((r) => sqItem(r.item_id));
  const six = mergeRoster({ rows, square: { addison: [...base, ...[1, 2, 3, 4, 5, 6].map((n) => sqItem(`NEW${n}`))] } });
  assert.equal(six.stats.added, 0);
  assert.match(six.warnings.join('\n'), /6 barbers that are not in barbers.json/);
  assert.deepEqual(six.rows, rows, 'shop passes through unchanged');
  const five = mergeRoster({ rows, square: { addison: [...base, ...[1, 2, 3, 4, 5].map((n) => sqItem(`NEW${n}`))] } });
  assert.equal(five.stats.added, 5);
});

/* ---------- Fix 5: hours, the file wins on any doubt ---------- */

const P = (d: string, a: string, b: string) => ({ day_of_week: d, start_local_time: a, end_local_time: b });
const WEEK = ['MON', 'TUE', 'WED', 'THU', 'FRI'].map((d) => P(d, '10:00:00', '19:00:00')).concat([P('SAT', '08:00:00', '15:00:00'), P('SUN', '09:00:00', '15:00:00')]);

test('fix 5 resolveHours: one skipped period (bad day, unreadable time, close before open, junk entry) keeps the file hours', () => {
  for (const bad of [P('FUNDAY', '10:00', '12:00'), P('TUE', 'ten', 'seven'), P('WED', '19:00', '10:00'), null]) {
    const r = resolveHours(FILE_HOURS, { id: 'L', timezone: 'America/Chicago', business_hours: { periods: [...WEEK, bad as never] } });
    assert.equal(r.hours_source, 'site', JSON.stringify(bad));
    assert.equal(r.hours, FILE_HOURS.hours);
    assert.ok(r.warnings.some((w) => /unusable, keeping the file hours/.test(w)));
  }
  assert.equal(periodsToHours([...WEEK, P('XYZ', '1', '2')]).skipped, 1);
});

test('fix 5 resolveHours: a clean week, a split shift and a midnight close still come from Square', () => {
  for (const periods of [WEEK, [...WEEK, P('TUE', '20:00:00', '21:00:00')], [...WEEK.filter((p) => p.day_of_week !== 'FRI'), P('FRI', '10:00:00', '00:00:00')]]) {
    assert.equal(resolveHours(FILE_HOURS, { id: 'L', timezone: 'America/Chicago', business_hours: { periods } }).hours_source, 'square');
  }
  assert.equal(resolveHours(FILE_HOURS, { id: 'L', timezone: 'America/New_York', business_hours: { periods: WEEK } }).hours_source, 'site');
});

/* ---------- Fix 6 + E: availability file sanitising ---------- */

test('fix 6/E parseFile: next 12345 hides the barber; soon keeps only strings; slots must be numbers; ok must be true', () => {
  const f = live({ addison: { ok: 'yes', fetched_at: fresh, barbers: {
    NUM: { next: 12345, soon: ['2026-10-28T20:00:00Z'] },
    MIX: { next: '2026-10-31T15:00:00Z', soon: ['2026-10-31T15:00:00Z', 7, null, { a: 1 }], slots_today: '3', slots_7d: 4, bookable: 'no' },
  } } });
  assert.equal(barberView(f, 'addison', 'NUM', NOW), null);
  assert.deepEqual(f.shops.addison!.barbers!.MIX, { next: '2026-10-31T15:00:00Z', soon: ['2026-10-31T15:00:00Z'], slots_7d: 4 });
  assert.equal(f.shops.addison!.ok, false);
  assert.equal(barberView(f, 'addison', 'MIX', NOW)?.state, 'amber', 'ok:false with a fresh block still shows (spec §3)');
});

test('fix 6 tz: an unknown time zone falls back to America/Chicago instead of throwing on every repaint', () => {
  assert.equal(validTz('Mars/Phobos'), 'America/Chicago');
  assert.equal(validTz('America/Denver'), 'America/Denver');
  const f = parseFile({ generated_at: fresh, tz: 'Mars/Phobos', shops: { addison: { ok: true, fetched_at: fresh, barbers: { B: { next: '2026-10-28T20:00:00Z', soon: ['2026-10-28T20:00:00Z'] } } } } });
  assert.equal(f.tz, 'America/Chicago');
  assert.equal(barberView(f, 'addison', 'B', NOW)?.state, 'green');
});

test('fix 6 slimFile: a barber without `next` stays "no data" (never turned into "Booked up"); damaged input never throws', () => {
  const slim = slimFile(live({ addison: { ok: true, fetched_at: fresh, barbers: { NONEXT: { soon: [] }, FULL: { next: null, soon: [] } } } }));
  assert.equal('NONEXT' in slim.shops.addison!.barbers!, false);
  assert.deepEqual(slim.shops.addison!.barbers!.FULL, { next: null, soon: [] });
  assert.doesNotThrow(() => slimFile({ generated_at: null, window_days: 7, tz: 'America/Chicago', shops: { a: null, b: { ok: true, barbers: { x: null } } } } as never));
});

test('fix 6 newer: a generated_at more than 2 h in the future never wins (and cannot stick); within 2 h it does', () => {
  const now = Date.parse('2026-10-28T18:00:00Z');
  const good = live({}, '2026-10-28T17:45:00Z');
  assert.equal(newer(good, live({}, '2026-10-29T18:00:00Z'), now), good);
  const soon = live({}, '2026-10-28T19:30:00Z');
  assert.equal(newer(good, soon, now), soon);
  const later = live({}, '2026-10-28T18:15:00Z');
  assert.equal(newer(live({}, '2026-10-29T18:00:00Z'), later, now), later, 'a future-dated current file loses to the next good one');
});

/* ---------- Fix 9: payment links are never lost; product alt text ---------- */

test('fix 9 ensurePaymentLinks: when a later create fails, the links already created come back on the error', async () => {
  const items = ['A', 'B'].map((n) => toRetailItem(
    { type: 'ITEM', id: n, present_at_all_locations: true, item_data: { name: `STMNT ${n}`, product_type: 'REGULAR', image_ids: ['I'], variations: [{ id: `V${n}`, present_at_all_locations: true, item_variation_data: { price_money: { amount: 2000 } } }] } },
    { locationId: 'LOC', images: new Map([['I', { url: 'https://img.test/a.jpg', caption: '' }]]), categories: new Map() },
  )!);
  const f = countCalls((n) => (n === 1 ? Response.json({ payment_link: { id: 'PL1', url: 'https://square.link/u/one' } }) : Response.json({ errors: [{ code: 'BAD_REQUEST' }] }, { status: 400 })));
  await assert.rejects(ensurePaymentLinks('t', 'LOC', items, new Map(), { store: {}, payment: {} }, { fetch: f.f, write: true, ...noSleep }), (e: unknown) => {
    const partial = (e as { partial?: { payment: Record<string, { url: string }>; created: string[] } }).partial;
    return Boolean(partial && partial.created.length === 1 && Object.values(partial.payment)[0]!.url === 'https://square.link/u/one');
  });
});

test('fix F productAlt: a doubled leading brand is dropped once, case-insensitively; other alts are untouched', () => {
  assert.equal(productAlt('STMNT STMNT NOMAD Classic Pomade', 'STMNT'), 'STMNT NOMAD Classic Pomade');
  assert.equal(productAlt('slick gorilla SLICK GORILLA Hair Styling Powder', 'SLICK GORILLA'), 'SLICK GORILLA Hair Styling Powder');
  assert.equal(productAlt('STMNT NOMAD Classic Pomade', 'STMNT'), 'STMNT NOMAD Classic Pomade');
  assert.equal(productAlt('H14 Sea Salt Spray', ''), 'H14 Sea Salt Spray');
});

test('fix 2 newcomer slug: a name with no letters falls back to a schema-valid slug built from the item id', () => {
  const r = mergeRoster({ rows: [], square: { addison: [sqItem('NEW_ITEM_1', { name: '!!!' })] } });
  assert.equal(r.rows[0]!.slug, 'barber-new-item-1');
  assert.match(String(r.rows[0]!.slug), /^[a-z0-9-]+$/);
});
