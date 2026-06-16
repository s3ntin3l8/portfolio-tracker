import {
  AntamProvider,
  EodhdProvider,
  FixtureProvider,
  GoldApiProvider,
  MarketDataService,
  NavProvider,
  OpenFigiProvider,
  TwelveDataProvider,
  YahooFinanceProvider,
  type MarketDataProvider,
} from "@portfolio/market-data";
import { providerSettings, type ProviderSetting } from "@portfolio/db";
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
}

// Registration order matches the historical hardcoded chain: keyed primaries first,
// keyless Yahoo fallback last. Keys/urls still come from env (see #106).
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
    configured: () => Boolean(process.env.ANTAM_BUYBACK_URL),
    create: () => new AntamProvider({ baseUrl: process.env.ANTAM_BUYBACK_URL! }),
  },
  {
    id: "nav",
    label: "Reksa Dana NAV",
    defaultPriority: 4,
    configured: () => Boolean(process.env.NAV_BASE_URL),
    create: () => new NavProvider({ baseUrl: process.env.NAV_BASE_URL! }),
  },
  {
    id: "eodhd",
    label: "EODHD",
    defaultPriority: 5,
    configured: () => Boolean(process.env.EODHD_API_KEY),
    create: () => new EodhdProvider({ apiKey: process.env.EODHD_API_KEY! }),
  },
  {
    id: "yahoo",
    label: "Yahoo Finance",
    defaultPriority: 6,
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
  service = new MarketDataService(providers);
  return service;
}

/** Drop the cached service so the next `getMarketData()` rebuilds from current settings. */
export function invalidateMarketData(): void {
  service = null;
}
