#!/usr/bin/env node
/**
 * Sync the Bodega (Shopify) catalog into src/data/products.json.
 *
 *   node scripts/sync-products.mjs                       # fetch https://www.bybodega.com/products.json (all pages)
 *   node scripts/sync-products.mjs --from a.json b.json  # read saved feed pages instead of fetching
 *   node scripts/sync-products.mjs --feature h1,h2,...   # set the home-strip picks (in this order)
 *
 * Keeps hand curation across re-syncs: `featured` and the featured `sort_order` are carried over
 * by handle from the existing products.json (unless --feature is passed). Products that are sold
 * out, priced 0, have no photo, or are event tickets / gift cards are skipped.
 *
 * buy_url is the checkout route switch: today it equals the Bodega product page. When the route is
 * decided (Shopify Buy Button or Square Online, see README "Products"), map it here.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const STORE = 'https://www.bybodega.com';
const OUT = fileURLToPath(new URL('../src/data/products.json', import.meta.url));
/** Listings that are not retail products (in-shop event cuts, gift cards). */
const EXCLUDE_HANDLES = new Set(['event-cut', 'learn-to-cut']);

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return null;
  const vals = [];
  for (let j = i + 1; j < args.length && !args[j].startsWith('--'); j++) vals.push(args[j]);
  return vals;
};

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
  if (!live.length || EXCLUDE_HANDLES.has(p.handle) || isEvent(p)) return null;
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
  _note: `Synced from ${STORE}/products.json on ${today} by scripts/sync-products.mjs (${feed.length} listings in feed, ${products.length} kept: available, price > 0, has a photo, not an event ticket or gift card). Edit "featured" (home strip) by hand or re-run with --feature; re-syncs keep it. Images are the client's own product photos on his own Shopify store (hotlinked from cdn.shopify.com; pages append &width=N). buy_url = checkout route switch, see README "Products".`,
  products,
};
await writeFile(OUT, JSON.stringify(out, null, 2) + '\n');
console.log(`Wrote ${products.length} products (${featured.length} featured) to src/data/products.json`);
