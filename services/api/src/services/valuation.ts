import { eq, inArray } from "drizzle-orm";
import { corporateActions, instruments, transactions } from "@portfolio/db";
import {
  summarizePortfolio,
  openLots,
  type CoreTransaction,
  type CorporateAction,
  type CostBasisMode,
  type PortfolioSummary,
} from "@portfolio/core";
import type { InstrumentRef, MarketDataService } from "@portfolio/market-data";
import type { DB } from "../db/client.js";
import { getCachedQuotes } from "./price-cache.js";
import { getFxRates, makeFxRateFn } from "./fx.js";
import { toCoreTxns } from "./tx-core.js";
import { logTiming } from "../lib/timing.js";
import type { FastifyBaseLogger } from "fastify";

/** Presentation metadata so the web app renders names without a second round-trip. */
export interface InstrumentMeta {
  symbol: string;
  name: string;
  /** Clean provider-resolved name (e.g. "Apple Inc."); null until enriched. UI prefers
   *  `displayName ?? name`. */
  displayName: string | null;
  assetClass: string;
  unit: string;
  /** Exchange/venue code (IDX, XETRA, XAU, …). Used for region breakdown in allocation analytics. */
  market: string;
  /** GICS-style sector populated by the refresh-instrument-metadata job; null until enriched. */
  sector: string | null;
  /**
   * Per-sector allocation weights for ETFs (GICS-style sector name → fraction 0–1).
   * Null for non-ETFs. Used for proportional sector look-through in allocationBreakdown.
   */
  sectorWeights: Record<string, number> | null;
  /**
   * Per-country allocation weights for ETFs (country name → fraction 0–1).
   * Null for non-ETFs. Used for proportional region look-through in allocationBreakdown.
   */
  countryWeights: Record<string, number> | null;
  /** Timestamp of last sector enrichment attempt; null = never attempted. */
  sectorCheckedAt: Date | null;
  /**
   * German Teilfreistellung rate for this instrument (InvStG §20 Abs. 9).
   * Non-null when an explicit per-instrument override is set; null = use asset-class default.
   */
  partialExemptionRate: string | null;
}

export interface Valuation {
  coreTxns: CoreTransaction[];
  summary: PortfolioSummary;
  metaById: Map<string, InstrumentMeta>;
  /** Latest price + currency keyed by instrument id (for open-position valuation). */
  prices: Record<string, { price: string; currency: string }>;
}

/**
 * Load a portfolio's transactions, price its instruments via market data, resolve FX,
 * and value it into a full summary expressed in `displayCurrency`. Shared by the
 * `/summary`, `/performance`, `/networth` routes and the daily snapshot job, so a
 * portfolio is valued the same way everywhere.
 */
export async function valuePortfolio(
  db: DB,
  marketData: MarketDataService,
  ttlMs: number,
  portfolioId: string,
  displayCurrency: string,
  costBasisMode?: CostBasisMode,
  cashCounted = true,
  _log?: FastifyBaseLogger,
): Promise<Valuation> {
  const t0 = performance.now();
  const rows = await db
    .select()
    .from(transactions)
    .where(eq(transactions.portfolioId, portfolioId));
  const tSql = performance.now();

  const instrumentIds = [
    ...new Set(
      rows.map((r) => r.instrumentId).filter((x): x is string => x !== null),
    ),
  ];
  const instrumentRows = instrumentIds.length
    ? await db
        .select()
        .from(instruments)
        .where(inArray(instruments.id, instrumentIds))
    : [];

  const metaById = new Map<string, InstrumentMeta>(
    instrumentRows.map((i) => [
      i.id,
      {
        symbol: i.symbol,
        name: i.name,
        displayName: i.displayName ?? null,
        assetClass: i.assetClass,
        unit: i.unit,
        market: i.market,
        sector: i.sector ?? null,
        sectorWeights: (i.sectorWeights as Record<string, number> | null) ?? null,
        countryWeights: (i.countryWeights as Record<string, number> | null) ?? null,
        sectorCheckedAt: i.sectorCheckedAt ? new Date(i.sectorCheckedAt) : null,
        partialExemptionRate: i.partialExemptionRate ?? null,
      },
    ]),
  );

  const refs = instrumentRows.map((i) => ({
    id: i.id,
    ref: {
      symbol: i.symbol,
      market: i.market,
      assetClass: i.assetClass,
      currency: i.currency,
      isin: i.isin ?? undefined,
    } satisfies InstrumentRef,
  }));
  const tCacheStart = performance.now();
  const prices = await getCachedQuotes(db, marketData, refs, ttlMs);
  const tPrices = performance.now();

  // Bonds without a live market price are valued at par (face value) — the v1
  // default; tradable ORI/SR market prices can override via a provider later.
  for (const i of instrumentRows) {
    if (i.assetClass === "bond" && i.faceValue && !prices[i.id]) {
      prices[i.id] = { price: i.faceValue, currency: i.currency };
    }
  }

  // Archived rows are excluded here so they never reach any core derivation.
  const coreTxns: CoreTransaction[] = toCoreTxns(rows);

  // Resolve FX so holdings/cash in other currencies convert to the display currency
  // (no-op when everything is already in displayCurrency).
  const currencies = new Set<string>();
  for (const p of Object.values(prices)) currencies.add(p.currency);
  for (const r of rows) currencies.add(r.currency);
  const tFxStart = performance.now();
  const rates = await getFxRates(db, [...currencies], displayCurrency);
  const fx = makeFxRateFn(rates, displayCurrency);
  const tFx = performance.now();

  const tCorpStart = performance.now();
  const cas = await corporateActionsForInstruments(db, instrumentIds);
  const summary = summarizePortfolio({
    transactions: coreTxns,
    corporateActions: cas,
    prices,
    displayCurrency,
    fx,
    costBasisMode,
    cashCounted,
  });

  // Attach standing open FIFO lots to each holding (instrument detail "Acquired / Qty /
  // Price / Cost" table). summarizePortfolio has no lot ledger of its own — openLots
  // replays the same transactions/corporate actions in a separate FIFO-only pass.
  const lotsByInstrument = openLots(coreTxns, cas);
  for (const h of summary.holdings) {
    h.lots = lotsByInstrument.get(h.instrumentId) ?? [];
  }
  const tEnd = performance.now();

  logTiming(undefined, "valuePortfolio", tEnd - t0, {
    portfolioId,
    displayCurrency,
    costBasisMode,
    cashCounted,
    transactionCount: rows.length,
    instrumentCount: instrumentIds.length,
    sqlMs: Math.round((tSql - t0) * 100) / 100,
    priceCacheMs: Math.round((tPrices - tCacheStart) * 100) / 100,
    fxMs: Math.round((tFx - tFxStart) * 100) / 100,
    corpActionsMs: Math.round((tCorpStart - tFx) * 100) / 100,
    computationMs: Math.round((tEnd - tFx) * 100) / 100,
  });

  return { coreTxns, summary, metaById, prices };
}

// In-process cache for valuePortfolio, for the read-serving routes (/summary,
// /performance, /networth, /portfolios/values) — NOT used by the daily/intraday
// snapshot job (services/snapshots.ts), which always calls `valuePortfolio` directly
// so its persisted record is a canonical, uncached computation.
//
// A portfolio's valuation replays every transaction + corporate action from scratch on
// every read (see valuePortfolio above), so a single page load's several endpoints
// (layout net worth, page holdings, page net worth, …) each pay that full cost even
// though most of them are asking for the exact same (portfolio, currency, cost basis,
// boundary) valuation. `transactions` has no `updatedAt` column, so there's no cheap
// version marker to key an always-correct cache on — extending the schema and auditing
// every one of the many transaction-mutating routes (imports, sync, corporate actions,
// reassign, merge, bulk ops, …) to bump it correctly is a much larger, riskier change
// than this perf pass warrants: a missed invalidation site would silently serve stale
// financial figures with no bound on how stale. A short, fixed TTL instead bounds
// staleness to a known, small window regardless of which write path touched the data —
// safe by construction, at the cost of up to DERIVATION_CACHE_TTL_MS of staleness after
// a write (accepted: the product decision here is "up to a minute stale is fine").
// Increased from 5s to 60s after baseline timing showed the full valuation takes
// ~1700ms — the 5s TTL was too short for tab-navigation patterns (by the time a user
// navigates Tab A → Tab B, the 5s had typically expired). 60s keeps tab hops fast
// while bounding write-staleness to at most one minute.
const DERIVATION_CACHE_TTL_MS = 60_000;
const derivationCache = new Map<string, { expiresAt: number; promise: Promise<Valuation> }>();

function derivationCacheKey(
  portfolioId: string,
  displayCurrency: string,
  costBasisMode: CostBasisMode | undefined,
  cashCounted: boolean,
): string {
  const mode = costBasisMode === undefined || costBasisMode === "purchase_price" ? "" : costBasisMode;
  return `${portfolioId}|${displayCurrency}|${mode}|${cashCounted}`;
}

/**
 * Cached wrapper around {@link valuePortfolio} — same signature, drop-in for read-serving
 * routes. Caches the in-flight *promise* (not just the resolved value), so concurrent
 * requests for the same (portfolio, currency, cost basis, boundary) within the TTL
 * window collapse onto one computation instead of each re-querying independently — the
 * same shape of win as `React.cache()` on the web side, but time-bounded rather than
 * request-scoped since this process serves many requests.
 */
export async function valuePortfolioCached(
  db: DB,
  marketData: MarketDataService,
  ttlMs: number,
  portfolioId: string,
  displayCurrency: string,
  costBasisMode?: CostBasisMode,
  cashCounted = true,
  /** Injectable clock for deterministic TTL tests (mirrors getCachedQuotes' `now` param) —
   *  defaults to the real clock in production. */
  now: number = Date.now(),
  _log?: FastifyBaseLogger,
): Promise<Valuation> {
  const key = derivationCacheKey(portfolioId, displayCurrency, costBasisMode, cashCounted);
  const hit = derivationCache.get(key);
  if (hit && hit.expiresAt > now) {
    logTiming(undefined, "valuePortfolioCached HIT", 0, { key, ttlRemaining: hit.expiresAt - now });
    return hit.promise;
  }
  logTiming(undefined, "valuePortfolioCached MISS", 0, { key });
  const promise = valuePortfolio(
    db,
    marketData,
    ttlMs,
    portfolioId,
    displayCurrency,
    costBasisMode,
    cashCounted,
    _log,
  );
  derivationCache.set(key, { expiresAt: now + DERIVATION_CACHE_TTL_MS, promise });
  // A failed computation must not poison the cache for the rest of the TTL window — drop
  // it immediately so the next call retries instead of re-throwing a stale error.
  promise.catch(() => {
    if (derivationCache.get(key)?.promise === promise) {
      derivationCache.delete(key);
    }
  });
  return promise;
}

/**
 * Drop every cached valuation. Called from a global `onResponse` hook (see app.ts)
 * after any write, since there's no cheap per-portfolio version marker to invalidate
 * precisely (see valuePortfolioCached's doc comment) — also used directly by tests to
 * reset cache state between cases.
 */
export function clearValuationCache(_log?: FastifyBaseLogger): void {
  const count = derivationCache.size;
  derivationCache.clear();
  logTiming(undefined, "clearValuationCache", 0, { entriesCleared: count });
}

/** Corporate actions for the given instruments, shaped for @portfolio/core. */
async function corporateActionsForInstruments(
  db: DB,
  instrumentIds: string[],
): Promise<CorporateAction[]> {
  if (instrumentIds.length === 0) return [];
  const rows = await db
    .select()
    .from(corporateActions)
    .where(inArray(corporateActions.instrumentId, instrumentIds));
  return rows.map((r) => ({
    instrumentId: r.instrumentId,
    type: r.type,
    ratio: r.ratio,
    exDate: new Date(r.exDate),
  }));
}
