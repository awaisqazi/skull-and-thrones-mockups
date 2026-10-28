/* npm test  (node --test). No network: Square is faked with fixtures shaped like the real Catalog / Inventory responses. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BRANDS, allowedBrand, brandOf, ensurePaymentLinks, fetchSquareProducts, fetchStock, listRetailItems, mergeShopProducts,
  paymentLinkRequest, pickVariation, resolveCreds, stockLabel, toProductRow, toRetailItem,
  type BuyLinks, type ParseContext, type ProductRow, type RawCatalogObject, type RetailItem,
} from './square-products.ts';

const LOC = 'LOC1';
const ctx = (extra: Partial<ParseContext> = {}): ParseContext => ({
  locationId: LOC,
  images: new Map([['IMG1', { url: 'https://items-images-production.s3.amazonaws.com/files/a/original.jpeg', caption: 'Tub of pomade' }]]),
  categories: new Map([['CAT_H14', 'H14'], ['CAT_FEAT', 'Featured'], ['CAT_POMADE', 'Pomade']]),
  ...extra,
});

const variation = (id: string, cents: number | null, extra: Record<string, unknown> = {}) => ({
  type: 'ITEM_VARIATION', id, present_at_all_locations: true,
  item_variation_data: { name: 'Regular', sku: `SKU-${id}`, pricing_type: cents == null ? 'VARIABLE_PRICING' : 'FIXED_PRICING', price_money: cents == null ? undefined : { amount: cents, currency: 'USD' }, ...extra },
});
const item = (id: string, name: string, variations: ReturnType<typeof variation>[], d: Record<string, unknown> = {}, top: Record<string, unknown> = {}): RawCatalogObject => ({
  type: 'ITEM', id, present_at_all_locations: true,
  item_data: { name, product_type: 'REGULAR', image_ids: ['IMG1'], variations, ...d },
  ...top,
} as RawCatalogObject);
const parse = (o: RawCatalogObject, c = ctx()): RetailItem => toRetailItem(o, c)!;

test('brand allowlist is case-insensitive and trims; brandOf prefers a brand category over the name', () => {
  assert.deepEqual([...BRANDS], ['STMNT', 'H14', 'SLICK GORILLA']);
  assert.equal(allowedBrand(' Stmnt '), true);
  assert.equal(allowedBrand('Slick Gorilla'), true);
  assert.equal(allowedBrand('Wahl'), false);
  assert.equal(allowedBrand(undefined), false);
  assert.equal(brandOf('STMNT NOMAD Classic Pomade', []), 'STMNT');
  assert.equal(brandOf('Slick Gorilla Sea Salt Spray', []), 'SLICK GORILLA');
  assert.equal(brandOf('Raw Matte Clay', ['h14']), 'H14');
  assert.equal(brandOf('H14X Clay', []), null, 'prefix must be a whole word');
  assert.equal(brandOf('Wahl Magic Clip', ['Clippers']), null);
});

test('toRetailItem: keeps live retail items at the location, drops services, archived, other locations', () => {
  const ok = item('I1', 'H14 Styling Powder', [variation('V1', 1800)], { categories: [{ id: 'CAT_POMADE' }] });
  const r = parse(ok);
  assert.equal(r.vendor, 'H14');
  assert.equal(r.category, 'Pomade');
  assert.equal(r.variations[0]!.cents, 1800);
  assert.deepEqual(r.image_urls, ['https://items-images-production.s3.amazonaws.com/files/a/original.jpeg']);

  assert.equal(toRetailItem(item('I2', 'Haircut', [variation('V2', 4500)], { product_type: 'APPOINTMENTS_SERVICE' }), ctx()), null, 'service');
  assert.equal(toRetailItem(item('I3', 'Old', [variation('V3', 100)], { is_archived: true }), ctx()), null, 'archived');
  assert.equal(toRetailItem(item('I4', 'Gone', [variation('V4', 100)], {}, { is_deleted: true }), ctx()), null, 'deleted');
  assert.equal(toRetailItem(item('I5', 'Elsewhere', [variation('V5', 100)], {}, { present_at_all_locations: false, present_at_location_ids: ['OTHER'] }), ctx()), null, 'other location');
  assert.equal(toRetailItem(item('I6', 'No type', [variation('V6', 100)], { product_type: undefined }), ctx())?.name, 'No type', 'missing product_type counts as REGULAR');
});

test('toRetailItem: location overrides win for price, tracking and sold_out; variable pricing has no price', () => {
  const r = parse(item('I1', 'STMNT Pomade', [
    variation('V1', 2495, { track_inventory: false, location_overrides: [{ location_id: LOC, price_money: { amount: 2295 }, track_inventory: true, sold_out: false }] }),
    variation('V2', null),
  ]));
  assert.equal(r.variations[0]!.cents, 2295);
  assert.equal(r.variations[0]!.tracked, true);
  assert.equal(r.variations[1]!.cents, null);
});

test('pickVariation: cheapest sellable; tracked with no count = out of stock; untracked is always in stock', () => {
  const r = parse(item('I1', 'STMNT Pomade', [
    variation('V_SMALL', 1500, { track_inventory: true }),
    variation('V_BIG', 2500, { track_inventory: true }),
  ]));
  assert.equal(pickVariation(r, new Map([['V_SMALL', 0], ['V_BIG', 3]]))!.variation.id, 'V_BIG', 'skips the sold-out small one');
  assert.equal(pickVariation(r, new Map([['V_SMALL', 2], ['V_BIG', 3]]))!.variation.id, 'V_SMALL');
  const none = pickVariation(r, new Map());
  assert.equal(none!.sellable, false);
  assert.equal(none!.variation.id, 'V_SMALL', 'nothing sellable: cheapest, flagged unavailable');
  const untracked = parse(item('I2', 'H14 Clay', [variation('V9', 1800)]));
  assert.deepEqual({ ...pickVariation(untracked, new Map()), variation: undefined }, { variation: undefined, stock: null, sellable: true });
  const soldOut = parse(item('I3', 'H14 Gum', [variation('V8', 1800, { location_overrides: [{ location_id: LOC, sold_out: true }] })]));
  assert.equal(pickVariation(soldOut, new Map())!.sellable, false);
  assert.equal(stockLabel(r, new Map([['V_SMALL', 2], ['V_BIG', 3]])), '5 in stock');
  assert.equal(stockLabel(r, new Map()), 'out of stock');
  assert.equal(stockLabel(untracked, new Map()), 'not tracked');
});

test('toProductRow: row has the Bodega shape (same keys) plus source', () => {
  const r = parse(item('I1', 'STMNT NOMAD Classic Pomade', [variation('V1', 2495)], { categories: [{ id: 'CAT_POMADE' }], ecom_uri: 'https://shop.square.site/product/nomad/1' }));
  const out = toProductRow(r, new Map());
  assert.ok('row' in out);
  assert.deepEqual(Object.keys(out.row).sort(), [
    'alt', 'available', 'buy_url', 'compare_at_price', 'featured', 'handle', 'image', 'image_height', 'image_width', 'price',
    'product_type', 'sort_order', 'source', 'tags', 'title', 'url', 'vendor',
  ].sort());
  assert.equal(out.row.handle, 'stmnt-nomad-classic-pomade');
  assert.equal(out.row.price, '24.95');
  assert.equal(out.row.vendor, 'STMNT');
  assert.equal(out.row.buy_url, 'https://shop.square.site/product/nomad/1');
  assert.equal(out.route, 'S1');
  assert.equal(out.row.available, true);
  assert.equal(out.row.product_type, 'Pomade');
});

test('toProductRow: skip reasons', () => {
  assert.deepEqual(toProductRow(parse(item('I1', 'Wahl Clipper', [variation('V1', 9900)])), new Map()), { skip: 'brand not in allowlist' });
  assert.deepEqual(toProductRow(parse(item('I2', 'H14 Clay', [variation('V2', 1800)], { image_ids: [] })), new Map()), { skip: 'no photo' });
  assert.deepEqual(toProductRow(parse(item('I3', 'H14 Gum', [variation('V3', null)])), new Map()), { skip: 'no fixed price' });
});

test('buy link priority: hand-kept map > item ecom_uri > payment link > none (and HIDDEN ecom pages are ignored)', () => {
  const base = item('I1', 'H14 Raw Matte Clay', [variation('V1', 1800)], { ecom_uri: 'https://shop.square.site/product/clay/9' });
  const links: BuyLinks = { store: {}, payment: { V1: { url: 'https://square.link/u/abc' } } };
  const row = (o: RawCatalogObject, l: BuyLinks) => { const r = toProductRow(parse(o), new Map(), l); return 'row' in r ? { url: r.row.buy_url, route: r.route } : null; };
  assert.deepEqual(row(base, { ...links, store: { 'h14-raw-matte-clay': 'https://shop.square.site/product/mapped' } }), { url: 'https://shop.square.site/product/mapped', route: 'S1' });
  assert.deepEqual(row(base, links), { url: 'https://shop.square.site/product/clay/9', route: 'S1' });
  const hidden = item('I1', 'H14 Raw Matte Clay', [variation('V1', 1800)], { ecom_uri: 'https://shop.square.site/product/clay/9', ecom_visibility: 'HIDDEN' });
  assert.deepEqual(row(hidden, links), { url: 'https://square.link/u/abc', route: 'S2' });
  const bare = item('I1', 'H14 Raw Matte Clay', [variation('V1', 1800)]);
  assert.deepEqual(row(bare, links), { url: 'https://square.link/u/abc', route: 'S2' });
  assert.deepEqual(row(bare, { store: {}, payment: {} }), { url: null, route: null });
});

const prow = (handle: string, vendor: string, extra: Partial<ProductRow> = {}): ProductRow => ({
  handle, title: handle, vendor, price: '10.00', compare_at_price: null, image: 'https://x/y.jpg', image_width: 1000, image_height: 1000, alt: handle,
  url: null, buy_url: null, product_type: '', tags: [], available: true, featured: false, sort_order: 0, source: 'square', ...extra,
});

test('mergeShopProducts: dedupes by handle across shops; available if either has it; first buy link wins', () => {
  const a = [prow('clay', 'H14', { available: false, price: '18.00' }), prow('pomade', 'STMNT')];
  const b = [prow('clay', 'H14', { available: true, price: '19.00', buy_url: 'https://b/clay', url: 'https://b/clay' })];
  const out = mergeShopProducts([a, b]);
  assert.equal(out.length, 2);
  const clay = out.find((r) => r.handle === 'clay')!;
  assert.equal(clay.available, true);
  assert.equal(clay.buy_url, 'https://b/clay');
  assert.deepEqual(out.map((r) => r.sort_order), [1, 2]);
});

test('mergeShopProducts: Featured category wins; else the home strip is round-robin across brands', () => {
  const withFeat = mergeShopProducts([[prow('a', 'H14'), prow('b', 'STMNT', { featured: true })]]);
  assert.equal(withFeat[0]!.handle, 'b');
  assert.deepEqual(withFeat.filter((r) => r.featured).map((r) => r.handle), ['b']);

  const many = [
    ...['h1', 'h2', 'h3', 'h4', 'h5'].map((h) => prow(h, 'H14')),
    ...['s1', 's2', 's3'].map((h) => prow(h, 'STMNT')),
    ...['g1', 'g2'].map((h) => prow(h, 'SLICK GORILLA')),
  ];
  const out = mergeShopProducts([many], 6);
  const featured = out.filter((r) => r.featured);
  assert.equal(featured.length, 6);
  assert.deepEqual(new Set(featured.map((r) => r.vendor)), new Set(['H14', 'STMNT', 'SLICK GORILLA']));
  assert.equal(out.slice(0, 6).every((r) => r.featured), true, 'featured first');
  assert.equal(mergeShopProducts([[prow('x', 'H14', { available: false })]])[0]!.featured, false, 'sold-out items are never auto-featured');
});

/* ---- fake Square ---- */
const fakeSquare = (state: { calls: { path: string; body: any }[]; catalogPages: any[]; counts?: any[]; fail?: string }) => (async (input: any, init: any) => {
  const path = new URL(String(input)).pathname;
  const body = JSON.parse(init.body);
  state.calls.push({ path, body });
  assert.match(init.headers.Authorization, /^Bearer tok/);
  const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  if (state.fail) return json(401, { errors: [{ category: 'AUTHENTICATION_ERROR', code: 'UNAUTHORIZED', detail: state.fail }] });
  if (path === '/v2/catalog/search') return json(200, state.catalogPages[body.cursor ? 1 : 0]);
  if (path === '/v2/inventory/counts/batch-retrieve') return json(200, { counts: state.counts ?? [] });
  if (path === '/v2/online-checkout/payment-links') return json(200, { payment_link: { id: 'PL1', url: `https://square.link/u/${body.order.line_items[0].catalog_object_id}` } });
  return json(404, { errors: [{ category: 'INVALID_REQUEST_ERROR', code: 'NOT_FOUND' }] });
}) as unknown as typeof fetch;

const page1 = {
  objects: [item('I1', 'STMNT Nomad Pomade', [variation('V1', 2495, { track_inventory: true })], { categories: [{ id: 'CAT_POMADE' }] })],
  related_objects: [{ type: 'IMAGE', id: 'IMG1', image_data: { url: 'https://img/a.jpg', caption: 'a' } }, { type: 'CATEGORY', id: 'CAT_POMADE', category_data: { name: 'Pomade' } }],
  cursor: 'NEXT',
};
const page2 = {
  objects: [
    item('I2', 'H14 Clay', [variation('V2', 1800, { track_inventory: true })]),
    item('I3', 'Wahl Magic Clip', [variation('V3', 17900)]),
  ],
  related_objects: [],
};

test('listRetailItems paginates and carries related IMAGE/CATEGORY objects across pages', async () => {
  const state = { calls: [] as any[], catalogPages: [page1, page2] };
  const items = await listRetailItems('tok', LOC, { fetch: fakeSquare(state) });
  assert.equal(items.length, 3);
  assert.equal(state.calls[0]!.body.include_related_objects, true);
  assert.deepEqual(state.calls[0]!.body.object_types, ['ITEM']);
  assert.equal(state.calls[1]!.body.cursor, 'NEXT');
  // page-2 items reference IMG1, which arrived with page 1
  assert.equal(items.find((i) => i.item_id === 'I2')!.image_urls[0], 'https://img/a.jpg');
  assert.equal(items.find((i) => i.item_id === 'I1')!.category, 'Pomade');
});

test('fetchStock sums IN_STOCK counts per variation and asks for the right location', async () => {
  const state = { calls: [] as any[], catalogPages: [], counts: [
    { catalog_object_id: 'V1', state: 'IN_STOCK', quantity: '4', location_id: LOC },
    { catalog_object_id: 'V2', state: 'IN_STOCK', quantity: '0', location_id: LOC },
  ] };
  const stock = await fetchStock('tok', LOC, ['V1', 'V2', 'V3'], { fetch: fakeSquare(state) });
  assert.deepEqual([...stock], [['V1', 4], ['V2', 0]]);
  assert.deepEqual(state.calls[0]!.body.location_ids, [LOC]);
  assert.deepEqual(state.calls[0]!.body.catalog_object_ids, ['V1', 'V2', 'V3']);
});

test('fetchSquareProducts: both shops, merged; skipped items reported; missing tokens = nothing fetched', async () => {
  const shops = [{ slug: 'addison', square_location_id: LOC }, { slug: 'elmhurst', square_location_id: LOC }];
  const state = { calls: [] as any[], catalogPages: [page1, page2], counts: [{ catalog_object_id: 'V1', state: 'IN_STOCK', quantity: '2' }] };
  const none = await fetchSquareProducts(shops, { SQUARE_TOKEN_ADDISON: 'tok' }, undefined, { fetch: fakeSquare(state) });
  assert.deepEqual(none.missing, ['SQUARE_TOKEN_ELMHURST']);
  assert.equal(state.calls.length, 0);

  const res = await fetchSquareProducts(shops, { SQUARE_TOKEN_ADDISON: 'tokA', SQUARE_TOKEN_ELMHURST: 'tokE' }, undefined, { fetch: fakeSquare(state) });
  assert.deepEqual(res.errors, []);
  // I2 (H14 Clay) is tracked with no count => out of stock => listed but unavailable; Wahl is skipped
  assert.deepEqual(res.products.map((p) => [p.handle, p.available]).sort(), [['h14-clay', false], ['stmnt-nomad-pomade', true]]);
  assert.deepEqual(res.skipped.map((s) => s.reason), ['brand not in allowlist', 'brand not in allowlist']);
});

test('fetchSquareProducts: a failing shop is reported, never thrown', async () => {
  const state = { calls: [] as any[], catalogPages: [], fail: 'bad token' };
  const res = await fetchSquareProducts([{ slug: 'addison', square_location_id: LOC }], { SQUARE_TOKEN_ADDISON: 'tok' }, undefined, { fetch: fakeSquare(state) });
  assert.equal(res.products.length, 0);
  assert.match(res.errors[0]!, /addison: .*HTTP 401.*UNAUTHORIZED: bad token/);
});

test('resolveCreds: production needs every token; sandbox base falls back to the sandbox token and location', () => {
  const shops = [{ slug: 'addison', square_location_id: 'A' }, { slug: 'elmhurst', square_location_id: 'E' }];
  assert.deepEqual(resolveCreds(shops, {}, undefined).missing, ['SQUARE_TOKEN_ADDISON', 'SQUARE_TOKEN_ELMHURST']);
  assert.deepEqual(resolveCreds(shops, { SQUARE_TOKEN_ADDISON: 'a', SQUARE_TOKEN_ELMHURST: 'e' }).creds.map((c) => [c.slug, c.token, c.locationId]), [['addison', 'a', 'A'], ['elmhurst', 'e', 'E']]);
  const sb = 'https://connect.squareupsandbox.com';
  assert.deepEqual(resolveCreds(shops, {}, sb).missing, ['SQUARE_SANDBOX_TOKEN', 'SQUARE_SANDBOX_LOCATION_ID']);
  assert.deepEqual(resolveCreds(shops, { SQUARE_SANDBOX_TOKEN: 's', SQUARE_SANDBOX_LOCATION_ID: 'L' }, sb).creds.map((c) => [c.slug, c.token, c.locationId]), [['addison', 's', 'L'], ['elmhurst', 's', 'L']]);
});

test('ensurePaymentLinks: dry run lists what it would create; write creates once and reuses stored links', async () => {
  const state = { calls: [] as any[], catalogPages: [] };
  const items = [
    parse(item('I1', 'STMNT Nomad Pomade', [variation('V1', 2495)])),
    parse(item('I2', 'H14 Clay', [variation('V2', 1800)], { ecom_uri: 'https://shop.square.site/p/clay' })),
    parse(item('I3', 'H14 Gum', [variation('V3', 1500)])),
  ];
  const dry = await ensurePaymentLinks('tok', LOC, items, new Map(), { store: {}, payment: { V3: { url: 'https://square.link/u/V3' } } }, { fetch: fakeSquare(state) });
  assert.deepEqual(dry.wouldCreate, ['stmnt-nomad-pomade']);
  assert.equal(state.calls.length, 0, 'dry run never calls Square');

  const real = await ensurePaymentLinks('tok', LOC, items, new Map(), { store: {}, payment: {} }, { fetch: fakeSquare(state), write: true, now: () => '2026-10-28T00:00:00Z', shop: 'addison' });
  assert.deepEqual(real.created.sort(), ['h14-gum', 'stmnt-nomad-pomade']);
  assert.equal(real.payment.V1!.url, 'https://square.link/u/V1');
  assert.equal(real.payment.V1!.created_at, '2026-10-28T00:00:00Z');
  assert.equal(real.payment.V1!.shop, 'addison', 'the shop is stored with the link');
  const sent = state.calls.find((c) => c.path === '/v2/online-checkout/payment-links')!.body;
  assert.equal(sent.order.location_id, LOC);
  assert.match(sent.description, /^Pick up at Skull & Thrones/);
  assert.equal(state.calls.length, 2, 'the item with a store page (S1) gets no payment link');
  const again = await ensurePaymentLinks('tok', LOC, items, new Map(), { store: {}, payment: real.payment }, { fetch: fakeSquare(state), write: true });
  assert.deepEqual(again.created, []);
  assert.equal(state.calls.length, 2, 'second run creates nothing');
});

test('paymentLinkRequest: one catalog variation, quantity 1, deterministic idempotency key, pickup note, no shipping', () => {
  const body = paymentLinkRequest(LOC, 'V1');
  assert.equal(body.description, 'Pick up at Skull & Thrones. We will text you when it is ready.');
  assert.deepEqual(body.pre_populated_data, {});
  assert.equal(body.idempotency_key, 'st-paylink-v2-V1');
  assert.deepEqual(body.order.line_items, [{ catalog_object_id: 'V1', quantity: '1' }]);
  assert.equal(body.order.location_id, LOC);
  assert.equal(body.checkout_options.ask_for_shipping_address, false);
});
