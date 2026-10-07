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
import { file } from 'astro/loaders';

const locationSlug = z.enum(['addison', 'elmhurst']);
const time = z.string().regex(/^\d{2}:\d{2}$/, 'HH:MM, 24h shop-local time');

/** Unwraps `{ "_note": "...", "<key>": [...] }` and keys every entry by its slug/id. */
const fromKey = (key: string, idField: string) => (text: string) =>
  (JSON.parse(text)[key] as Record<string, unknown>[]).map((row) => ({ id: String(row[idField]), ...row }));

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
    any_artist_item_id: z.string(),
    map_query: z.string(),
    parking: z.string().optional(),
    placeholder_fields: z.array(z.string()).default([]),
  }),
});

const barbers = defineCollection({
  loader: file('src/data/barbers.json', { parser: fromKey('barbers', 'slug') }),
  schema: z.object({
    slug: z.string().regex(/^[a-z0-9-]+$/),
    name: z.string(),
    location: locationSlug,
    tier: z.enum(['apprentice', 'barber', 'veteran', 'master']),
    role: z.string(),
    haircut_from: z.number().int().positive(),
    /** Square service item id; booking_url = location.square_booking_url + '/' + item_id */
    item_id: z.string(),
    /** Pre-resolved URL (the Supabase `barbers_with_booking` view provides this). Wins over item_id. */
    booking_url: z.string().url().optional(),
    instagram: z.string().optional(),
    /** Remote headshot URL (Supabase Storage later). Absent = generated placeholder tile. */
    headshot: z.string().url().optional(),
    specialties: z.array(z.string()).default([]),
    bio: z.string().default(''),
    accepting_new_clients: z.boolean().default(true),
    sort_order: z.number().int().default(0),
    is_active: z.boolean().default(true),
    square_note: z.string().optional(),
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
    image: z.string().url().optional(),
    featured: z.boolean().default(false),
    sort_order: z.number().int().default(0),
    placeholder: z.boolean().default(false),
  }),
});

export const collections = { locations, barbers, portfolio };

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
