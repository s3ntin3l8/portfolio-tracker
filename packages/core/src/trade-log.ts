/**
 * Trade log — per-position round-trip "trades" with performance, dividends folded in.
 *
 * A **trade** is a round-trip *episode*: the lifecycle of a position from when its
 * quantity goes 0 → >0 until it returns to ~0 (fully closed). Re-buying after a full
 * close starts a NEW episode. Open positions are in-progress trades.
 *
 * Two cost-basis methods are derived from a SINGLE chronological pass:
 *   - "average" — running average cost (consistent with computeHoldings/the dashboard).
 *   - "fifo"    — oldest-lot-first matching (German-tax-correct).
 *
 * Invariant (relied on by callers + tests): over a FULLY-CLOSED episode the total
 * realized P&L is method-independent — every lot bought is sold, so Σproceeds − Σcost
 * is identical. The methods only diverge on (a) the tax-year attribution of partial
 * interim sells, (b) the cost basis of OPEN positions, and (c) per-lot holding period.
 *
 * Money fields on a Trade are in the DISPLAY currency; per-share prices (avgEntry/
 * avgExit) are in the instrument's own currency, mirroring the holdings table.
 *
 * Acquisition/disposal handling matches computeHoldings exactly (buy/savings_plan add,
 * sell removes; split/bonus corporate actions adjust open lots) so the trade log's
 * quantities and cost reconcile with the dashboard. costBasisMode capitalizes financing
 * (gold cicilan) into the OPEN episode's cost, same as summarizePortfolio.
 */
import { Decimal } from "decimal.js";
import { cashFlow } from "./cash.js";
import { financingByInstrument } from "./loans.js";
import { convert, type FxRateFn } from "./networth.js";
import { xirr, type CashFlowPoint } from "./xirr.js";
import type { CoreTransaction, CorporateAction } from "./types.js";
import type { CostBasisMode } from "./valuation.js";

const D = (v: string | number) => new Decimal(v);
const ZERO = new Decimal(0);
const MS_PER_DAY = 1000 * 60 * 60 * 24;
/** Default §23-EStG-style threshold: gold/other private-sale gains are tax-free after a 1-year hold. */
const LONG_TERM_DAYS = 365;
/** Quantity residual below which a position counts as fully closed (import rounding dust). */
const DEFAULT_DUST = "0.000001";

export type TradeMethod = "average" | "fifo";

/** A matched disposal slice — FIFO: one consumed lot; average: the whole sell at episode-entry. */
export interface TradeLeg {
  /** Acquisition date of the matched lot (FIFO) or the episode entry (average). */
  acqDate: string; // YYYY-MM-DD
  sellDate: string; // YYYY-MM-DD
  quantity: string;
  cost: string; // display currency
  proceeds: string; // display currency
  gain: string; // display currency
  holdingDays: number;
  longTerm: boolean;
  taxYear: number;
}

export interface Trade {
  instrumentId: string;
  /** Instrument currency — the unit for avgEntryPrice / avgExitPrice. */
  currency: string;
  status: "open" | "closed";
  entryDate: string; // YYYY-MM-DD
  exitDate: string | null; // YYYY-MM-DD, null while open
  holdingDays: number;
  /** Capital-weighted average holding period. Equals `holdingDays` for a single
   * lump-sum buy; shorter than `holdingDays` for savings plans because capital
   * deployed later was invested for less time. Used to reconcile annualized (XIRR)
   * with total return — `totalReturnPct / (avgHoldingDays / 365) ≈ annualizedPct`. */
  avgHoldingDays: number;
  longTerm: boolean;
  /** Open: current units held. Closed: total units acquired over the episode. */
  quantity: string;
  avgEntryPrice: string; // instrument currency, fees excluded
  avgExitPrice: string | null; // instrument currency, fees excluded
  invested: string; // display currency (cost deployed, fees + financing incl.)
  realizedPnL: string; // display currency, method-aware
  unrealizedPnL: string; // display currency (open portion; "0" when closed/unpriced)
  dividends: string; // display currency (instrument income within the holding window)
  totalReturn: string; // realized + unrealized + dividends, display currency
  totalReturnPct: number | null;
  annualizedPct: number | null; // XIRR over the episode's flows + terminal value
  legs: TradeLeg[];
}

export interface YearAmount {
  year: number;
  amount: string; // display currency
}

export interface YearTax {
  year: number;
  amount: string; // net income received, display currency
  tax: string; // withholding tax, display currency
}

export interface TradeLog {
  displayCurrency: string;
  method: TradeMethod;
  trades: Trade[];
  totalRealized: string;
  totalDividends: string;
  totalReturn: string;
  /** Fraction of closed trades with a positive total return (incl. dividends); null if none closed. */
  winRate: number | null;
  realizedByYear: YearAmount[]; // method-aware (from leg tax years)
  dividendsByYear: YearTax[]; // all income incl. instrument-less interest
  /** Broker-credited bonuses by year: bonus_cash (e.g. Kindergeld), saveback buy legs,
   * and transfer_in free-share receipts. Purely informational — NOT included in
   * totalReturn or totalDividends. Excludes roundup (user's own spare change). */
  bonusesByYear: YearAmount[];
}

export interface ComputeTradesInput {
  transactions: CoreTransaction[];
  corporateActions?: CorporateAction[];
  /** Latest price + currency keyed by instrument id (open-position valuation). */
  prices: Record<string, { price: string; currency: string }>;
  displayCurrency: string;
  fx?: FxRateFn;
  method?: TradeMethod; // default "average"
  costBasisMode?: CostBasisMode; // default "purchase_price"
  now?: Date;
  /** Quantity dust tolerance for episode closure. Default 1e-6. */
  dustEpsilon?: string;
  /** Instrument metadata (specifically assetClass) keyed by instrument id. */
  instruments?: Map<string, { assetClass: string }> | Record<string, { assetClass: string }>;
}

function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function daysBetween(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / MS_PER_DAY));
}

/** A FIFO lot: shares acquired together at a per-unit cost (fees included). */
interface Lot {
  acqDate: Date;
  qty: Decimal;
  unitCost: Decimal;
}

/** Mutable accumulators for the in-progress episode of one instrument. */
interface Episode {
  entryDate: Date;
  acqQtyPrice: Decimal; // Σ qty×price (fees excluded) — for avgEntryPrice
  acqQty: Decimal; // Σ acquired qty (restated to current-share terms by splits)
  acqCost: Decimal; // Σ qty×price + fees — invested
  sellQtyPrice: Decimal; // Σ sellqty×price — for avgExitPrice
  soldQty: Decimal;
  realized: Decimal; // method-aware, instrument currency
  legs: TradeLeg[];
  flows: CashFlowPoint[]; // for XIRR, display currency
}

function makeEpisode(at: Date): Episode {
  return {
    entryDate: at,
    acqQtyPrice: ZERO,
    acqQty: ZERO,
    acqCost: ZERO,
    sellQtyPrice: ZERO,
    soldQty: ZERO,
    realized: ZERO,
    legs: [],
    flows: [],
  };
}

type Event =
  | { kind: "tx"; at: Date; tx: CoreTransaction }
  | { kind: "ca"; at: Date; ca: CorporateAction };

/**
 * Compute the trade log for a set of transactions. Pure — the caller injects current
 * prices and an FX snapshot. Multi-currency realized/dividends are converted at the
 * single provided fx rate (not per-transaction-date) — the UI carries an "indicative,
 * not your official tax figure" disclaimer for that reason.
 */
export function computeTrades(input: ComputeTradesInput): TradeLog {
  const fx: FxRateFn = input.fx ?? (() => "1");
  const method = input.method ?? "average";
  const now = input.now ?? new Date();
  const dust = D(input.dustEpsilon ?? DEFAULT_DUST);
  const display = input.displayCurrency;
  const cas = input.corporateActions ?? [];
  const conv = (amount: Decimal | string, from: string): Decimal =>
    D(convert(amount.toString(), from, display, fx));

  const TAX_FREE_ELIGIBLE_CLASSES = new Set(["gold", "crypto"]);
  const isTaxFreeEligible = (id: string): boolean => {
    if (!input.instruments) return true;
    const assetClass =
      input.instruments instanceof Map
        ? input.instruments.get(id)?.assetClass
        : (input.instruments as Record<string, { assetClass: string }>)[id]?.assetClass;
    return assetClass ? TAX_FREE_ELIGIBLE_CLASSES.has(assetClass) : true;
  };

  // Financing capitalized into the open episode's cost basis under "total_paid".
  const financing =
    input.costBasisMode === "total_paid"
      ? financingByInstrument(input.transactions)
      : {};

  // Group price-bearing transactions + corporate actions per instrument.
  const byInstrument = new Map<string, Event[]>();
  for (const tx of input.transactions) {
    if (!tx.instrumentId) continue;
    const list = byInstrument.get(tx.instrumentId) ?? [];
    list.push({ kind: "tx", at: tx.executedAt, tx });
    byInstrument.set(tx.instrumentId, list);
  }
  for (const ca of cas) {
    if (!byInstrument.has(ca.instrumentId)) continue;
    byInstrument.get(ca.instrumentId)!.push({ kind: "ca", at: ca.exDate, ca });
  }

  const trades: Trade[] = [];

  for (const [instrumentId, events] of byInstrument) {
    events.sort((a, b) => a.at.getTime() - b.at.getTime());

    // instrumentCcy — quote currency for market-value conversions (terminal MV, exposure).
    // costCcy      — trade currency of the actual buy/sell txns; used for cost basis,
    //                realized P&L, and leg amounts. Often equal to instrumentCcy, but
    //                diverges for cross-currency holdings (e.g. US stock bought in EUR).
    const firstPriceTx = events.find(
      (e): e is Extract<Event, { kind: "tx" }> =>
        e.kind === "tx" &&
        (e.tx.type === "buy" || e.tx.type === "savings_plan" || e.tx.type === "sell"),
    );
    const instrumentCcy =
      input.prices[instrumentId]?.currency ?? firstPriceTx?.tx.currency ?? display;
    const costCcy = firstPriceTx?.tx.currency ?? instrumentCcy;

    // Income (dividend/coupon) events for this instrument, for window-folding.
    const incomeEvents = events
      .filter(
        (e) => e.kind === "tx" && (e.tx.type === "dividend" || e.tx.type === "coupon"),
      )
      .map((e) => (e as { tx: CoreTransaction }).tx);

    // --- per-episode accumulators ---
    let lots: Lot[] = []; // FIFO ledger
    let avgQty = ZERO; // average-method running quantity
    let avgCost = ZERO; // average-method running cost (fees incl.)
    let episode: Episode | null = null;

    const finalizeTrade = (
      ep: Episode,
      status: "open" | "closed",
      exitAt: Date | null,
    ) => {
      const currentQty = avgQty; // remaining units (0 when closed)
      const entryDate = ep.entryDate;
      const exitDate = status === "closed" ? exitAt : null;
      const periodEnd = exitDate ?? now;
      const holdingDays = daysBetween(entryDate, periodEnd);

      // Dividends in the holding window [entry, end].
      let dividends = ZERO;
      const flows = [...ep.flows];
      for (const inc of incomeEvents) {
        if (inc.executedAt >= entryDate && inc.executedAt <= periodEnd) {
          const amt = conv(cashFlow(inc), inc.currency);
          dividends = dividends.add(amt);
          flows.push({ amount: amt.toNumber(), date: inc.executedAt });
        }
      }

      // Remaining cost basis of the OPEN portion (method-aware), + financing.
      const fin = status === "open" ? D(financing[instrumentId] ?? "0") : ZERO;
      const remainingCost =
        method === "fifo"
          ? lots.reduce((s, l) => s.add(l.qty.mul(l.unitCost)), ZERO)
          : avgCost;
      const remainingCostFin = remainingCost.add(fin);

      // Open-position unrealized + terminal XIRR flow.
      // Market value uses the quote currency (instrumentCcy); cost basis uses the trade
      // currency (costCcy). Both are converted to display before subtracting so the
      // subtraction is always in a common (display) unit — necessary when the two
      // currencies differ (e.g. USD quote, EUR cost).
      let unrealized = ZERO;
      const quote = input.prices[instrumentId];
      if (status === "open" && quote && currentQty.gt(0)) {
        const mvDisplay = conv(currentQty.mul(quote.price), instrumentCcy);
        unrealized = mvDisplay.sub(conv(remainingCostFin, costCcy));
        flows.push({ amount: mvDisplay.toNumber(), date: periodEnd });
      }

      const realizedDisplay = conv(ep.realized, costCcy);
      const investedDisplay = conv(ep.acqCost.add(fin), costCcy);
      const totalReturn = realizedDisplay.add(unrealized).add(dividends);
      const totalReturnPct = investedDisplay.isZero()
        ? null
        : totalReturn.div(investedDisplay).toNumber();
      const ann = xirr(flows);
      const annualizedPct = Number.isFinite(ann) ? ann : null;

      // Capital-weighted average holding period (in days).
      // Derived from the same `flows` array that feeds XIRR, so it is always
      // consistent with the money-weighted return.  The formula mirrors XIRR's
      // own time-axis: t0 = earliest flow date, tᵢ = (flowDate − t0) / MS_PER_YEAR.
      //   avgT(side) = Σ(|amount| · tᵢ) / Σ|amount|
      //   avgHoldingYears = avgT(inflows) − avgT(outflows)
      // For a single buy + single sell: avgHoldingYears == calendar years exactly.
      // For a savings plan: shorter, because later tranches were invested less time.
      // Falls back to holdingDays when avgHoldingYears ≤ 0 (e.g. open position with
      // no price quote, so the only inflow is dividends-only or the side is empty).
      let avgHoldingDays = holdingDays;
      if (flows.length >= 2) {
        const MS_PER_YEAR = MS_PER_DAY * 365;
        const t0 = Math.min(...flows.map((f) => f.date.getTime()));
        const outflows = flows.filter((f) => Number(f.amount) < 0);
        const inflows = flows.filter((f) => Number(f.amount) > 0);
        const wavg = (side: typeof flows) => {
          const totalAmt = side.reduce((s, f) => s + Math.abs(Number(f.amount)), 0);
          if (totalAmt === 0) return 0;
          return (
            side.reduce(
              (s, f) =>
                s + Math.abs(Number(f.amount)) * ((f.date.getTime() - t0) / MS_PER_YEAR),
              0,
            ) / totalAmt
          );
        };
        const avgHoldingYears = wavg(inflows) - wavg(outflows);
        if (avgHoldingYears > 0) {
          avgHoldingDays = Math.round(avgHoldingYears * 365);
        }
      }

      const qtyShown = status === "open" ? currentQty : ep.acqQty;
      const avgEntryPrice = ep.acqQty.gt(0)
        ? ep.acqQtyPrice.div(ep.acqQty).toString()
        : "0";
      const avgExitPrice = ep.soldQty.gt(0)
        ? ep.sellQtyPrice.div(ep.soldQty).toString()
        : null;

      trades.push({
        instrumentId,
        // avgEntryPrice / avgExitPrice are in the trade (cost) currency, which is
        // what the user actually paid per share — use costCcy so the label is correct.
        currency: costCcy,
        status,
        entryDate: toDateStr(entryDate),
        exitDate: exitDate ? toDateStr(exitDate) : null,
        holdingDays,
        avgHoldingDays,
        longTerm: holdingDays >= LONG_TERM_DAYS && isTaxFreeEligible(instrumentId),
        quantity: qtyShown.toString(),
        avgEntryPrice,
        avgExitPrice,
        invested: investedDisplay.toString(),
        realizedPnL: realizedDisplay.toString(),
        unrealizedPnL: unrealized.toString(),
        dividends: dividends.toString(),
        totalReturn: totalReturn.toString(),
        totalReturnPct,
        annualizedPct,
        legs: ep.legs,
      });
    };

    for (const ev of events) {
      if (ev.kind === "ca") {
        // Lot-level corporate actions: keep total cost fixed, scale quantities.
        const ratio = D(ev.ca.ratio);
        const factor =
          ev.ca.type === "split"
            ? ratio
            : ev.ca.type === "bonus"
              ? D(1).add(ratio)
              : null; // rights: no-op
        if (factor && avgQty.gt(0)) {
          avgQty = avgQty.mul(factor);
          for (const l of lots) {
            l.qty = l.qty.mul(factor);
            l.unitCost = l.unitCost.div(factor);
          }
          // Restate acquired units in current-share terms so the per-share
          // avgEntryPrice (= acqQtyPrice / acqQty) and the "quantity traded" shown
          // for a closed split position stay comparable to post-split sells. Money
          // (acqQtyPrice / acqCost) is split-invariant and left untouched.
          if (episode) episode.acqQty = episode.acqQty.mul(factor);
        }
        continue;
      }

      const tx = ev.tx;
      const q = D(tx.quantity);
      const p = D(tx.price);
      const f = D(tx.fees);

      if (tx.type === "buy" || tx.type === "savings_plan") {
        if (q.lte(0)) continue;
        if (!episode) episode = makeEpisode(tx.executedAt);
        const cost = q.mul(p).add(f);
        lots.push({ acqDate: tx.executedAt, qty: q, unitCost: cost.div(q) });
        avgQty = avgQty.add(q);
        avgCost = avgCost.add(cost);
        episode.acqQty = episode.acqQty.add(q);
        episode.acqQtyPrice = episode.acqQtyPrice.add(q.mul(p));
        episode.acqCost = episode.acqCost.add(cost);
        episode.flows.push({
          amount: conv(cost, tx.currency).neg().toNumber(),
          date: tx.executedAt,
        });
      } else if (tx.type === "sell") {
        if (!episode || avgQty.lte(0)) continue;
        const sellQty = Decimal.min(q, avgQty);
        const proceeds = sellQty.mul(p).sub(f); // instrument ccy
        const sellDate = tx.executedAt;
        const taxYear = sellDate.getUTCFullYear();

        // --- average method realized ---
        const avgUnit = avgCost.div(avgQty);
        const costAvg = avgUnit.mul(sellQty);

        // --- FIFO method: consume oldest lots ---
        let remaining = sellQty;
        let costFifo = ZERO;
        const fifoSlices: { acqDate: Date; qty: Decimal; cost: Decimal }[] = [];
        while (remaining.gt(0) && lots.length > 0) {
          const lot = lots[0];
          const take = Decimal.min(lot.qty, remaining);
          const sliceCost = take.mul(lot.unitCost);
          costFifo = costFifo.add(sliceCost);
          fifoSlices.push({ acqDate: lot.acqDate, qty: take, cost: sliceCost });
          lot.qty = lot.qty.sub(take);
          remaining = remaining.sub(take);
          if (lot.qty.lte(0)) lots.shift();
        }

        const costMethod = method === "fifo" ? costFifo : costAvg;
        const realizedSlice = proceeds.sub(costMethod);
        episode.realized = episode.realized.add(realizedSlice);

        // Legs for the chosen method (display currency).
        // Leg cost/proceeds/gain are all in costCcy (the trade currency of buys/sells).
        if (method === "fifo") {
          const proceedsPerUnit = sellQty.gt(0) ? proceeds.div(sellQty) : ZERO;
          for (const s of fifoSlices) {
            const sliceProceeds = s.qty.mul(proceedsPerUnit);
            const days = daysBetween(s.acqDate, sellDate);
            episode.legs.push({
              acqDate: toDateStr(s.acqDate),
              sellDate: toDateStr(sellDate),
              quantity: s.qty.toString(),
              cost: conv(s.cost, costCcy).toString(),
              proceeds: conv(sliceProceeds, costCcy).toString(),
              gain: conv(sliceProceeds.sub(s.cost), costCcy).toString(),
              holdingDays: days,
              longTerm: days >= LONG_TERM_DAYS && isTaxFreeEligible(instrumentId),
              taxYear,
            });
          }
        } else {
          const days = daysBetween(episode.entryDate, sellDate);
          episode.legs.push({
            acqDate: toDateStr(episode.entryDate),
            sellDate: toDateStr(sellDate),
            quantity: sellQty.toString(),
            cost: conv(costAvg, costCcy).toString(),
            proceeds: conv(proceeds, costCcy).toString(),
            gain: conv(realizedSlice, costCcy).toString(),
            holdingDays: days,
            longTerm: days >= LONG_TERM_DAYS && isTaxFreeEligible(instrumentId),
            taxYear,
          });
        }

        // Update average trackers + episode stats.
        avgCost = avgCost.sub(costAvg);
        avgQty = avgQty.sub(sellQty);
        episode.soldQty = episode.soldQty.add(sellQty);
        episode.sellQtyPrice = episode.sellQtyPrice.add(sellQty.mul(p));
        episode.flows.push({
          amount: conv(proceeds, tx.currency).toNumber(),
          date: sellDate,
        });

        // Dust tolerance: snap to closed (discard negligible residual + its cost).
        if (avgQty.lte(dust)) {
          finalizeTrade(episode, "closed", sellDate);
          episode = null;
          lots = [];
          avgQty = ZERO;
          avgCost = ZERO;
        }
      }
      // dividend/coupon/interest/fee/deposit/withdrawal/loan_*/bonus|split|rights TYPE:
      // no effect on the lot ledger (income is folded by window; CAs handled above).
    }

    // Any still-open episode.
    if (episode) finalizeTrade(episode, "open", null);
  }

  // dividendsByYear — all income (dividend/coupon/interest), net amount + withholding.
  const divMap = new Map<number, { amount: Decimal; tax: Decimal }>();
  for (const tx of input.transactions) {
    if (tx.type !== "dividend" && tx.type !== "coupon" && tx.type !== "interest") {
      continue;
    }
    const year = tx.executedAt.getUTCFullYear();
    const entry = divMap.get(year) ?? { amount: ZERO, tax: ZERO };
    entry.amount = entry.amount.add(conv(cashFlow(tx), tx.currency));
    entry.tax = entry.tax.add(conv(tx.tax ?? "0", tx.currency));
    divMap.set(year, entry);
  }
  const dividendsByYear: YearTax[] = [...divMap.entries()]
    .sort(([a], [b]) => a - b)
    .map(([year, { amount, tax }]) => ({
      year,
      amount: amount.toString(),
      tax: tax.toString(),
    }));

  // bonusesByYear — broker-credited rewards, purely informational, NOT in totalReturn.
  //   • bonus_cash (e.g. Kindergeld, promo cash) — cash flow as lump sum income.
  //   • buy / savings_plan with kind="saveback" — reinvested cashback (notional cost).
  //   • bonus with kind="transfer_in" — free share receipts (notional value q×p).
  // roundup is excluded: it is the user's own spare change, not broker-credited.
  const bonusMap = new Map<number, Decimal>();
  for (const tx of input.transactions) {
    let bonusAmount: Decimal | null = null;
    if (tx.type === "bonus_cash") {
      bonusAmount = conv(cashFlow(tx), tx.currency);
    } else if (
      (tx.type === "buy" || tx.type === "savings_plan") &&
      tx.kind === "saveback"
    ) {
      bonusAmount = conv(
        D(tx.quantity).mul(D(tx.price)).add(D(tx.fees)),
        tx.currency,
      );
    } else if (tx.type === "bonus" && tx.kind === "transfer_in") {
      bonusAmount = conv(D(tx.quantity).mul(D(tx.price)), tx.currency);
    }
    if (bonusAmount !== null) {
      const year = tx.executedAt.getUTCFullYear();
      bonusMap.set(year, (bonusMap.get(year) ?? ZERO).add(bonusAmount));
    }
  }
  const bonusesByYear: YearAmount[] = [...bonusMap.entries()]
    .sort(([a], [b]) => a - b)
    .map(([year, amount]) => ({ year, amount: amount.toString() }));

  return finalizeLog(trades, dividendsByYear, bonusesByYear, method, display);
}

/** Open first, then most-recent entry date on top. */
function sortTrades(trades: Trade[]): void {
  trades.sort((a, b) => {
    if (a.status !== b.status) return a.status === "open" ? -1 : 1;
    return a.entryDate < b.entryDate ? 1 : a.entryDate > b.entryDate ? -1 : 0;
  });
}

/** Assemble the final TradeLog: sort, realized-by-year (from legs), totals, win rate. */
function finalizeLog(
  trades: Trade[],
  dividendsByYear: YearTax[],
  bonusesByYear: YearAmount[],
  method: TradeMethod,
  display: string,
): TradeLog {
  sortTrades(trades);

  // realizedByYear (method-aware) from leg tax years.
  const realizedMap = new Map<number, Decimal>();
  for (const t of trades) {
    for (const leg of t.legs) {
      realizedMap.set(leg.taxYear, (realizedMap.get(leg.taxYear) ?? ZERO).add(leg.gain));
    }
  }
  const realizedByYear: YearAmount[] = [...realizedMap.entries()]
    .sort(([a], [b]) => a - b)
    .map(([year, amount]) => ({ year, amount: amount.toString() }));

  let totalRealized = ZERO;
  let totalDividends = ZERO;
  let totalReturn = ZERO;
  let closed = 0;
  let wins = 0;
  for (const t of trades) {
    totalRealized = totalRealized.add(t.realizedPnL);
    totalDividends = totalDividends.add(t.dividends);
    totalReturn = totalReturn.add(t.totalReturn);
    if (t.status === "closed") {
      closed += 1;
      if (new Decimal(t.totalReturn).gt(0)) wins += 1;
    }
  }

  return {
    displayCurrency: display,
    method,
    trades,
    totalRealized: totalRealized.toString(),
    totalDividends: totalDividends.toString(),
    totalReturn: totalReturn.toString(),
    winRate: closed > 0 ? wins / closed : null,
    realizedByYear,
    dividendsByYear,
    bonusesByYear,
  };
}

/**
 * Merge per-portfolio trade logs into one aggregate (for the cross-portfolio view).
 * Trades are concatenated (a position in two portfolios is two trades); by-year tax
 * buckets are summed; totals and win rate are recomputed. All logs must already be in
 * the same display currency and computed under the same method.
 */
export function mergeTradeLogs(
  logs: TradeLog[],
  displayCurrency: string,
  method: TradeMethod,
): TradeLog {
  const trades = logs.flatMap((l) => l.trades);
  const divMap = new Map<number, { amount: Decimal; tax: Decimal }>();
  const bonusMap = new Map<number, Decimal>();
  for (const l of logs) {
    for (const d of l.dividendsByYear) {
      const e = divMap.get(d.year) ?? { amount: ZERO, tax: ZERO };
      e.amount = e.amount.add(d.amount);
      e.tax = e.tax.add(d.tax);
      divMap.set(d.year, e);
    }
    for (const b of l.bonusesByYear) {
      bonusMap.set(b.year, (bonusMap.get(b.year) ?? ZERO).add(b.amount));
    }
  }
  const dividendsByYear: YearTax[] = [...divMap.entries()]
    .sort(([a], [b]) => a - b)
    .map(([year, { amount, tax }]) => ({
      year,
      amount: amount.toString(),
      tax: tax.toString(),
    }));
  const bonusesByYear: YearAmount[] = [...bonusMap.entries()]
    .sort(([a], [b]) => a - b)
    .map(([year, amount]) => ({ year, amount: amount.toString() }));
  return finalizeLog(trades, dividendsByYear, bonusesByYear, method, displayCurrency);
}
