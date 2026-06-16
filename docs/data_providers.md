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
| Antam          | 3        | —      | —   | —           | ✓              | —           | ANTAM           | `ANTAM_BUYBACK_URL`  | URL    |
| Reksa Dana NAV | 4        | —      | —   | —           | —              | ✓           | (any)           | `NAV_BASE_URL`       | URL    |
| EODHD          | 5        | ✓      | ✓   | —           | —              | —           | US, XETRA, …    | `EODHD_API_KEY`      | Yes    |
| Yahoo Finance  | 6        | ✓      | ✓   | —           | —              | —           | (any, suffixed) | — (keyless)          | No     |

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
- **Mutual fund (reksa dana):** Reksa Dana NAV → Fixture

Gold is sourced two different ways on purpose: **spot** (market `XAU`, via Twelve Data /
GoldAPI) prices paper/abstract gold, while **buyback** (market `ANTAM`, via the Antam
provider) values physical Antam/Pegadaian holdings at the dealer buyback rate. They are
distinct markets and never substitute for one another.

## Configuration

Each routable provider is gated by an environment variable. If the gate is unset the
provider is **silently skipped** — it simply drops out of the chain. Yahoo and Fixture need
no configuration.

| Env var              | Provider       | Required | Notes                                                       |
| -------------------- | -------------- | -------- | ----------------------------------------------------------- |
| `TWELVEDATA_API_KEY` | Twelve Data    | No       | IDX/US equities & ETFs, gold spot.                          |
| `GOLDAPI_KEY`        | GoldAPI        | No       | Gold spot (XAU).                                            |
| `ANTAM_BUYBACK_URL`  | Antam          | No       | JSON endpoint URL for the buyback rate.                     |
| `NAV_BASE_URL`       | Reksa Dana NAV | No       | Base URL for per-fund NAV lookups (`<base>/<fund-symbol>`). |
| `EODHD_API_KEY`      | EODHD          | No       | US/XETRA equities & ETFs (EU / Trade Republic instruments). |
| `OPENFIGI_API_KEY`   | OpenFIGI       | No       | Optional; only raises the discovery rate limit.             |

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
