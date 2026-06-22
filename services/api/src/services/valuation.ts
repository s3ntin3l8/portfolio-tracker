import { eq, inArray } from "drizzle-orm";
import { corporateActions, instruments, transactions } from "@portfolio/db";
import {
  summarizePortfolio,
  type CoreTransaction,
  type CorporateAction,
  type CostBasisMode,
  type PortfolioSummary,
} from "@portfolio/core";
import type { InstrumentRef, MarketDataService } from "@portfolio/market-data";
import type { DB } from "../db/client.js";
import { getCachedQuotes } from "./price-cache.js";
import { getFxRates, makeFxRateFn } from "./fx.js";

/** Presentation metadata so the web app renders names without a second round-trip. */
export interface InstrumentMeta {
  symbol: string;
  name: string;
  assetClass: string;
  unit: string;
  /** Exchange/venue code (IDX, XETRA, XAU, …). Used for region breakdown in allocation analytics. */
  market: string;
  /** GICS-style sector populated by the refresh-instrument-metadata job; null until enriched. */
  sector: string | null;
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
): Promise<Valuation> {
  const rows = await db
    .select()
    .from(transactions)
    .where(eq(transactions.portfolioId, portfolioId));

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
      { symbol: i.symbol, name: i.name, assetClass: i.assetClass, unit: i.unit, market: i.market, sector: i.sector ?? null },
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
  const prices = await getCachedQuotes(db, marketData, refs, ttlMs);

  // Bonds without a live market price are valued at par (face value) — the v1
  // default; tradable ORI/SR market prices can override via a provider later.
  for (const i of instrumentRows) {
    if (i.assetClass === "bond" && i.faceValue && !prices[i.id]) {
      prices[i.id] = { price: i.faceValue, currency: i.currency };
    }
  }

  const coreTxns: CoreTransaction[] = rows.map((r) => ({
    instrumentId: r.instrumentId,
    type: r.type,
    quantity: r.quantity,
    price: r.price,
    fees: r.fees,
    currency: r.currency,
    executedAt: r.executedAt,
    loanId: r.loanId,
    kind: r.kind,
    tax: r.tax,
    savingsPlanId: r.savingsPlanId,
  }));

  // Resolve FX so holdings/cash in other currencies convert to the display currency
  // (no-op when everything is already in displayCurrency).
  const currencies = new Set<string>();
  for (const p of Object.values(prices)) currencies.add(p.currency);
  for (const r of rows) currencies.add(r.currency);
  const rates = await getFxRates(db, [...currencies], displayCurrency);
  const fx = makeFxRateFn(rates, displayCurrency);

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
  return { coreTxns, summary, metaById, prices };
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
