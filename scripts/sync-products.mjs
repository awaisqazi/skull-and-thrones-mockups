#!/usr/bin/env node
/**
 * Sync the Bodega (Shopify) catalog into src/data/products.json.
 *
 *   node scripts/sync-products.mjs                       # fetch https://www.bybodega.com/products.json (all pages)
 *   node scripts/sync-products.mjs --from a.json b.json  # read saved feed pages instead of fetching
 *   node scripts/sync-products.mjs --feature h1,h2,...   # set the home-strip picks (in this order)
 *   node scripts/sync-products.mjs --create-links --location addison|elmhurst [--write]   # Square S2: pickup payment links (see below); dry run without --write
 *
 * Keeps hand curation across re-syncs: `featured` and the featured `sort_order` are carried over
 * by handle from the existing products.json (unless --feature is passed). Products that are sold
 * out, priced 0, have no photo, or are event tickets / gift cards are skipped. Only the brands in
 * BRANDS (the lines the shop stocks and uses) are kept; add a vendor there to list another brand.
 *
 * --create-links --location <shop> (docs/SQUARE-INTEGRATION-SPEC.md section 5, route S2): for each in-stock STMNT/H14/Slick Gorilla item in
 * that ONE shop's Square catalog (pickup is at a specific shop, so the shop is required; run it once per shop) that has no Square Online page and no stored link yet, creates ONE Checkout API payment link
 * (POST /v2/online-checkout/payment-links) and stores it in src/data/square-payment-links.json keyed by variation id, so
 * links are reused, never duplicated. Without --write it only lists what it would create. Writing needs production tokens
 * (SQUARE_TOKEN, or SQUARE_TOKEN_ADDISON / SQUARE_TOKEN_ELMHURST, env or site/.env) with ORDERS_WRITE + PAYMENTS_WRITE; it refuses the sandbox
 * unless SQUARE_API_BASE is the sandbox (then it uses the sandbox token). Does not touch products.json.
 *
 * buy_url is the checkout route switch: today it equals the Bodega product page. When the route is
 * decided (Shopify Buy Button or Square Online, see README "Products"), map it here.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BRANDS, allowedBrand, ensurePaymentLinks, loadShopRetail, resolveCreds } from '../src/lib/square-products.ts';

const STORE = 'https://www.bybodega.com';
const DEFAULT_OUT = fileURLToPath(new URL('../src/data/products.json', import.meta.url));
/** Listings that are not retail products (in-shop event cuts, gift cards). */
const EXCLUDE_HANDLES = new Set(['event-cut', 'learn-to-cut']);
// Brand allowlist: BRANDS / allowedBrand live in src/lib/square-products.ts, shared with the Square products loader
// (client request 2026-10-18: only STMNT, H14 and SLICK GORILLA). Add a vendor name there to list another brand.

const args = process.argv.slice(2);
// --out <file>: write somewhere else than src/data/products.json (tests).
const OUT = args.includes('--out') ? args[args.indexOf('--out') + 1] : DEFAULT_OUT;
const flag = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return null;
  const vals = [];
  for (let j = i + 1; j < args.length && !args[j].startsWith('--'); j++) vals.push(args[j]);
  return vals;
};

/* ---- S2: create Square payment links (only with --create-links) ---- */
async function createLinks() {
  const root = new URL('../', import.meta.url);
  if (existsSync(new URL('.env', root))) process.loadEnvFile(new URL('.env', root));
  const apiBase = process.env.SQUARE_API_BASE || undefined;
  const write = args.includes('--write');
  const shops = JSON.parse(await readFile(new URL('src/data/locations.json', root), 'utf8')).locations;
  const linksPath = fileURLToPath(new URL('src/data/square-payment-links.json', root));
  const buyPath = new URL('src/data/square-buy-links.json', root);
  const file = JSON.parse(await readFile(linksPath, 'utf8'));
  const store = existsSync(buyPath) ? JSON.parse(await readFile(buyPath, 'utf8')).links ?? {} : {};
  const shopArg = args[args.indexOf('--location') + 1];
  if (args.indexOf('--location') < 0 || !shops.some((s) => s.slug === shopArg)) {
    console.error(`--create-links needs --location ${shops.map((s) => s.slug).join('|')}: a payment link is pickup at one specific shop.`);
    process.exit(1);
  }
  const { creds: all, missing } = resolveCreds(shops, process.env, apiBase);
  if (missing.length) { console.error(`--create-links needs ${missing.join(' and ')} (env or site/.env).`); process.exit(1); }
  const creds = all.filter((c) => c.slug === shopArg);
  let payment = file.links ?? {};
  let made = 0;
  const save = async () => {
    await writeFile(linksPath, JSON.stringify({ ...file, links: payment }, null, 2) + '\n');
    console.log(`Wrote ${made} new link(s) to src/data/square-payment-links.json (${Object.keys(payment).length} total).`);
  };
  for (const c of creds) {
    const { items, stock } = await loadShopRetail(c.token, c.locationId, { apiBase });
    let r;
    try {
      r = await ensurePaymentLinks(c.token, c.locationId, items, stock, { store, payment }, { apiBase, write, shop: c.slug });
    } catch (e) {
      // Some links may already exist in Square: record them before failing, so a re-run reuses them.
      if (write && e.partial) {
        payment = e.partial.payment;
        made += e.partial.created.length;
        if (e.partial.created.length) await save();
      }
      throw e;
    }
    payment = r.payment;
    made += r.created.length;
    console.log(`${c.slug}: ${write ? `created ${r.created.length}` : `would create ${r.wouldCreate.length}`}${(write ? r.created : r.wouldCreate).length ? ` (${(write ? r.created : r.wouldCreate).join(', ')})` : ''}`);
  }
  if (write && made) {
    await save();
  } else if (!write) console.log('Dry run. Add --write to create the links.');
}

if (args.includes('--create-links')) {
  await createLinks();
  process.exit(0);
}

async function loadFeed() {
  const files = flag('--from');
  if (files?.length) {
    const pages = await Promise.all(files.map(async (f) => JSON.parse(await readFile(f, 'utf8')).products ?? []));
    return pages.flat();
  }
  const all = [];
  for (let page = 1; page < 50; page++) {
    const res = await fetch(`${STORE}/products.json?limit=250&page=${page}`, { headers: { 'User-Agent': 'skull-and-thrones-site/sync-products' } });
    if (!res.ok) throw new Error(`products.json page ${page}: HTTP ${res.status}`);
    const { products = [] } = await res.json();
    if (!products.length) break;
    all.push(...products);
  }
  return all;
}

const isEvent = (p) =>
  /event/i.test(p.product_type || '') || (p.tags || []).some((t) => /^events?$/i.test(t)) || /gift card/i.test(p.title || '');

function toRow(p) {
  const live = (p.variants || []).filter((v) => v.available && Number(v.price) > 0);
  if (!live.length || EXCLUDE_HANDLES.has(p.handle) || isEvent(p) || !allowedBrand(p.vendor)) return null;
  const img = (p.images || [])[0];
  if (!img?.src) return null;
  const cheapest = live.reduce((a, b) => (Number(b.price) < Number(a.price) ? b : a));
  const compare = Number(cheapest.compare_at_price) > Number(cheapest.price) ? Number(cheapest.compare_at_price).toFixed(2) : null;
  const url = `${STORE}/products/${encodeURIComponent(p.handle)}`;
  return {
    handle: p.handle,
    title: p.title.trim(),
    vendor: p.vendor.trim(),
    price: Number(cheapest.price).toFixed(2),
    compare_at_price: compare,
    // Full-size Shopify CDN original. Pages request a resized copy by appending &width=N (see src/lib/data.ts).
    image: img.src,
    image_width: img.width || 1000,
    image_height: img.height || 1000,
    alt: img.alt || `${p.vendor} ${p.title}`.trim(),
    url,
    buy_url: url, // checkout route switch: point at a Buy Button / Square checkout link later
    product_type: p.product_type || '',
    tags: p.tags || [],
    available: true,
    featured: false,
    sort_order: 0,
  };
}

const feed = await loadFeed();
const rows = feed.map(toRow).filter(Boolean);
// An empty feed (store down, blocked, or every listing filtered out) must never wipe the shop page.
if (!rows.length) {
  console.error(`Feed gave 0 usable products (${feed.length} listings): ${OUT} left unchanged.`);
  process.exit(1);
}

let previous = [];
try { previous = JSON.parse(await readFile(OUT, 'utf8')).products ?? []; } catch { /* first run */ }
const featureArg = flag('--feature');
const picks = featureArg
  ? featureArg.join(',').split(',').map((s) => s.trim()).filter(Boolean)
  : previous.filter((p) => p.featured).sort((a, b) => a.sort_order - b.sort_order).map((p) => p.handle);
const missing = picks.filter((h) => !rows.some((r) => r.handle === h));
if (missing.length) console.warn(`Featured products no longer available (dropped): ${missing.join(', ')}`);

// Featured picks first (sort_order 1..n), then everything else by vendor, then title.
const rest = rows.filter((r) => !picks.includes(r.handle))
  .sort((a, b) => a.vendor.localeCompare(b.vendor) || a.title.localeCompare(b.title));
const featured = picks.map((h) => rows.find((r) => r.handle === h)).filter(Boolean);
featured.forEach((r) => { r.featured = true; });
const products = [...featured, ...rest].map((r, i) => ({ ...r, sort_order: i + 1 }));

const today = new Date().toISOString().slice(0, 10);
const out = {
  _note: `Synced from ${STORE}/products.json on ${today} by scripts/sync-products.mjs (${feed.length} listings in feed, ${products.length} kept: available, price > 0, has a photo, not an event ticket or gift card, vendor in the BRANDS allowlist: ${BRANDS.join(', ')}). Edit "featured" (home strip) by hand or re-run with --feature; re-syncs keep it. Images are the client's own product photos on his own Shopify store (hotlinked from cdn.shopify.com; pages append &width=N). buy_url = checkout route switch, see README "Products".`,
  products,
};
await writeFile(OUT, JSON.stringify(out, null, 2) + '\n');
console.log(`Wrote ${products.length} products (${featured.length} featured) to src/data/products.json`);
