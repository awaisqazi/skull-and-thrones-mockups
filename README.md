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
```

Requires Node 18.20+ (CI uses Node 22).

## Where things live

| Path | What |
|---|---|
| `src/data/locations.json` | Both shops: address, phone, hours, Square booking URL, any-artist item id, map query |
| `src/data/barbers.json` | 25 barbers (seeded from `docs/barbers.json`). `placeholder_fields` lists invented copy |
| `src/data/portfolio.json` | PLACEHOLDER portfolio set (12 per shop), tagged by barber slug + style |
| `src/content.config.ts` | Content collections (`file()` loader + zod schemas) and a commented Supabase loader stub |
| `src/lib/data.ts` | The only data API pages use. Builds `booking_url = square_booking_url + '/' + item_id` |
| `src/lib/placeholder.ts` | Generates the grey striped SVG placeholder tiles (data URIs) |
| `src/lib/url.ts` | `url(path)` prefixes `import.meta.env.BASE_URL`. Use it for every internal link |
| `src/components/` | Layout pieces: Nav, MobileBookBar, BarberCard/Grid, LocationTabs, PortfolioGrid, LocationCard, Footer |
| `src/scripts/app.ts` | Vanilla JS: tabs, popovers, portfolio filters, lightbox, "Open now" |
| `src/styles/global.css` | Mockup CSS ported 1:1 (design tokens unchanged) + small additions in section 16 |

Routes: `/`, `/book/`, `/barbers/`, `/barbers/{slug}/`, `/addison/`, `/elmhurst/` (Barbers | Portfolio
tabs, `#portfolio` opens the portfolio tab), `/contact/`, `/portfolio/` (redirects to `/addison/#portfolio`), 404.
Sitemap: `sitemap-index.xml` (@astrojs/sitemap); `robots.txt` is generated from `site` + `base`.

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

## Moving data to Supabase later

Swap the `loader:` for each collection in `src/content.config.ts` for the `supabaseLoader()` stub
at the bottom of that file. Schemas, `src/lib/data.ts` and the pages stay the same. If the
`barbers_with_booking` view supplies `booking_url`, it is used as-is; otherwise it's built from `item_id`.

## Placeholders still to replace

Headshots, shop photos, portfolio photos, barber bios/specialties/roles/accepting flag, parking
notes, the Google rating line (`src/lib/site.ts`, unverified) and the Facebook URL. See `../docs/NEEDED-FROM-CLIENT.md`.
