/* npm test  (node --test; Node 22.18+ runs .ts directly). No network: Square is faked. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeRoster, slugify, type Row } from './roster.ts';
import { listSquareItems, toSquareItem, type CatalogObject, type SquareItem } from './square.ts';

const ADDISON = 'D11BVA91E8V3N';
const sq = (item_id: string, name: string, extra: Partial<SquareItem> = {}): SquareItem => ({
  item_id, name, price_from: 45, duration_minutes: 45, description: '', product_type: 'APPOINTMENTS_SERVICE', is_archived: false, ...extra,
});
const row = (slug: string, item_id: string, location = 'addison', extra: Record<string, unknown> = {}): Row => ({
  slug, name: slug[0]!.toUpperCase() + slug.slice(1), location, item_id, tier: 'barber', role: 'Barber', haircut_from: 40,
  headshot_source: 'instagram-profile', bio: `${slug} bio`, specialties: ['Fades'], sort_order: 3, is_active: true, ...extra,
});

test('matched rows: Square supplies name/price/duration, JSON keeps profile fields', () => {
  const { rows, stats } = mergeRoster({
    rows: [row('nick', 'A1')],
    square: { addison: [sq('A1', 'Nick', { price_from: 55.0, duration_minutes: 60, description: 'Fades + beards' })] },
  });
  assert.equal(stats.matched, 1);
  assert.deepEqual(
    { name: rows[0]!.name, haircut_from: rows[0]!.haircut_from, duration_minutes: rows[0]!.duration_minutes, square_note: rows[0]!.square_note, bio: rows[0]!.bio, slug: rows[0]!.slug, needs_profile: rows[0]!.needs_profile },
    { name: 'Nick', haircut_from: 55, duration_minutes: 60, square_note: 'Fades + beards', bio: 'nick bio', slug: 'nick', needs_profile: false },
  );
});

test('new Square item gets an auto slug and needs_profile, sorted after the shop', () => {
  const { rows, warnings, stats } = mergeRoster({
    rows: [row('nick', 'A1', 'addison', { sort_order: 7 })],
    square: { addison: [sq('A1', 'Nick'), sq('B2', 'José Ñúñez Jr.', { price_from: null })] },
  });
  assert.equal(stats.added, 1);
  const added = rows.find((r) => r.item_id === 'B2')!;
  assert.equal(added.slug, 'jose-nunez-jr');
  assert.equal(added.needs_profile, true);
  assert.equal(added.bio, '');
  assert.equal(added.sort_order, 8);
  assert.equal('haircut_from' in added, false, 'no invented price when Square has none');
  assert.match(warnings.join('\n'), /needs photo \+ bio/);
});

test('auto slugs never collide with existing slugs', () => {
  const { rows } = mergeRoster({ rows: [row('nick', 'A1')], square: { addison: [sq('A1', 'Nick'), sq('C3', 'Nick')] } });
  assert.equal(rows.find((r) => r.item_id === 'C3')!.slug, 'nick-2');
});

test('JSON row missing from Square is deactivated with a warning', () => {
  const { rows, warnings, stats } = mergeRoster({ rows: [row('nick', 'A1'), row('gone', 'Z9')], square: { addison: [sq('A1', 'Nick')] } });
  assert.equal(stats.deactivated, 1);
  assert.equal(rows.find((r) => r.slug === 'gone')!.is_active, false);
  assert.match(warnings.join('\n'), /gone: item Z9 is no longer in Square/);
});

test('safety valve: Square hiding most of a shop is ignored for that shop', () => {
  const shop = ['a', 'b', 'c', 'd', 'e'].map((x) => row(x, x.toUpperCase()));
  const { rows, warnings, stats } = mergeRoster({ rows: shop, square: { addison: [sq('A', 'A'), sq('NEW', 'Newbie')] } });
  assert.equal(stats.deactivated, 0);
  assert.equal(stats.added, 0);
  assert.deepEqual(rows, shop);
  assert.match(warnings[0]!, /would hide 4 of 5/);
  assert.equal(mergeRoster({ rows: shop, square: { addison: [sq('A', 'A')] }, maxDeactivateShare: 1 }).stats.deactivated, 4);
});

test('rows for a shop that was not fetched pass through unchanged', () => {
  const elm = row('bella', 'E1', 'elmhurst');
  const { rows, stats } = mergeRoster({ rows: [row('nick', 'A1'), elm], square: { addison: [sq('A1', 'Nick')] } });
  assert.equal(stats.passthrough, 1);
  assert.deepEqual(rows.find((r) => r.slug === 'bella'), elm);
});

test('any-artist, archived and retail items are not barbers', () => {
  const { rows, stats } = mergeRoster({
    rows: [],
    square: { addison: [sq('ANY', 'Any artist available'), sq('OLD', 'Old', { is_archived: true }), sq('PASTE', 'Matte paste', { product_type: 'REGULAR' }), sq('OK', 'Rudy')] },
    excludeItemIds: ['ANY'],
  });
  assert.deepEqual(rows.map((r) => r.item_id), ['OK']);
  assert.equal(stats.added, 1);
});

test('Square location wins over barbers.json location', () => {
  const { rows, warnings } = mergeRoster({ rows: [row('nick', 'A1', 'addison')], square: { addison: [], elmhurst: [sq('A1', 'Nick')] } });
  assert.equal(rows[0]!.location, 'elmhurst');
  assert.match(warnings[0]!, /using Square/);
});

test('slugify', () => {
  assert.equal(slugify('Eric "El Samurai"'), 'eric-el-samurai');
  assert.equal(slugify('Ánh & Co'), 'anh-and-co');
});

/* ---------- Square client ---------- */
const obj = (id: string, extra: Partial<CatalogObject> = {}, variations: { cents?: number; ms?: number; at?: string[] }[] = [{ cents: 4500, ms: 2700000 }]): CatalogObject => ({
  type: 'ITEM', id, present_at_all_locations: false, present_at_location_ids: [ADDISON],
  item_data: {
    name: id, product_type: 'APPOINTMENTS_SERVICE',
    variations: variations.map((v, i) => ({
      id: `${id}-v${i}`, present_at_all_locations: !v.at, present_at_location_ids: v.at ?? [],
      item_variation_data: { ...(v.cents != null ? { price_money: { amount: v.cents, currency: 'USD' } } : {}), ...(v.ms != null ? { service_duration: v.ms } : {}) },
    })),
  },
  ...extra,
});

test('toSquareItem: lowest-priced variation, cents to dollars, ms to minutes', () => {
  const item = toSquareItem(obj('X', {}, [{ cents: 6000, ms: 3600000 }, { cents: 4500, ms: 1800000 }, { ms: 900000 }]), ADDISON)!;
  assert.equal(item.price_from, 45);
  assert.equal(item.duration_minutes, 30);
});

test('toSquareItem: location filtering', () => {
  assert.equal(toSquareItem(obj('X', { present_at_location_ids: ['OTHER'] }), ADDISON), null);
  assert.ok(toSquareItem(obj('X', { present_at_all_locations: true, present_at_location_ids: [] }), ADDISON));
  assert.equal(toSquareItem(obj('X', { present_at_all_locations: true, absent_at_location_ids: [ADDISON] }), ADDISON), null);
});

test('listSquareItems paginates with cursor and sends the auth + version headers', async () => {
  const calls: { body: Record<string, unknown>; headers: Record<string, string> }[] = [];
  const pages = [{ objects: [obj('A')], cursor: 'next' }, { objects: [obj('B'), obj('C', { present_at_location_ids: ['OTHER'] })] }];
  const fakeFetch = (async (_url: string, init: RequestInit) => {
    calls.push({ body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> });
    return new Response(JSON.stringify(pages[calls.length - 1]), { status: 200 });
  }) as unknown as typeof fetch;
  const items = await listSquareItems('tok', ADDISON, { fetch: fakeFetch });
  assert.deepEqual(items.map((i) => i.item_id), ['A', 'B']);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0]!.body.object_types, ['ITEM']);
  assert.equal(calls[1]!.body.cursor, 'next');
  assert.equal(calls[0]!.headers.Authorization, 'Bearer tok');
  assert.ok(calls[0]!.headers['Square-Version']);
});

test('listSquareItems throws on API errors (the loader catches and falls back)', async () => {
  const fakeFetch = (async () => new Response(JSON.stringify({ errors: [{ category: 'AUTHENTICATION_ERROR', code: 'UNAUTHORIZED' }] }), { status: 401 })) as unknown as typeof fetch;
  await assert.rejects(listSquareItems('bad', ADDISON, { fetch: fakeFetch }), /HTTP 401.*UNAUTHORIZED/);
});
