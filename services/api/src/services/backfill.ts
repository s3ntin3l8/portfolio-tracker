/**
 * Backfill service: materialise historical price closes and per-day TWR components
 * (marketValue, effectiveFlow) into portfolio_snapshots from the portfolio's inception.
 *
 * Data sources by asset class:
 * - equity/etf/crypto: Yahoo getHistoryFrom(period1=firstHeld), fallback getHistory("max")
 * - gold (ANTAM/GALERI24): XAU-spot scaled to today's real buyback (proxy)
 * - gold (XAU): Yahoo getHistoryFrom
 * - bond: flat at faceValue
 * - mutual_fund: flat at today's latest price (NAV carried back)
 */
import { eq, inArray } from "drizzle-orm";
import { Decimal } from "decimal.js";
import {
  corporateActions,
  dividendEvents,
  instruments,
  portfolios,
  portfolioSnapshots,
  prices,
  scrapedQuotes,
  transactions,
} from "@portfolio/db";
import {
  buildDailyValueFlows,
  cashBalances,
  computeHoldings,
  netWorth,
  splitAdjustmentFactor,
  type PriceSeriesKind,
  type TransactionType,
} from "@portfolio/core";
import type { InstrumentRef, MarketDataService } from "@portfolio/market-data";
import type { DB } from "../db/client.js";
import { getFxRatesForDates, makeFxRateFn } from "./fx.js";

export interface BackfillOptions {
  /** Only recompute snapshots on or after this date (ISO YYYY-MM-DD). */
  fromDate?: string;
}

export interface BackfillResult {
  instruments: number;
  days: number;
  truncated: string[]; // instrument IDs whose history was truncated
}

/**
 * Backfill the price history and TWR snapshots for a single portfolio.
 * Safe to re-run: prices are upserted (raw close stored, adjusted at read-time);
 * portfolio_snapshots rows are upserted by (portfolioId, date).
 */
export async function backfillPortfolioHistory(
  db: DB,
  marketData: MarketDataService,
  _ttlMs: number,
  portfolioId: string,
  opts: BackfillOptions = {},
): Promise<BackfillResult> {
  // ── Load transactions ──────────────────────────────────────────────────────
  const txRows = await db
    .select()
    .from(transactions)
    .where(eq(transactions.portfolioId, portfolioId));

  if (txRows.length === 0) return { instruments: 0, days: 0, truncated: [] };

  // Cash is part of historical net worth only when inside this portfolio's boundary.
  const [pf] = await db
    .select({ cashCounted: portfolios.cashCounted })
    .from(portfolios)
    .where(eq(portfolios.id, portfolioId))
    .limit(1);
  const cashCounted = pf?.cashCounted ?? true;

  // Inception = earliest transaction date, unless fromDate narrows it.
  const inceptionMs = Math.min(...txRows.map((r) => r.executedAt.getTime()));
  const inceptionDate = new Date(inceptionMs).toISOString().slice(0, 10);
  const startDate = opts.fromDate && opts.fromDate > inceptionDate ? opts.fromDate : inceptionDate;
  const today = new Date().toISOString().slice(0, 10);

  if (startDate > today) return { instruments: 0, days: 0, truncated: [] };

  // ── Load instruments + corporate actions ───────────────────────────────────
  const instrIds = [
    ...new Set(txRows.map((r) => r.instrumentId).filter((x): x is string => x !== null)),
  ];
  const instrRows = instrIds.length
    ? await db.select().from(instruments).where(inArray(instruments.id, instrIds))
    : [];
  const instrById = new Map(instrRows.map((i) => [i.id, i]));

  const caRows = instrIds.length
    ? await db.select().from(corporateActions).where(inArray(corporateActions.instrumentId, instrIds))
    : [];
  const coreCas = caRows.map((r) => ({
    instrumentId: r.instrumentId,
    type: r.type as "split" | "bonus" | "rights",
    ratio: r.ratio,
    exDate: new Date(r.exDate),
  }));

  // ── Fetch and materialise price history ────────────────────────────────────
  const truncated: string[] = [];
  // rawPrices[instrumentId][date] = { close, currency }
  const rawPrices = new Map<string, Map<string, { close: string; currency: string }>>();

  // Get today's gold buyback (keyed by market name lowercase)
  const goldBuybackByMarket = new Map<string, string>();
  const buybackRows = await db
    .select()
    .from(scrapedQuotes)
    .where(
      inArray(scrapedQuotes.key, ["gold:antam-buyback", "gold:galeri24-buyback"]),
    );
  for (const r of buybackRows) {
    const market = r.key.replace("gold:", "").replace("-buyback", "").toUpperCase();
    goldBuybackByMarket.set(market, r.value);
  }

  // Fetch XAU spot history once (shared by all gold proxies)
  let xauSpotHistory: Map<string, string> | null = null;

  // Find XAU spot instrument if any gold buyback instruments are held
  const goldBuybackInstrs = instrRows.filter(
    (i) => i.assetClass === "gold" && (i.market === "ANTAM" || i.market === "GALERI24"),
  );

  if (goldBuybackInstrs.length > 0) {
    // Use the instrument's currency for XAU pair (XAUIDR, XAUEUR, etc.)
    const goldCurrency = goldBuybackInstrs[0]!.currency;
    const xauRef: InstrumentRef = {
      symbol: `XAU${goldCurrency}`,
      market: "XAU",
      assetClass: "gold",
      currency: goldCurrency,
    };
    const xauCandles = await marketData.getHistoryFrom(xauRef, startDate).catch(() => []);
    if (xauCandles.length > 0) {
      xauSpotHistory = new Map(xauCandles.map((c) => [c.date, c.close]));
    }
  }

  for (const instr of instrRows) {
    const firstHeld = txRows
      .filter((r) => r.instrumentId === instr.id)
      .reduce(
        (min, r) => (r.executedAt < min ? r.executedAt : min),
        txRows[0]!.executedAt,
      );
    const firstHeldDate = firstHeld.toISOString().slice(0, 10);
    const fetchFrom = firstHeldDate < startDate ? startDate : firstHeldDate;

    const instrPrices = new Map<string, { close: string; currency: string }>();
    rawPrices.set(instr.id, instrPrices);

    if (instr.assetClass === "bond") {
      // Flat at face value — generate a close for every day in range
      if (instr.faceValue) {
        const d = new Date(fetchFrom);
        const end = new Date(today);
        while (d <= end) {
          const ds = d.toISOString().slice(0, 10);
          instrPrices.set(ds, { close: instr.faceValue, currency: instr.currency });
          d.setUTCDate(d.getUTCDate() + 1);
        }
      }
      continue;
    }

    if (instr.assetClass === "mutual_fund") {
      // NAV: carry today's price back flat (no real history)
      // We'll fill it from scrapedQuotes or leave empty; daily job fills forward.
      const navRow = await db
        .select()
        .from(scrapedQuotes)
        .where(eq(scrapedQuotes.key, `nav:${instr.symbol}`))
        .limit(1);
      if (navRow[0]) {
        const nav = navRow[0].value;
        const d = new Date(fetchFrom);
        const end = new Date(today);
        while (d <= end) {
          const ds = d.toISOString().slice(0, 10);
          instrPrices.set(ds, { close: nav, currency: instr.currency });
          d.setUTCDate(d.getUTCDate() + 1);
        }
      }
      continue;
    }

    if (instr.assetClass === "gold" && (instr.market === "ANTAM" || instr.market === "GALERI24")) {
      // Proxy: XAU-spot scaled to today's real buyback
      const todayBuyback = goldBuybackByMarket.get(instr.market);
      if (!todayBuyback || !xauSpotHistory) continue;

      // k = todayBuyback / todaySpot; proxyClose(d) = k * xauSpot(d)
      // Find today's spot price (use nearest available date)
      const todaySpot = xauSpotHistory.get(today);
      if (!todaySpot || Number(todaySpot) === 0) continue;

      const k = new Decimal(todayBuyback).div(new Decimal(todaySpot));
      for (const [date, spot] of xauSpotHistory) {
        if (date < fetchFrom) continue;
        const proxyClose = k.mul(new Decimal(spot)).toString();
        instrPrices.set(date, { close: proxyClose, currency: instr.currency });
      }
      continue;
    }

    // Exchange-listed: equity, etf, crypto, gold (XAU spot), derivative
    const ref: InstrumentRef = {
      symbol: instr.symbol,
      market: instr.market,
      assetClass: instr.assetClass as InstrumentRef["assetClass"],
      currency: instr.currency,
      isin: instr.isin ?? undefined,
    };

    let candles = await marketData.getHistoryFrom(ref, fetchFrom).catch(() => []);
    if (candles.length === 0) {
      candles = await marketData.getHistory(ref, "max").catch(() => []);
    }

    if (candles.length > 0) {
      const earliest = candles[0]!.date;
      if (earliest > firstHeldDate) {
        truncated.push(instr.id);
      }
      for (const c of candles) {
        if (c.date >= fetchFrom) {
          instrPrices.set(c.date, { close: c.close, currency: instr.currency });
        }
      }
    }
  }

  // ── One-time deep dividend pull (removes 2-year cap for ex-date alignment) ─
  if (instrIds.length > 0) {
    try {
      // refreshDividends uses a ~2-year rolling window on held instruments.
      // Running it here ensures dividend_events are up-to-date for ex-date alignment.
      const { refreshDividends } = await import("./dividends.js");
      await refreshDividends(db, marketData, new Date());
    } catch {
      // non-fatal: falls back to pay-date for unmatched txns
    }
  }

  // Load updated dividend_events for ex-date mapping
  const divEventRows = instrIds.length
    ? await db.select().from(dividendEvents).where(inArray(dividendEvents.instrumentId, instrIds))
    : [];
  // Map: instrumentId → list of { exDate, payDate, amountPerShare }
  const divEventsByInstr = new Map<string, { exDate: string; payDate: string | null; amountPerShare: string }[]>();
  for (const row of divEventRows) {
    const list = divEventsByInstr.get(row.instrumentId) ?? [];
    list.push({ exDate: row.exDate, payDate: row.payDate ?? null, amountPerShare: row.amountPerShare });
    divEventsByInstr.set(row.instrumentId, list);
  }

  // flowDateOf: maps dividend/coupon txns to their ex-date for accurate netting
  function flowDateOf(tx: { instrumentId: string | null; type: string; price: string; executedAt: Date }): string {
    const payDate = tx.executedAt.toISOString().slice(0, 10);
    if ((tx.type === "dividend" || tx.type === "coupon") && tx.instrumentId) {
      const events = divEventsByInstr.get(tx.instrumentId) ?? [];
      // Match by nearest payDate ≈ executedAt (within 7 days), then by amountPerShare
      const payMs = tx.executedAt.getTime();
      let bestMatch: { exDate: string } | null = null;
      let bestDelta = Infinity;
      for (const ev of events) {
        if (ev.payDate) {
          const delta = Math.abs(new Date(ev.payDate).getTime() - payMs);
          if (delta < bestDelta && delta < 7 * 86_400_000) {
            bestDelta = delta;
            bestMatch = ev;
          }
        }
        if (!bestMatch && ev.amountPerShare === tx.price) {
          bestMatch = ev;
        }
      }
      if (bestMatch) return bestMatch.exDate;
    }
    return payDate;
  }

  // ── Persist raw closes to prices table ────────────────────────────────────
  for (const [instrId, dateMap] of rawPrices) {
    for (const [date, { close, currency }] of dateMap) {
      await db
        .insert(prices)
        .values({ instrumentId: instrId, date, close, currency })
        .onConflictDoUpdate({
          target: [prices.instrumentId, prices.date],
          set: { close, currency },
        });
    }
  }

  // ── Build date grid from startDate to today ────────────────────────────────
  const dateGrid: string[] = [];
  const d = new Date(startDate);
  const endDate = new Date(today);
  while (d <= endDate) {
    dateGrid.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }

  // ── FX rates for all dates ─────────────────────────────────────────────────
  // Collect all currencies needed
  const allCurrencies = [...new Set(instrRows.map((i) => i.currency))];
  const txCurrencies = [...new Set(txRows.map((r) => r.currency))];
  const allCcys = [...new Set([...allCurrencies, ...txCurrencies])];

  // Get the portfolio's base currency
  const [pfRow] = await db
    .select({ baseCurrency: (await import("@portfolio/db")).portfolios.baseCurrency })
    .from((await import("@portfolio/db")).portfolios)
    .where(eq((await import("@portfolio/db")).portfolios.id, portfolioId))
    .limit(1);
  const baseCurrency = pfRow?.baseCurrency ?? "IDR";

  const fxByDate = await getFxRatesForDates(db, allCcys, baseCurrency, dateGrid);

  // ── Build priceAt and kindOf ───────────────────────────────────────────────
  function kindOf(instrId: string): PriceSeriesKind {
    const instr = instrById.get(instrId);
    if (!instr) return "none";
    if (instr.assetClass === "bond" || instr.assetClass === "mutual_fund") return "flatProxy";
    return "realSeries";
  }

  function priceAt(instrId: string, date: string): { close: string; currency: string } | null {
    const dateMap = rawPrices.get(instrId);
    if (!dateMap) return null;
    // Direct match
    const exact = dateMap.get(date);
    if (exact) {
      // Apply split adjustment
      const factor = splitAdjustmentFactor(coreCas, instrId, date);
      if (factor.isZero() || factor.isNaN()) return exact;
      return { close: new Decimal(exact.close).div(factor).toString(), currency: exact.currency };
    }
    // Carry-forward: find the most recent price on or before this date
    const instr = instrById.get(instrId);
    if (instr?.assetClass === "bond" || instr?.assetClass === "mutual_fund") {
      // For flat proxies, carry forward; find dates before this
      let bestDate = "";
      for (const [pd] of dateMap) {
        if (pd <= date && pd > bestDate) bestDate = pd;
      }
      if (bestDate) {
        const p = dateMap.get(bestDate)!;
        return { close: p.close, currency: p.currency };
      }
    }
    return null;
  }

  function fxAt(date: string) {
    return makeFxRateFn(fxByDate.get(date) ?? {}, baseCurrency);
  }

  // ── Build CoreTransactions for core ───────────────────────────────────────
  const coreTxns = txRows.map((r) => ({
    instrumentId: r.instrumentId,
    type: r.type as TransactionType,
    quantity: r.quantity,
    price: r.price,
    fees: r.fees,
    currency: r.currency,
    executedAt: r.executedAt,
    loanId: r.loanId,
  }));

  // ── Compute per-day value flows ────────────────────────────────────────────
  const dailyFlows = buildDailyValueFlows({
    transactions: coreTxns,
    corporateActions: coreCas,
    dates: dateGrid,
    priceAt,
    fxAt,
    baseCurrency,
    kindOf,
    flowDateOf: (tx) => flowDateOf(tx),
  });

  // ── Build prices lookup for netWorth computation ───────────────────────────
  // For each date, compute netWorth (holdings MV + cash, in baseCurrency)
  // Use the same prices map for the holdings valuation

  // ── Upsert portfolio_snapshots ────────────────────────────────────────────
  let count = 0;
  for (const flow of dailyFlows) {
    // Compute netWorth for this date: holdings MV + cash balances at this date
    const asOf = new Date(`${flow.date}T23:59:59.999Z`);
    const holdingsAtDate = computeHoldings(coreTxns, coreCas, asOf);
    const pricesForDate: Record<string, { price: string; currency: string }> = {};
    for (const h of holdingsAtDate) {
      const p = priceAt(h.instrumentId, flow.date);
      if (p) pricesForDate[h.instrumentId] = { price: p.close, currency: p.currency };
    }
    const cash = cashCounted
      ? cashBalances(coreTxns.filter((t) => t.executedAt <= asOf))
      : {};
    const fx = fxAt(flow.date);
    const nw = netWorth({
      holdings: holdingsAtDate,
      prices: pricesForDate,
      cash,
      displayCurrency: baseCurrency,
      fx,
    });

    await db
      .insert(portfolioSnapshots)
      .values({
        portfolioId,
        date: flow.date,
        netWorth: nw,
        marketValue: flow.marketValue,
        effectiveFlow: flow.effectiveFlow,
        currency: baseCurrency,
      })
      .onConflictDoUpdate({
        target: [portfolioSnapshots.portfolioId, portfolioSnapshots.date],
        set: {
          netWorth: nw,
          marketValue: flow.marketValue,
          effectiveFlow: flow.effectiveFlow,
          currency: baseCurrency,
        },
      });
    count++;
  }

  return { instruments: instrRows.length, days: count, truncated };
}
