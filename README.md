# Renpho Health MCP — smart-scale data for your Claude training coach

A remote [MCP](https://modelcontextprotocol.io) server, deployed on Cloudflare
Workers, that exposes your **Renpho smart-scale** body-composition data —
weight, body fat, fat-free mass, muscle, water, bone, visceral fat, BMR,
metabolic age and more — to Claude via the Renpho Health cloud API.
Add it once as a custom connector and it works on Claude **web, desktop, and
mobile**. Pairs with the Strava and Google Health connectors so your coach sees
training load, recovery *and* body composition.

> **Data source:** the **Renpho Health** app (blue icon) backend at
> `cloud.renpho.com`. Accounts on the legacy Renpho app (`renpho.qnclouds.com`)
> are not supported — migrate them in the app first.

Built on the reverse-engineered protocol from
[StartupBros-com/renpho-mcp-server](https://github.com/StartupBros-com/renpho-mcp-server)
(a local stdio server) and
[forkerer/RenphoGarminSync-CLI](https://github.com/forkerer/RenphoGarminSync-CLI),
restructured as a multi-user remote Worker in the style of
[google-health-mcp](https://github.com/a1dancole/google-health-mcp).

## Tools

| Tool | What it answers |
|------|-----------------|
| `get_latest_measurement` | "How am I doing?" — the newest reading with **every** metric, category classifications, changes vs 7/30/90 days ago, and progress toward the app's weight goal |
| `get_measurements` | Reading history over a range: every metric per weigh-in, or averaged per day/week; optional metric subset and device/impedance details |
| `get_body_composition_trend` | Per-metric start/end averages, change, min/max/mean and a least-squares weekly rate (with r²) plus a daily/weekly series — is weight change fat or lean mass? |
| `get_weight_trend` | Daily-average weight with a 7-day rolling mean, fitted weekly rate, and a projection of when the goal is reached (and the rate needed to hit the goal date) |
| `get_profile` | Sex, age, height, units, athlete mode, and the goals set in the app (target weight/date, target body fat, starting weight) |
| `get_scale_users` | Scale-user (profile) ids, data tables, family members and every device/data category Renpho reports |
| `run_diagnostics` | End-to-end probe: session, tables, page ordering, recent readings per profile, bound vs unbound, devices seen |
| `query_endpoint` | Escape hatch: call **any** `cloud.renpho.com` endpoint with the app's encryption/auth applied |
| `refresh_data` | Drop the cached session + pages and log in again (after a new weigh-in that isn't showing) |
| `delete_my_data` | Delete everything cached for your account |

> **Troubleshooting:** if readings look missing, stale, or attributed to the
> wrong person, run `run_diagnostics` first. It reports where the data
> actually lives (which table/profile, bound or not) instead of making you
> infer it from a downstream symptom.

---

## Field mapping (Renpho Health API)

A raw record from `RenphoHealth/scale/queryAllMeasureDataList` has ~57 keys.
The tools rename the metrics to unit-suffixed snake_case, decode enum codes,
drop envelope noise, and keep anything unrecognised under `extra` so nothing
is lost when Renpho adds fields (see [`src/measurements.ts`](src/measurements.ts)).

| Renpho key | Tool field | Unit / meaning |
|------------|-----------|----------------|
| `weight` | `weight_kg` | kg (always kg, regardless of the app's display unit) |
| `bmi` | `bmi` | — |
| `bodyfat` | `body_fat_pct` | % |
| `fatFreeWeight` | `fat_free_mass_kg` | kg |
| `subfat` | `subcutaneous_fat_pct` | % |
| `visfat` | `visceral_fat_level` | level 1–59 (≤9 healthy, 10–14 high, ≥15 very high) |
| `water` | `body_water_pct` | % |
| `sinew` | `skeletal_muscle_pct` | % |
| `muscle` | `muscle_mass_kg` | kg |
| `bone` | `bone_mass_kg` | kg |
| `protein` | `protein_pct` | % |
| `bmr` | `bmr_kcal` | kcal/day |
| `bodyage` | `metabolic_age` | years |
| `heartRate` | `heart_rate_bpm` | bpm (only scales with an HR sensor) |
| `cardiacIndex` | `cardiac_index` | L/min/m² |
| `waistline`, `hip` | `waistline_cm`, `hip_cm` | cm (only if entered) |
| `bodyShape` / `bodytype` | `body_type` | `thin`, `low_fat`, `athletic`, `muscle_deficient`, `well_balanced`, `overweight`, `invisible_obesity`, `fat_excess`, `obese` |
| `personType` | `athlete_mode` | boolean |
| `resistance`, `secResistance`, `actual*` | `impedance.*` | raw bio-impedance (Ω) |
| `method` | `source.method` | how the reading was allocated (`bluetooth_online_measure`, `cloud_wifi_auto_allocation`, `manual_input`, …) |
| `internalModel`, `scaleName`, `mac`, `deviceType`, `isAuto`, `sportFlag`, `invalidFlag` | `source.*` | device + flags |
| `bUserId`, `subUserId` | `user.bound_user_id`, `user.scale_user_id` | account the reading is bound to / profile it was measured under |
| `timeStamp` | `timestamp`, `time`, `date` | unix seconds; local RFC-3339 and calendar date in `TIME_ZONE` |

A metric reported as `0` means "not measured" and is omitted. Renpho ids are
64-bit integers beyond JavaScript's safe range, so the client re-quotes them
as strings before parsing ([`src/json.ts`](src/json.ts)).

### How data is fetched

- **Login** (`renpho-aggregation/user/login`) returns a bearer token with an
  `expAt`; it is cached (sealed) in KV until shortly before expiry and renewed
  by logging in again — Renpho has no refresh tokens.
- **`device/count`** lists the account's data tables and record counts and is
  fetched fresh on every tool call; it is the freshness signal.
- **Measurement pages** (200 records each) are cached in KV keyed by table,
  profile set **and record count**, so a new weigh-in changes the key and
  invalidates automatically. The paginator detects which way the table is
  ordered and walks from the newest page only as far as the requested window
  needs (max 30 pages / 6 000 records per table per call).
- **Selection:** readings bound to the signed-in account (`bUserId`) are
  returned by default; if nothing is bound yet (Wi-Fi scales upload before the
  app binds the reading) it falls back to the account's first scale-user
  profile and says so. Pass `scale_user_id` for a family member.

### Caching & encryption

Everything written to the `RENPHO_CACHE` KV namespace — session tokens and
measurement pages — is **AES-256-GCM sealed** with a key derived from the
`SESSION_ENCRYPTION_KEY` secret, keyed per user (SHA-256 of the email). If the
secret is unset, caching is simply disabled. Cache failures never break a
request.

The Renpho transport itself is AES-128-ECB with the static key shipped in the
app; WebCrypto has no ECB mode so the Worker uses the pure-JS `aes-js`
([`src/crypto.ts`](src/crypto.ts), verified byte-for-byte against OpenSSL in
the tests).

---

## How sign-in works (read this once)

Renpho has **no OAuth**. The Worker is an OAuth server *to Claude*
(`workers-oauth-provider`), and its `/authorize` page is a Renpho sign-in
form. Your email/password are checked against Renpho once, then stored
**inside the grant's encrypted props** — the encryption key is derived from
the token Claude holds, so the KV contents alone cannot be decrypted. The
credentials are needed because Renpho session tokens expire after a few hours
and the only way to get a new one is to log in again.

- **Disconnecting the connector in Claude deletes the grant** (and with it the
  stored credentials); `delete_my_data` clears the cache.
- Set `ALLOWED_EMAILS` (comma-separated) to stop anyone else's Renpho account
  connecting to *your* deployment. Left empty, any Renpho user can use it
  (each only ever sees their own data).

## Deploy

### Option A — GitHub Actions (no local wrangler)

The workflow in [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)
deploys on every push to `master` (and on demand). The app secret lives in
Cloudflare, not GitHub — GitHub only holds the Cloudflare API token + account id.

1. **Create two KV namespaces** in the Cloudflare dashboard (*Storage &
   Databases → KV*): `OAUTH_KV` and `RENPHO_CACHE`. Paste their ids into
   [`wrangler.jsonc`](wrangler.jsonc) and commit.
2. **Create a Cloudflare API token** (*My Profile → API Tokens → "Edit
   Cloudflare Workers" template*) and note your **Account ID**.
3. **Add GitHub repo secrets** `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
4. **Push to `master`.** The Actions log prints the Worker URL
   (`https://renpho-health-mcp.<subdomain>.workers.dev`).
5. **Set the app secret in Cloudflare** (*Workers & Pages → renpho-health-mcp →
   Settings → Variables and Secrets*, type **Secret**):
   `SESSION_ENCRYPTION_KEY` = any long random string.
   Optionally set the `ALLOWED_EMAILS` variable to your Renpho email.

### Option B — local wrangler

```sh
npm install
npx wrangler kv namespace create OAUTH_KV        # paste the id into wrangler.jsonc
npx wrangler kv namespace create RENPHO_CACHE    # paste the id into wrangler.jsonc
npx wrangler secret put SESSION_ENCRYPTION_KEY   # any long random string
npx wrangler deploy
```

## Connect in Claude

1. **Settings → Connectors → Add custom connector.**
2. URL: `https://renpho-health-mcp.<subdomain>.workers.dev/mcp`
3. Click **Connect** → sign in with your Renpho Health email/password → done.

Then ask your coach: *"Pull my latest scale reading and tell me whether the
last month's weight loss came from fat or lean mass."*

## Local development

```sh
cp .dev.vars.example .dev.vars   # set SESSION_ENCRYPTION_KEY
npm run dev                      # http://localhost:8787
npm test                         # vitest
npm run typecheck                # worker + tests
npm run icon                     # regenerate assets/icon.png + src/icon.ts
```

Test the flow with the MCP Inspector:

```sh
npx @modelcontextprotocol/inspector@latest
# Transport: Streamable HTTP → http://localhost:8787/mcp → Connect
```

## How it works

```
Claude (web/desktop/mobile)
  └─ custom connector → /mcp
       └─ workers-oauth-provider  (this Worker IS Claude's OAuth server)
            └─ AuthHandler        (Renpho sign-in page; validates against Renpho)
                 └─ RenphoMCP (Durable Object) → RenphoClient → cloud.renpho.com
```

- `src/index.ts` — wires `OAuthProvider` + the `McpAgent` Durable Object.
- `src/auth-handler.ts` — sign-in page (`/authorize`), landing page, icon.
- `src/renpho-api.ts` — Renpho client: session cache, encrypted transport with
  retry/re-login, order-agnostic paginator, user selection.
- `src/measurements.ts` — raw record → lean coaching shape, enums, classification, profile.
- `src/stats.ts` — regression, edge-window summaries, rolling means, goal projection.
- `src/tools.ts` — the coaching tools above.
- `src/crypto.ts`, `src/json.ts`, `src/dates.ts` — AES helpers, big-int-safe
  JSON, timezone-correct dates. All pure and unit-tested.

## Notes & limits

- **Wi-Fi scale binding lag.** Some Wi-Fi scales upload a reading before the
  app binds it to your account; until then it has a `scale_user_id` but no
  `bound_user_id`. The tools fall back to the first profile and say so
  (`selection: "fallback_scale_user"`); `run_diagnostics` lists hidden readings.
- **Bio-impedance is noisy.** Hydration, time of day and recent training move
  body-fat/water readings by several points. Weigh at the same time of day and
  read the averages/trends, not single readings — the trend tools use 7-day
  edge windows and rolling means for exactly this reason.
- **Units.** Masses are kg and compositional metrics are %, matching the
  Renpho app. `muscle` is reported as muscle *mass* (kg) and `sinew` as
  skeletal-muscle %; if your device firmware reports otherwise, the raw
  values are unchanged — only the label differs.
- **Only the `scale` category** has dedicated tools. Girth/tape, treadmill,
  rope and body-scan (MorphoScan) data show up in `get_scale_users` →
  `device_categories` and can be explored with `query_endpoint`.
- **Rate limits.** Renpho returns code `429` when pushed; the client backs off
  and retries, and cached pages keep serving.
- **Password changes** break the stored credentials — disconnect and reconnect
  the connector.
- **Unofficial API.** This uses the mobile app's private API; Renpho may change
  it at any time. Not affiliated with or endorsed by Renpho.

## Privacy

- Credentials are used only to authenticate with Renpho and are stored
  encrypted inside the OAuth grant; nothing is logged.
- Health data is cached only in your own KV namespace, sealed, and deletable
  with `delete_my_data`; nothing is sent to any third party.

## Credits

- API reverse engineering: [forkerer/RenphoGarminSync-CLI](https://github.com/forkerer/RenphoGarminSync-CLI)
  and [StartupBros-com/renpho-mcp-server](https://github.com/StartupBros-com/renpho-mcp-server) (MIT).

## License

MIT
