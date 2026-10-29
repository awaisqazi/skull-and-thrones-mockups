import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildJsonLd, locationNode, openingHoursSpecification, type SchemaContext, type SchemaLocation } from './schema.ts';
import { jsonForScript } from './safe.ts';

const site = { name: 'Skull & Thrones', alt_name: 'S&T Hair Society', slogan: 'Progress', email: 'a@b.co', instagram: 'https://www.instagram.com/x/', payment_accepted: 'Credit Card, Debit Card' };
const ROOT = 'https://example.test';
const ctx: SchemaContext = {
  site,
  abs: (p) => new URL(p, ROOT).href,
  orgId: `${ROOT}/#organization`,
  homeUrl: `${ROOT}/`,
  locationId: (s) => `${ROOT}/${s}/#salon`,
  logo: `${ROOT}/logo-512.png`,
  fallbackImage: `${ROOT}/og.png`,
  locationImage: (s) => (s === 'addison' ? `${ROOT}/a.jpg` : undefined),
};
const loc = (over: Partial<SchemaLocation> = {}): SchemaLocation => ({
  slug: 'addison', name: 'Addison', href: '/addison/', street: '1405 W Lake Street', city: 'Addison', region: 'IL', postal_code: '60101',
  phone_e164: '+16306138134', maps_url: 'https://www.google.com/maps?q=x',
  hours: [{ label: 'Mon – Fri', days: [1, 2, 3, 4, 5], opens: '10:00', closes: '19:00' }, { label: 'Sunday', days: [0], opens: '09:00', closes: '15:00' }],
  ...over,
});

test('opening hours come straight from the rendered hours rows', () => {
  const spec = openingHoursSpecification(loc().hours);
  assert.deepEqual(spec[0], { '@type': 'OpeningHoursSpecification', dayOfWeek: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'], opens: '10:00', closes: '19:00' });
  assert.deepEqual(spec[1]!.dayOfWeek, ['Sunday']);
});

test('location node: HairSalon (schema.org has no BarberShop), no ReserveAction, no invented geo', () => {
  const n = locationNode(loc(), ctx) as Record<string, any>;
  assert.equal(n['@type'], 'HairSalon');
  assert.equal(n['@id'], `${ROOT}/addison/#salon`);
  assert.equal(n.url, `${ROOT}/addison/`);
  assert.equal(n.image, `${ROOT}/a.jpg`);
  assert.equal(n.telephone, '+16306138134');
  assert.equal(n.address.addressCountry, 'US');
  assert.equal('potentialAction' in n, false);
  assert.equal('geo' in n, false);
  assert.equal(n.hasMap, 'https://www.google.com/maps?q=x');
  assert.deepEqual(n.sameAs, [site.instagram]);
  assert.deepEqual(n.parentOrganization, { '@id': ctx.orgId });
});

test('name follows the Google listing name when set, else the site name', () => {
  assert.equal((locationNode(loc({ google_listing_name: 'Skull & Thrones Hair Society' }), ctx) as any).name, 'Skull & Thrones Hair Society');
  assert.equal((locationNode(loc(), ctx) as any).name, 'Skull & Thrones');
});

test('a shop without its own photo falls back to the site image', () => {
  assert.equal((locationNode(loc({ slug: 'elmhurst' }), ctx) as any).image, `${ROOT}/og.png`);
});

test('google_maps_url feeds hasMap and sameAs; coordinates feed geo only when both exist', () => {
  const url = 'https://maps.app.goo.gl/abc';
  const n = locationNode(loc({ google_maps_url: url, latitude: 41.93, longitude: -88.0 }), ctx) as Record<string, any>;
  assert.equal(n.hasMap, url);
  assert.deepEqual(n.sameAs, [site.instagram, url]);
  assert.deepEqual(n.geo, { '@type': 'GeoCoordinates', latitude: 41.93, longitude: -88.0 });
  assert.equal('geo' in (locationNode(loc({ latitude: 41.9, longitude: null }), ctx) as object), false);
  assert.equal((locationNode(loc({ google_maps_url: null }), ctx) as any).hasMap, 'https://www.google.com/maps?q=x');
});

test('graph: the brand lists every shop by @id and each @id resolves inside the document', () => {
  const g = buildJsonLd([loc(), loc({ slug: 'elmhurst', name: 'Elmhurst', href: '/elmhurst/' })], ctx);
  const nodes = g['@graph'] as Record<string, any>[];
  const ids = new Set(nodes.map((n) => n['@id']));
  const org = nodes[0]!;
  assert.equal(org['@type'], 'Organization');
  assert.equal(org.url, `${ROOT}/`);
  assert.deepEqual(org.subOrganization, [{ '@id': `${ROOT}/addison/#salon` }, { '@id': `${ROOT}/elmhurst/#salon` }]);
  for (const ref of org.subOrganization) assert.ok(ids.has(ref['@id']));
  for (const n of nodes.slice(1)) assert.ok(ids.has(n.parentOrganization['@id']));
});

test('output survives the script-tag escaping and parses back unchanged', () => {
  const g = buildJsonLd([loc({ street: '1 <script>&' })], ctx);
  const text = jsonForScript(g);
  assert.ok(!/[<>&]/.test(text));
  assert.deepEqual(JSON.parse(text), JSON.parse(JSON.stringify(g)));
});
