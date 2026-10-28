#!/usr/bin/env node
/**
 * npm run check:square
 * Lists each shop's Square catalog with the real API and prints the roster the build would use
 * (Square merged with src/data/barbers.json), verifies every barbers.json item_id against its shop's catalog,
 * lists the retail (REGULAR) items with price, stock and photo count, and recommends a shop route (S1/S2/S3,
 * docs/SQUARE-INTEGRATION-SPEC.md section 5). Read-only: only POST /v2/catalog/search and
 * POST /v2/inventory/counts/batch-retrieve.
 *
 * SQUARE_API_BASE=https://connect.squareupsandbox.com: runs against the sandbox with SQUARE_SANDBOX_TOKEN and
 * SQUARE_SANDBOX_LOCATION_ID standing in for both shops (barbers.json item ids will not exist there).
 *
 * Needs SQUARE_TOKEN_ADDISON and SQUARE_TOKEN_ELMHURST (env or a git-ignored site/.env).
 * Without them it says so and exits 0. Exits 1 if a shop's fetch fails.
 * Node 22.18+ (imports the .ts modules directly; Node strips the types).
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fetchShops, tokenEnv } from '../src/lib/square.ts';
import { mergeRoster, isBarberItem } from '../src/lib/roster.ts';
import { BRANDS, loadShopRetail, pickVariation, resolveCreds, stockLabel, toProductRow } from '../src/lib/square-products.ts';

const root = new URL('../', import.meta.url);
if (existsSync(new URL('.env', root))) process.loadEnvFile(new URL('.env', root));

const realShops = JSON.parse(await readFile(new URL('src/data/locations.json', root), 'utf8')).locations;
const rows = JSON.parse(await readFile(new URL('src/data/barbers.json', root), 'utf8')).barbers;
const readLinks = async (name) => JSON.parse(await readFile(new URL(`src/data/${name}`, root), 'utf8')).links ?? {};
const links = { store: await readLinks('square-buy-links.json').catch(() => ({})), payment: await readLinks('square-payment-links.json').catch(() => ({})) };

const apiBase = process.env.SQUARE_API_BASE || undefined;
const sandbox = /squareupsandbox\.com/.test(apiBase ?? '');
let shops = realShops;
let env = process.env;
if (sandbox) {
  const { creds } = resolveCreds(realShops, process.env, apiBase);
  if (creds.length) {
    console.log('SANDBOX mode (SQUARE_API_BASE is the sandbox): SQUARE_SANDBOX_TOKEN and SQUARE_SANDBOX_LOCATION_ID stand in for both shops.');
    shops = realShops.map((s) => ({ ...s, square_location_id: creds.find((c) => c.slug === s.slug).locationId }));
    env = { ...process.env, ...Object.fromEntries(creds.map((c) => [tokenEnv(c.slug), c.token])) };
  }
}

const { square, missing, errors } = await fetchShops(shops, env, { apiBase });
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

/* ---- (a) barbers.json item_id verification ---- */
console.log('\nItem id check (every active barbers.json row against its shop catalog):');
let idProblems = 0;
for (const s of shops) {
  const items = square[s.slug];
  if (!items) continue;
  const byId = new Map(items.map((i) => [i.item_id, i]));
  const mine = rows.filter((r) => r.location === s.slug && r.is_active !== false);
  const bad = [];
  for (const r of mine) {
    const hit = byId.get(r.item_id);
    if (!hit) bad.push(`${r.name} (${r.item_id}): not in the ${s.name} catalog`);
    else if (!isBarberItem(hit, exclude)) bad.push(`${r.name} (${r.item_id}): found as "${hit.name}" but it is ${hit.is_archived ? 'archived' : hit.product_type ?? 'not a service'}`);
  }
  console.log(`  ${s.name}: ${mine.length - bad.length} of ${mine.length} found${bad.length ? '' : ' (all)'}`);
  for (const b of bad) console.log(`    MISMATCH ${b}`);
  idProblems += bad.length;
}
if (idProblems) console.log(`  ${idProblems} mismatch(es): the roster merge deactivates those rows (or keeps barbers.json if Square would hide over half a shop). Fix the item_id in barbers.json or in Square.`);

/* ---- (b) retail (REGULAR) items ---- */
console.log('\nRetail items (product_type REGULAR; listed = would appear on /shop/ with SHOP_SOURCE=square):');
const { creds } = resolveCreds(shops, env, apiBase);
// Sets keyed by product name: the same product in both shops counts once.
const tally = Object.fromEntries(['retail', 'listable', 'listed', 'withStoreLink', 'withPaymentLink', 'sellable'].map((k) => [k, new Set()]));
for (const c of creds) {
  let shop;
  try { shop = await loadShopRetail(c.token, c.locationId, { apiBase }); }
  catch (e) { errors.push(`${c.slug} retail: ${e.message}`); continue; }
  const { items, stock } = shop;
  console.log(`  ${shops.find((s) => s.slug === c.slug).name}: ${items.length} retail items`);
  for (const i of items) {
    const r = toProductRow(i, stock, links);
    const pick = pickVariation(i, stock);
    const price = pick ? `$${(pick.variation.cents / 100).toFixed(2)}` : '—';
    const status = 'skip' in r ? `skipped: ${r.skip}` : r.row.available ? `listed${r.route ? ` (${r.route} link)` : ', no buy link'}` : 'hidden: out of stock';
    const store = i.ecom_uri ? `${i.ecom_uri} [ecom_visibility ${i.ecom_visibility ?? 'unset'}]` : `no store page${i.ecom_visibility ? ` [ecom_visibility ${i.ecom_visibility}]` : ''}`;
    console.log(`    ${i.name.padEnd(36)} ${(i.vendor ?? '—').padEnd(14)} ${price.padStart(8)}  ${stockLabel(i, stock).padEnd(13)} ${String(i.image_urls.length).padStart(2)} photo${i.image_urls.length === 1 ? ' ' : 's'}  ${status}`);
    console.log(`        store page: ${store}`);
    tally.retail.add(i.name);
    if (i.vendor) tally.listable.add(i.name);
    if (!('skip' in r)) {
      tally.listed.add(i.name);
      if (r.row.available) tally.sellable.add(i.name);
      if (r.route === 'S1') tally.withStoreLink.add(i.name);
      if (r.route === 'S2') tally.withPaymentLink.add(i.name);
    }
  }
}

/* ---- (c) shop route recommendation ---- */
const n = Object.fromEntries(Object.entries(tally).map(([k, v]) => [k, v.size]));
let rec;
if (!n.retail) rec = 'S3 (keep Bodega): no retail items in these Square catalogs, so the products are not rung through Square. Leave SHOP_SOURCE unset.';
else if (!n.listable) rec = `S3 (keep Bodega): ${n.retail} retail items found, but none from ${BRANDS.join(' / ')}. Leave SHOP_SOURCE unset, or ask the client whether those three lines are in Square under another name.`;
else if (n.withStoreLink) rec = `S1 (Square Online product pages): ${n.withStoreLink} of ${n.sellable} sellable items already have a store page. Set SHOP_SOURCE=square; add any missing pages to src/data/square-buy-links.json.`;
else rec = `S2 (Checkout API payment links): ${n.listable} ${BRANDS.join(' / ')} items in Square, none published to a Square Online store. Run \`node scripts/sync-products.mjs --create-links --location addison --write\` (then elmhurst; production tokens), then set SHOP_SOURCE=square.`;
console.log(`\nShop route recommendation: ${rec}`);

for (const e of errors) console.error(`error: ${e}`);
process.exit(errors.length ? 1 : 0);
