# Market-Data Providers

How live prices are sourced. The market-data layer is a set of interchangeable
**providers** behind a single `MarketDataProvider` interface
(`packages/market-data/src/types.ts`). For each quote/history request the
`MarketDataService` walks the **enabled providers in priority order** and asks each whether
it `supports(assetClass, market)`; the first supporting provider that returns a non-null
result wins. If none do, the request falls through to the always-on **Fixture** catch-all.

Two providers are special and **not user-configurable**: `OpenFIGI` (ISIN → instrument
discovery only — never returns a price) and `Fixture` (deterministic test/dev catch-all).
Both are appended unconditionally after the configurable chain.

## Provider × asset-class matrix

Priority is the default tried-first order (lower = earlier). Cells reflect each provider's
`supports()` logic — ✓ = priced, — = not served.

| Provider       | Priority | Equity | ETF | Gold (spot) | Gold (buyback) | Mutual fund | Markets         | Env gate             | Keyed? |
| -------------- | -------- | ------ | --- | ----------- | -------------- | ----------- | --------------- | -------------------- | ------ |
| Twelve Data    | 1        | ✓      | ✓   | ✓           | —              | —           | IDX, US, XAU    | `TWELVEDATA_API_KEY` | Yes    |
| GoldAPI        | 2        | —      | —   | ✓           | —              | —           | XAU             | `GOLDAPI_KEY`        | Yes    |
| Antam          | 3        | —      | —   | —           | ✓              | —           | ANTAM           | `ANTAM_BUYBACK_URL`  | Scraper|
| Galeri24       | 4        | —      | —   | —           | ✓              | —           | GALERI24        | `GALERI24_BUYBACK_URL` | Scraper|
| Reksa Dana NAV | 5        | —      | —   | —           | —              | ✓           | (any)           | `NAV_BASE_URL`       | Scraper|
| EODHD          | 6        | ✓      | ✓   | —           | —              | —           | US, XETRA, …    | `EODHD_API_KEY`      | Yes    |
| Yahoo Finance  | 7        | ✓      | ✓   | —           | —              | —           | (any, suffixed) | — (keyless)          | No     |

Antam and Galeri24 are both **gold buyback** sources backed by one shared `BuybackProvider`
(`packages/market-data/src/buyback.ts`), one instance per brand/market.

Always-on, outside the configurable registry:

- **OpenFIGI** — discovery only. `supports()` always returns false, so it never prices an
  instrument; it resolves ISINs to a symbol + exchange during search. `OPENFIGI_API_KEY` is
  optional and only raises the rate limit.
- **Fixture** — supports every asset class/market and returns deterministic prices for a
  small built-in catalogue. It is the final fallback and the only price source under test
  (`NODE_ENV=test` skips all live providers).

## Coverage gaps

`ASSET_CLASSES` (`packages/market-data/src/types.ts`) also defines `bond`, `crypto`, and
`derivative`, but **no live provider serves them today** — only the Fixture catch-all
answers, so outside tests they have no real price source. Adding live coverage for these
means adding a provider (see [Adding a provider](#adding-a-provider)).

## Priority & fallback

Default priorities come from `PROVIDER_REGISTRY` registration order
(`services/api/src/services/market-data.ts`): keyed primaries first, the keyless Yahoo
fallback last. The service tries supporting providers in order until one returns a result,
so the effective chain per asset is:

- **IDX equity / ETF:** Twelve Data → Yahoo → Fixture
- **US equity / ETF:** Twelve Data → EODHD → Yahoo → Fixture
- **XETRA (and other EODHD-mapped) equity / ETF:** EODHD → Yahoo → Fixture
- **Gold spot (XAU):** Twelve Data → GoldAPI → Fixture
- **Gold buyback (ANTAM):** Antam → Fixture
- **Gold buyback (GALERI24):** Galeri24 → Fixture
- **Mutual fund (reksa dana):** Reksa Dana NAV → Fixture

Gold is sourced multiple ways on purpose: **spot** (market `XAU`, via Twelve Data / GoldAPI)
prices paper/abstract gold, while each **buyback** market (`ANTAM`, `GALERI24`) values
physical holdings at that dealer's own buyback rate — the rates differ, so the markets never
substitute for one another. The add-transaction gold flow lets the user pick the buyback
source per holding.

## Configuration

Each routable provider is gated by an environment variable. If the gate is unset the
provider is **silently skipped** — it simply drops out of the chain. Yahoo and Fixture need
no configuration.

| Env var              | Provider       | Required | Notes                                                       |
| -------------------- | -------------- | -------- | ----------------------------------------------------------- |
| `TWELVEDATA_API_KEY` | Twelve Data    | No       | IDX/US equities & ETFs, gold spot.                          |
| `GOLDAPI_KEY`        | GoldAPI        | No       | Gold spot (XAU).                                            |
| `ANTAM_BUYBACK_URL`  | Antam          | No       | Override the built-in scraper with an external JSON endpoint. Blank ⇒ internal scraper route (see below). |
| `GALERI24_BUYBACK_URL` | Galeri24     | No       | Override the built-in scraper with an external JSON endpoint. Blank ⇒ internal scraper route (see below). |
| `NAV_BASE_URL`       | Reksa Dana NAV | No       | Override the built-in scraper with an external `<base>/<fund-symbol>` endpoint. Blank ⇒ internal scraper route. |
| `MARKET_DATA_SELF_URL` | Antam / Galeri24 / NAV | No | Base URL the providers use to reach this API's internal scraper routes. Default `http://127.0.0.1:$PORT`. |
| `EODHD_API_KEY`      | EODHD          | No       | US/XETRA equities & ETFs (EU / Trade Republic instruments). |
| `OPENFIGI_API_KEY`   | OpenFIGI       | No       | Optional; only raises the discovery rate limit.             |

Unlike the other providers, **Antam, Galeri24 and Reksa Dana NAV are always on**: with their
env var blank they fetch the built-in scrapers' internal routes (next section) instead of
dropping out of the chain.

## Built-in scrapers

Gold buyback (Antam, Galeri24) and reksa-dana NAV have no official free API, so the API
scrapes them itself (scheduler jobs → `scraped_quotes` cache → internal routes the providers
fetch). Failures degrade gracefully: a missing/stale value just makes the provider fall
through to Fixture.

| Source        | Scrapes                                         | Cache key          | Internal route                  | Schedule            |
| ------------- | ----------------------------------------------- | ------------------ | ------------------------------- | ------------------- |
| harga-emas.org | Antam LM buyback (`Harga pembelian kembali`)   | `gold:antam-buyback` | `GET /internal/gold/antam-buyback` | every 4h (`0 */4 * * *`) |
| galeri24.co.id | Galeri24 buyback (1 g `Harga Buyback`)          | `gold:galeri24-buyback` | `GET /internal/gold/galeri24-buyback` | every 4h (`0 */4 * * *`) |
| api.bibit.id  | Reksa-dana NAV catalogue (`symbol` → `nav.value`) | `nav:<symbol>`     | `GET /internal/nav/:symbol`     | 16:00 & 01:00 UTC (`0 1,16 * * *`) |

- **Gold source (Antam):** the canonical Antam page (`logammulia.com/id/sell/gold`) sits
  behind anti-bot protection that 403s non-browser clients, so it is unusable server-side. We
  read the same official Antam LM buyback from harga-emas.org instead. The source URL +
  extraction are isolated in `services/api/src/services/scrapers/antam-buyback.ts`.
- **Gold source (Galeri24):** `galeri24.co.id/harga-emas` is directly scrapeable server-side
  (static Nuxt HTML). The page lists several brands; extraction scopes to the `GALERI 24`
  section and reads the 1 g `Harga Buyback`, isolated in
  `services/api/src/services/scrapers/galeri24-buyback.ts`.
- **NAV source & symbol scheme:** Bibit's `products/list` returns an AES-encrypted catalogue
  (decrypted in `bibit-nav.ts`). The **canonical fund symbol is Bibit's `symbol` field**
  (e.g. `RD4196`) — store that on the `mutual_fund` instrument so `/internal/nav/<symbol>`
  resolves. Per-unit NAV is `nav.value`.
- Code: `services/api/src/services/scrapers/*`, routes in
  `services/api/src/routes/internal-market-data.ts`, scheduled in
  `services/api/src/services/scheduler.ts`. The internal routes are unauthenticated (they
  expose only already-public prices and are the providers' own data source).

**Run the scrapers on demand** (e.g. right after a deploy, so you don't wait for the cron):

- Admin API: `POST /admin/market-data/scrape` (Authentik admin group) → runs all scrapers
  and returns `{ antamBuyback, galeri24Buyback, navFunds }`.
- CLI: `npm run scrape` (in `services/api`, loads `../../.env`), or in a container
  `node dist/db/scrape.js` with `DATABASE_URL` set.

## Admin overrides

The `provider_settings` table (`packages/db/src/schema.ts`) overlays the registry defaults
at runtime: admins can toggle a provider's `enabled` flag and override its `priority`
without a deploy. The merge is `resolveProviderConfig()` in
`services/api/src/services/market-data.ts` — a missing row means "use the default" (enabled,
registration priority). Changes invalidate the cached service so the next request rebuilds
the chain.

- **UI:** `/admin` → Data providers (`apps/web/src/app/[locale]/(app)/admin/page.tsx`,
  `apps/web/src/components/admin-providers.tsx`).
- **API:** `GET /admin/providers` (effective config), `PATCH /admin/providers` (upsert
  enabled/priority) — `services/api/src/routes/admin.ts`.

API **keys/URLs remain env-only** — the admin UI never sets credentials, only enable/order.
A provider whose env gate is unset shows as not configured and stays out of the chain even
if enabled.

## Adding a provider

1. Implement the `MarketDataProvider` interface in `packages/market-data/src/` (at minimum
   `name`, `supports()`, `getQuote()`; optionally `getHistory()`, `search()`,
   `resolveISIN()`).
2. Export it from `packages/market-data/src/index.ts`.
3. Add a `ProviderDescriptor` to `PROVIDER_REGISTRY` in
   `services/api/src/services/market-data.ts` (id, label, `defaultPriority`, `configured()`
   env gate, `create()`).

The registry is the single source of truth for both instantiation and the admin UI.
OpenFIGI and Fixture stay outside it (appended unconditionally).

## References

- `services/api/src/services/market-data.ts` — `PROVIDER_REGISTRY`, `resolveProviderConfig()`, `getMarketData()`
- `packages/market-data/src/types.ts` — `ASSET_CLASSES`, `MarketDataProvider`
- `packages/market-data/src/*.ts` — per-provider `supports()` / implementations
- `packages/db/src/schema.ts` — `provider_settings`
- `services/api/src/routes/admin.ts` — `GET`/`PATCH /admin/providers`
- `apps/web/src/app/[locale]/(app)/admin/page.tsx`, `apps/web/src/components/admin-providers.tsx` — admin UI
