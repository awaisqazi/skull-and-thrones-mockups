/**
 * Retail products from Square (build time only). Used when SHOP_SOURCE=square
 * (src/content.config.ts products loader) and by `npm run check:square`.
 * See docs/SQUARE-INTEGRATION-SPEC.md section 5 (S1 / S2 / S3).
 *
 * Reads, per shop (each shop is its own Square merchant account, so its own token):
 *   POST /v2/catalog/search               ITEMs + related IMAGE / CATEGORY objects (include_related_objects)
 *   POST /v2/inventory/counts/batch-retrieve   IN_STOCK counts for the variations (only when tracked)
 * and only writes (POST /v2/online-checkout/payment-links) from `ensurePaymentLinks`, which nothing
 * calls except `node scripts/sync-products.mjs --create-links`.
 *
 * Output rows have the same shape as the Bodega rows in src/data/products.json, so ProductCard needs
 * no special case beyond `buy_url: null` (item has no online buy link: "Available in shop").
 *
 * Pure fetch, no SDK, no Astro imports (loadable by `node --test` and the scripts; Node strips the types).
 * Deliberately independent of the roster's SquareItem so the two workstreams never share a struct.
 */
import { SQUARE_API, arrayField, isAtLocation, missingTokens, squareCall, squareToken, type ListOptions, type SquareShop } from './square.ts';

/**
 * Brand allowlist, shared by BOTH sources (client request 2026-10-18): only these vendors are listed.
 * Bodega rows are matched on the Shopify vendor; Square rows on a CATEGORY named like the brand, else
 * on the item name starting with the brand (the Bodega titles all start with it: "STMNT NOMAD Classic Pomade").
 * To list another brand add its name here, then re-run sync / rebuild.
 */
export const BRANDS = ['STMNT', 'H14', 'SLICK GORILLA'] as const;
const BRAND_SET = new Set<string>(BRANDS);
export const allowedBrand = (vendor: unknown): boolean => BRAND_SET.has(String(vendor ?? '').trim().toUpperCase());

/* ---------- Types ---------- */

interface Money { amount?: number | bigint | string | null; currency?: string }
interface RawVariation {
  id: string;
  type?: string;
  is_deleted?: boolean;
  present_at_all_locations?: boolean;
  present_at_location_ids?: string[];
  absent_at_location_ids?: string[];
  item_variation_data?: {
    name?: string;
    sku?: string;
    pricing_type?: string;
    price_money?: Money | null;
    track_inventory?: boolean;
    location_overrides?: { location_id?: string; price_money?: Money | null; pricing_type?: string; track_inventory?: boolean; sold_out?: boolean }[];
  };
}
export interface RawCatalogObject {
  type: string;
  id: string;
  is_deleted?: boolean;
  present_at_all_locations?: boolean;
  present_at_location_ids?: string[];
  absent_at_location_ids?: string[];
  image_data?: { url?: string; caption?: string; name?: string };
  category_data?: { name?: string };
  item_data?: {
    name?: string;
    description_plaintext?: string;
    product_type?: string;
    is_archived?: boolean;
    image_ids?: string[];
    category_id?: string;
    categories?: { id?: string }[];
    reporting_category?: { id?: string };
    ecom_uri?: string;
    ecom_visibility?: string;
    ecom_image_uris?: string[];
    variations?: RawVariation[];
  };
}

export interface RetailVariation {
  id: string;
  name: string;
  sku: string | null;
  /** Price at this location in cents; null = variable pricing / not set. */
  cents: number | null;
  /** Inventory tracked at this location. false = always sellable (unless sold_out). */
  tracked: boolean;
  /** Square's location-level "sold out" switch. */
  sold_out: boolean;
}

/** One Square retail ITEM, parsed. */
export interface RetailItem {
  item_id: string;
  name: string;
  description: string;
  /** Brand from the allowlist (canonical upper-case spelling) or null. */
  vendor: string | null;
  category: string;
  /** Names of every category the item is in (lower-cased), used for the "Featured" category. */
  categories: string[];
  variations: RetailVariation[];
  image_urls: string[];
  /** Square Online product page, when the item is published to the online store. */
  ecom_uri: string | null;
  ecom_visibility: string | null;
}

/** Same fields as a row of src/data/products.json (plus `source`), so ProductCard/ProductStrip are shared. */
export interface ProductRow {
  handle: string;
  title: string;
  vendor: string;
  price: string;
  compare_at_price: string | null;
  image: string;
  image_width: number;
  image_height: number;
  alt: string;
  /** Product page on the shop's Square Online store, or null (no store link). */
  url: string | null;
  /** Where "Buy" goes (store page, or a Checkout API payment link), or null = no online buy button. */
  buy_url: string | null;
  product_type: string;
  tags: string[];
  available: boolean;
  featured: boolean;
  sort_order: number;
  source: 'square';
}

export type SkipReason = 'brand not in allowlist' | 'no photo' | 'no fixed price';

export interface BuyLinks {
  /** S1: handle -> product page on the Square Online store (hand-maintained, wins over the item's own ecom_uri). */
  store: Record<string, string>;
  /** S2: variation id -> Checkout API payment link, created once by `--create-links`. */
  payment: Record<string, { url: string; handle?: string; shop?: string; payment_link_id?: string; created_at?: string }>;
}
export const NO_LINKS: BuyLinks = { store: {}, payment: {} };

/** Same options as every Square client (fetch, apiBase, timeoutMs, retries, sleep; see square.ts ListOptions). */
export type FetchOptions = ListOptions;

/** An absolute http(s) URL, or null. The content schema needs absolute URLs; anything else must never fail the build. */
export function absoluteUrl(u: unknown): string | null {
  if (typeof u !== 'string' || !u.trim()) return null;
  try {
    const url = new URL(u.trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

/* ---------- Pure helpers ---------- */

export const slugify = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const cents = (m: Money | null | undefined): number | null => {
  if (m?.amount == null) return null;
  const n = Number(m.amount);
  return Number.isFinite(n) && n > 0 ? n : null;
};
const dollars = (c: number) => (c / 100).toFixed(2);

/** Brand for an item: a category named like an allowlisted brand, else the name's leading brand. */
export function brandOf(name: string, categoryNames: string[]): string | null {
  for (const c of categoryNames) if (allowedBrand(c)) return c.trim().toUpperCase();
  const lower = name.trim().toUpperCase();
  for (const b of BRANDS) if (lower === b || lower.startsWith(b + ' ')) return b;
  return null;
}

/** Retail = Square product_type REGULAR (the API omits it on older items, which are REGULAR too). */
export const isRetailType = (productType: string | undefined | null) => productType == null || productType === 'REGULAR';

export interface ParseContext {
  locationId: string;
  /** IMAGE object id -> url (from related_objects). */
  images: ReadonlyMap<string, { url: string; caption: string }>;
  /** CATEGORY object id -> name. */
  categories: ReadonlyMap<string, string>;
}

/** Pure: catalog ITEM -> RetailItem (null: not a live, non-archived retail item sold at this location). */
export function toRetailItem(o: RawCatalogObject, ctx: ParseContext): RetailItem | null {
  const d = o.item_data;
  if (o.type !== 'ITEM' || o.is_deleted || !d || d.is_archived || !isRetailType(d.product_type) || !isAtLocation(o, ctx.locationId)) return null;
  const name = (d.name ?? '').trim();
  if (!name) return null;
  const variations: RetailVariation[] = (d.variations ?? [])
    .filter((v) => !v.is_deleted && isAtLocation(v, ctx.locationId))
    .map((v) => {
      const vd = v.item_variation_data ?? {};
      const ov = (vd.location_overrides ?? []).find((x) => x.location_id === ctx.locationId);
      const fixed = (ov?.pricing_type ?? vd.pricing_type) !== 'VARIABLE_PRICING';
      return {
        id: v.id,
        name: (vd.name ?? '').trim(),
        sku: vd.sku?.trim() || null,
        cents: fixed ? cents(ov?.price_money) ?? cents(vd.price_money) : null,
        tracked: ov?.track_inventory ?? vd.track_inventory ?? false,
        sold_out: ov?.sold_out ?? false,
      };
    });
  const catIds = [...(d.categories ?? []).map((c) => c.id), d.category_id, d.reporting_category?.id].filter((x): x is string => Boolean(x));
  const categories = [...new Set(catIds.map((id) => ctx.categories.get(id)).filter((x): x is string => Boolean(x)))];
  const imageObjs = (d.image_ids ?? []).map((id) => ctx.images.get(id)).filter((x): x is { url: string; caption: string } => Boolean(x));
  // Only absolute http(s) image URLs count: a relative or broken one is "no photo" (skipped), never a schema failure.
  const imageUrls = imageObjs.map((i) => absoluteUrl(i.url)).filter((u): u is string => u !== null);
  for (const raw of Array.isArray(d.ecom_image_uris) ? d.ecom_image_uris : []) { const u = absoluteUrl(raw); if (u && !imageUrls.includes(u)) imageUrls.push(u); }
  return {
    item_id: o.id,
    name,
    description: (d.description_plaintext ?? '').trim(),
    vendor: brandOf(name, categories),
    category: categories.find((c) => !allowedBrand(c)) ?? '',
    categories: categories.map((c) => c.toLowerCase()),
    variations,
    image_urls: imageUrls,
    ecom_uri: absoluteUrl(d.ecom_uri),
    ecom_visibility: d.ecom_visibility || null,
  };
}

export interface Sellable { variation: RetailVariation; stock: number | null; sellable: boolean }

/** Which variation the card shows: the cheapest sellable priced one; if none is sellable, the cheapest priced. */
export function pickVariation(item: RetailItem, stock: ReadonlyMap<string, number>): Sellable | null {
  const priced = item.variations
    .filter((v) => v.cents != null)
    .map((v): Sellable => {
      const qty = v.tracked ? stock.get(v.id) ?? 0 : null;
      return { variation: v, stock: qty, sellable: !v.sold_out && (qty == null || qty > 0) };
    })
    .sort((a, b) => a.variation.cents! - b.variation.cents!);
  return priced.find((p) => p.sellable) ?? priced[0] ?? null;
}

/** Stock label for diagnostics: "12 in stock", "out of stock", "not tracked". Sums every tracked variation. */
export function stockLabel(item: RetailItem, stock: ReadonlyMap<string, number>): string {
  const tracked = item.variations.filter((v) => v.tracked);
  if (!tracked.length) return item.variations.some((v) => v.sold_out) ? 'sold out' : 'not tracked';
  const total = tracked.reduce((n, v) => n + (stock.get(v.id) ?? 0), 0);
  return total > 0 ? `${total} in stock` : 'out of stock';
}

/** Buy link route for an item: S1 hand-kept link, S1 the item's own Square Online page, S2 payment link, else none. */
export function buyLinkFor(handle: string, item: RetailItem, pick: Sellable | null, links: BuyLinks): { url: string; route: 'S1' | 'S2' } | null {
  const mapped = absoluteUrl(links.store[handle]);
  if (mapped) return { url: mapped, route: 'S1' };
  if (item.ecom_uri && item.ecom_visibility !== 'HIDDEN' && item.ecom_visibility !== 'UNAVAILABLE') return { url: item.ecom_uri, route: 'S1' };
  const pay = pick ? absoluteUrl(links.payment[pick.variation.id]?.url) : null;
  if (pay) return { url: pay, route: 'S2' };
  return null;
}

/** Pure: RetailItem -> product row, or the reason it is not listed. Rows come back unsorted, sort_order 0. */
export function toProductRow(item: RetailItem, stock: ReadonlyMap<string, number>, links: BuyLinks = NO_LINKS): { row: ProductRow; route: 'S1' | 'S2' | null } | { skip: SkipReason } {
  if (!item.vendor) return { skip: 'brand not in allowlist' };
  if (!item.image_urls.length) return { skip: 'no photo' };
  const pick = pickVariation(item, stock);
  if (!pick) return { skip: 'no fixed price' };
  const handle = slugify(item.name);
  const link = buyLinkFor(handle, item, pick, links);
  return {
    route: link?.route ?? null,
    row: {
      handle,
      title: item.name,
      vendor: item.vendor,
      price: dollars(pick.variation.cents!),
      compare_at_price: null,
      image: item.image_urls[0]!,
      // Square's IMAGE objects carry no dimensions; packshots are shown in a square frame (object-fit: contain).
      image_width: 1000,
      image_height: 1000,
      alt: `${item.vendor} ${item.name}`.trim(),
      url: link?.route === 'S1' ? link.url : null,
      buy_url: link?.url ?? null,
      product_type: item.category,
      tags: [],
      available: pick.sellable,
      featured: item.categories.includes('featured'),
      sort_order: 0,
      source: 'square',
    },
  };
}

/**
 * Pure: rows from every shop -> one list. Same product in both shops (same handle) becomes one row:
 * available if either shop has it, the first shop's price and photo, the first buy link found.
 * Order: Featured-category items first, then vendor, then title. If nothing is in a "Featured" category the home
 * strip gets the first `featureCount` rows taken round-robin across brands so it is not one brand.
 */
export function mergeShopProducts(perShop: ProductRow[][], featureCount = 8): ProductRow[] {
  const byHandle = new Map<string, ProductRow>();
  for (const rows of perShop) {
    for (const r of rows) {
      const have = byHandle.get(r.handle);
      if (!have) { byHandle.set(r.handle, { ...r }); continue; }
      have.available ||= r.available;
      have.featured ||= r.featured;
      if (!have.buy_url && r.buy_url) { have.buy_url = r.buy_url; have.url = r.url; }
      if (have.available !== r.available && r.available) have.price = r.price;
    }
  }
  let list = [...byHandle.values()].sort((a, b) => Number(b.featured) - Number(a.featured) || a.vendor.localeCompare(b.vendor) || a.title.localeCompare(b.title));
  if (!list.some((r) => r.featured)) {
    const queues = new Map<string, ProductRow[]>();
    for (const r of list.filter((x) => x.available)) queues.set(r.vendor, [...(queues.get(r.vendor) ?? []), r]);
    const picks: ProductRow[] = [];
    while (picks.length < featureCount && [...queues.values()].some((q) => q.length)) {
      for (const q of queues.values()) { const r = q.shift(); if (r && picks.length < featureCount) picks.push(r); }
    }
    for (const r of picks) r.featured = true;
    list = [...picks, ...list.filter((r) => !r.featured)];
  }
  return list.map((r, i) => ({ ...r, sort_order: i + 1 }));
}

/* ---------- Square API ---------- */

/** One POST through the shared Square call (retries, strict JSON bodies); throws `Square <path> failed (HTTP n): …`. */
async function call<T extends object>(token: string, path: string, body: unknown, opts: FetchOptions): Promise<T> {
  return squareCall<T>(`Square ${path}`, `${opts.apiBase ?? SQUARE_API}${path}`, { method: 'POST', token, body: JSON.stringify(body) }, opts);
}

/** Every retail ITEM sold at `locationId`, with photos and categories resolved. POST /v2/catalog/search, include_related_objects. */
export async function listRetailItems(token: string, locationId: string, opts: FetchOptions = {}): Promise<RetailItem[]> {
  const objects: RawCatalogObject[] = [];
  const images = new Map<string, { url: string; caption: string }>();
  const categories = new Map<string, string>();
  let cursor: string | undefined;
  let pages = 0;
  do {
    const body = await call<{ objects?: unknown; related_objects?: unknown; cursor?: string }>(
      token, '/v2/catalog/search',
      { object_types: ['ITEM'], include_related_objects: true, include_deleted_objects: false, limit: 1000, ...(cursor ? { cursor } : {}) },
      opts,
    );
    objects.push(...arrayField<RawCatalogObject>(body, 'objects', 'Square /v2/catalog/search').filter((o) => typeof o === 'object' && o !== null));
    for (const r of arrayField<RawCatalogObject>(body, 'related_objects', 'Square /v2/catalog/search')) {
      if (!r || typeof r !== 'object' || r.is_deleted) continue;
      if (r.type === 'IMAGE' && r.image_data?.url) images.set(r.id, { url: r.image_data.url, caption: r.image_data.caption ?? '' });
      if (r.type === 'CATEGORY' && r.category_data?.name) categories.set(r.id, r.category_data.name.trim());
    }
    cursor = body.cursor || undefined;
    if (++pages > 50) throw new Error('Square catalog search: more than 50 pages, giving up');
  } while (cursor);
  const ctx: ParseContext = { locationId, images, categories };
  return objects.map((o) => toRetailItem(o, ctx)).filter((x): x is RetailItem => x !== null);
}

/** IN_STOCK quantity per variation id at the location. Variations with no count are absent (= 0). POST /v2/inventory/counts/batch-retrieve. */
export async function fetchStock(token: string, locationId: string, variationIds: string[], opts: FetchOptions = {}): Promise<Map<string, number>> {
  const stock = new Map<string, number>();
  for (let i = 0; i < variationIds.length; i += 500) {
    let cursor: string | undefined;
    let pages = 0;
    do {
      const body = await call<{ counts?: unknown; cursor?: string }>(
        token, '/v2/inventory/counts/batch-retrieve',
        { catalog_object_ids: variationIds.slice(i, i + 500), location_ids: [locationId], states: ['IN_STOCK'], ...(cursor ? { cursor } : {}) },
        opts,
      );
      // A bad inventory body throws (strict JSON, `counts` must be a list): the shop then fails and the site keeps Bodega.
      for (const c of arrayField<{ catalog_object_id?: string; state?: string; quantity?: string }>(body, 'counts', 'Square /v2/inventory/counts/batch-retrieve')) {
        if (c && c.catalog_object_id && c.state === 'IN_STOCK') stock.set(c.catalog_object_id, (stock.get(c.catalog_object_id) ?? 0) + (Number(c.quantity) || 0));
      }
      cursor = body.cursor || undefined;
      if (++pages > 50) throw new Error('Square inventory: more than 50 pages, giving up');
    } while (cursor);
  }
  return stock;
}

/** One shop: retail items + stock, ready for toProductRow. Only calls Inventory when something is tracked. */
export async function loadShopRetail(token: string, locationId: string, opts: FetchOptions = {}): Promise<{ items: RetailItem[]; stock: Map<string, number> }> {
  const items = await listRetailItems(token, locationId, opts);
  const tracked = items.flatMap((i) => i.variations.filter((v) => v.tracked).map((v) => v.id));
  const stock = tracked.length ? await fetchStock(token, locationId, tracked, opts) : new Map<string, number>();
  return { items, stock };
}

/* ---------- Credentials (production tokens, or the sandbox shortcut) ---------- */

export interface ShopCreds { slug: string; token: string; locationId: string }

const isSandbox = (apiBase?: string) => /squareupsandbox\.com/.test(apiBase ?? '');

/**
 * Production: SQUARE_TOKEN (the main account) or a per-shop override (SQUARE_TOKEN_ADDISON /
 * SQUARE_TOKEN_ELMHURST) and the shop's square_location_id; any token missing -> nothing (half a shop would be confusing).
 * Sandbox (apiBase is squareupsandbox.com): both shops use SQUARE_TOKEN_<SHOP> if set else SQUARE_SANDBOX_TOKEN,
 * and the single sandbox location SQUARE_SANDBOX_LOCATION_ID, so a one-account sandbox stands in for both shops.
 */
export function resolveCreds(shops: SquareShop[], env: Record<string, string | undefined>, apiBase?: string): { creds: ShopCreds[]; missing: string[] } {
  if (isSandbox(apiBase)) {
    const missing = ['SQUARE_SANDBOX_TOKEN', 'SQUARE_SANDBOX_LOCATION_ID'].filter((k) => !env[k]);
    if (missing.length) return { creds: [], missing };
    return { creds: shops.map((s) => ({ slug: s.slug, token: squareToken(env, s.slug) || env.SQUARE_SANDBOX_TOKEN!, locationId: env.SQUARE_SANDBOX_LOCATION_ID! })), missing: [] };
  }
  const missing = missingTokens(shops, env);
  if (missing.length) return { creds: [], missing };
  return { creds: shops.map((s) => ({ slug: s.slug, token: squareToken(env, s.slug)!, locationId: s.square_location_id })), missing: [] };
}

export interface SquareProductsResult {
  products: ProductRow[];
  missing: string[];
  /** One line per shop that failed. Failed shops contribute nothing. */
  errors: string[];
  /** Items not listed, with the reason (for logs and check:square). */
  skipped: { shop: string; name: string; reason: SkipReason }[];
}

/** All shops -> merged product rows. Never throws: failures come back in `errors`. */
export async function fetchSquareProducts(shops: SquareShop[], env: Record<string, string | undefined>, links: BuyLinks = NO_LINKS, opts: FetchOptions = {}): Promise<SquareProductsResult> {
  const { creds, missing } = resolveCreds(shops, env, opts.apiBase);
  const result: SquareProductsResult = { products: [], missing, errors: [], skipped: [] };
  if (missing.length) return result;
  const perShop: ProductRow[][] = [];
  await Promise.all(creds.map(async (c, idx) => {
    try {
      const { items, stock } = await loadShopRetail(c.token, c.locationId, opts);
      const rows: ProductRow[] = [];
      for (const item of items) {
        const r = toProductRow(item, stock, links);
        if ('skip' in r) result.skipped.push({ shop: c.slug, name: item.name, reason: r.skip });
        else rows.push(r.row);
      }
      perShop[idx] = rows;
    } catch (e) {
      result.errors.push(`${c.slug}: ${(e as Error).message}`);
    }
  }));
  result.products = mergeShopProducts(perShop.filter(Boolean));
  return result;
}

/* ---------- S2: Checkout API payment links (writes; only via `sync-products.mjs --create-links`) ---------- */

/** Shown to the buyer on the checkout page: these links are pickup only (no shipping address is collected). */
export const PICKUP_NOTE = 'Pick up at Skull & Thrones. We will text you when it is ready.';

/** Pure: request body for one payment link (one catalog variation, quantity 1, pickup at the shop `locationId` belongs to). */
export function paymentLinkRequest(locationId: string, variationId: string) {
  return {
    idempotency_key: `st-paylink-v2-${variationId}`,
    description: PICKUP_NOTE,
    order: { location_id: locationId, line_items: [{ catalog_object_id: variationId, quantity: '1' }] },
    checkout_options: { ask_for_shipping_address: false, allow_tipping: false },
    pre_populated_data: {},
  };
}

/**
 * Creates (once) a payment link per sellable item that has no S1 link and no stored S2 link.
 * Existing entries are reused, never duplicated. Returns the full updated map and the handles created.
 * `locationId` is ONE explicit shop's location (pickup happens there); `opts.shop` is stored in each entry.
 * Needs a production token with ORDERS_WRITE + PAYMENTS_WRITE scope; dry run unless `write` is true.
 */
export async function ensurePaymentLinks(
  token: string, locationId: string, items: RetailItem[], stock: ReadonlyMap<string, number>, links: BuyLinks,
  opts: FetchOptions & { write?: boolean; now?: () => string; shop?: string } = {},
): Promise<{ payment: BuyLinks['payment']; created: string[]; wouldCreate: string[] }> {
  const payment = { ...links.payment };
  const created: string[] = [];
  const wouldCreate: string[] = [];
  for (const item of items) {
    const r = toProductRow(item, stock, links);
    if ('skip' in r || r.row.buy_url || !r.row.available) continue;
    const pick = pickVariation(item, stock)!;
    if (payment[pick.variation.id]) continue;
    if (!opts.write) { wouldCreate.push(r.row.handle); continue; }
    let url: string | undefined;
    let body: { payment_link?: { id?: string; url?: string; long_url?: string } };
    try {
      body = await call<{ payment_link?: { id?: string; url?: string; long_url?: string } }>(
        token, '/v2/online-checkout/payment-links', paymentLinkRequest(locationId, pick.variation.id), opts,
      );
      url = body.payment_link?.url ?? body.payment_link?.long_url;
      if (!url) throw new Error(`Square returned no payment link url for ${r.row.handle}`);
    } catch (e) {
      // Links already created in Square must not be lost: hand back what succeeded so the caller can write it, then fail.
      throw Object.assign(e as Error, { partial: { payment, created } });
    }
    payment[pick.variation.id] = { url, handle: r.row.handle, ...(opts.shop ? { shop: opts.shop } : {}), payment_link_id: body.payment_link?.id, created_at: (opts.now ?? (() => new Date().toISOString()))() };
    created.push(r.row.handle);
  }
  return { payment, created, wouldCreate };
}

/* ---------- Render helpers (shared by both sources) ---------- */

/**
 * Image alt text without a doubled brand: the Bodega feed builds alt as "<vendor> <title>" and most titles already
 * start with the vendor ("STMNT STMNT NOMAD Classic Pomade" → "STMNT NOMAD Classic Pomade"). Case-insensitive.
 */
export function productAlt(alt: string, vendor: string): string {
  const a = String(alt ?? '').trim().replace(/\s+/g, ' ');
  const v = String(vendor ?? '').trim().replace(/\s+/g, ' ');
  if (!v) return a;
  const lower = a.toLowerCase(), pre = v.toLowerCase() + ' ';
  return lower.startsWith(pre) && lower.slice(pre.length).startsWith(pre) ? a.slice(pre.length) : a;
}
