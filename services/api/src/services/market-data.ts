import {
  FixtureProvider,
  GoldApiProvider,
  MarketDataService,
  TwelveDataProvider,
  YahooFinanceProvider,
  type MarketDataProvider,
} from "@portfolio/market-data";

let service: MarketDataService | null = null;

/**
 * The app's market-data service. Live providers are registered from env keys
 * (Twelve Data for IDX + gold, GoldAPI for gold), with a keyless Yahoo Finance
 * fallback for IDX equities/ETFs, all routed ahead of the always-available
 * FixtureProvider. The service tries supporting providers in order until one
 * returns a result, so Yahoo covers IDX if Twelve Data is absent or rate-limited.
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
      // Keyless IDX equity/ETF fallback — no signup, unofficial endpoint.
      providers.push(new YahooFinanceProvider());
    }
    providers.push(new FixtureProvider());
    service = new MarketDataService(providers);
  }
  return service;
}
