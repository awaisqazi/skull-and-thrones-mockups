# Skull & Thrones — website (Astro 5)

Static Astro site for Skull & Thrones / S&T Hair Society (Addison + Elmhurst, IL), converted
from the HTML mockups in `../mockups/`. Booking goes to each shop's own Square page.

## Run locally

```sh
npm install
npm run dev        # http://localhost:4321/skull-and-thrones-mockups/
npm run build      # outputs dist/
npm run preview    # serves dist/ at http://localhost:4321/skull-and-thrones-mockups/
npm run check      # astro check (types + .astro diagnostics)
npm test           # unit tests: roster merge + Square client (no network)
npm run check:square  # live Square catalog → printed roster (needs the two tokens; exits 0 without them)
```

Requires Node 18.20+ (CI uses Node 22).

## Where things live

| Path | What |
|---|---|
| `src/data/locations.json` | Both shops: address, phone, hours, Square booking URL, any-artist item id, map query |
| `src/data/barbers.json` | 25 barbers (seeded from `docs/barbers.json`). `placeholder_fields` lists invented copy |
| `src/data/portfolio.json` | PLACEHOLDER portfolio set (12 per shop), tagged by barber slug + style |
| `src/data/culture.json` | Behind-the-scenes page: `culture_items` (education/events/community/shop tiles, Instagram `source_url`, `featured` = big tile) + `stats` row. Collections `culture` / `cultureStats`, read via `getCultureItems()` / `getCultureStats()` |
| `src/pages/culture.astro` | `/culture/` "Behind the scenes": hero, stat band, filterable collage (`CultureTile.astro`, reuses portfolio filters + lightbox), Learn with us (Bodega Events), Book band |
| `src/data/products.json` + `scripts/sync-products.mjs` | Bodega (bybodega.com) retail products, synced from the Shopify feed. `featured` = home strip. Collection `products`, read via `getProducts()` / `getFeaturedProducts()`; `ProductStrip.astro` (home) + `ProductCard.astro`, page `src/pages/shop.astro` (`/shop/`). See "Products" below |
| `src/content.config.ts` | Content collections (`file()` loaders + zod schemas), the Square roster loader for `barbers`, and a commented Supabase loader stub |
| `src/lib/square.ts`, `src/lib/roster.ts` | Square Catalog client and the pure Square ⇄ barbers.json merge (tests in `src/lib/roster.test.ts`) |
| `src/lib/data.ts` | The only data API pages use. Builds `booking_url = square_booking_url + '/' + item_id` |
| `src/lib/placeholder.ts` | Generates the grey striped SVG placeholder tiles (data URIs) |
| `src/lib/url.ts` | `url(path)` prefixes `import.meta.env.BASE_URL`. Use it for every internal link |
| `src/components/` | Layout pieces: Nav, MobileBookBar, BarberCard/Grid, LocationTabs, PortfolioGrid, LocationCard, Footer |
| `src/scripts/app.ts` | Vanilla JS: tabs (home starts neutral: "Choose your shop", choice remembered in localStorage `st-location`; `#addison`/`#elmhurst` links win), popovers, portfolio filters, lightbox, "Open now" |
| `src/styles/global.css` | Mockup CSS ported 1:1 (design tokens unchanged) + small additions in section 16 |

Routes: `/`, `/book/`, `/barbers/`, `/barbers/{slug}/`, `/addison/`, `/elmhurst/` (Barbers | Portfolio
tabs, `#portfolio` opens the portfolio tab), `/culture/` (Behind the scenes), `/shop/`, `/contact/`, `/portfolio/` (redirects to `/addison/#portfolio`), 404.
Sitemap: `sitemap-index.xml` (@astrojs/sitemap); `robots.txt` is generated from `site` + `base`.

## Products

The home page has a "Shop the tools we use" strip (below the work section, never above booking) and
`/shop/` lists every product with brand filters. Both read `src/data/products.json`, which
`node scripts/sync-products.mjs` rebuilds from Bodega's public Shopify feed
(`https://www.bybodega.com/products.json`, all pages). It keeps products that are in stock, priced
above 0 and have a photo, and skips event tickets and gift cards. Re-run it whenever the store
changes (or `--from page1.json …` to use saved feed pages), then rebuild.

- **Featured** (`"featured": true`, ordered by `sort_order`): the 8 products in the home strip. Edit by
  hand, or re-run with `--feature handle1,handle2,…`. Re-syncs keep the current picks; a pick that
  sells out is dropped with a warning.
- **Images** are hotlinked from `cdn.shopify.com`. They are the client's own product photos on his
  own store, so hotlinking is fine. Pages append `&width=300|600|900` (Shopify resizes and serves
  WebP/AVIF), so no multi-MB originals ship and nothing is added to the Pages build. They are plain
  `<img>` tags with width/height, not Astro's image optimizer.
- **Checkout route switch: `buy_url`.** Today `buy_url` = the Bodega product page, so "Buy ↗" opens
  bybodega.com. The route is undecided (see `../docs/MEETING-2026-10-09-PLAN.md` §5 C). Either way
  only `buy_url` (set in `toRow()` in the sync script) and possibly `ProductCard.astro` change:
  - *Shopify Buy Button:* create the Buy Button sales channel, embed its script (`buy-button-storefront`
    SDK) in `ProductCard.astro` as a small island, and point `buy_url` at each product's Buy Button
    checkout link (the no-JS fallback).
  - *Square Online:* create the items in Square, and point `buy_url` at each item's Square Online
    checkout link (map handle → link in the sync script, or add a `square_checkout_url` column).
- Prices shown are retail only (the lowest in-stock variant). PRO pricing stays on bybodega.com.

## Deploy (GitHub Pages)

`.github/workflows/deploy.yml` builds with `withastro/action@v3` and publishes with
`actions/deploy-pages@v4` on every push to `main` and on manual "Run workflow".

1. Push the repo to GitHub (the workflow assumes this `site/` folder is the repo root; if not,
   move the workflow to the root `.github/workflows/` and set `path: site`).
2. Repo → Settings → Pages → Source: **GitHub Actions**.
3. Push to `main` (or Actions → Deploy site → Run workflow). The site appears at
   `https://awaisqazi.github.io/skull-and-thrones-mockups/`.

The Pages artifact is uploaded by the action, so no `.nojekyll` file is needed (Jekyll never runs
on an Actions deploy, and `_astro/` assets are served as-is).

### Base path

`astro.config.mjs` reads `BASE_PATH` (default `/skull-and-thrones-mockups`) and `SITE_URL`
(default `https://awaisqazi.github.io`). The workflow sets both in its `env:` block.

### Switching to the custom domain

1. In `.github/workflows/deploy.yml` set `BASE_PATH: /` and `SITE_URL: https://skullandthrones.com`
   (and update the defaults in `astro.config.mjs` if you like).
2. Repo → Settings → Pages → Custom domain: `skullandthrones.com`, then tick **Enforce HTTPS**.
   With an Actions deploy, the domain set in Settings is what counts. If you also want a `CNAME`
   file in the build for reference, add `public/CNAME` containing `skullandthrones.com`.
3. DNS: apex `A` → 185.199.108.153 / .109.153 / .110.153 / .111.153, `www` CNAME → `awaisqazi.github.io`.
   See `../cms/ARCHITECTURE.md` for the full checklist.

Because every link goes through `url()` / `import.meta.env.BASE_URL`, nothing else changes.
At the domain root, `robots.txt` and the sitemap also become effective for crawlers (on a
project sub-path, crawlers only read the domain-root robots.txt).

## Square roster (barbers appear/disappear from Square)

When both tokens are present, every build lists each shop's Square catalog (`POST /v2/catalog/search`,
items at that shop's `square_location_id`) and merges it with `src/data/barbers.json` by `item_id`:

- Square supplies who exists, their name, the lowest price (`haircut_from`) and duration.
- barbers.json supplies slug, headshot, bio, specialties, Instagram, sort order, the accepting flag.
- A Square item with no barbers.json row appears with an auto slug, the placeholder headshot and no
  bio (`needs_profile: true`, build warning "needs photo + bio"). Add a row with that `item_id` to finish it.
- A barbers.json row whose item is gone from Square gets `is_active: false` (hidden) plus a warning.
- Each shop's "Any artist available" item (`any_artist_item_id`) and retail/archived items are skipped.
- Safety: a Square error, an empty catalog, or Square hiding more than half a shop at once → that shop
  falls back to barbers.json with a warning. The build never fails because of Square.
- No tokens → barbers.json exactly as before (one info line in the build log).

The workflow also rebuilds nightly (`schedule: 0 9 * * *`, 3–4 AM Chicago), so a barber added in
Square shows up the next morning, or immediately via Actions → Deploy site → Run workflow.

**Secrets to add** (repo → Settings → Secrets and variables → Actions → New repository secret):

| Secret | Value |
|---|---|
| `SQUARE_TOKEN_ADDISON` | Production access token for the **Addison** Square account (location `D11BVA91E8V3N`) |
| `SQUARE_TOKEN_ELMHURST` | Production access token for the **Elmhurst** Square account (location `L65DF5AG5BDAN`) |

The shops are two separate Square merchant accounts, so each needs its own token: create an app at
developer.squareup.com while signed in to that account, and copy its **Production** access token
(read-only `ITEMS_READ` is all the roster needs). Optional `SQUARE_API_BASE=https://connect.squareupsandbox.com`
for sandbox tokens. Locally, put the two lines in `site/.env` (git-ignored) or prefix the command, then
run `npm run check:square` to print what the build would use.

**Status (2026-10-10): no tokens yet.** The client's Square team-member invite (both accounts:
Appointments, Items & Orders, Online) is still pending, so the roster is barbers.json only. The merge
logic is unit-tested with fixtures; the live API call has not been run against a real account.

## Moving data to Supabase later

Swap the `loader:` for each collection in `src/content.config.ts` for the `supabaseLoader()` stub
at the bottom of that file. Schemas, `src/lib/data.ts` and the pages stay the same. If the
`barbers_with_booking` view supplies `booking_url`, it is used as-is; otherwise it's built from `item_id`.

## Placeholders still to replace

Headshots, shop photos, portfolio photos, barber bios/specialties/roles, parking
notes, the Google rating line (`src/lib/site.ts`, unverified) and the Facebook URL. See `../docs/NEEDED-FROM-CLIENT.md`.

`accepting_new_clients` is set `true` for all 25 barbers (no evidence anyone is closed). It renders
"Accepting new clients" (green dot) or "Booked up" (neutral chip): a shop-set statement, **not** live
Square availability. The client must set it per barber in the CMS. `next_opening` (optional, e.g.
"Tue 2pm") renders under the chip; the phase-2 Square availability job will fill it.

## Adding real photos (no code changes)

Drop files into these folders and rebuild (or push; Actions rebuilds):

- `src/assets/headshots/<barber-slug>.jpg` → that barber's headshot (slugs are in `src/data/barbers.json`, e.g. `nick-celli.jpg`).
- `src/assets/portfolio/<id>.jpg` → that portfolio tile's photo (ids are in `src/data/portfolio.json`, e.g. `addison-01.jpg`; the matching Instagram post is in each entry's `source_url`).
- `src/assets/culture/<id>.jpg` → that `/culture/` tile's photo (ids in `src/data/culture.json`, e.g. `edu-global-educators.jpg`), or set the item's `image` to a file name in that folder. New photos = a new `culture_items` entry.

JPG, PNG or WebP all work. Keep sources under ~2000px on the long edge; Astro generates the responsive sizes. A remote `headshot` / `image` URL in the data (Supabase later) still takes priority over a local file.
