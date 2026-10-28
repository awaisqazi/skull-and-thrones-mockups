# skull-thrones-square-relay

A tiny Cloudflare Worker that turns **Square webhooks into GitHub `repository_dispatch` events**, so the
site refreshes within a minute of a booking or a catalog change instead of waiting for the next cron.

```
Square (booking / catalog / team / location event)
   -> POST https://<worker>.workers.dev/square          (signed, x-square-hmacsha256-signature)
   -> this Worker: verify signature, route, dedupe
   -> POST api.github.com/repos/<GITHUB_REPO>/dispatches
        booking.*                                   -> event_type "square-booking" -> availability.yml (chips)
        catalog.version.updated, team_member.*,
        location.updated                            -> event_type "square-catalog" -> deploy.yml (rebuild)
```

It is also the **15-minute clock** for the availability refresh: a Cloudflare Cron Trigger (`[triggers]` in
`wrangler.toml`, `*/15 12-23 * * *` and `*/15 0-2 * * *` UTC) fires `square-booking` with
`client_payload: { reason: "cron", scheduled_time }`. GitHub's own `schedule:` in `availability.yml` is best-effort
(on 2026-10-28 it fired 0 times in 5.5 hours of shop time) and stays only as a backstop; `availability.yml` applies its
shop-hours guard to these cron dispatches, so ticks outside 07:00–20:59 Chicago exit quietly. Cron Triggers are free on
the Workers Free plan. Until the Worker is deployed, only GitHub's cron runs.

Plain JavaScript, no dependencies, no KV, no database. Full design and the setup checklist:
`docs/SQUARE-INTEGRATION-SPEC.md` section 10.

## What it does

| Request | Answer |
|---|---|
| `GET /health` | `200 ok` |
| `POST /square`, signature matches **any** key in `SQUARE_SIGNATURE_KEYS` | route the event, dedupe, dispatch to GitHub, `200` |
| `POST /square`, missing or wrong signature | `401` (nothing is dispatched) |
| `POST /square`, signed but not JSON | `400` |
| `POST /square`, body over 256 KB (counted in bytes, also for streamed bodies without `content-length`) | `413` |
| Cron Trigger (every 15 min, UTC windows above) | dispatch `square-booking` `{ reason: "cron", scheduled_time }`; a GitHub failure is logged (`"cron dispatch failed"`), the next tick tries again |
| `POST /square` while the Worker is not configured | `500` (logged) |
| anything else | `404` |

Rules once a request is verified:

- Event types we do not use (payments, orders, ...) answer `200` and do nothing.
- **Dedupe** by `event_id` for 10 minutes (Cache API plus an in-memory table per Worker instance), so
  Square's retries and double deliveries fire one workflow, not several. It is best effort: the workflows
  also collapse bursts (`concurrency`), so a missed dedupe only costs one extra short run.
- Square gets `200` even if GitHub refused or failed, so it does not retry a storm. The one exception:
  GitHub unreachable (network, timeout, 5xx, 429) **and** a `booking.*` event: answer `502` so Square
  retries (and that retry is not treated as a duplicate).
- Only `type`, `merchant_id`, `event_id`, `created_at` are forwarded to GitHub as `client_payload`.
  The Square `data` object (customer and booking details) is never forwarded.
- Request bodies, signatures and tokens are never logged; log lines carry only type, route, event id and
  GitHub's status code (`npx wrangler tail` shows them).

## Configuration

| Name | Kind | Value |
|---|---|---|
| `GITHUB_REPO` | var (in `wrangler.toml`) | `awaisqazi/skull-and-thrones-mockups` |
| `GITHUB_TOKEN` | **secret** | Fine-grained personal access token, see below |
| `SQUARE_SIGNATURE_KEYS` | **secret** | Signature keys from the Square webhook subscriptions, comma separated: `<addison key>,<elmhurst key>` |
| `NOTIFICATION_URL` | **secret** | The exact URL typed into the Square subscriptions: `https://skull-thrones-square-relay.<your-subdomain>.workers.dev/square`. Square signs `URL + body`, so a trailing slash or `http` vs `https` mismatch makes every event a `401`. |

## Deploy (the owner does this; ~10 minutes, free)

You need a free Cloudflare account. `npm create cloudflare` is **not** needed.

```bash
cd site/worker
npx wrangler login                      # opens the browser; sign in to Cloudflare
npx wrangler deploy                     # prints https://skull-thrones-square-relay.<subdomain>.workers.dev
curl https://skull-thrones-square-relay.<subdomain>.workers.dev/health    # -> ok
```

Then set the three secrets (each command prompts; paste the value, it is never echoed or stored in the repo):

```bash
npx wrangler secret put NOTIFICATION_URL         # https://skull-thrones-square-relay.<subdomain>.workers.dev/square
npx wrangler secret put GITHUB_TOKEN             # the PAT below
npx wrangler secret put SQUARE_SIGNATURE_KEYS    # add this AFTER step "Square" below (comma separated)
```

`wrangler secret put` takes effect immediately; no redeploy needed. Re-running `wrangler deploy` keeps the secrets.

### GitHub personal access token

GitHub -> Settings -> Developer settings -> Personal access tokens -> **Fine-grained tokens** -> Generate new token.

- Token name: `skull-thrones-square-relay`
- Expiration: 1 year (put the renewal date in your calendar; see "Rotating" below)
- Resource owner: `awaisqazi`; Repository access: **Only select repositories** -> `skull-and-thrones-mockups`
- Repository permissions: **Contents: Read and write** (that is what `repository_dispatch` requires; nothing else).
  Metadata: Read is added automatically.

### Square (do it once per Square account: Addison, then Elmhurst)

1. developer.squareup.com -> sign in **as that account** -> Applications -> the app ("Skull & Thrones" for Addison,
   "Skull & Thrones website" for Elmhurst) -> **Webhooks** -> **Subscriptions** -> **Add subscription**.
2. Name: `GitHub relay`. URL: the `NOTIFICATION_URL` above. API version: `2025-09-24`.
3. Events: `booking.created`, `booking.updated`, `catalog.version.updated`, `team_member.created`,
   `team_member.updated`, `location.updated`. Make sure the **Production** tab is selected (sandbox has its own list).
4. Save, then open the subscription and copy its **Signature key**.
5. After both accounts are done: `npx wrangler secret put SQUARE_SIGNATURE_KEYS` and paste `key1,key2`.
6. Optional: in the subscription click **Send test event** and check `npx wrangler tail` and the repo's Actions tab.

The personal access tokens already used by the site include the appointment read scopes the booking events need.

## Smoke test (signed sample event, no Square needed)

Uses your real secrets, so it really fires the workflow once. For a no-side-effect check, use `GET /health`
or the unit tests below.

```bash
WORKER=https://skull-thrones-square-relay.<subdomain>.workers.dev
KEY='<one of the signature keys>'
BODY='{"merchant_id":"SMOKE","type":"booking.updated","event_id":"smoke-'$(date +%s)'","created_at":"2026-01-01T00:00:00Z","data":{"type":"booking","id":"x"}}'
SIG=$(printf '%s%s' "$WORKER/square" "$BODY" | openssl dgst -sha256 -hmac "$KEY" -binary | base64)

curl -i -X POST "$WORKER/square" -H "content-type: application/json" -H "x-square-hmacsha256-signature: $SIG" --data "$BODY"
#   200 dispatched   -> GitHub accepted it; a "Refresh live availability" run appears in the Actions tab
#   401              -> wrong key, or NOTIFICATION_URL differs from $WORKER/square
#   200 accepted     -> signature fine but GitHub refused: check GITHUB_TOKEN scope / expiry (npx wrangler tail)
curl -i -X POST "$WORKER/square" -H "x-square-hmacsha256-signature: bogus" --data "$BODY"      # 401
```

Run it twice with the same `event_id` within 10 minutes to see `200 duplicate`.

## Local checks

```bash
cd site
node --test "worker/test/*.test.mjs"   # 43 unit tests, no network (node:test); also run by deploy.yml
# or, from site/worker: npm test   (= node --test "test/*.test.mjs")
# Cron locally: npx wrangler dev --test-scheduled, then curl "http://localhost:8787/__scheduled?cron=*/15+12-23+*+*+*"
cd worker && npx wrangler dev          # local Worker on :8787; set values in worker/.dev.vars (git-ignored), not in the repo
```

## Operating notes

- **Free tier:** Workers Free allows 100,000 requests/day. The shops generate a few hundred webhook events a day.
- **Rotating the GitHub token:** create a new fine-grained token as above, `npx wrangler secret put GITHUB_TOKEN`,
  delete the old one in GitHub. Do it before the expiry date; an expired token makes the Worker answer `200 accepted`
  while dispatching nothing (booking chips then refresh only on the 15-minute cron). Look for `"github":401` in
  `npx wrangler tail`.
- **Rotating a Square signature key:** Square Developer Console -> subscription -> rotate key -> update
  `SQUARE_SIGNATURE_KEYS` immediately (both keys, comma separated).
- **Nothing here is critical:** if the Worker is down, the 15-minute availability cron and the nightly build still run.
- **Cost of a mistake:** none. The Worker has no Square credentials and cannot read or change anything in Square.
