#!/usr/bin/env node
/**
 * node scripts/seed-sandbox-products.mjs            seed the Square SANDBOX with retail test items (idempotent)
 * node scripts/seed-sandbox-products.mjs --images d  use d/<slug>.png|jpg|jpeg as the photo (default: a generated solid-colour tile)
 *
 * Creates four REGULAR items so the products loader (SHOP_SOURCE=square) and `npm run check:square` have
 * something to read without the real accounts:
 *   STMNT Test Matte Paste          $24.95  tracked, 12 in stock
 *   H14 Test Styling Powder         $18.00  tracked,  7 in stock
 *   Slick Gorilla Test Sea Salt Spray $16.00 tracked,  0 in stock   -> hidden (sold out)
 *   Wahl Test Clipper               $129.00 tracked,  3 in stock    -> skipped (brand not in the allowlist)
 * each with one photo (IMAGE object). Items are looked up by exact name first, so re-running changes nothing.
 *
 * Refuses to run unless SQUARE_API_BASE points at connect.squareupsandbox.com. Uses SQUARE_SANDBOX_TOKEN and
 * SQUARE_SANDBOX_LOCATION_ID from the environment or the git-ignored site/.env. Never prints the token.
 * Node 22.18+.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { SQUARE_VERSION } from '../src/lib/square.ts';
import { slugify } from '../src/lib/square-products.ts';

const root = new URL('../', import.meta.url);
if (existsSync(new URL('.env', root))) process.loadEnvFile(new URL('.env', root));

const BASE = process.env.SQUARE_API_BASE || '';
const TOKEN = process.env.SQUARE_SANDBOX_TOKEN;
const LOCATION = process.env.SQUARE_SANDBOX_LOCATION_ID;
if (!/squareupsandbox\.com/.test(BASE)) {
  console.error('Refusing to seed: set SQUARE_API_BASE=https://connect.squareupsandbox.com (this script only writes to the sandbox).');
  process.exit(1);
}
if (!TOKEN || !LOCATION) {
  console.error('SQUARE_SANDBOX_TOKEN and SQUARE_SANDBOX_LOCATION_ID are required (site/.env).');
  process.exit(1);
}

const args = process.argv.slice(2);
const imagesDir = args.includes('--images') ? args[args.indexOf('--images') + 1] : null;

const ITEMS = [
  { name: 'STMNT Test Matte Paste', description: 'Sandbox test item.', cents: 2495, stock: 12, rgb: [201, 164, 92] },
  { name: 'H14 Test Styling Powder', description: 'Sandbox test item.', cents: 1800, stock: 7, rgb: [92, 140, 201] },
  { name: 'Slick Gorilla Test Sea Salt Spray', description: 'Sandbox test item, sold out.', cents: 1600, stock: 0, rgb: [92, 201, 140] },
  { name: 'Wahl Test Clipper', description: 'Sandbox test item, brand not in the allowlist.', cents: 12900, stock: 3, rgb: [201, 92, 92] },
];

async function api(path, body, { form } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Square-Version': SQUARE_VERSION, Accept: 'application/json', ...(form ? {} : { 'Content-Type': 'application/json' }) },
    body: form ?? JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.errors?.length) throw new Error(`${path} HTTP ${res.status}: ${(json.errors ?? []).map((e) => `${e.code}${e.detail ? ` ${e.detail}` : ''}`).join('; ') || res.statusText}`);
  return json;
}

/* Minimal solid-colour PNG (no dependencies) so the seed works anywhere. */
function solidPng(w, h, [r, g, b]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const t = Buffer.from(type); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, c]); };
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

async function findPhoto(item) {
  if (!imagesDir) return { bytes: solidPng(600, 600, item.rgb), type: 'image/png', file: `${slugify(item.name)}.png` };
  for (const ext of ['png', 'jpg', 'jpeg']) {
    const f = `${imagesDir.replace(/\/$/, '')}/${slugify(item.name)}.${ext}`;
    if (existsSync(f)) return { bytes: await readFile(f), type: ext === 'png' ? 'image/png' : 'image/jpeg', file: `${slugify(item.name)}.${ext}` };
  }
  return { bytes: solidPng(600, 600, item.rgb), type: 'image/png', file: `${slugify(item.name)}.png` };
}

const existing = async (name) => {
  const r = await api('/v2/catalog/search', { object_types: ['ITEM'], query: { exact_query: { attribute_name: 'name', attribute_value: name } } });
  return r.objects?.[0];
};

for (const it of ITEMS) {
  let obj = await existing(it.name);
  let created = false;
  if (!obj) {
    const r = await api('/v2/catalog/object', {
      idempotency_key: `st-seed-${slugify(it.name)}`,
      object: {
        type: 'ITEM', id: '#item', present_at_all_locations: true,
        item_data: {
          name: it.name, description: it.description, product_type: 'REGULAR',
          variations: [{
            type: 'ITEM_VARIATION', id: '#var', present_at_all_locations: true,
            item_variation_data: { item_id: '#item', name: 'Regular', sku: slugify(it.name).toUpperCase().slice(0, 24), pricing_type: 'FIXED_PRICING', price_money: { amount: it.cents, currency: 'USD' }, track_inventory: true },
          }],
        },
      },
    });
    obj = r.catalog_object;
    created = true;
  }
  const itemId = obj.id;
  const varId = obj.item_data.variations[0].id;

  let photo = 'photo already there';
  if (!obj.item_data.image_ids?.length) {
    const p = await findPhoto(it);
    const form = new FormData();
    form.append('request', new Blob([JSON.stringify({ idempotency_key: `st-seed-img-${slugify(it.name)}`, object_id: itemId, image: { id: '#img', type: 'IMAGE', image_data: { caption: it.name } } })], { type: 'application/json' }), 'request.json');
    form.append('image_file', new Blob([p.bytes], { type: p.type }), p.file);
    await api('/v2/catalog/images', null, { form });
    photo = `photo uploaded (${p.file})`;
  }

  const counts = await api('/v2/inventory/counts/batch-retrieve', { catalog_object_ids: [varId], location_ids: [LOCATION], states: ['IN_STOCK'] });
  const have = Number(counts.counts?.[0]?.quantity ?? 0);
  let stock = `stock ${have}`;
  if (have < it.stock) {
    await api('/v2/inventory/changes/batch-create', {
      idempotency_key: `st-seed-stock-${slugify(it.name)}-${it.stock - have}`,
      changes: [{ type: 'PHYSICAL_COUNT', physical_count: { catalog_object_id: varId, state: 'IN_STOCK', location_id: LOCATION, quantity: String(it.stock), occurred_at: new Date().toISOString() } }],
    });
    stock = `stock set to ${it.stock}`;
  }
  console.log(`${created ? 'created' : 'exists '}  ${it.name.padEnd(36)} $${(it.cents / 100).toFixed(2).padStart(7)}  ${photo}, ${stock}`);
}
