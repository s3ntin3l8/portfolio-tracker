import { and, eq, inArray } from "drizzle-orm";
import { fxRates } from "@portfolio/db";
import type { FxRateFn } from "@portfolio/core";
import type { DB } from "../db/client.js";

/** Live FX source: returns the rate to convert 1 `from` into `to`, or null. */
export interface FxProvider {
  getRate(from: string, to: string): Promise<number | null>;
}

/**
 * exchangerate.host-style FX provider: GET <baseUrl>?base=<from>&symbols=<to>
 * → { rates: { <to>: rate } }. Configured via env; absent in tests.
 */
export class HttpFxProvider implements FxProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly doFetch: typeof fetch = globalThis.fetch,
  ) {}

  async getRate(from: string, to: string): Promise<number | null> {
    try {
      const url = `${this.baseUrl}?base=${encodeURIComponent(from)}&symbols=${encodeURIComponent(to)}`;
      const res = await this.doFetch(url);
      if (!res.ok) return null;
      const data = (await res.json()) as { rates?: Record<string, number> };
      const rate = data.rates?.[to];
      return typeof rate === "number" && Number.isFinite(rate) ? rate : null;
    } catch {
      return null;
    }
  }
}

let provider: FxProvider | null | undefined;

/** The configured FX provider, or null when FX_BASE_URL is unset (tests/local). */
export function getFxProvider(): FxProvider | null {
  if (provider === undefined) {
    provider = process.env.FX_BASE_URL
      ? new HttpFxProvider(process.env.FX_BASE_URL)
      : null;
  }
  return provider;
}

/**
 * Read-through FX cache: returns each foreign currency's rate to `base`, served
 * from today's fx_rates rows and back-filled live via the provider. Currencies
 * without a rate are simply omitted (callers fall back to 1:1).
 */
export async function getFxRates(
  db: DB,
  currencies: string[],
  base: string,
  now: Date = new Date(),
  fxProvider: FxProvider | null = getFxProvider(),
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const foreign = [...new Set(currencies)].filter((c) => c && c !== base);
  if (foreign.length === 0) return out;

  const today = now.toISOString().slice(0, 10);
  const cached = await db
    .select()
    .from(fxRates)
    .where(
      and(
        eq(fxRates.quote, base),
        eq(fxRates.date, today),
        inArray(fxRates.base, foreign),
      ),
    );
  for (const r of cached) out[r.base] = r.rate;

  const missing = foreign.filter((c) => !(c in out));
  if (missing.length > 0 && fxProvider) {
    for (const from of missing) {
      const rate = await fxProvider.getRate(from, base);
      if (rate === null) continue;
      out[from] = String(rate);
      await db
        .insert(fxRates)
        .values({ base: from, quote: base, rate: String(rate), date: today })
        .onConflictDoUpdate({
          target: [fxRates.base, fxRates.quote, fxRates.date],
          set: { rate: String(rate) },
        });
    }
  }
  return out;
}

/** Build a synchronous FxRateFn from a foreign→base rate map (for valuation). */
export function makeFxRateFn(
  rates: Record<string, string>,
  base: string,
): FxRateFn {
  return (from, to) => {
    if (from === to) return "1";
    if (to === base && rates[from]) return rates[from];
    return "1"; // unknown pair: leave unconverted rather than zero out value
  };
}
