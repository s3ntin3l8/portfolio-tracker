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

let service: MarketDataService | null = null;

/**
 * The app's market-data service. Live providers are registered from env keys
 * (Twelve Data for IDX/US + gold, GoldAPI for gold, EODHD for EU/Xetra), with a
 * keyless Yahoo Finance fallback for IDX + EU equities/ETFs, all routed ahead of
 * the always-available FixtureProvider. The service tries supporting providers in
 * order until one returns a result, so Yahoo covers Xetra if EODHD is absent.
 * Tests use the fixture only (deterministic, no network).
 */
export function getMarketData(): MarketDataService {
  if (!service) {
    const providers: MarketDataProvider[] = [];
    if (process.env.NODE_ENV !== "test") {
      if (process.env.TWELVEDATA_API_KEY) {
        providers.push(new TwelveDataProvider(process.env.TWELVEDATA_API_KEY));
      }
      if (process.env.GOLDAPI_KEY) {
        providers.push(new GoldApiProvider(process.env.GOLDAPI_KEY));
      }
      // Gold buyback (Antam/Pegadaian) for holdings valuation, and reksa-dana NAV —
      // unofficial sources, enabled by pointing at a configured endpoint.
      if (process.env.ANTAM_BUYBACK_URL) {
        providers.push(new AntamProvider({ baseUrl: process.env.ANTAM_BUYBACK_URL }));
      }
      if (process.env.NAV_BASE_URL) {
        providers.push(new NavProvider({ baseUrl: process.env.NAV_BASE_URL }));
      }
      // Keyed EU/Xetra equity/ETF primary (Trade Republic instruments) — ahead of the
      // keyless Yahoo fallback, which also covers Xetra if EODHD is absent.
      if (process.env.EODHD_API_KEY) {
        providers.push(new EodhdProvider({ apiKey: process.env.EODHD_API_KEY }));
      }
      // Keyless equity/ETF fallback (IDX + EU) — no signup, unofficial endpoint.
      providers.push(new YahooFinanceProvider());
      // ISIN → instrument discovery (keyless; OPENFIGI_API_KEY raises the rate limit).
      providers.push(new OpenFigiProvider({ apiKey: process.env.OPENFIGI_API_KEY }));
    }
    providers.push(new FixtureProvider());
    service = new MarketDataService(providers);
  }
  return service;
}
