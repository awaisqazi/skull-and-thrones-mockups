#!/usr/bin/env node
/**
 * npm run availability [-- options]
 * The 15-minute job (spec §3, .github/workflows/availability.yml): for each shop with a token, list
 * its Square catalog, map every barber item to a bookable variation + team member, run one
 * availability search per barber for the next 7 days, and write availability.json.
 *
 *   --dry-run            print the barber → variation → team member mapping and exit (catalog calls only, nothing written)
 *   --out <file>         where to write (default src/data/availability.json, the baked snapshot)
 *   --previous <file>    last published file; a shop that fails keeps its block from here with ok:false
 *                        (default: the --out file)
 *   --sandbox            one shop (addison) from SQUARE_SANDBOX_TOKEN + SQUARE_SANDBOX_LOCATION_ID against
 *                        https://connect.squareupsandbox.com (seed it with npm run seed:sandbox)
 *   --fixture <file>     replay recorded Square responses instead of calling Square (no tokens needed);
 *                        slot dates are moved so the fixture's anchor_date becomes today
 *
 * Tokens: SQUARE_TOKEN_ADDISON / SQUARE_TOKEN_ELMHURST (env or the git-ignored site/.env).
 * SQUARE_API_BASE overrides the API host. Tokens are never printed.
 * Exit code: 0 even when Square fails for a shop (the failure is recorded in the file); 1 only when
 * the file cannot be written or the arguments are wrong.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { listSquareItems, tokenEnv } from '../src/lib/square.ts';
import { isBarberItem } from '../src/lib/roster.ts';
import { pickBookableVariation, searchAvailability, summarise, isoSeconds, localDate } from '../src/lib/bookings.ts';

const root = new URL('../', import.meta.url);
if (existsSync(new URL('.env', root))) process.loadEnvFile(new URL('.env', root));

const TZ = 'America/Chicago';
const WINDOW_DAYS = 7;
const CONCURRENCY = 4;
const SANDBOX_API = 'https://connect.squareupsandbox.com';

let args;
try {
  args = parseArgs({
    options: {
      'dry-run': { type: 'boolean', default: false },
      out: { type: 'string' },
      previous: { type: 'string' },
      sandbox: { type: 'boolean', default: false },
      fixture: { type: 'string' },
    },
  }).values;
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
const out = resolve(args.out ?? fileURLToPath(new URL('src/data/availability.json', root)));
const previousPath = resolve(args.previous ?? out);

const shops = JSON.parse(await readFile(new URL('src/data/locations.json', root), 'utf8')).locations;
const exclude = new Set(shops.map((s) => s.any_artist_item_id).filter(Boolean));

/* ---------- Previous file (a failing shop keeps its last good block) ---------- */
let previous = { shops: {} };
try {
  const p = JSON.parse(await readFile(previousPath, 'utf8'));
  if (p && typeof p.shops === 'object' && p.shops) previous = p;
} catch { /* first run, or no previous file: start empty */ }

/* ---------- Credentials per shop ---------- */
const fixture = args.fixture ? JSON.parse(await readFile(resolve(args.fixture), 'utf8')) : null;
function credsFor(shop) {
  if (fixture) {
    const f = fixture.shops?.[shop.slug];
    return f ? { token: 'fixture', locationId: f.location_id ?? shop.square_location_id, fetch: replay(f), apiBase: 'https://fixture.invalid' } : { missing: 'not in fixture' };
  }
  if (args.sandbox) {
    // The sandbox has one seller and one location; it stands in for the first shop only.
    if (shop.slug !== shops[0].slug) return { missing: 'token missing (sandbox run covers one shop)' };
    const token = process.env.SQUARE_SANDBOX_TOKEN, locationId = process.env.SQUARE_SANDBOX_LOCATION_ID;
    if (!token || !locationId) return { missing: 'token missing (SQUARE_SANDBOX_TOKEN / SQUARE_SANDBOX_LOCATION_ID)' };
    return { token, locationId, apiBase: process.env.SQUARE_API_BASE || SANDBOX_API };
  }
  const token = process.env[tokenEnv(shop.slug)];
  if (!token) return { missing: 'token missing' };
  return { token, locationId: shop.square_location_id, apiBase: process.env.SQUARE_API_BASE || undefined };
}

/**
 * Fixture replay: answers POST /v2/catalog/search and /v2/bookings/availability/search from recorded
 * responses. Slots are shifted by whole days so `anchor_date` (shop-local) lands on today.
 */
function replay(f) {
  const shiftMs = (Date.parse(localDate(new Date(), TZ)) - Date.parse(fixture.anchor_date)) || 0;
  return async (url, init) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    if (url.endsWith('/v2/catalog/search')) return Response.json({ objects: f.catalog ?? [] });
    if (url.endsWith('/v2/bookings/availability/search')) {
      const flt = body.query.filter;
      const rec = f.availability?.[flt.segment_filters[0].service_variation_id];
      if (!rec) return Response.json({ availabilities: [], errors: [] });
      if (rec.status && rec.status !== 200) return Response.json({ errors: rec.errors ?? [] }, { status: rec.status });
      const from = Date.parse(flt.start_at_range.start_at), to = Date.parse(flt.start_at_range.end_at);
      const availabilities = (rec.availabilities ?? [])
        .map((a) => ({ ...a, start_at: isoSeconds(new Date(Date.parse(a.start_at) + shiftMs)) }))
        .filter((a) => { const t = Date.parse(a.start_at); return t >= from && t <= to; });
      return Response.json({ availabilities, errors: [] });
    }
    return Response.json({ errors: [{ code: 'NOT_FOUND', detail: `fixture has no ${url}` }] }, { status: 404 });
  };
}

/* ---------- Helpers ---------- */
async function pool(items, n, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; results[i] = await fn(items[i], i); }
  }));
  return results;
}

/** Shop failed this run: keep the previous good block (fetched_at stays old, so the site hides it after 2 h). */
function failed(slug, error) {
  const prev = previous.shops?.[slug] ?? {};
  return { ...(prev.fetched_at ? { fetched_at: prev.fetched_at } : {}), ok: false, error, ...(prev.barbers ? { barbers: prev.barbers } : {}) };
}

/** Barber items → { item, choice, problem } (the mapping --dry-run prints). */
function mapBarbers(items) {
  return items.filter((i) => isBarberItem(i, exclude)).map((item) => {
    const choice = pickBookableVariation(item);
    const problem = !choice ? 'no service variation bookable online'
      : !choice.team_member_id ? `no team member assigned to variation ${choice.variation.id} (${choice.variation.name || 'unnamed'})`
      : null;
    return { item, choice, problem };
  });
}

/* ---------- Run ---------- */
const now = new Date();
const window = { start: now, end: new Date(now.getTime() + WINDOW_DAYS * 86400000) };
const result = {};

for (const shop of shops) {
  const creds = credsFor(shop);
  if (creds.missing) {
    console.log(`${shop.slug}: ${creds.missing}; ${previous.shops?.[shop.slug]?.barbers ? 'keeping the previous block' : 'no data'}.`);
    result[shop.slug] = failed(shop.slug, creds.missing);
    continue;
  }
  const opts = { apiBase: creds.apiBase, ...(creds.fetch ? { fetch: creds.fetch } : {}) };
  let mapped;
  try {
    mapped = mapBarbers(await listSquareItems(creds.token, creds.locationId, opts));
    if (!mapped.length) throw new Error(`no barber service items at location ${creds.locationId}`);
  } catch (e) {
    console.log(`${shop.slug}: catalog failed: ${e.message}`);
    result[shop.slug] = failed(shop.slug, `catalog: ${e.message}`);
    continue;
  }

  if (args['dry-run']) {
    console.log(`\n${shop.name} (location ${creds.locationId}): ${mapped.length} barber items`);
    for (const { item, choice, problem } of mapped) {
      const v = choice?.variation;
      const extra = v && v.team_member_ids.length > 1 ? `  (warn: ${v.team_member_ids.length} team members on this variation; using the first)` : '';
      console.log(`  ${item.name.padEnd(26)} item ${item.item_id}  →  ${v ? `"${v.name}" ${v.id} ${v.price != null ? '$' + v.price : '—'}` : '—'}  →  ${choice?.team_member_id ?? '—'}${problem ? `  [NO DATA: ${problem}]` : ''}${extra}`);
    }
    continue;
  }

  const entries = await pool(mapped, CONCURRENCY, async ({ item, choice, problem }) => {
    if (problem) return [item.item_id, { ...(choice ? { variation_id: choice.variation.id } : {}), error: problem }];
    const base = { variation_id: choice.variation.id, team_member_id: choice.team_member_id };
    try {
      const slots = await searchAvailability(creds.token, creds.locationId, choice.variation.id, choice.team_member_id, window, opts);
      return [item.item_id, { ...base, ...summarise(slots, now, TZ, WINDOW_DAYS) }];
    } catch (e) {
      return [item.item_id, { ...base, error: e.message }];
    }
  });
  const searched = entries.filter(([, b]) => b.team_member_id);
  const good = searched.filter(([, b]) => !b.error);
  if (searched.length && !good.length) {
    // Every search failed (auth, Appointments not enabled, outage): treat as a shop failure, keep the last good data.
    const why = searched[0][1].error;
    console.log(`${shop.slug}: every availability search failed: ${why}`);
    result[shop.slug] = failed(shop.slug, why);
    continue;
  }
  result[shop.slug] = { fetched_at: isoSeconds(new Date()), ok: true, barbers: Object.fromEntries(entries) };
  const open = good.filter(([, b]) => b.next).length;
  const nodata = entries.length - good.length;
  console.log(`${shop.slug}: ${entries.length} barbers, ${open} with an opening in ${WINDOW_DAYS} days, ${good.length - open} booked up, ${nodata} no data.`);
  for (const [id, b] of entries) if (b.error) console.log(`  no data for ${id}: ${b.error}`);
}

if (args['dry-run']) process.exit(0);

const file = { generated_at: isoSeconds(now), window_days: WINDOW_DAYS, tz: TZ, shops: result };
try {
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(file, null, 2) + '\n');
  console.log(`wrote ${out}`);
} catch (e) {
  console.error(`could not write ${out}: ${e.message}`);
  process.exit(1);
}
