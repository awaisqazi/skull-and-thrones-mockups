#!/usr/bin/env node
/**
 * npm run availability [-- options]
 * The 15-minute job (spec §3, .github/workflows/availability.yml): for each shop with a token, list
 * its Square catalog and its team member booking profiles, map every barber item to a bookable variation +
 * team member, run one availability search per barber that is bookable online for the next 7 days, and
 * write availability.json. A barber whose team member is not bookable online (Square booking profile
 * is_bookable false) is not searched and gets `bookable: false` (the site shows "Call the shop to book").
 *
 *   --dry-run            print the barber → variation → team member → bookable mapping and exit (catalog + profile calls only, nothing written)
 *   --out <file>         where to write (default src/data/availability.json, the baked snapshot)
 *   --previous <file>    last published file; a shop that fails keeps its block from here with ok:false
 *                        (default: the --out file)
 *   --sandbox            one shop (addison) from SQUARE_SANDBOX_TOKEN + SQUARE_SANDBOX_LOCATION_ID against
 *                        https://connect.squareupsandbox.com (seed it with npm run seed:sandbox)
 *   --fixture <file>     replay recorded Square responses instead of calling Square (no tokens needed);
 *                        slot dates are moved so the fixture's anchor_date becomes today
 *
 * Tokens: SQUARE_TOKEN (main account) plus SQUARE_TOKEN_ELMHURST (separate Elmhurst account); SQUARE_TOKEN_<SHOP> overrides (env or the git-ignored site/.env).
 * SQUARE_API_BASE overrides the API host. Tokens are never printed.
 * Exit code: 0 when every shop worked or failed for a passing reason (5xx, network, empty catalog: the failure is
 * recorded in the file and the shop keeps its last good block); 2 when a shop's catalog or booking-profiles call
 * answered HTTP 401/403 (token rejected: the file is still written first, then one "AUTH FAILURE <shop>" line per
 * shop and exit 2, so the workflow publishes the stale-but-honest file and then fails, which emails the repo owner);
 * 1 when the file cannot be written or the arguments are wrong (any AUTH FAILURE lines are still printed first).
 * Time budget: AVAILABILITY_DEADLINE_MS (default 360000 = 6 min); past it no new search or shop starts, those barbers
 * get `error: 'deadline'` (a shop not reached keeps its previous block), and the file is written as usual.
 * Square bodies are read strictly (src/lib/square.ts readJson): a 2xx that is not the expected JSON is an error for
 * that call, never "nothing open"; a bad booking-profiles body means "bookable unknown" (no flag, everyone searched).
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { listSquareItems, squareToken, tokenEnv } from '../src/lib/square.ts';
import { isBarberItem } from '../src/lib/roster.ts';
import {
  pickBookableVariation, searchAvailability, summarise, isoSeconds, localDate,
  listTeamMemberBookingProfiles, profilesById, bookableFrom, isAuthFailure,
} from '../src/lib/bookings.ts';
import { parseFile } from '../src/lib/availability.ts';

const root = new URL('../', import.meta.url);
if (existsSync(new URL('.env', root))) process.loadEnvFile(new URL('.env', root));

const TZ = 'America/Chicago';
const WINDOW_DAYS = 7;
const CONCURRENCY = 4;
/**
 * Overall time budget (spec §3): once it is spent no new search starts; the barbers left get `error: 'deadline'`
 * and the file is still written, well inside the workflow's 10-minute timeout. Env AVAILABILITY_DEADLINE_MS.
 */
const DEADLINE_MS = Number.isFinite(Number(process.env.AVAILABILITY_DEADLINE_MS)) && process.env.AVAILABILITY_DEADLINE_MS !== ''
  ? Number(process.env.AVAILABILITY_DEADLINE_MS) : 360000;
const STARTED = Date.now();
const pastDeadline = () => Date.now() - STARTED >= DEADLINE_MS;
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
// Read through parseFile (src/lib/availability.ts), so only well-formed shop and barber blocks are ever carried over.
let previous = { shops: {} };
if (existsSync(previousPath)) {
  let raw = null;
  try {
    raw = JSON.parse(await readFile(previousPath, 'utf8'));
  } catch (e) {
    console.log(`previous file ${previousPath} is unreadable (${e.message}); starting empty.`);
  }
  if (raw !== null) {
    const isObj = (x) => typeof x === 'object' && x !== null && !Array.isArray(x);
    if (!isObj(raw) || !isObj(raw.shops)) console.log(`previous file ${previousPath} is not an availability file (no "shops" object); starting empty.`);
    previous = parseFile(raw);
  }
} else {
  console.log(`no previous file at ${previousPath}; starting empty.`);
}

/* ---------- Credentials per shop ---------- */
const fixture = args.fixture ? JSON.parse(await readFile(resolve(args.fixture), 'utf8')) : null;
function credsFor(shop) {
  if (fixture) {
    const f = fixture.shops?.[shop.slug];
    return f ? { token: 'fixture', tokenVar: 'the fixture', locationId: f.location_id ?? shop.square_location_id, fetch: replay(f), apiBase: 'https://fixture.invalid' } : { missing: 'not in fixture' };
  }
  if (args.sandbox) {
    // The sandbox has one seller and one location; it stands in for the first shop only.
    if (shop.slug !== shops[0].slug) return { missing: 'token missing (sandbox run covers one shop)' };
    const token = process.env.SQUARE_SANDBOX_TOKEN, locationId = process.env.SQUARE_SANDBOX_LOCATION_ID;
    if (!token || !locationId) return { missing: 'token missing (SQUARE_SANDBOX_TOKEN / SQUARE_SANDBOX_LOCATION_ID)' };
    return { token, tokenVar: 'SQUARE_SANDBOX_TOKEN', locationId, apiBase: process.env.SQUARE_API_BASE || SANDBOX_API };
  }
  const token = squareToken(process.env, shop.slug);
  if (!token) return { missing: 'token missing' };
  // Which env var supplied it, for the AUTH FAILURE line (never the value).
  const tokenVar = process.env[tokenEnv(shop.slug)] ? tokenEnv(shop.slug) : 'SQUARE_TOKEN';
  return { token, tokenVar, locationId: shop.square_location_id, apiBase: process.env.SQUARE_API_BASE || undefined };
}

/**
 * Fixture replay: answers POST /v2/catalog/search, GET /v2/bookings/team-member-booking-profiles and
 * POST /v2/bookings/availability/search from recorded responses. Slots are shifted by whole days so
 * `anchor_date` (shop-local) lands on today. Per shop: `catalog` (objects), `profiles` (booking profiles;
 * absent = an empty list), `availability` (by variation id); `catalog_status` / `profiles_status` (+ `errors`)
 * make that call fail with the given HTTP status (tests use 401 to exercise the auth-failure exit).
 */
function replay(f) {
  const shiftMs = (Date.parse(localDate(new Date(), TZ)) - Date.parse(fixture.anchor_date)) || 0;
  return async (url, init) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    const fail = (status) => Response.json({ errors: f.errors ?? [{ category: 'AUTHENTICATION_ERROR', code: 'UNAUTHORIZED', detail: 'fixture' }] }, { status });
    if (url.endsWith('/v2/catalog/search')) return f.catalog_status ? fail(f.catalog_status) : Response.json({ objects: f.catalog ?? [] });
    if (url.includes('/v2/bookings/team-member-booking-profiles')) {
      return f.profiles_status ? fail(f.profiles_status) : Response.json({ team_member_booking_profiles: f.profiles ?? [], errors: [] });
    }
    if (url.endsWith('/v2/bookings/availability/search')) {
      const flt = body.query.filter;
      const rec = f.availability?.[flt.segment_filters[0].service_variation_id];
      if (!rec) return Response.json({ availabilities: [], errors: [] });
      if (rec.delay_ms) await new Promise((r) => setTimeout(r, rec.delay_ms)); // tests: a slow search (deadline)
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

/**
 * Barber items → { item, choice, problem, bookable } (the mapping --dry-run prints). `profiles` = the shop's
 * booking profiles by team member id, or null when that call failed (bookable then stays undefined).
 */
function mapBarbers(items, profiles) {
  return items.filter((i) => isBarberItem(i, exclude)).map((item) => {
    const choice = pickBookableVariation(item);
    const problem = !choice ? 'no service variation bookable online'
      : !choice.team_member_id ? `no team member assigned to variation ${choice.variation.id} (${choice.variation.name || 'unnamed'})`
      : null;
    const bookable = choice?.team_member_id ? bookableFrom(profiles, choice.team_member_id) : undefined;
    return { item, choice, problem, bookable };
  });
}

/** Shops whose token Square rejected (HTTP 401/403 on the catalog or profiles call): reported last, exit 2. */
const authFailures = [];
function authFailure(shop, creds, e) {
  const status = e?.status || Number(/\(HTTP (\d{3})\)/.exec(String(e?.message))?.[1]) || 401;
  authFailures.push(`AUTH FAILURE ${shop.slug}: token rejected (HTTP ${status}). Rotate ${creds.tokenVar}`);
}

/* ---------- Run ---------- */
const now = new Date();
const window = { start: now, end: new Date(now.getTime() + WINDOW_DAYS * 86400000) };
const result = {};

for (const shop of shops) {
  if (pastDeadline()) {
    console.log(`${shop.slug}: time budget (${DEADLINE_MS} ms) spent before this shop; keeping the previous block.`);
    result[shop.slug] = failed(shop.slug, 'deadline');
    continue;
  }
  const creds = credsFor(shop);
  if (creds.missing) {
    console.log(`${shop.slug}: ${creds.missing}; ${previous.shops?.[shop.slug]?.barbers ? 'keeping the previous block' : 'no data'}.`);
    result[shop.slug] = failed(shop.slug, creds.missing);
    continue;
  }
  const opts = { apiBase: creds.apiBase, ...(creds.fetch ? { fetch: creds.fetch } : {}) };
  let items;
  try {
    items = await listSquareItems(creds.token, creds.locationId, opts);
  } catch (e) {
    console.log(`${shop.slug}: catalog failed: ${e.message}`);
    if (isAuthFailure(e)) authFailure(shop, creds, e);
    result[shop.slug] = failed(shop.slug, `catalog: ${e.message}`);
    continue;
  }
  // One profiles call per shop: who is bookable online. A rejected token here is an auth failure like the
  // catalog's; any other failure (5xx, network) only costs the `bookable` flag: everyone is searched as before.
  let profiles = null;
  try {
    profiles = profilesById(await listTeamMemberBookingProfiles(creds.token, creds.locationId, opts));
  } catch (e) {
    console.log(`${shop.slug}: booking profiles failed: ${e.message}`);
    if (isAuthFailure(e)) {
      authFailure(shop, creds, e);
      result[shop.slug] = failed(shop.slug, `booking profiles: ${e.message}`);
      continue;
    }
    console.log(`${shop.slug}: continuing without the bookable flag (every barber is searched).`);
  }
  const mapped = mapBarbers(items, profiles);
  if (!mapped.length) {
    const why = `no barber service items at location ${creds.locationId}`;
    console.log(`${shop.slug}: catalog failed: ${why}`);
    result[shop.slug] = failed(shop.slug, `catalog: ${why}`);
    continue;
  }

  if (args['dry-run']) {
    const offlineCount = mapped.filter((m) => m.bookable === false).length;
    console.log(`\n${shop.name} (location ${creds.locationId}): ${mapped.length} barber items; booking profiles: ${profiles ? `${profiles.size} listed, ${offlineCount ? `${offlineCount} barber(s) not bookable online` : 'every mapped barber bookable online'}` : 'call failed, bookable unknown'}`);
    for (const { item, choice, problem, bookable } of mapped) {
      const v = choice?.variation;
      const extra = v && v.team_member_ids.length > 1 ? `  (warn: ${v.team_member_ids.length} team members on this variation; using the first)` : '';
      const flag = bookable === false ? '  [NOT BOOKABLE ONLINE: not searched, "Call the shop to book"]' : bookable === undefined && !problem ? '  (bookable unknown)' : '';
      console.log(`  ${item.name.padEnd(26)} item ${item.item_id}  →  ${v ? `"${v.name}" ${v.id} ${v.price != null ? '$' + v.price : '—'}` : '—'}  →  ${choice?.team_member_id ?? '—'}${problem ? `  [NO DATA: ${problem}]` : ''}${flag}${extra}`);
    }
    continue;
  }

  const entries = await pool(mapped, CONCURRENCY, async ({ item, choice, problem, bookable }) => {
    if (problem) return [item.item_id, { ...(choice ? { variation_id: choice.variation.id } : {}), error: problem }];
    const base = { variation_id: choice.variation.id, team_member_id: choice.team_member_id, ...(bookable !== undefined ? { bookable } : {}) };
    // Not bookable online: Square would only say "no openings"; skip the call and say so (no `error`: this is data).
    if (bookable === false) return [item.item_id, { ...base, next: null, soon: [], slots_today: 0, slots_7d: 0 }];
    if (pastDeadline()) return [item.item_id, { ...base, error: 'deadline' }];
    try {
      const slots = await searchAvailability(creds.token, creds.locationId, choice.variation.id, choice.team_member_id, window, opts);
      return [item.item_id, { ...base, ...summarise(slots, now, TZ, WINDOW_DAYS) }];
    } catch (e) {
      return [item.item_id, { ...base, error: e.message }];
    }
  });
  const searched = entries.filter(([, b]) => b.team_member_id && b.bookable !== false);
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
  const offline = entries.filter(([, b]) => b.bookable === false).length;
  const nodata = entries.length - good.length - offline;
  console.log(`${shop.slug}: ${entries.length} barbers, ${open} with an opening in ${WINDOW_DAYS} days, ${good.length - open} booked up, ${offline} not bookable online, ${nodata} no data${profiles ? '' : ' (bookable unknown: profiles call failed)'}.`);
  for (const [id, b] of entries) if (b.bookable === false) console.log(`  not bookable online: ${id} (team member ${b.team_member_id})`);
  for (const [id, b] of entries) if (b.error) console.log(`  no data for ${id}: ${b.error}`);
}

/** Printed after everything else (and after the file is written) so the line is the last thing in the log. */
function reportAuthFailures() {
  for (const line of authFailures) console.error(line);
  if (authFailures.length) process.exit(2);
}

if (args['dry-run']) { reportAuthFailures(); process.exit(0); }

const file = { generated_at: isoSeconds(now), window_days: WINDOW_DAYS, tz: TZ, shops: result };
try {
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(file, null, 2) + '\n');
  console.log(`wrote ${out}`);
} catch (e) {
  console.error(`could not write ${out}: ${e.message}`);
  for (const line of authFailures) console.error(line); // the rotate hint still reaches the log
  process.exit(1);
}
reportAuthFailures();
