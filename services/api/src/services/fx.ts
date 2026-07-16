import { and, eq, inArray, lte } from "drizzle-orm";
import { Decimal } from "decimal.js";
import { fxRates } from "@portfolio/db";
import type { FxRateFn } from "@portfolio/core";
import type { DB } from "../db/client.js";

/** Live FX source: returns the rate to convert 1 `from` into `to`, or null. */
export interface FxProvider {
  getRate(from: string, to: string): Promise<number | null>;
  /**
   * Optional: daily rates to convert 1 `from` into `to` across [start, end]
   * (inclusive, YYYY-MM-DD), keyed by date. Used to backfill historical FX.
   */
  getRateHistory?(
    from: string,
    to: string,
    start: string,
    end: string,
  ): Promise<Record<string, number>>;
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

/**
 * Frankfurter (api.frankfurter.dev) — a free, key-less FX source backed by ECB
 * reference rates, with current and historical daily series (a whole date range in
 * one request). `GET /rates?base=<from>&quotes=<to>[&from=&to=]` →
 * `[{ date, base, quote, rate }, ...]`.
 */
export class FrankfurterFxProvider implements FxProvider {
  constructor(
    private readonly baseUrl = "https://api.frankfurter.dev/v2",
    private readonly doFetch: typeof fetch = globalThis.fetch,
  ) {}

  async getRate(from: string, to: string): Promise<number | null> {
    try {
      const url = `${this.baseUrl}/rates?base=${encodeURIComponent(from)}&quotes=${encodeURIComponent(to)}`;
      const res = await this.doFetch(url);
      if (!res.ok) return null;
      const data = (await res.json()) as { rate?: number }[];
      const rate = data?.[0]?.rate;
      return typeof rate === "number" && Number.isFinite(rate) ? rate : null;
    } catch {
      return null;
    }
  }

  async getRateHistory(
    from: string,
    to: string,
    start: string,
    end: string,
  ): Promise<Record<string, number>> {
    try {
      const url = `${this.baseUrl}/rates?from=${start}&to=${end}&base=${encodeURIComponent(from)}&quotes=${encodeURIComponent(to)}`;
      const res = await this.doFetch(url);
      if (!res.ok) return {};
      const data = (await res.json()) as { date?: string; rate?: number }[];
      const out: Record<string, number> = {};
      for (const row of data ?? []) {
        if (row.date && typeof row.rate === "number" && Number.isFinite(row.rate)) {
          out[row.date] = row.rate;
        }
      }
      return out;
    } catch {
      return {};
    }
  }
}

let provider: FxProvider | null | undefined;

/**
 * The configured FX provider. A custom `FX_BASE_URL` selects the keyed
 * exchangerate.host-style provider; otherwise we default to the key-less
 * Frankfurter source — except under test, where providers are injected explicitly
 * so the suite stays hermetic (no live network calls).
 */
export function getFxProvider(): FxProvider | null {
  if (provider === undefined) {
    if (process.env.FX_BASE_URL) {
      provider = new HttpFxProvider(process.env.FX_BASE_URL);
    } else if (process.env.NODE_ENV === "test") {
      provider = null;
    } else {
      provider = new FrankfurterFxProvider();
    }
  }
  return provider;
}

/** Stringify an FX rate without scientific notation (tiny rates → safe `numeric`). */
function fmtRate(rate: number): string {
  return new Decimal(rate).toFixed();
}

/** Cache one `(from → base, date)` rate, overwriting any existing row for that day. */
async function cacheFxRate(
  db: DB,
  from: string,
  base: string,
  rate: string,
  date: string,
): Promise<void> {
  await db
    .insert(fxRates)
    .values({ base: from, quote: base, rate, date })
    .onConflictDoUpdate({
      target: [fxRates.base, fxRates.quote, fxRates.date],
      set: { rate },
    });
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
    .where(and(eq(fxRates.quote, base), eq(fxRates.date, today), inArray(fxRates.base, foreign)));
  for (const r of cached) out[r.base] = r.rate;

  const missing = foreign.filter((c) => !(c in out));
  if (missing.length > 0 && fxProvider) {
    for (const from of missing) {
      const rate = await fxProvider.getRate(from, base);
      if (rate === null) continue;
      const str = fmtRate(rate);
      out[from] = str;
      await cacheFxRate(db, from, base, str, today);
    }
  }
  return out;
}

/**
 * Per-day foreign→`base` rates for a set of snapshot `dates`, so historical net-worth
 * converts each day at that day's rate (not today's). Served from `fx_rates`, with any
 * still-missing dates back-filled from the provider's historical series across the
 * range, then carried forward (and back, for leading gaps) to cover non-trading days.
 * Returns a `date → { foreign: rate }` map; currencies with no rate are omitted so the
 * caller falls back to 1:1 via {@link makeFxRateFn}.
 */
export async function getFxRatesForDates(
  db: DB,
  currencies: string[],
  base: string,
  dates: string[],
  fxProvider: FxProvider | null = getFxProvider(),
): Promise<Map<string, Record<string, string>>> {
  const wanted = [...new Set(dates)].sort();
  const result = new Map<string, Record<string, string>>(wanted.map((d) => [d, {}]));
  const foreign = [...new Set(currencies)].filter((c) => c && c !== base);
  if (foreign.length === 0 || wanted.length === 0) return result;

  const maxDate = wanted[wanted.length - 1];
  // `byCurrency[from]` = its known dated rates (cached rows + any back-filled ones),
  // including dates earlier than `wanted` so carry-forward has something to start from.
  const byCurrency = new Map<string, Map<string, string>>(
    foreign.map((c) => [c, new Map<string, string>()]),
  );
  const cached = await db
    .select()
    .from(fxRates)
    .where(
      and(eq(fxRates.quote, base), lte(fxRates.date, maxDate), inArray(fxRates.base, foreign)),
    );
  for (const r of cached) byCurrency.get(r.base)?.set(r.date, r.rate);

  // Back-fill any currency that lacks an exact rate for one of the wanted dates.
  // All missing currencies are fetched in parallel (was a serial for-loop) — the
  // Frankfurter API supports up to ~30 currencies per request, but to keep the
  // provider interface generic we fan out with Promise.all instead.
  if (fxProvider?.getRateHistory) {
    const minDate = wanted[0];
    const missing = foreign.filter((from) => {
      const known = byCurrency.get(from)!;
      return !wanted.every((d) => known.has(d));
    });
    const cacheOps: Promise<void>[] = [];
    await Promise.all(
      missing.map(async (from) => {
        const known = byCurrency.get(from)!;
        const history = await fxProvider.getRateHistory!(from, base, minDate, maxDate);
        for (const [date, rate] of Object.entries(history)) {
          const str = fmtRate(rate);
          known.set(date, str);
          cacheOps.push(cacheFxRate(db, from, base, str, date));
        }
      }),
    );
    await Promise.all(cacheOps);
  }

  for (const from of foreign) {
    const known = byCurrency.get(from)!;
    const knownDates = [...known.keys()].sort();
    if (knownDates.length === 0) continue;
    // Most recent rate on or before each wanted date (carry-forward); for dates before
    // the earliest known rate, carry the earliest one back.
    const earliest = known.get(knownDates[0])!;
    let i = 0;
    let last: string | undefined;
    for (const d of wanted) {
      while (i < knownDates.length && knownDates[i] <= d) {
        last = known.get(knownDates[i]);
        i++;
      }
      result.get(d)![from] = last ?? earliest;
    }
  }
  return result;
}

/** Build a synchronous FxRateFn from a foreign→base rate map (for valuation). */
export function makeFxRateFn(rates: Record<string, string>, base: string): FxRateFn {
  return (from, to) => {
    if (from === to) return "1";
    if (to === base && rates[from]) return rates[from];
    return "1"; // unknown pair: leave unconverted rather than zero out value
  };
}
