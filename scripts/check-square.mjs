#!/usr/bin/env node
/**
 * npm run check:square
 * Lists each shop's Square catalog with the real API and prints the roster the build would use
 * (Square merged with src/data/barbers.json). Read-only: only POST /v2/catalog/search.
 *
 * Needs SQUARE_TOKEN_ADDISON and SQUARE_TOKEN_ELMHURST (env or a git-ignored site/.env).
 * Without them it says so and exits 0. Exits 1 if a shop's fetch fails.
 * Node 22.18+ (imports the .ts modules directly; Node strips the types).
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fetchShops, tokenEnv } from '../src/lib/square.ts';
import { mergeRoster, isBarberItem } from '../src/lib/roster.ts';

const root = new URL('../', import.meta.url);
if (existsSync(new URL('.env', root))) process.loadEnvFile(new URL('.env', root));

const shops = JSON.parse(await readFile(new URL('src/data/locations.json', root), 'utf8')).locations;
const rows = JSON.parse(await readFile(new URL('src/data/barbers.json', root), 'utf8')).barbers;

const { square, missing, errors } = await fetchShops(shops, process.env, { apiBase: process.env.SQUARE_API_BASE || undefined });
if (missing.length) {
  console.log(`Square check skipped: ${missing.join(' and ')} not set. The build uses src/data/barbers.json as-is.`);
  console.log(`Set both (${shops.map((s) => tokenEnv(s.slug)).join(', ')}) to test against the live Square Catalog API.`);
  process.exit(0);
}

const exclude = new Set(shops.map((s) => s.any_artist_item_id));
for (const s of shops) {
  const items = square[s.slug];
  if (!items) continue;
  console.log(`\n${s.name} (${s.square_location_id}): ${items.length} catalog items, ${items.filter((i) => isBarberItem(i, exclude)).length} barbers`);
  for (const i of items) {
    const tag = isBarberItem(i, exclude) ? '' : `  [skipped: ${exclude.has(i.item_id) ? 'any-artist' : i.is_archived ? 'archived' : i.product_type}]`;
    console.log(`  ${i.item_id}  ${i.name.padEnd(28)} ${i.price_from != null ? '$' + i.price_from : '—'}  ${i.duration_minutes ?? '—'} min${tag}`);
  }
}

const { rows: roster, warnings, stats } = mergeRoster({ rows, square, excludeItemIds: [...exclude] });
console.log(`\nRoster: ${stats.matched} matched, ${stats.added} new in Square, ${stats.deactivated} no longer in Square, ${stats.passthrough} unchanged (shop not fetched)`);
for (const r of roster) {
  const flags = [r.is_active === false && 'INACTIVE', r.needs_profile && 'NEEDS PHOTO + BIO'].filter(Boolean).join(', ');
  console.log(`  ${String(r.location).padEnd(9)} ${String(r.slug).padEnd(20)} ${String(r.name).padEnd(24)} ${r.haircut_from != null ? '$' + r.haircut_from : '—'}${flags ? '  ' + flags : ''}`);
}
for (const w of warnings) console.warn(`warn: ${w}`);
for (const e of errors) console.error(`error: ${e}`);
process.exit(errors.length ? 1 : 0);
