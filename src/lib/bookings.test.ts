/* npm test (node --test). No network: Square is faked with responses shaped like the real API. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickBookableVariation, searchAvailability, summarise, localDate, SquareApiError, type Availability,
  listTeamMemberBookingProfiles, profilesById, bookableFrom, isAuthFailure,
} from './bookings.ts';
import type { SquareVariation } from './square.ts';

const TZ = 'America/Chicago';
const v = (id: string, name: string, price: number | null, team: string[] = ['TM1'], extra: Partial<SquareVariation> = {}): SquareVariation => ({
  id, name, price, duration_minutes: 45, team_member_ids: team, available_for_booking: true, ...extra,
});

/* Shaped like a real POST /v2/bookings/availability/search response (Square returns "errors": [] on success). */
const seg = { duration_minutes: 45, team_member_id: 'TM1', service_variation_id: 'VAR_HAIRCUT', service_variation_version: 1730000000000 };
const squareResponse = (starts: string[]) => ({
  availabilities: starts.map((start_at) => ({ start_at, location_id: 'LOC1', appointment_segments: [seg] })),
  errors: [],
});

test('pickBookableVariation: cheapest priced "haircut" variation wins over cheaper non-haircut ones', () => {
  const pick = pickBookableVariation({ variations: [v('B', 'Beard trim', 20), v('H2', 'Haircut + beard', 60), v('H1', "Men's Haircut", 45)] })!;
  assert.equal(pick.variation.id, 'H1');
  assert.equal(pick.team_member_id, 'TM1');
});

test('pickBookableVariation: no haircut → cheapest priced; no prices → first variation', () => {
  assert.equal(pickBookableVariation({ variations: [v('X', 'Fade', 50), v('Y', 'Line up', 25)] })!.variation.id, 'Y');
  assert.equal(pickBookableVariation({ variations: [v('X', 'Consult', null), v('Y', 'Cut', 0)] })!.variation.id, 'X');
});

test('pickBookableVariation: skips variations not bookable online, prefers ones with a team member', () => {
  const pick = pickBookableVariation({ variations: [v('H0', 'Haircut', 30, [], {}), v('OFF', 'Haircut', 10, ['TM9'], { available_for_booking: false }), v('B', 'Beard', 25, ['TM2'])] })!;
  assert.equal(pick.variation.id, 'B', 'the haircut has nobody on it and the cheaper one is not bookable');
  assert.equal(pick.team_member_id, 'TM2');
  const none = pickBookableVariation({ variations: [v('H', 'Haircut', 40, [])] })!;
  assert.equal(none.team_member_id, null, 'nobody assigned anywhere: still picked, team member null');
  assert.equal(pickBookableVariation({ variations: [] }), null);
  assert.equal(pickBookableVariation({ variations: [v('OFF', 'Haircut', 40, ['TM1'], { available_for_booking: false })] }), null);
});

test('summarise: drops past slots, de-duplicates, sorts, first 3, counts today in shop time', () => {
  // 2026-10-28 15:00 CDT = 20:00Z. Chicago "today" ends at 2026-10-29T05:00Z.
  const now = new Date('2026-10-28T20:00:00Z');
  const slots: Availability[] = squareResponse([
    '2026-10-29T15:00:00Z', // tomorrow 10:00 AM
    '2026-10-28T19:30:00Z', // already past
    '2026-10-28T21:00:00Z', // today 4:00 PM
    '2026-10-28T20:15:00Z', // today 3:15 PM
    '2026-10-28T20:15:00Z', // duplicate segment
    '2026-10-29T04:30:00Z', // today 11:30 PM Chicago (tomorrow in UTC)
    'not a date',
  ]).availabilities;
  const s = summarise(slots, now, TZ);
  assert.deepEqual(s, {
    next: '2026-10-28T20:15:00Z',
    soon: ['2026-10-28T20:15:00Z', '2026-10-28T21:00:00Z', '2026-10-29T04:30:00Z'],
    slots_today: 3,
    slots_7d: 4,
  });
});

test('summarise: nothing open → next null, empty soon; slots past the window are ignored', () => {
  const now = new Date('2026-10-28T20:00:00Z');
  assert.deepEqual(summarise([], now, TZ), { next: null, soon: [], slots_today: 0, slots_7d: 0 });
  assert.equal(summarise([{ start_at: '2026-11-20T15:00:00Z' }], now, TZ).next, null);
});

test('localDate uses the shop time zone, not UTC', () => {
  assert.equal(localDate(new Date('2026-10-29T04:30:00Z'), TZ), '2026-10-28');
});

test('searchAvailability: POSTs the spec request with auth + version headers', async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  const fakeFetch = (async (url: string, init: RequestInit) => {
    seen = { url, init };
    return new Response(JSON.stringify(squareResponse(['2026-10-29T15:00:00Z'])), { status: 200 });
  }) as unknown as typeof fetch;
  const start = new Date('2026-10-28T20:00:00Z'), end = new Date('2026-11-04T20:00:00Z');
  const out = await searchAvailability('tok', 'LOC1', 'VAR_HAIRCUT', 'TM1', { start, end }, { fetch: fakeFetch, apiBase: 'https://sandbox.test' });
  assert.equal(out.length, 1);
  assert.equal(seen!.url, 'https://sandbox.test/v2/bookings/availability/search');
  const h = seen!.init.headers as Record<string, string>;
  assert.equal(h.Authorization, 'Bearer tok');
  assert.ok(h['Square-Version']);
  assert.deepEqual(JSON.parse(String(seen!.init.body)), {
    query: { filter: {
      start_at_range: { start_at: '2026-10-28T20:00:00.000Z', end_at: '2026-11-04T20:00:00.000Z' },
      location_id: 'LOC1',
      segment_filters: [{ service_variation_id: 'VAR_HAIRCUT', team_member_id_filter: { any: ['TM1'] } }],
    } },
  });
});

test('searchAvailability: retries 429/5xx at most twice with backoff, then throws', async () => {
  const waits: number[] = [];
  let calls = 0;
  const flaky = (async () => {
    calls++;
    if (calls === 1) return new Response(JSON.stringify({ errors: [{ category: 'RATE_LIMIT_ERROR', code: 'RATE_LIMITED' }] }), { status: 429, headers: { 'Retry-After': '3' } });
    if (calls === 2) return new Response('{}', { status: 503 });
    return new Response(JSON.stringify(squareResponse(['2026-10-29T15:00:00Z'])), { status: 200 });
  }) as unknown as typeof fetch;
  const w = { start: new Date(), end: new Date(Date.now() + 86400000) };
  const sleep = async (ms: number) => { waits.push(ms); };
  assert.equal((await searchAvailability('t', 'L', 'V', 'T', w, { fetch: flaky, sleep })).length, 1);
  assert.deepEqual(waits, [3000, 2000], 'Retry-After honoured, then exponential backoff');

  calls = 0;
  const always429 = (async () => { calls++; return new Response('{}', { status: 429 }); }) as unknown as typeof fetch;
  await assert.rejects(searchAvailability('t', 'L', 'V', 'T', w, { fetch: always429, sleep }), /HTTP 429/);
  assert.equal(calls, 3, 'one try + two retries');
});

test('searchAvailability: auth errors are not retried and keep Square\'s detail', async () => {
  let calls = 0;
  const notOnboarded = (async () => {
    calls++;
    return new Response(JSON.stringify({ errors: [{ category: 'AUTHENTICATION_ERROR', code: 'UNAUTHORIZED', detail: 'Merchant not onboarded to Appointments' }] }), { status: 401 });
  }) as unknown as typeof fetch;
  const w = { start: new Date(), end: new Date(Date.now() + 86400000) };
  await assert.rejects(
    searchAvailability('t', 'L', 'V', 'T', w, { fetch: notOnboarded, sleep: async () => {} }),
    (e: unknown) => e instanceof SquareApiError && e.status === 401 && /UNAUTHORIZED: Merchant not onboarded to Appointments/.test(e.message),
  );
  assert.equal(calls, 1);
});

test('pickBookableVariation: the plain "Haircut" beats a cheaper "Kids Haircut" (production catalogs list both)', () => {
  const pick = pickBookableVariation({ variations: [v('HB', 'Haircut and Beard', 75), v('K', 'Kids Haircut', 40), v('H', 'Haircut', 65), v('B', 'Beard Grooming', 30)] })!;
  assert.equal(pick.variation.id, 'H');
  const noPlain = pickBookableVariation({ variations: [v('K', 'Kids Haircut (12 and under)', 35), v('L', 'Long Length Haircut', 70), v('M', "Men's haircut", 50)] })!;
  assert.equal(noPlain.variation.id, 'M', 'not kids, not long-length');
});

/* ---------- Team member booking profiles (GET /v2/bookings/team-member-booking-profiles) ---------- */
// Shaped like the real production response (2026-10-29): description only when a bio is typed in Square,
// profile_image_url on some, no is_bookable key never seen but tolerated.
const profilePage = (profiles: Record<string, unknown>[], cursor?: string) => ({ team_member_booking_profiles: profiles, ...(cursor ? { cursor } : {}), errors: [] });

test('listTeamMemberBookingProfiles: GET per location, follows cursor, maps and trims fields', async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const pages = [
    profilePage([
      { team_member_id: 'TM1', display_name: ' Christian ', is_bookable: true, description: '  Shear work and classic cuts.  ' },
      { team_member_id: 'TM2', display_name: 'Front Desk', is_bookable: false },
    ], 'NEXT'),
    profilePage([{ team_member_id: 'TM3', display_name: 'Elyse', profile_image_url: 'https://x.test/a.jpg' }, { display_name: 'no id' }]),
  ];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response(JSON.stringify(pages[seen.length - 1]), { status: 200 });
  }) as unknown as typeof fetch;
  const out = await listTeamMemberBookingProfiles('tok', 'LOC1', { fetch: fakeFetch, apiBase: 'https://sq.test' });
  assert.deepEqual(out, [
    { team_member_id: 'TM1', display_name: 'Christian', is_bookable: true, description: 'Shear work and classic cuts.' },
    { team_member_id: 'TM2', display_name: 'Front Desk', is_bookable: false, description: '' },
    { team_member_id: 'TM3', display_name: 'Elyse', is_bookable: true, description: '' },
  ], 'is_bookable unset counts as bookable; a profile without an id is dropped');
  assert.equal(seen.length, 2);
  const u0 = new URL(seen[0]!.url), u1 = new URL(seen[1]!.url);
  assert.equal(u0.origin + u0.pathname, 'https://sq.test/v2/bookings/team-member-booking-profiles');
  assert.deepEqual([u0.searchParams.get('location_id'), u0.searchParams.get('limit'), u0.searchParams.get('cursor')], ['LOC1', '100', null]);
  assert.equal(u1.searchParams.get('cursor'), 'NEXT');
  assert.equal(seen[0]!.init.method, 'GET');
  assert.equal(seen[0]!.init.body, undefined, 'a GET carries no body');
  assert.equal((seen[0]!.init.headers as Record<string, string>).Authorization, 'Bearer tok');
});

test('listTeamMemberBookingProfiles: same retry policy as searchAvailability; 401 is not retried', async () => {
  let calls = 0;
  const waits: number[] = [];
  const flaky = (async () => {
    calls++;
    return calls === 1 ? new Response('{}', { status: 502 }) : new Response(JSON.stringify(profilePage([{ team_member_id: 'TM1', is_bookable: false }])), { status: 200 });
  }) as unknown as typeof fetch;
  const sleep = async (ms: number) => { waits.push(ms); };
  assert.equal((await listTeamMemberBookingProfiles('t', 'L', { fetch: flaky, sleep }))[0]!.is_bookable, false);
  assert.deepEqual(waits, [1000]);

  calls = 0;
  const rejected = (async () => { calls++; return new Response(JSON.stringify({ errors: [{ category: 'AUTHENTICATION_ERROR', code: 'UNAUTHORIZED', detail: 'This request could not be authorized.' }] }), { status: 401 }); }) as unknown as typeof fetch;
  await assert.rejects(listTeamMemberBookingProfiles('t', 'L', { fetch: rejected, sleep }), (e: unknown) =>
    e instanceof SquareApiError && e.status === 401 && /^booking profiles failed \(HTTP 401\): UNAUTHORIZED/.test(e.message) && isAuthFailure(e));
  assert.equal(calls, 1);

  const down = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
  await assert.rejects(listTeamMemberBookingProfiles('t', 'L', { fetch: down, sleep }), (e: unknown) => e instanceof SquareApiError && e.status === 0 && !isAuthFailure(e));
});

test('listTeamMemberBookingProfiles: gives up after 20 pages instead of looping on a bad cursor', async () => {
  let calls = 0;
  const endless = (async () => { calls++; return new Response(JSON.stringify(profilePage([], 'AGAIN')), { status: 200 }); }) as unknown as typeof fetch;
  await assert.rejects(listTeamMemberBookingProfiles('t', 'L', { fetch: endless }), /more than 20 pages/);
  assert.equal(calls, 20);
});

test('isAuthFailure: 401/403 from either client; outages and other errors are not', () => {
  assert.equal(isAuthFailure(new SquareApiError('x', 403)), true);
  assert.equal(isAuthFailure(new SquareApiError('x', 503)), false);
  assert.equal(isAuthFailure(new SquareApiError('x', 0)), false);
  // listSquareItems (square.ts) throws plain Errors with the status in the message.
  assert.equal(isAuthFailure(new Error('Square catalog search failed (HTTP 401): UNAUTHORIZED')), true);
  assert.equal(isAuthFailure(new Error('Square catalog search failed (HTTP 403): FORBIDDEN')), true);
  assert.equal(isAuthFailure(new Error('Square catalog search failed (HTTP 500): INTERNAL_SERVER_ERROR')), false);
  assert.equal(isAuthFailure(new Error('fetch failed')), false);
  assert.equal(isAuthFailure(undefined), false);
});

test('bookableFrom: profile flag wins; missing from the list = bookable; no list = unknown', () => {
  const m = profilesById([
    { team_member_id: 'ON', display_name: 'On', is_bookable: true, description: '' },
    { team_member_id: 'OFF', display_name: 'Off', is_bookable: false, description: '' },
  ]);
  assert.equal(bookableFrom(m, 'ON'), true);
  assert.equal(bookableFrom(m, 'OFF'), false);
  assert.equal(bookableFrom(m, 'NOT_LISTED'), true);
  assert.equal(bookableFrom(null, 'OFF'), undefined);
});
