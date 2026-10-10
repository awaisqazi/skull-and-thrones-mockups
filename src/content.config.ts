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
import { file, type Loader } from 'astro/loaders';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { fetchShops, type SquareShop } from './lib/square.ts';
import { mergeRoster, type Row } from './lib/roster.ts';

const locationSlug = z.enum(['addison', 'elmhurst']);
const time = z.string().regex(/^\d{2}:\d{2}$/, 'HH:MM, 24h shop-local time');

/** Unwraps `{ "_note": "...", "<key>": [...] }` and keys every entry by its slug/id. */
const fromKey = (key: string, idField: string) => (text: string) =>
  (JSON.parse(text)[key] as Record<string, unknown>[]).map((row) => ({ id: String(row[idField]), ...row }));

/**
 * Barbers roster: Square decides who exists, barbers.json (the CMS later) decides how they look.
 * - SQUARE_TOKEN_ADDISON and SQUARE_TOKEN_ELMHURST set: list each shop's Square catalog items
 *   (src/lib/square.ts) and merge with barbers.json by item_id (src/lib/roster.ts, unit-tested).
 *   New Square items get an auto slug + needs_profile; rows gone from Square get is_active: false.
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
        if (missing.length) logger.info(`Square roster off (${missing.join(', ')} not set): using src/data/barbers.json.`);
        for (const e of errors) logger.warn(`Square roster: ${e} (that shop falls back to barbers.json)`);
        if (Object.keys(square).length) {
          const merged = mergeRoster({ rows, square, excludeItemIds: shops.map((l) => l.any_artist_item_id ?? '') });
          for (const w of merged.warnings) logger.warn(w);
          const { matched, added, deactivated } = merged.stats;
          logger.info(`Square roster (${Object.keys(square).join(' + ')}): ${matched} matched, ${added} new, ${deactivated} no longer in Square.`);
          roster = merged.rows;
        }
        store.clear();
        for (const row of roster) {
          const id = String(row.slug);
          store.set({ id, data: await parseData({ id, data: row }), digest: generateDigest(row) });
        }
      };
      await sync();
      // Dev server: re-run when barbers.json changes (what the file() loader used to do).
      watcher?.add(barbersPath);
      watcher?.on('change', (changed) => { if (changed === barbersPath) sync().catch((e) => logger.error(String(e))); });
    },
  };
}

const locations = defineCollection({
  loader: file('src/data/locations.json', { parser: fromKey('locations', 'slug') }),
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
  // without SQUARE_TOKEN_ADDISON + SQUARE_TOKEN_ELMHURST this is exactly barbers.json.
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
    /** Remote headshot URL (Supabase Storage later). Absent = generated placeholder tile. */
    headshot: z.string().url().optional(),
    /** Where the current headshot came from; 'instagram-profile' means interim until the shop supplies real headshots. */
    headshot_source: z.enum(['client', 'instagram-profile']).optional(),
    specialties: z.array(z.string()).default([]),
    bio: z.string().default(''),
    /** Shop-set statement "Accepting new clients" (false = "Booked up"). NOT live Square availability. */
    accepting_new_clients: z.boolean().default(true),
    /** Phase 2: written by the nightly Square availability search, e.g. "Tue 2pm". null/absent = not shown. */
    next_opening: z.string().nullable().default(null),
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

/** Retail products from Bodega (bybodega.com, Shopify). Written by scripts/sync-products.mjs. */
const price = z.string().regex(/^\d+\.\d{2}$/, 'USD, e.g. "24.95"');
const products = defineCollection({
  loader: file('src/data/products.json', { parser: fromKey('products', 'handle') }),
  schema: z.object({
    handle: z.string(),
    title: z.string(),
    vendor: z.string(),
    /** Lowest available variant price. */
    price,
    compare_at_price: price.nullable().default(null),
    /** Shopify CDN original; pages append &width=N for a resized copy. */
    image: z.string().url(),
    image_width: z.number().int().positive().default(1000),
    image_height: z.number().int().positive().default(1000),
    alt: z.string(),
    /** Product page on bybodega.com. */
    url: z.string().url(),
    /* checkout route switch: today = url. Later a Shopify Buy Button checkout or a Square Online checkout link. */
    buy_url: z.string().url(),
    product_type: z.string().default(''),
    tags: z.array(z.string()).default([]),
    available: z.boolean().default(true),
    /** Shown in the home-page product strip. */
    featured: z.boolean().default(false),
    sort_order: z.number().int().default(0),
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
