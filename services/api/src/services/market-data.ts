import {
  BuybackProvider,
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
import { providerSettings, providerUsage, type ProviderSetting } from "@portfolio/db";
import { eq } from "drizzle-orm";
import { getDb } from "../db/client.js";

/**
 * A routable price provider, gated by an env key/url. The registry is the single source
 * of truth for both instantiation (here) and the admin UI (GET/PATCH /admin/providers).
 * `OpenFigi` (discovery-only) and `Fixture` (catch-all) are intentionally NOT here — they
 * are appended unconditionally and aren't user-configurable.
 */
export interface ProviderDescriptor {
  id: string;
  label: string;
  /** Tried-first ordering when there is no DB override (registration order). */
  defaultPriority: number;
  /** Whether the env key/url that this provider needs is present. */
  configured: () => boolean;
  /** Instantiate the provider. Only called when `configured()` is true. */
  create: () => MarketDataProvider;
  /**
   * The `market` constant this provider serves as a *user-selectable gold buyback source*
   * (e.g. `"ANTAM"`). Set only on providers that price physical/savings gold holdings, so
   * the manual-entry form can offer them in a source picker (see {@link goldSources}). Spot
   * (XAU) is the live ticker, not a holding source, so the spot providers stay unset.
   */
  goldMarket?: string;
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
// keyless Yahoo fallback last. Keys/urls still come from env (see #106); the scraped
// Antam/NAV sources default to this API's internal routes (see selfBaseUrl).
export const PROVIDER_REGISTRY: ProviderDescriptor[] = [
  {
    id: "twelvedata",
    label: "Twelve Data",
    defaultPriority: 1,
    configured: () => Boolean(process.env.TWELVEDATA_API_KEY),
    create: () => new TwelveDataProvider(process.env.TWELVEDATA_API_KEY!),
  },
  {
    id: "goldapi",
    label: "GoldAPI",
    defaultPriority: 2,
    configured: () => Boolean(process.env.GOLDAPI_KEY),
    create: () => new GoldApiProvider(process.env.GOLDAPI_KEY!),
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
    create: () =>
      new BuybackProvider({
        name: "antam",
        market: "ANTAM",
        baseUrl: process.env.ANTAM_BUYBACK_URL ?? `${selfBaseUrl()}/internal/gold/antam-buyback`,
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
    create: () =>
      new BuybackProvider({
        name: "galeri24",
        market: "GALERI24",
        baseUrl:
          process.env.GALERI24_BUYBACK_URL ?? `${selfBaseUrl()}/internal/gold/galeri24-buyback`,
      }),
  },
  {
    id: "nav",
    label: "Reksa Dana NAV",
    defaultPriority: 5,
    // Always available: defaults to the internal route fed by the Bibit NAV scraper.
    configured: () => true,
    create: () =>
      new NavProvider({
        baseUrl: process.env.NAV_BASE_URL ?? `${selfBaseUrl()}/internal/nav`,
      }),
  },
  {
    id: "eodhd",
    label: "EODHD",
    defaultPriority: 6,
    configured: () => Boolean(process.env.EODHD_API_KEY),
    create: () => new EodhdProvider({ apiKey: process.env.EODHD_API_KEY! }),
  },
  {
    id: "yahoo",
    label: "Yahoo Finance",
    defaultPriority: 7,
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
 * "use the default" (enabled, registration priority). Pure — no env or network — so the
 * merge is unit-testable independently of provider instantiation.
 */
export function resolveProviderConfig(
  rows: Pick<ProviderSetting, "provider" | "enabled" | "priority">[],
  registry: ProviderDescriptor[] = PROVIDER_REGISTRY,
): ResolvedProvider[] {
  const byId = new Map(rows.map((r) => [r.provider, r]));
  return registry
    .map((d) => {
      const row = byId.get(d.id);
      return {
        id: d.id,
        label: d.label,
        configured: d.configured(),
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
): GoldSource[] {
  const goldMarketById = new Map(
    registry.filter((d) => d.goldMarket).map((d) => [d.id, d.goldMarket!]),
  );
  return resolveProviderConfig(rows, registry)
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
 * The app's market-data service. Live providers come from the registry, ordered and
 * enabled per the DB `provider_settings` overlay (admins edit these from the UI), with
 * always-on OpenFigi discovery + a FixtureProvider catch-all. The service tries supporting
 * providers in order until one returns a result. The built service is cached;
 * `invalidateMarketData()` drops the cache so a settings change is picked up on the next
 * call (every caller invokes this per request/job — see #105 for multi-replica reload).
 * Tests use the fixture only (deterministic, no network).
 */
export async function getMarketData(): Promise<MarketDataService> {
  if (service) return service;
  const providers: MarketDataProvider[] = [];
  if (process.env.NODE_ENV !== "test") {
    const rows = await getDb()
      .select({
        provider: providerSettings.provider,
        enabled: providerSettings.enabled,
        priority: providerSettings.priority,
      })
      .from(providerSettings);
    const byId = new Map(PROVIDER_REGISTRY.map((d) => [d.id, d]));
    for (const r of resolveProviderConfig(rows)) {
      if (!r.enabled || !r.configured) continue;
      providers.push(byId.get(r.id)!.create());
    }
    // ISIN → instrument discovery (keyless; OPENFIGI_API_KEY raises the rate limit).
    providers.push(new OpenFigiProvider({ apiKey: process.env.OPENFIGI_API_KEY }));
  }
  providers.push(new FixtureProvider());
  service = new MarketDataService(providers, { onCall: recordCall });
  return service;
}

/** Drop the cached service so the next `getMarketData()` rebuilds from current settings. */
export function invalidateMarketData(): void {
  service = null;
  usageCache = null;
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

  const localRows = await getDb().select().from(providerUsage);
  const localById = new Map(localRows.map((r) => [r.provider, r]));

  for (const d of PROVIDER_REGISTRY) {
    if (!d.configured()) continue;
    let view: ProviderUsageView | null = null;

    const provider = d.create();
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
