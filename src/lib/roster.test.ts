/* npm test  (node --test; Node 22.18+ runs .ts directly). No network: Square is faked. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBarberItem, mergeRoster, mergeRosterCheckingPhotos, photoTeamMember, slugify, cleanBio, squareBio, squarePhoto, BIO_MAX, type Row } from './roster.ts';
import { imageUrlsById, listSquareItems, toSquareItem, type CatalogObject, type SquareItem } from './square.ts';
import type { PhotoCheck } from './square-photos.ts';

const ADDISON = 'D11BVA91E8V3N';
const sq = (item_id: string, name: string, extra: Partial<SquareItem> = {}): SquareItem => ({
  item_id, name, price_from: 45, duration_minutes: 45, description: '', product_type: 'APPOINTMENTS_SERVICE', is_archived: false,
  variations: [], image_ids: [], image_url: null, ...extra,
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

test('toSquareItem: variations keep id, name, dollars, minutes, team members; image ids pass through', () => {
  const o = obj('X', {}, [{ cents: 6000, ms: 3600000 }, { cents: 4500, ms: 1800000, at: ['OTHER'] }, { ms: 900000 }]);
  o.item_data!.image_ids = ['IMG1'];
  o.item_data!.variations![0]!.item_variation_data = { ...o.item_data!.variations![0]!.item_variation_data, name: ' Haircut ', team_member_ids: ['TM1'] };
  o.item_data!.variations![2]!.item_variation_data = { ...o.item_data!.variations![2]!.item_variation_data, name: 'Consult', available_for_booking: false };
  const item = toSquareItem(o, ADDISON)!;
  assert.deepEqual(item.variations, [
    { id: 'X-v0', name: 'Haircut', price: 60, duration_minutes: 60, team_member_ids: ['TM1'], available_for_booking: true },
    { id: 'X-v2', name: 'Consult', price: null, duration_minutes: 15, team_member_ids: [], available_for_booking: false },
  ]);
  assert.deepEqual(item.image_ids, ['IMG1']);
  assert.equal(item.price_from, 60, 'the variation at another location no longer counts');
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

test('isBarberItem: the "No Show" fee item and items with no online-bookable variation are not barbers', () => {
  const ex = new Set<string>();
  const vb = (available_for_booking: boolean) => ({ id: 'V', name: 'Regular', price: 0, duration_minutes: 30, team_member_ids: [], available_for_booking });
  assert.equal(isBarberItem(sq('N1', 'No Show', { variations: [vb(false)] }), ex), false);
  assert.equal(isBarberItem(sq('N2', 'No-show', { variations: [vb(true)] }), ex), false);
  assert.equal(isBarberItem(sq('F1', 'Fee only', { variations: [vb(false)] }), ex), false, 'nothing bookable online');
  assert.equal(isBarberItem(sq('B1', 'Bella', { variations: [vb(false), { ...vb(true), name: 'Haircut' }] }), ex), true);
  assert.equal(isBarberItem(sq('B2', 'Nick'), ex), true, 'no variations listed (fixtures) still counts');
});

/* ---------- Bios from Square team member booking profiles ---------- */
const hv = (id: string, name: string, team: string[], price = 45) => ({ id, name, price, duration_minutes: 45, team_member_ids: team, available_for_booking: true });
// Shaped like the production profiles (2026-10-29): only some carry a description.
const PROFILES = new Map<string, { description?: string }>([
  ['TM_BIO', { description: '  Christian is extremely passionate\n\nabout barbering.   He specializes in shear work.  ' }],
  ['TM_KIDS', { description: 'Kids-cut specialist profile (a second team member).' }],
  ['TM_NONE', {}],
]);

test('cleanBio: trims, collapses whitespace, caps at 400 chars on a word boundary', () => {
  assert.equal(cleanBio('  a\n\n b\t c  '), 'a b c');
  assert.equal(cleanBio(undefined), '');
  const long = cleanBio(('word ').repeat(200));
  assert.ok(long.length <= BIO_MAX, `${long.length} chars`);
  assert.ok(long.endsWith('word…'));
  const noSpaces = cleanBio('x'.repeat(500));
  assert.equal(noSpaces.length, BIO_MAX);
});

test('squareBio: the standard-haircut variation\'s first team member, else the first staffed variation', () => {
  const item = { variations: [hv('K', 'Kids Haircut', ['TM_KIDS'], 30), hv('H', 'Haircut', ['TM_BIO', 'TM_KIDS'])] };
  assert.equal(squareBio(item, PROFILES), 'Christian is extremely passionate about barbering. He specializes in shear work.');
  assert.equal(squareBio({ variations: [hv('H', 'Haircut', []), hv('B', 'Beard', ['TM_KIDS'])] }, PROFILES), 'Kids-cut specialist profile (a second team member).');
  assert.equal(squareBio({ variations: [hv('H', 'Haircut', ['TM_NONE'])] }, PROFILES), '', 'profile without a description');
  assert.equal(squareBio({ variations: [hv('H', 'Haircut', ['TM_UNKNOWN'])] }, PROFILES), '');
  assert.equal(squareBio({ variations: [] }, PROFILES), '');
  assert.equal(squareBio(item, undefined), '');
  assert.equal(squareBio(item, new Map()), '');
});

test('mergeRoster profiles: an empty bio is filled from Square with bio_source square; a site bio always wins', () => {
  const withBio = { variations: [hv('H', 'Haircut', ['TM_BIO'])] };
  const { rows } = mergeRoster({
    rows: [
      row('reno', 'A1', 'addison', { bio: '', placeholder_fields: ['role', 'specialties', 'bio'] }),
      row('nick', 'A2'),
      row('blank', 'A3', 'addison', { bio: '   ' }),
      row('fake', 'A4', 'addison', { bio: 'Invented mockup copy.', placeholder_fields: ['bio'] }),
      row('nobio', 'A5', 'addison', { bio: '' }),
    ],
    square: { addison: [sq('A1', 'Reno', withBio), sq('A2', 'Nick', withBio), sq('A3', 'Blank', withBio), sq('A4', 'Fake', withBio), sq('A5', 'Nobio', { variations: [hv('H', 'Haircut', ['TM_NONE'])] })] },
    profiles: PROFILES,
  });
  const by = (slug: string) => rows.find((r) => r.slug === slug)!;
  const expected = 'Christian is extremely passionate about barbering. He specializes in shear work.';
  assert.equal(by('reno').bio, expected);
  assert.equal(by('reno').bio_source, 'square');
  assert.deepEqual(by('reno').placeholder_fields, ['role', 'specialties'], 'the Square bio is real copy, so it renders');
  assert.equal(by('nick').bio, 'nick bio', 'non-empty barbers.json bio wins');
  assert.equal('bio_source' in by('nick'), false);
  assert.equal(by('blank').bio, expected, 'whitespace-only counts as empty');
  assert.equal('placeholder_fields' in by('blank'), false, 'no placeholder list invented');
  assert.equal(by('fake').bio, expected, 'placeholder copy never renders, so Square replaces it');
  assert.deepEqual(by('fake').placeholder_fields, []);
  assert.equal(by('nobio').bio, '', 'no description in Square: unchanged');
  assert.equal('bio_source' in by('nobio'), false);
});

test('mergeRoster profiles: newcomers get the Square bio; no profiles = exactly as before', () => {
  const square = { addison: [sq('A1', 'Nick'), sq('NEW', 'Newbie', { variations: [hv('H', 'Haircut', ['TM_BIO'])] })] };
  const withP = mergeRoster({ rows: [row('nick', 'A1')], square, profiles: PROFILES }).rows.find((r) => r.item_id === 'NEW')!;
  assert.match(String(withP.bio), /^Christian is extremely passionate/);
  assert.equal(withP.bio_source, 'square');
  assert.deepEqual(withP.placeholder_fields, ['role', 'specialties', 'headshot']);
  assert.equal(withP.needs_profile, true, 'still needs a photo');
  const without = mergeRoster({ rows: [row('nick', 'A1')], square }).rows.find((r) => r.item_id === 'NEW')!;
  assert.equal(without.bio, '');
  assert.equal('bio_source' in without, false);
  assert.deepEqual(without.placeholder_fields, ['role', 'bio', 'specialties', 'headshot']);
});

test('mergeRoster profiles: rows of a shop that was not fetched are untouched', () => {
  const elm = row('javier', 'E1', 'elmhurst', { bio: '' });
  const { rows } = mergeRoster({ rows: [row('nick', 'A1'), elm], square: { addison: [sq('A1', 'Nick')] }, profiles: PROFILES });
  assert.deepEqual(rows.find((r) => r.slug === 'javier'), elm);
});

/* ---------- Headshots from Square (spec §4) ---------- */
// Real host shapes (production, read-only 2026-10-29); the hashes are made up.
const ITEM_IMG = 'https://items-images-production.s3.us-west-2.amazonaws.com/files/aaaa1111/original.jpeg';
const ITEM_IMG_2 = 'https://items-images-production.s3.us-west-2.amazonaws.com/files/bbbb2222/original.jpeg';
const STAFF_IMG = 'https://appointments-production-f.squarecdn.com/files/cccc3333/original.jpg';
const STAFF = new Map<string, { description?: string; profile_image_url?: string | null; display_name?: string }>([
  ['TM_ERIC', { display_name: 'Eric', profile_image_url: STAFF_IMG }],
  ['TM_BELLA', { display_name: 'Bella', profile_image_url: 'https://appointments-production-f.squarecdn.com/files/bella/original.jpg' }],
  ['TM_NICK', { display_name: 'Nick Celli', profile_image_url: 'https://appointments-production-f.squarecdn.com/files/nick/original.jpg' }],
  ['TM_NOPHOTO', { display_name: 'Fabi', profile_image_url: null }],
  ['TM_HTTP', { display_name: 'Http', profile_image_url: 'http://appointments-production-f.squarecdn.com/files/x/original.jpg' }],
]);

test('squarePhoto precedence: item image → staff photo → none', () => {
  const both = { name: 'Eric el Samurai', image_url: ITEM_IMG, variations: [hv('H', 'Haircut', ['TM_ERIC'])] };
  assert.deepEqual(squarePhoto(both, STAFF), { url: ITEM_IMG, from: 'item' }, 'the item image (what Square\'s booking page shows) wins');
  assert.deepEqual(squarePhoto({ ...both, image_url: null }, STAFF), { url: STAFF_IMG, from: 'profile' });
  assert.equal(squarePhoto({ ...both, image_url: null }, undefined), null, 'no profiles = no staff photo');
  assert.equal(squarePhoto({ name: 'Fabi', image_url: null, variations: [hv('H', 'Haircut', ['TM_NOPHOTO'])] }, STAFF), null);
  assert.equal(squarePhoto({ name: 'Nobody', image_url: null, variations: [] }, STAFF), null);
});

test('squarePhoto: only https URLs on the Square photo hosts count; others are ignored with a warning', () => {
  const warnings: string[] = [];
  const bad = ['http://items-images-production.s3.us-west-2.amazonaws.com/files/a/original.jpeg', 'https://evil.example/files/a.jpg', 'https://items-images-production.s3.us-west-2.amazonaws.com.evil.example/files/a.jpg', '/files/a.jpg', 'not a url', 'https://items-images-production.s3.us-west-2.amazonaws.com/other/a.jpg', 'https://u:p@appointments-production-f.squarecdn.com/files/a.jpg'];
  for (const image_url of bad) {
    assert.equal(squarePhoto({ name: 'X', image_url, variations: [] }, STAFF, { warnings, label: 'x' }), null, image_url);
  }
  assert.equal(warnings.length, bad.length);
  assert.match(warnings[0]!, /^x: Square item image ignored \(not an https URL on a Square photo host\)/);
  // A bad item image falls through to a good staff photo; a bad staff photo is ignored too.
  assert.deepEqual(squarePhoto({ name: 'Eric', image_url: 'https://evil.example/files/a.jpg', variations: [hv('H', 'Haircut', ['TM_ERIC'])] }, STAFF), { url: STAFF_IMG, from: 'profile' });
  const w2: string[] = [];
  assert.equal(squarePhoto({ name: 'Http', image_url: null, variations: [hv('H', 'Haircut', ['TM_HTTP'])] }, STAFF, { warnings: w2 }), null);
  assert.match(w2[0]!, /staff photo ignored/);
});

test('photoTeamMember: one team member, or the one whose name matches on a shared service, else none', () => {
  assert.equal(photoTeamMember({ name: 'Eric el Samurai', variations: [hv('H', 'Haircut', ['TM_ERIC'])] }, STAFF), 'TM_ERIC');
  const shared = [hv('H', 'Haircut', ['TM_NICK', 'TM_BELLA', 'TM_ERIC'])];
  assert.equal(photoTeamMember({ name: 'Bella', variations: shared }, STAFF), 'TM_BELLA');
  assert.equal(photoTeamMember({ name: 'Nick Celli', variations: shared }, STAFF), 'TM_NICK');
  assert.equal(photoTeamMember({ name: 'Christian', variations: shared }, STAFF), undefined, 'never a colleague\'s face');
  assert.equal(photoTeamMember({ name: 'Christian', variations: shared }, undefined), undefined);
  assert.equal(photoTeamMember({ name: 'Rudy', variations: [hv('H', 'Haircut', []), hv('B', 'Beard', ['TM_ERIC'])] }, STAFF), 'TM_ERIC', 'first staffed variation when the haircut has nobody');
});

test('mergeRoster photos: a Square photo sets headshot + headshot_source square; none keeps the row as it was', () => {
  const { rows, photos } = mergeRoster({
    rows: [
      row('eric', 'A1'),
      row('juan', 'A2', 'addison', { headshot_source: 'client', headshot: 'https://cms.example/juan.jpg' }),
      row('fabi', 'A3'),
      row('angel', 'A4', 'addison', { placeholder_fields: ['role', 'headshot'] }),
    ],
    square: { addison: [
      sq('A1', 'Eric', { image_url: ITEM_IMG, variations: [hv('H', 'Haircut', ['TM_ERIC'])] }),
      sq('A2', 'Juan', { image_url: ITEM_IMG_2 }),
      sq('A3', 'Fabi', { variations: [hv('H', 'Haircut', ['TM_NOPHOTO'])] }),
      sq('A4', 'Angel', { variations: [hv('H', 'Haircut', ['TM_ERIC'])] }),
    ] },
    profiles: STAFF,
  });
  const by = (slug: string) => rows.find((r) => r.slug === slug)!;
  assert.deepEqual([by('eric').headshot, by('eric').headshot_source], [ITEM_IMG, 'square']);
  assert.deepEqual([by('juan').headshot, by('juan').headshot_source], [ITEM_IMG_2, 'square'], 'Square wins over a hand-set remote headshot');
  assert.deepEqual([by('fabi').headshot, by('fabi').headshot_source], [undefined, 'instagram-profile'], 'no Square photo: row unchanged (local file renders)');
  assert.deepEqual([by('angel').headshot, by('angel').headshot_source], [STAFF_IMG, 'square']);
  assert.deepEqual(by('angel').placeholder_fields, ['role'], 'a real photo is no longer a placeholder field');
  assert.deepEqual(photos, { eric: 'item', juan: 'item', angel: 'profile' });
});

test('mergeRoster photos: newcomers get the Square photo; unfetched shops and rejected URLs are untouched', () => {
  const square = { addison: [sq('A1', 'Nick'), sq('NEW', 'Newbie', { image_url: ITEM_IMG })] };
  const fresh = mergeRoster({ rows: [row('nick', 'A1')], square }).rows.find((r) => r.item_id === 'NEW')!;
  assert.deepEqual([fresh.headshot, fresh.headshot_source, fresh.needs_profile], [ITEM_IMG, 'square', true]);
  assert.deepEqual(fresh.placeholder_fields, ['role', 'bio', 'specialties']);
  const elm = row('javier', 'E1', 'elmhurst');
  assert.deepEqual(mergeRoster({ rows: [row('nick', 'A1'), elm], square }).rows.find((r) => r.slug === 'javier'), elm);
  const rejected = mergeRoster({ rows: [row('nick', 'A1')], square: { addison: [sq('A1', 'Nick', { image_url: ITEM_IMG })] }, rejectPhotos: new Set([ITEM_IMG]) });
  assert.equal(rejected.rows[0]!.headshot_source, 'instagram-profile');
  assert.equal('headshot' in rejected.rows[0]!, false);
  assert.deepEqual(rejected.photos, {});
});

test('mergeRosterCheckingPhotos: a failed item image falls to the staff photo, then to the row; each URL checked once', async () => {
  const input = {
    rows: [row('eric', 'A1'), row('juan', 'A2'), row('reno', 'A3')],
    square: { addison: [
      sq('A1', 'Eric', { image_url: ITEM_IMG, variations: [hv('H', 'Haircut', ['TM_ERIC'])] }), // item 404 → staff ok
      sq('A2', 'Juan', { image_url: ITEM_IMG_2 }), // item times out, no staff photo → row (local file)
      sq('A3', 'Reno', { image_url: 'https://items-images-production.s3.us-west-2.amazonaws.com/files/ok/original.jpeg' }),
    ] },
    profiles: STAFF,
  };
  const asked: string[][] = [];
  const check = async (urls: string[]): Promise<PhotoCheck[]> => {
    asked.push(urls);
    return urls.map((url) => (url === ITEM_IMG ? { url, ok: false, reason: 'HTTP 404' } : url === ITEM_IMG_2 ? { url, ok: false, reason: 'timed out after 8 s' } : { url, ok: true }));
  };
  const res = await mergeRosterCheckingPhotos(input, check);
  const by = (slug: string) => res.rows.find((r) => r.slug === slug)!;
  assert.deepEqual([by('eric').headshot, by('eric').headshot_source], [STAFF_IMG, 'square']);
  assert.deepEqual([by('juan').headshot, by('juan').headshot_source], [undefined, 'instagram-profile']);
  assert.equal(by('reno').headshot_source, 'square');
  assert.deepEqual(res.photos, { eric: 'profile', reno: 'item' });
  assert.equal(asked.length, 2, 'second round only for the staff photo');
  assert.deepEqual(asked[1], [STAFF_IMG]);
  assert.equal(new Set(asked.flat()).size, asked.flat().length, 'no URL checked twice');
  assert.equal(res.photoWarnings.length, 2);
  assert.match(res.photoWarnings.join('\n'), /eric: Square photo failed the pre-check \(HTTP 404\)/);
  assert.match(res.photoWarnings.join('\n'), /juan: Square photo failed the pre-check \(timed out after 8 s\)/);
});

test('mergeRosterCheckingPhotos: a check that throws drops every Square photo; no Square photo = no check call', async () => {
  const input = { rows: [row('eric', 'A1')], square: { addison: [sq('A1', 'Eric', { image_url: ITEM_IMG })] } };
  const res = await mergeRosterCheckingPhotos(input, async () => { throw new Error('boom'); });
  assert.equal(res.rows[0]!.headshot_source, 'instagram-profile');
  assert.match(res.photoWarnings[0]!, /pre-check failed \(boom\)/);
  let calls = 0;
  const none = await mergeRosterCheckingPhotos({ rows: [row('eric', 'A1')], square: { addison: [sq('A1', 'Eric')] } }, async () => { calls++; return []; });
  assert.equal(calls, 0);
  assert.deepEqual(none.rows, mergeRoster({ rows: [row('eric', 'A1')], square: { addison: [sq('A1', 'Eric')] } }).rows);
});

/* ---------- square.ts: image ids → URLs (related IMAGE objects) ---------- */
// Shaped like the production catalog search with include_related_objects (2026-10-29): IMAGE, CATEGORY and TAX objects.
const relatedFixture = [
  { type: 'IMAGE', id: 'IMG_A', image_data: { name: '', url: 'https://items-images-production.s3.us-west-2.amazonaws.com/files/757c/original.jpeg', caption: '' } },
  { type: 'IMAGE', id: 'IMG_B', image_data: { url: 'https://items-images-production.s3.us-west-2.amazonaws.com/files/cfe0/original.jpeg' } },
  { type: 'IMAGE', id: 'IMG_EMPTY', image_data: { url: '' } },
  { type: 'IMAGE', id: 'IMG_GONE', is_deleted: true, image_data: { url: 'https://items-images-production.s3.us-west-2.amazonaws.com/files/dead/original.jpeg' } },
  { type: 'CATEGORY', id: 'CAT', category_data: { name: 'Barbers' } },
  { type: 'TAX', id: 'TAX' },
  null,
  'junk',
];

test('imageUrlsById: IMAGE objects with a url only', () => {
  const m = imageUrlsById(relatedFixture);
  assert.deepEqual([...m.keys()], ['IMG_A', 'IMG_B']);
  assert.equal(imageUrlsById(undefined).size, 0);
  assert.equal(imageUrlsById({ not: 'a list' }).size, 0);
});

test('toSquareItem: image_url = the first image id that resolves; ids kept; none = null', () => {
  const images = imageUrlsById(relatedFixture);
  const o = obj('X');
  o.item_data!.image_ids = ['IMG_MISSING', 'IMG_EMPTY', 'IMG_B', 'IMG_A'];
  const item = toSquareItem(o, ADDISON, images)!;
  assert.equal(item.image_url, 'https://items-images-production.s3.us-west-2.amazonaws.com/files/cfe0/original.jpeg');
  assert.deepEqual(item.image_ids, ['IMG_MISSING', 'IMG_EMPTY', 'IMG_B', 'IMG_A']);
  assert.equal(toSquareItem(obj('Y'), ADDISON, images)!.image_url, null, 'no image_ids');
  assert.equal(toSquareItem(o, ADDISON)!.image_url, null, 'no related objects passed');
});

test('listSquareItems: asks for related objects and resolves each page\'s images', async () => {
  const a = obj('A');
  a.item_data!.image_ids = ['IMG_A'];
  const b = obj('B');
  b.item_data!.image_ids = ['IMG_B'];
  const pages = [
    { objects: [a], related_objects: relatedFixture.slice(0, 1), cursor: 'p2' },
    { objects: [b, obj('C')], related_objects: relatedFixture.slice(1) },
  ];
  const bodies: Record<string, unknown>[] = [];
  const fakeFetch = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify(pages[bodies.length - 1]), { status: 200 });
  }) as unknown as typeof fetch;
  const items = await listSquareItems('tok', ADDISON, { fetch: fakeFetch });
  assert.equal(bodies[0]!.include_related_objects, true);
  assert.deepEqual(items.map((i) => [i.item_id, i.image_url]), [
    ['A', 'https://items-images-production.s3.us-west-2.amazonaws.com/files/757c/original.jpeg'],
    ['B', 'https://items-images-production.s3.us-west-2.amazonaws.com/files/cfe0/original.jpeg'],
    ['C', null],
  ]);
  // A malformed related_objects costs only the photos.
  const odd = (async () => new Response(JSON.stringify({ objects: [a], related_objects: 'nope' }), { status: 200 })) as unknown as typeof fetch;
  assert.deepEqual((await listSquareItems('tok', ADDISON, { fetch: odd })).map((i) => [i.item_id, i.image_url]), [['A', null]]);
});
