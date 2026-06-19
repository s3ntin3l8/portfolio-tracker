import {
  BuybackProvider,
  CoinGeckoProvider,
  EodhdProvider,
  FixtureProvider,
  GoldApiProvider,
  MarketDataService,
  NavProvider,
  OpenFigiProvider,
  TwelveDataProvider,
  YahooFinanceProvider,
  type MarketDataProvider,
  type ProviderUsage,
} from "@portfolio/market-data";
import { BorseFrankfurtProvider } from "./borse-frankfurt.js";
import {
  providerSettings,
  providerUsage,
  providerCredentials,
  type ProviderSetting,
} from "@portfolio/db";
import { eq } from "drizzle-orm";
import { getDb, getEncryption } from "../db/client.js";

/**
 * Resolved secrets for a provider: the DB key/url overrides the env value.
 * Passed to `ProviderDescriptor.configured()` and `create()` so the registry
 * stays pure (no async DB calls) while supporting DB-stored keys.
 */
export interface ResolvedSecret {
  apiKey?: string;
  url?: string;
}

/**
 * A routable price provider, gated by an env key/url or a DB credential.
 * The registry is the single source of truth for both instantiation (here) and
 * the admin UI (GET/PATCH /admin/providers). `OpenFigi` (discovery-only) and
 * `Fixture` (catch-all) are intentionally NOT here — they are appended
 * unconditionally and aren't user-configurable.
 */
export interface ProviderDescriptor {
  id: string;
  label: string;
  /** Tried-first ordering when there is no DB override (registration order). */
  defaultPriority: number;
  /**
   * Whether this provider can be used given the supplied secrets.
   * When `secrets` is provided (DB override), checks the secret's apiKey/url first;
   * falls back to env when absent. The signature is compatible with `() => boolean`
   * so existing test fixtures can keep the shorter form.
   */
  configured: (secrets?: ResolvedSecret) => boolean;
  /**
   * Instantiate the provider. secrets.apiKey/url take precedence over env.
   * Only called when `configured(secrets)` is true.
   */
  create: (secrets?: ResolvedSecret) => MarketDataProvider;
  /**
   * The `market` constant this provider serves as a *user-selectable gold buyback source*
   * (e.g. `"ANTAM"`). Set only on providers that price physical/savings gold holdings, so
   * the manual-entry form can offer them in a source picker (see {@link goldSources}). Spot
   * (XAU) is the live ticker, not a holding source, so the spot providers stay unset.
   */
  goldMarket?: string;
  /**
   * Name of the environment variable that supplies this provider's API key or URL.
   * Used by the admin UI to show a "from .env" indicator when no DB credential is set
   * but an env key is present. Never exposed as a value — presence only.
   */
  keyEnvVar?: string;
}

/**
 * Base URL the Antam/NAV providers fetch their data from. They consume a JSON endpoint;
 * by default that endpoint is this API's own internal market-data routes, which serve the
 * values our scrapers cache (see routes/internal-market-data.ts, services/scrapers/*).
 * Override `MARKET_DATA_SELF_URL` if the API isn't reachable at localhost:PORT (e.g. behind
 * a different internal hostname). The per-provider env vars below still win when set, so the
 * URLs can be repointed at an external scraper without code changes.
 */
function selfBaseUrl(): string {
  return process.env.MARKET_DATA_SELF_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`;
}

// Registration order matches the historical hardcoded chain: keyed primaries first,
// keyless Yahoo fallback last. DB credentials win over env (see resolveCredentials);
// the scraped Antam/NAV sources default to this API's internal routes (see selfBaseUrl).
export const PROVIDER_REGISTRY: ProviderDescriptor[] = [
  {
    id: "twelvedata",
    label: "Twelve Data",
    defaultPriority: 1,
    keyEnvVar: "TWELVEDATA_API_KEY",
    configured: (s) => Boolean(s?.apiKey ?? process.env.TWELVEDATA_API_KEY),
    create: (s) => new TwelveDataProvider(s?.apiKey ?? process.env.TWELVEDATA_API_KEY!),
  },
  {
    id: "goldapi",
    label: "GoldAPI",
    defaultPriority: 2,
    keyEnvVar: "GOLDAPI_KEY",
    configured: (s) => Boolean(s?.apiKey ?? process.env.GOLDAPI_KEY),
    create: (s) => new GoldApiProvider(s?.apiKey ?? process.env.GOLDAPI_KEY!),
  },
  {
    id: "antam",
    label: "Antam buyback",
    defaultPriority: 3,
    goldMarket: "ANTAM",
    // Always available: defaults to the internal route fed by the buyback scraper, served
    // from the scraped_quotes cache. 404 until the first scrape, which the provider treats
    // as "no quote" (falls through to spot / fixture).
    configured: () => true,
    create: (s) =>
      new BuybackProvider({
        name: "antam",
        market: "ANTAM",
        baseUrl:
          s?.url ?? process.env.ANTAM_BUYBACK_URL ?? `${selfBaseUrl()}/internal/gold/antam-buyback`,
      }),
  },
  {
    id: "galeri24",
    label: "Galeri24 buyback",
    defaultPriority: 4,
    goldMarket: "GALERI24",
    // Always available: defaults to the internal route fed by the Galeri24 buyback scraper.
    // Serves a disjoint market from Antam, so its priority only affects display order.
    configured: () => true,
    create: (s) =>
      new BuybackProvider({
        name: "galeri24",
        market: "GALERI24",
        baseUrl:
          s?.url ??
          process.env.GALERI24_BUYBACK_URL ??
          `${selfBaseUrl()}/internal/gold/galeri24-buyback`,
      }),
  },
  {
    id: "nav",
    label: "Reksa Dana NAV",
    defaultPriority: 5,
    // Always available: defaults to the internal route fed by the Bibit NAV scraper.
    configured: () => true,
    create: (s) =>
      new NavProvider({
        baseUrl: s?.url ?? process.env.NAV_BASE_URL ?? `${selfBaseUrl()}/internal/nav`,
      }),
  },
  {
    id: "eodhd",
    label: "EODHD",
    defaultPriority: 6,
    keyEnvVar: "EODHD_API_KEY",
    configured: (s) => Boolean(s?.apiKey ?? process.env.EODHD_API_KEY),
    create: (s) => new EodhdProvider({ apiKey: s?.apiKey ?? process.env.EODHD_API_KEY! }),
  },
  {
    id: "coingecko",
    label: "CoinGecko",
    defaultPriority: 7,
    keyEnvVar: "COINGECKO_API_KEY",
    // Always available: the public API works keyless; an optional Demo COINGECKO_API_KEY
    // raises the rate limit. The crypto specialist, so it sorts ahead of Yahoo's crypto
    // fallback (order only matters among crypto supporters).
    configured: () => true,
    create: (s) => new CoinGeckoProvider({ apiKey: s?.apiKey ?? process.env.COINGECKO_API_KEY }),
  },
  {
    id: "yahoo",
    label: "Yahoo Finance",
    defaultPriority: 8,
    configured: () => true, // keyless fallback
    create: () => new YahooFinanceProvider(),
  },
];

/** The effective config for one registry provider after the DB overlay is applied. */
export interface ResolvedProvider {
  id: string;
  label: string;
  configured: boolean;
  enabled: boolean;
  priority: number;
}

/**
 * Overlay the DB `provider_settings` rows onto the registry defaults and return every
 * registry provider in effective priority order (lower first). A missing row means
 * "use the default" (enabled, registration priority). When `credentials` is supplied,
 * each provider's `configured` reflects whether a key is available via DB or env.
 * Pure (no async, no network) — unit-testable independently of provider instantiation.
 */
export function resolveProviderConfig(
  rows: Pick<ProviderSetting, "provider" | "enabled" | "priority">[],
  registry: ProviderDescriptor[] = PROVIDER_REGISTRY,
  credentials?: Map<string, ResolvedSecret>,
): ResolvedProvider[] {
  const byId = new Map(rows.map((r) => [r.provider, r]));
  return registry
    .map((d) => {
      const row = byId.get(d.id);
      const secret = credentials?.get(d.id);
      return {
        id: d.id,
        label: d.label,
        configured: d.configured(secret),
        enabled: row ? row.enabled : true,
        priority: row ? row.priority : d.defaultPriority,
      };
    })
    .sort((a, b) => a.priority - b.priority);
}

/** A gold buyback source the manual-entry form can offer, mapped to its routing market. */
export interface GoldSource {
  market: string;
  label: string;
}

/**
 * The selectable gold buyback sources: every registry provider that declares a `goldMarket`
 * and is both `configured` and `enabled`, in effective priority order. Drives the gold-source
 * picker in the add-transaction form — a new gold provider (e.g. Galeri24) surfaces here
 * automatically once it's in the registry and configured. Pure (no env/network).
 */
export function goldSources(
  rows: Pick<ProviderSetting, "provider" | "enabled" | "priority">[],
  registry: ProviderDescriptor[] = PROVIDER_REGISTRY,
  credentials?: Map<string, ResolvedSecret>,
): GoldSource[] {
  const goldMarketById = new Map(
    registry.filter((d) => d.goldMarket).map((d) => [d.id, d.goldMarket!]),
  );
  return resolveProviderConfig(rows, registry, credentials)
    .filter((p) => p.configured && p.enabled && goldMarketById.has(p.id))
    .map((p) => ({ market: goldMarketById.get(p.id)!, label: p.label }));
}

// In-process tally of API calls per provider since the last flush. Incremented by the
// MarketDataService `onCall` hook (cheap, no DB), drained into `provider_usage` by
// `flushUsage()`. Avoids a DB write on every quote.
const callCounts = new Map<string, number>();

function recordCall(name: string): void {
  callCounts.set(name, (callCounts.get(name) ?? 0) + 1);
}

let service: MarketDataService | null = null;

/**
 * Fetch and decrypt DB credential overrides for providers in the given registry.
 * DB key wins over the env key; missing rows fall back to env transparently.
 * Returns an empty Map when there are no DB rows (the common case on first boot).
 * The EncryptionService is a passthrough when DB_ENCRYPTION_KEY is not set, so this
 * is safe to call regardless — but the write routes refuse to store keys without it.
 *
 * NOTE (see #105): this is called per `getMarketData()` rebuild (on invalidation);
 * in a multi-replica deployment, invalidation is in-process only — other replicas
 * keep serving their cached service until they restart. LISTEN/NOTIFY is the fix,
 * tracked as a deferred follow-up.
 */
export async function resolveCredentials(
  registry: ProviderDescriptor[] = PROVIDER_REGISTRY,
): Promise<Map<string, ResolvedSecret>> {
  const enc = getEncryption();
  const db = getDb();
  const ids = new Set(registry.map((d) => d.id));
  const rows = await db
    .select()
    .from(providerCredentials)
    .then((rs) => rs.filter((r) => ids.has(r.provider)));

  const out = new Map<string, ResolvedSecret>();
  for (const row of rows) {
    const secret: ResolvedSecret = {};
    if (row.apiKeyEnc) {
      try {
        secret.apiKey = enc.decryptString(row.apiKeyEnc);
      } catch {
        // Decryption failure: skip this key; env will act as fallback
      }
    }
    if (row.urlOverride) {
      secret.url = row.urlOverride;
    }
    if (secret.apiKey !== undefined || secret.url !== undefined) {
      out.set(row.provider, secret);
    }
  }
  return out;
}

/**
 * The app's market-data service. Live providers come from the registry, ordered and
 * enabled per the DB `provider_settings` overlay (admins edit these from the UI), with
 * DB credential overrides layered on top (from `provider_credentials`), always-on
 * OpenFigi discovery + a FixtureProvider catch-all. The service tries supporting
 * providers in order until one returns a result. The built service is cached;
 * `invalidateMarketData()` drops the cache so a settings change is picked up on the
 * next call (every caller invokes this per request/job — see #105 for multi-replica reload).
 * Tests use the fixture only (deterministic, no network).
 */
export async function getMarketData(): Promise<MarketDataService> {
  if (service) return service;
  const providers: MarketDataProvider[] = [];
  if (process.env.NODE_ENV !== "test") {
    const db = getDb();
    const [rows, credentials] = await Promise.all([
      db
        .select({
          provider: providerSettings.provider,
          enabled: providerSettings.enabled,
          priority: providerSettings.priority,
        })
        .from(providerSettings),
      resolveCredentials(),
    ]);
    const byId = new Map(PROVIDER_REGISTRY.map((d) => [d.id, d]));
    for (const r of resolveProviderConfig(rows, PROVIDER_REGISTRY, credentials)) {
      if (!r.enabled || !r.configured) continue;
      providers.push(byId.get(r.id)!.create(credentials.get(r.id)));
    }
    // ISIN → instrument discovery (keyless; OPENFIGI_API_KEY raises the rate limit).
    providers.push(new OpenFigiProvider({ apiKey: process.env.OPENFIGI_API_KEY }));
  }
  providers.push(new FixtureProvider());
  service = new MarketDataService(providers, { onCall: recordCall });
  return service;
}

/**
 * Return the Börse Frankfurt enrichment provider when enabled via BORSE_FRANKFURT_ENABLED=true.
 * NOT added to the MarketDataService typeahead chain — used only for explicit on-demand lookups.
 */
export function getBorseFrankfurt(): BorseFrankfurtProvider | null {
  if (process.env.BORSE_FRANKFURT_ENABLED !== "true") return null;
  return new BorseFrankfurtProvider();
}

/** Drop the cached service so the next `getMarketData()` rebuilds from current settings. */
export function invalidateMarketData(): void {
  service = null;
  usageCache = null;
}

/** Override the cached service — for tests that need specific fixture prices. */
export function overrideMarketData(svc: MarketDataService): void {
  service = svc;
}

// --- Usage / quota --------------------------------------------------------

/** The merged usage view for one provider, surfaced to the admin UI. */
export interface ProviderUsageView extends ProviderUsage {
  /** `provider` = live from the provider's API; `local` = our own call counter. */
  source: "provider" | "local";
}

function todayKey(now: Date): string {
  return now.toISOString().slice(0, 10); // YYYY-MM-DD
}

function monthKey(now: Date): string {
  return now.toISOString().slice(0, 7); // YYYY-MM
}

/**
 * Drain the in-process call tally into `provider_usage`, rolling the day/month windows
 * over lazily (a stored window that no longer matches now resets before we add). Called
 * from the admin read and the scheduler tick so counts persist without a per-call write.
 */
export async function flushUsage(): Promise<void> {
  if (callCounts.size === 0) return;
  const drained = [...callCounts.entries()];
  callCounts.clear();
  const now = new Date();
  const day = todayKey(now);
  const month = monthKey(now);
  const db = getDb();
  for (const [provider, count] of drained) {
    const [existing] = await db
      .select()
      .from(providerUsage)
      .where(eq(providerUsage.provider, provider));
    if (!existing) {
      await db.insert(providerUsage).values({
        provider,
        day,
        callsDay: count,
        month,
        callsMonth: count,
      });
      continue;
    }
    const callsDay = (existing.day === day ? existing.callsDay : 0) + count;
    const callsMonth = (existing.month === month ? existing.callsMonth : 0) + count;
    await db
      .update(providerUsage)
      .set({ day, callsDay, month, callsMonth, updatedAt: now })
      .where(eq(providerUsage.provider, provider));
  }
}

const USAGE_TTL_MS = 60_000;
let usageCache: { at: number; data: Record<string, ProviderUsageView> } | null = null;

/**
 * Per-provider usage for the admin UI: live quota from the provider's API where it exposes
 * one, else our local call counter. Memoised for {@link USAGE_TTL_MS} so repeated admin
 * loads don't re-hit the providers' usage endpoints; the cache is cleared by
 * `invalidateMarketData()`.
 */
export async function getProviderUsage(): Promise<Record<string, ProviderUsageView>> {
  if (usageCache && Date.now() - usageCache.at < USAGE_TTL_MS) {
    return usageCache.data;
  }
  const out: Record<string, ProviderUsageView> = {};
  const now = new Date();
  const month = monthKey(now);

  const [localRows, credentials] = await Promise.all([
    getDb().select().from(providerUsage),
    resolveCredentials(),
  ]);
  const localById = new Map(localRows.map((r) => [r.provider, r]));

  for (const d of PROVIDER_REGISTRY) {
    const secret = credentials.get(d.id);
    if (!d.configured(secret)) continue;
    let view: ProviderUsageView | null = null;

    const provider = d.create(secret);
    if (provider.getUsage) {
      const live = await provider.getUsage();
      if (live) view = { source: "provider", ...live };
    }

    if (!view) {
      const local = localById.get(d.id);
      if (local) {
        view = {
          source: "local",
          window: "month",
          used: local.month === month ? local.callsMonth : 0,
          limit: null,
        };
      }
    }

    if (view) out[d.id] = view;
  }

  usageCache = { at: Date.now(), data: out };
  return out;
}
