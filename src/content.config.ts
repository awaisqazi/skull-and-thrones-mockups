/**
 * Content collections (Astro 5 Content Layer).
 *
 * Today every collection reads a local JSON file in src/data/ with the `file()` loader.
 * Pages never touch those files directly: they go through src/lib/data.ts, which only
 * calls getCollection(). Moving to Supabase is therefore a change to THIS file only:
 * swap each `loader:` for the Supabase loader stubbed at the bottom. The schemas stay
 * the same, so a bad CMS row fails the build instead of shipping a broken page.
 */
import { defineCollection, z } from 'astro:content';
import { file, type Loader, type LoaderContext } from 'astro/loaders';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { fetchShops, type SquareShop } from './lib/square.ts';
import { mergeRosterCheckingPhotos, type Row } from './lib/roster.ts';
import { checkPhotos } from './lib/square-photos.ts';
import { listTeamMemberBookingProfiles, type BookingProfile } from './lib/bookings.ts';
import { squareToken } from './lib/square.ts';
import { fetchLocation, resolveHours, type SquareLocation } from './lib/square-locations.ts';
import { allowedBrand, fetchSquareProducts, NO_LINKS, type BuyLinks } from './lib/square-products.ts';

const locationSlug = z.enum(['addison', 'elmhurst']);
const time = z.string().regex(/^\d{2}:\d{2}$/, 'HH:MM, 24h shop-local time');

/**
 * Stores each row, never letting a row that fails the collection schema fail the build (QA 2026-10-28: Square data
 * such as a 20-second service_duration used to stop every deploy). A row that does not parse is replaced by its
 * `fallback` (the barbers.json / locations.json row it was merged from) with a warning; when there is no fallback or
 * the fallback fails too, the row is skipped with an error in the build log.
 */
async function storeRows(
  ctx: Pick<LoaderContext, 'store' | 'parseData' | 'generateDigest' | 'logger'>,
  label: string, rows: Record<string, unknown>[], idOf: (r: Record<string, unknown>) => string, fallbackOf: (r: Record<string, unknown>) => Record<string, unknown> | undefined = () => undefined,
  /** true when `rows` came straight from a data file (products.json): a bad row is then a content bug and fails the build. */
  fromFile = false,
) {
  const firstLine = (e: unknown) => String((e as Error)?.message ?? e).split('\n').filter((l) => l.trim()).slice(0, 3).join(' ').slice(0, 300);
  for (const row of rows) {
    const id = idOf(row);
    try {
      ctx.store.set({ id, data: await ctx.parseData({ id, data: row }), digest: ctx.generateDigest(row) });
      continue;
    } catch (e) {
      const fb = fallbackOf(row);
      // A row that came straight from the data file (no Square merge) is a content bug: fail the build loudly,
      // as the file() loader used to. Only rows Square changed get the silent fallback (Square data must never break a deploy).
      if (fb === row || (!fb && fromFile)) throw new Error(`${label} ${id}: does not match the schema (${firstLine(e)})`);
      // No file row and not from a file = a Square-only row (newcomer barber, Square product): skip it, never break the deploy.
      if (!fb) { ctx.logger.error(`${label} ${id}: Square row does not match the schema, skipped (${firstLine(e)})`); continue; }
      ctx.logger.warn(`${label} ${id}: merged row does not match the schema, using the file row (${firstLine(e)})`);
      const fid = idOf(fb);
      try {
        ctx.store.set({ id: fid, data: await ctx.parseData({ id: fid, data: fb }), digest: ctx.generateDigest(fb) });
      } catch (e2) {
        throw new Error(`${label} ${id}: the file row does not match the schema either (${firstLine(e2)})`);
      }
    }
  }
}

/** Unwraps `{ "_note": "...", "<key>": [...] }` and keys every entry by its slug/id. */
const fromKey = (key: string, idField: string) => (text: string) =>
  (JSON.parse(text)[key] as Record<string, unknown>[]).map((row) => ({ id: String(row[idField]), ...row }));

/**
 * Barbers roster: Square decides who exists, barbers.json (the CMS later) decides how they look.
 * - SQUARE_TOKEN (or SQUARE_TOKEN_ADDISON and SQUARE_TOKEN_ELMHURST) set: list each shop's Square catalog items
 *   (src/lib/square.ts) and merge with barbers.json by item_id (src/lib/roster.ts, unit-tested).
 *   New Square items get an auto slug + needs_profile; rows gone from Square get is_active: false.
 * - Bios: each fetched shop's team member booking profiles (listTeamMemberBookingProfiles in src/lib/bookings.ts)
 *   fill the bio of rows whose barbers.json bio is empty (bio_source: 'square'); a barbers.json bio always wins.
 *   A failed profiles call only warns: the roster builds without Square bios, exactly as before.
 * - Headshots (spec §4): the item image, else the staff profile photo, becomes `headshot` with
 *   `headshot_source: 'square'` (rendered ahead of the local file in src/assets/headshots). Each Square photo URL
 *   is HEAD-checked first (checkPhotos in src/lib/square-photos.ts: 8 s timeout, 4 in flight); a 404, timeout or
 *   non-image falls back to the next source with a warning, so a bad photo never fails the build.
 * - Tokens missing: barbers.json exactly as before (one info line in the build log).
 * - Square error for a shop: warn, that shop falls back to barbers.json. Never fails the build.
 */
function squareRosterLoader(): Loader {
  return {
    name: 'square-roster',
    load: async ({ store, parseData, generateDigest, logger, config, watcher }) => {
      const barbersPath = fileURLToPath(new URL('src/data/barbers.json', config.root));
      const locationsPath = fileURLToPath(new URL('src/data/locations.json', config.root));
      const sync = async () => {
        const rows = JSON.parse(await readFile(barbersPath, 'utf8')).barbers as Row[];
        const shops = JSON.parse(await readFile(locationsPath, 'utf8')).locations as SquareShop[];
        let roster = rows;
        // SQUARE_API_BASE: optional override, e.g. https://connect.squareupsandbox.com for sandbox tokens.
        const { square, missing, errors } = await fetchShops(shops, process.env, { apiBase: process.env.SQUARE_API_BASE || undefined });
        if (missing.length) logger.info(`Square roster off (set SQUARE_TOKEN, or ${missing.join(' + ')}): using src/data/barbers.json.`);
        for (const e of errors) logger.warn(`Square roster: ${e} (that shop falls back to barbers.json)`);
        if (Object.keys(square).length) {
          // Bios typed in Square (Appointments → Staff → profile). Team member ids are unique per account, so one map serves both shops.
          const profiles = new Map<string, BookingProfile>();
          await Promise.all(shops.filter((s) => square[s.slug]).map(async (s) => {
            try {
              const list = await listTeamMemberBookingProfiles(squareToken(process.env, s.slug)!, s.square_location_id, { apiBase: process.env.SQUARE_API_BASE || undefined });
              for (const p of list) profiles.set(p.team_member_id, p);
            } catch (e) {
              logger.warn(`Square roster: ${s.slug}: booking profiles failed (${(e as Error).message}); no Square bios for that shop.`);
            }
          }));
          const merged = await mergeRosterCheckingPhotos(
            { rows, square, excludeItemIds: shops.map((l) => l.any_artist_item_id ?? ''), profiles },
            (urls) => checkPhotos(urls, { timeoutMs: 8000, concurrency: 4 }),
          );
          const fromSquare = merged.rows.filter((r) => r.bio_source === 'square').map((r) => r.slug);
          if (fromSquare.length) logger.info(`Square roster: bio from Square for ${fromSquare.join(', ')}.`);
          const photoSlugs = (from: 'item' | 'profile') => Object.entries(merged.photos).filter(([, f]) => f === from).map(([s]) => s);
          const noPhoto = merged.rows.filter((r) => r.is_active !== false && r.headshot_source !== 'square' && Object.keys(square).includes(r.location)).map((r) => r.slug);
          logger.info(`Square roster: photo from the Square item image for ${photoSlugs('item').join(', ') || 'nobody'}; from the staff photo for ${photoSlugs('profile').join(', ') || 'nobody'}; no Square photo (local file or placeholder) for ${noPhoto.join(', ') || 'nobody'}.`);
          for (const w of merged.photoWarnings) logger.warn(w);
          for (const w of merged.warnings) logger.warn(w);
          const { matched, added, deactivated } = merged.stats;
          logger.info(`Square roster (${Object.keys(square).join(' + ')}): ${matched} matched, ${added} new, ${deactivated} no longer in Square.`);
          roster = merged.rows;
        }
        store.clear();
        const fileRow = new Map(rows.map((r) => [r.item_id, r]));
        await storeRows({ store, parseData, generateDigest, logger }, 'barber', roster, (r) => String(r.slug), (r) => fileRow.get(String(r.item_id)));
      };
      await sync();
      // Dev server: re-run when barbers.json changes (what the file() loader used to do).
      watcher?.add(barbersPath);
      watcher?.on('change', (changed) => { if (changed === barbersPath) sync().catch((e) => logger.error(String(e))); });
    },
  };
}

/**
 * Locations: locations.json (address, phone, links) with the opening hours taken from Square when the shop has
 * them set there (spec section 2/10, src/lib/square-locations.ts).
 * - A token for the shop (squareToken: SQUARE_TOKEN_<SHOP> else SQUARE_TOKEN) and `business_hours.periods` on its
 *   Square location: `hours` + `hours_short` come from Square, `hours_source: 'square'`.
 * - No token, no hours set in Square (Addison today), or any Square error: the file's hours, `hours_source: 'site'`.
 *   An error is a warning; it never fails the build.
 */
function locationsLoader(): Loader {
  return {
    name: 'square-locations',
    load: async ({ store, parseData, generateDigest, logger, config, watcher }) => {
      const locationsPath = fileURLToPath(new URL('src/data/locations.json', config.root));
      const sync = async () => {
        const rows = JSON.parse(await readFile(locationsPath, 'utf8')).locations as Record<string, any>[];
        const apiBase = process.env.SQUARE_API_BASE || undefined;
        const out: Record<string, unknown>[] = [];
        for (const row of rows) {
          const token = squareToken(process.env, String(row.slug));
          let square: SquareLocation | null = null;
          if (token && row.square_location_id) {
            try {
              square = await fetchLocation(token, String(row.square_location_id), { apiBase });
            } catch (e) {
              logger.warn(`Square hours (${row.slug}): ${(e as Error).message} (keeping the hours in locations.json)`);
            }
          }
          const r = resolveHours({ hours: row.hours, hours_short: row.hours_short }, square);
          for (const w of r.warnings) logger.warn(`Square hours (${row.slug}): ${w}`);
          if (r.hours_source === 'square') logger.info(`Square hours (${row.slug}): ${r.hours.map((h) => `${h.label} ${h.opens}-${h.closes}`).join(', ')} (${r.hours_short}).`);
          else if (square) logger.info(`Square hours (${row.slug}): ${r.note ?? 'not used'}; using locations.json.`);
          out.push({ ...row, hours: r.hours, hours_short: r.hours_short, hours_source: r.hours_source });
        }
        if (!process.env.SQUARE_TOKEN && !process.env.SQUARE_TOKEN_ADDISON && !process.env.SQUARE_TOKEN_ELMHURST) {
          logger.info('Square hours off (no Square token set): using src/data/locations.json.');
        }
        store.clear();
        const fileRow = new Map(rows.map((r) => [String(r.slug), r]));
        await storeRows({ store, parseData, generateDigest, logger }, 'location', out, (r) => String(r.slug), (r) => fileRow.get(String(r.slug)));
      };
      await sync();
      // Dev server: re-run when locations.json changes (what the file() loader used to do).
      watcher?.add(locationsPath);
      watcher?.on('change', (changed) => { if (changed === locationsPath) sync().catch((e) => logger.error(String(e))); });
    },
  };
}

const locations = defineCollection({
  loader: locationsLoader(),
  schema: z.object({
    slug: locationSlug,
    name: z.string(),
    sort_order: z.number().int(),
    street: z.string(),
    city: z.string(),
    region: z.string().length(2),
    postal_code: z.string(),
    phone: z.string(),
    phone_e164: z.string().regex(/^\+1\d{10}$/),
    hours: z.array(
      z.object({
        label: z.string(),
        days: z.array(z.number().int().min(0).max(6)).min(1),
        opens: time,
        closes: time,
      }),
    ),
    hours_short: z.string(),
    /** Where `hours`/`hours_short` came from this build: Square's business hours, or src/data/locations.json. */
    hours_source: z.enum(['site', 'square']).default('site'),
    square_booking_url: z.string().url(),
    /** Square location id (the one inside square_booking_url); the roster loader lists this location's catalog. */
    square_location_id: z.string(),
    any_artist_item_id: z.string(),
    map_query: z.string(),
    parking: z.string().optional(),
    /** Instagram handle (no @) for this location; both shops currently share @skullandthrones. */
    instagram: z.string().optional(),
    /** Short verified facts (from Instagram, Oct 2026) for the location page / CMS. */
    notes: z.array(z.string()).default([]),
    placeholder_fields: z.array(z.string()).default([]),
  }),
});

const barbers = defineCollection({
  // barbers.json merged with both shops' Square catalogs (see squareRosterLoader below);
  // without SQUARE_TOKEN (or SQUARE_TOKEN_ADDISON + SQUARE_TOKEN_ELMHURST) this is exactly barbers.json.
  loader: squareRosterLoader(),
  schema: z.object({
    slug: z.string().regex(/^[a-z0-9-]+$/),
    name: z.string(),
    location: locationSlug,
    tier: z.enum(['apprentice', 'barber', 'veteran', 'master']),
    role: z.string(),
    /** Dollars. From Square's lowest-priced variation when the roster comes from Square; absent = price line hidden. */
    haircut_from: z.number().int().positive().optional(),
    /** Minutes, from Square's service_duration (Square roster only). */
    duration_minutes: z.number().int().positive().optional(),
    /** Square service item id; booking_url = location.square_booking_url + '/' + item_id */
    item_id: z.string(),
    /** Pre-resolved URL (the Supabase `barbers_with_booking` view provides this). Wins over item_id. */
    booking_url: z.string().url().optional(),
    instagram: z.string().optional(),
    /**
     * Remote headshot URL. With headshot_source 'square' it is the barber's Square photo (set by the roster loader,
     * spec §4) and renders ahead of the local file; otherwise (Supabase Storage later) the local file in
     * src/assets/headshots wins. Absent and no local file = generated placeholder tile.
     */
    headshot: z.string().url().optional(),
    /**
     * Where the current headshot came from. 'square' = Square item image or staff photo (this build, roster loader);
     * 'instagram-profile' / 'instagram-post' (a crop from a shop or collab post) mean interim until the shop supplies real headshots.
     */
    headshot_source: z.enum(['client', 'instagram-profile', 'instagram-post', 'square']).optional(),
    specialties: z.array(z.string()).default([]),
    bio: z.string().default(''),
    /** 'square' = the bio came from the barber's Square booking profile because barbers.json had none. Absent = barbers.json. */
    bio_source: z.enum(['site', 'square']).optional(),
    /** Shop-set statement "Accepting new clients" (false = "Booked up"). NOT live Square availability. */
    accepting_new_clients: z.boolean().default(true),
    /** Phase 2: written by the nightly Square availability search, e.g. "Tue 2pm". null/absent = not shown. */
    /** In Square but no barbers.json/CMS row yet: renders with the placeholder headshot and no bio. */
    needs_profile: z.boolean().default(false),
    sort_order: z.number().int().default(0),
    is_active: z.boolean().default(true),
    square_note: z.string().optional(),
    /** Languages verified from the barber's own posts. */
    languages: z.array(z.string()).default([]),
    /** URLs the bio/specialties/instagram were verified from. */
    sources: z.array(z.string().url()).default([]),
    /** confirmed | likely (handle matches roster name, location not stated) | none (nothing found). */
    confidence: z.enum(['confirmed', 'likely', 'none']).optional(),
    /** Fields that hold invented mockup copy and still need real client data. */
    placeholder_fields: z.array(z.string()).default([]),
  }),
});

const portfolio = defineCollection({
  loader: file('src/data/portfolio.json', { parser: fromKey('items', 'id') }),
  schema: z.object({
    location: locationSlug,
    barber: z.string(),
    style: z.string(),
    tag: z.enum(['fades', 'scissor', 'beards', 'kids', 'color']),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    /** Remote photo URL (Supabase Storage later). Absent = generated placeholder tile. */
    image: z.string().url().nullable().optional(),
    /** Public Instagram post this tile represents (shown as an "IG ↗" link while image is null). */
    source_url: z.string().url().optional(),
    caption: z.string().optional(),
    featured: z.boolean().default(false),
    sort_order: z.number().int().default(0),
    placeholder: z.boolean().default(false),
  }),
});

/** Behind-the-scenes page (/culture/): education, events, community, shop life. */
const culture = defineCollection({
  loader: file('src/data/culture.json', { parser: fromKey('culture_items', 'id') }),
  schema: z.object({
    kind: z.enum(['photo', 'post']),
    /** null = placeholder tile; a file name in src/assets/culture/ or a remote URL (Supabase Storage later). */
    image: z.string().nullable().default(null),
    /** Instagram post this tile represents (shown as an "IG ↗" link while image is null). */
    source_url: z.string().url().nullable().default(null),
    caption: z.string(),
    date: z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/, 'YYYY-MM-DD or YYYY-MM').nullable().default(null),
    category: z.enum(['education', 'events', 'community', 'shop']),
    featured: z.boolean().default(false),
    sort_order: z.number().int().default(0),
  }),
});

/** Stat row on /culture/ (same JSON file, `stats` key). */
const cultureStats = defineCollection({
  loader: file('src/data/culture.json', { parser: fromKey('stats', 'id') }),
  schema: z.object({
    value: z.string(),
    label: z.string(),
    /** Where the number comes from (Instagram post URL). */
    source: z.string().url(),
  }),
});

/**
 * Retail products. Two sources, one row shape (see docs/SQUARE-INTEGRATION-SPEC.md section 5):
 * - default (SHOP_SOURCE unset or "bodega"): src/data/products.json from the Bodega Shopify feed, exactly as before.
 * - SHOP_SOURCE=square AND SQUARE_TOKEN (or both SQUARE_TOKEN_*) set: the shops' Square retail catalog (src/lib/square-products.ts),
 *   with stock from the Inventory API and buy links from src/data/square-buy-links.json / square-payment-links.json.
 * A Square failure, or Square returning no listable products, logs a warning and falls back to products.json.
 * The brand allowlist (BRANDS in src/lib/square-products.ts, shared with scripts/sync-products.mjs) applies to both.
 */
function productsLoader(): Loader {
  return {
    name: 'products',
    load: async ({ store, parseData, generateDigest, logger, config, watcher }) => {
      const dataPath = (name: string) => fileURLToPath(new URL(`src/data/${name}`, config.root));
      const productsPath = dataPath('products.json');
      const readJson = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
      const sync = async () => {
        const fileRows: Record<string, unknown>[] = (await readJson(productsPath)).products;
        let rows: Record<string, unknown>[] = fileRows;
        const source = (process.env.SHOP_SOURCE || 'bodega').trim().toLowerCase();
        if (source === 'square') {
          const links: BuyLinks = { ...NO_LINKS };
          try {
            links.store = (await readJson(dataPath('square-buy-links.json'))).links ?? {};
            links.payment = (await readJson(dataPath('square-payment-links.json'))).links ?? {};
          } catch (e) { logger.warn(`Square products: could not read the buy link files (${(e as Error).message}); items get no buy link.`); }
          const shops = (await readJson(dataPath('locations.json'))).locations as SquareShop[];
          const res = await fetchSquareProducts(shops, process.env, links, { apiBase: process.env.SQUARE_API_BASE || undefined });
          if (res.missing.length) logger.warn(`SHOP_SOURCE=square but ${res.missing.join(', ')} not set: using src/data/products.json (Bodega).`);
          for (const e of res.errors) logger.warn(`Square products: ${e}`);
          if (!res.missing.length) {
            if (res.errors.length || !res.products.length) {
              logger.warn(`Square products: ${res.errors.length ? 'a shop failed' : 'no listable products'}; using src/data/products.json (Bodega).`);
            } else {
              const skipped = [...new Map(res.skipped.map((s) => [s.name, s.reason])).values()].reduce<Record<string, number>>((n, r) => ({ ...n, [r]: (n[r] ?? 0) + 1 }), {});
              logger.info(`Square products: ${res.products.length} listed (${res.products.filter((p) => p.available).length} in stock)${Object.keys(skipped).length ? `, skipped ${Object.entries(skipped).map(([k, v]) => `${v} ${k}`).join(', ')}` : ''}.`);
              rows = res.products as unknown as Record<string, unknown>[];
            }
          }
        }
        store.clear();
        // A product row that fails the schema is skipped with an error (no per-row fallback: a Square row and a Bodega row are different products).
        const fromSquare = rows !== fileRows;
        await storeRows({ store, parseData, generateDigest, logger }, 'product', rows.filter((r) => allowedBrand(r.vendor)), (r) => String(r.handle), () => undefined, !fromSquare);
      };
      await sync();
      // Dev server: re-run when products.json changes (what the file() loader used to do).
      watcher?.add(productsPath);
      watcher?.on('change', (changed) => { if (changed === productsPath) sync().catch((e) => logger.error(String(e))); });
    },
  };
}

const price = z.string().regex(/^\d+\.\d{2}$/, 'USD, e.g. "24.95"');
const products = defineCollection({
  loader: productsLoader(),
  schema: z.object({
    handle: z.string(),
    title: z.string(),
    vendor: z.string(),
    /** Lowest available variant price. */
    price,
    compare_at_price: price.nullable().default(null),
    /** Product photo. Shopify CDN original (pages append &width=N for a resized copy) or a Square image URL (used as is). */
    image: z.string().url(),
    image_width: z.number().int().positive().default(1000),
    image_height: z.number().int().positive().default(1000),
    alt: z.string(),
    /** Product page (bybodega.com, or the shop's Square Online page). null = no product page to link to (Square item without a store link). */
    url: z.string().url().nullable().default(null),
    /* checkout route switch: Bodega product page today; Square store page (S1) or payment link (S2) with SHOP_SOURCE=square. null = no online buy button ("Available in shop"). */
    buy_url: z.string().url().nullable().default(null),
    product_type: z.string().default(''),
    tags: z.array(z.string()).default([]),
    available: z.boolean().default(true),
    /** Shown in the home-page product strip. */
    featured: z.boolean().default(false),
    sort_order: z.number().int().default(0),
    /** Where the row came from. */
    source: z.enum(['bodega', 'square']).default('bodega'),
  }),
});

export const collections = { locations, barbers, portfolio, culture, cultureStats, products };

/* ---------------------------------------------------------------------------------------
 * Supabase loader stub (not wired up yet). To switch, replace e.g.
 *   loader: file('src/data/barbers.json', { parser: fromKey('barbers', 'slug') }),
 * with
 *   loader: supabaseLoader('barbers_with_booking', 'slug', { is_active: 'eq.true' }),
 * and set PUBLIC_SUPABASE_URL / PUBLIC_SUPABASE_ANON_KEY in the build environment
 * (GitHub repo → Settings → Variables). RLS limits the anon key to public rows.
 *
 * import type { Loader } from 'astro/loaders';
 *
 * function supabaseLoader(table: string, idField: string, filters: Record<string, string> = {}): Loader {
 *   return {
 *     name: `supabase:${table}`,
 *     load: async ({ store, parseData, logger }) => {
 *       const url = new URL(`/rest/v1/${table}`, import.meta.env.PUBLIC_SUPABASE_URL);
 *       url.searchParams.set('select', '*');
 *       for (const [k, v] of Object.entries(filters)) url.searchParams.set(k, v);
 *       const key = import.meta.env.PUBLIC_SUPABASE_ANON_KEY;
 *       const res = await fetch(url, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
 *       if (!res.ok) throw new Error(`Supabase ${table}: ${res.status} ${await res.text()}`);
 *       const rows: Record<string, unknown>[] = await res.json();
 *       store.clear();
 *       for (const row of rows) {
 *         const id = String(row[idField]);
 *         store.set({ id, data: await parseData({ id, data: row }) });
 *       }
 *       logger.info(`Loaded ${rows.length} rows from ${table}`);
 *     },
 *   };
 * }
 * ------------------------------------------------------------------------------------- */
