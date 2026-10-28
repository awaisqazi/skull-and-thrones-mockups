#!/usr/bin/env node
/**
 * npm run seed:sandbox
 * Seeds the Square SANDBOX with a fake two-barber shop so scripts/fetch-availability.mjs can be
 * exercised without the real accounts (spec §7 "Sandbox testing"). Idempotent: re-running finds
 * what exists (team members by reference_id, items by name) and only creates or repairs what is missing.
 *
 *   - 2 team members: "Test Barber One" / "Test Barber Two" (reference_id st-seed-barber-1/2)
 *   - 2 APPOINTMENTS_SERVICE items with the same names, each with a "Haircut" ($45, 45 min) and a
 *     "Beard trim" ($25, 20 min) variation assigned to that barber's team member.
 *
 * Needs SQUARE_SANDBOX_TOKEN and SQUARE_SANDBOX_LOCATION_ID (env or the git-ignored site/.env).
 * Refuses to run against production. Never prints the token.
 */
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { SQUARE_VERSION, squareHeaders } from '../src/lib/square.ts';

const root = new URL('../', import.meta.url);
if (existsSync(new URL('.env', root))) process.loadEnvFile(new URL('.env', root));

const API = process.env.SQUARE_API_BASE || 'https://connect.squareupsandbox.com';
const TOKEN = process.env.SQUARE_SANDBOX_TOKEN;
const LOC = process.env.SQUARE_SANDBOX_LOCATION_ID;
if (!/squareupsandbox\.com/.test(API)) { console.error(`Refusing to seed ${API}: this script only writes to the sandbox.`); process.exit(1); }
if (!TOKEN || !LOC) { console.error('SQUARE_SANDBOX_TOKEN and SQUARE_SANDBOX_LOCATION_ID must be set (site/.env).'); process.exit(1); }

const BARBERS = [
  { ref: 'st-seed-barber-1', given: 'Test', family: 'Barber One' },
  { ref: 'st-seed-barber-2', given: 'Test', family: 'Barber Two' },
];
const SERVICES = [
  { name: 'Haircut', cents: 4500, minutes: 45 },
  { name: 'Beard trim', cents: 2500, minutes: 20 },
];

async function call(method, path, body) {
  const res = await fetch(API + path, { method, headers: squareHeaders(TOKEN, SQUARE_VERSION), body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.errors?.length) {
    const why = json.errors?.map((e) => `${e.code}${e.detail ? `: ${e.detail}` : ''}`).join('; ') || res.statusText;
    throw new Error(`${method} ${path} → HTTP ${res.status}: ${why}`);
  }
  return json;
}

/* ---------- Team members ---------- */
const existing = (await call('POST', '/v2/team-members/search', { query: { filter: { status: 'ACTIVE' } }, limit: 200 })).team_members ?? [];
const team = {};
for (const b of BARBERS) {
  let tm = existing.find((t) => t.reference_id === b.ref);
  if (tm) {
    console.log(`team member   ${b.given} ${b.family}: exists ${tm.id}`);
  } else {
    tm = (await call('POST', '/v2/team-members', {
      idempotency_key: randomUUID(),
      team_member: {
        reference_id: b.ref, given_name: b.given, family_name: b.family, status: 'ACTIVE',
        assigned_locations: { assignment_type: 'EXPLICIT_LOCATIONS', location_ids: [LOC] },
      },
    })).team_member;
    console.log(`team member   ${b.given} ${b.family}: created ${tm.id}`);
  }
  team[b.ref] = tm.id;
}

/* ---------- Service items (one per barber) ---------- */
const variation = (ref, itemId, s, tmId, prev) => ({
  type: 'ITEM_VARIATION',
  id: prev?.id ?? `#${ref}-${s.name.toLowerCase().replace(/\W+/g, '-')}`,
  ...(prev?.version != null ? { version: prev.version } : {}),
  present_at_all_locations: false,
  present_at_location_ids: [LOC],
  item_variation_data: {
    item_id: itemId,
    name: s.name,
    pricing_type: 'FIXED_PRICING',
    price_money: { amount: s.cents, currency: 'USD' },
    service_duration: s.minutes * 60000,
    available_for_booking: true,
    team_member_ids: [tmId],
  },
});

for (const b of BARBERS) {
  const name = `${b.given} ${b.family}`;
  const tmId = team[b.ref];
  const found = (await call('POST', '/v2/catalog/search', {
    object_types: ['ITEM'],
    query: { exact_query: { attribute_name: 'name', attribute_value: name } },
  })).objects?.find((o) => o.item_data?.product_type === 'APPOINTMENTS_SERVICE');
  const vars = found?.item_data?.variations ?? [];
  const correct = found && SERVICES.every((s) => vars.some((v) => v.item_variation_data?.name === s.name && (v.item_variation_data?.team_member_ids ?? []).includes(tmId)))
    && (found.present_at_all_locations || (found.present_at_location_ids ?? []).includes(LOC));
  if (correct) {
    console.log(`service item  ${name}: exists ${found.id} (${vars.map((v) => `${v.item_variation_data?.name} ${v.id}`).join(', ')})`);
    continue;
  }
  const itemId = found?.id ?? `#${b.ref}`;
  const object = {
    type: 'ITEM',
    id: itemId,
    ...(found?.version != null ? { version: found.version } : {}),
    present_at_all_locations: false,
    present_at_location_ids: [LOC],
    item_data: {
      name,
      product_type: 'APPOINTMENTS_SERVICE',
      description: 'Sandbox test barber for scripts/fetch-availability.mjs (seeded by scripts/seed-sandbox.mjs).',
      variations: SERVICES.map((s) => variation(b.ref, itemId, s, tmId, vars.find((v) => v.item_variation_data?.name === s.name))),
    },
  };
  const saved = (await call('POST', '/v2/catalog/object', { idempotency_key: randomUUID(), object })).catalog_object;
  console.log(`service item  ${name}: ${found ? 'repaired' : 'created'} ${saved.id} (${(saved.item_data?.variations ?? []).map((v) => `${v.item_variation_data?.name} ${v.id}`).join(', ')})`);
}

/* ---------- Can this sandbox seller serve availability at all? ---------- */
try {
  await call('GET', '/v2/bookings/business-booking-profile');
  console.log('bookings      business booking profile OK: availability searches should work.');
} catch (e) {
  console.log(`bookings      ${e.message}`);
  console.log('              The sandbox seller has not enabled Square Appointments. Fix: Developer Console → Sandbox test accounts →');
  console.log('              "Open in Square Dashboard" → Appointments → set up the Free plan; Staff → each test barber → "Add to appointments"');
  console.log('              + "Bookable by customers online". That clears team_member_ids on the services, so re-run this script (it repairs them).');
}
