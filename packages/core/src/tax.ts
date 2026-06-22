/**
 * German tax optimization helpers — Sparerpauschbetrag (§20 EStG) headroom tracking
 * and tax-free harvest suggestions.
 *
 * Scope:
 *   - Sparerpauschbetrag: annual investment-income tax-free allowance per holder.
 *   - Teilfreistellung: partial exemption for equity/mixed funds (§20 Abs. 9 InvStG).
 *   - FIFO lot ordering: tax-correct gain attribution (oldest-lot-first disposal).
 *   - Harvest suggestions: open positions whose tf-adjusted gain fits the remaining allowance.
 *
 * Explicitly OUT OF SCOPE: Vorabpauschale, Verlustverrechnungstopf, church-tax surtax
 * calculation, cross-year loss carry-forward, Günstigerprüfung.
 *
 * All money amounts are Decimal strings (never floats). Caller supplies:
 *   - A merged TradeLog computed with method:"fifo"
 *   - Teilfreistellung rates per instrument (0–1; 0 = no exemption)
 *   - The holder's annual allowance and tax year
 */

import { Decimal } from "decimal.js";
import type { TradeLog, Trade } from "./trade-log.js";

const D = (v: string | number) => new Decimal(v);
const ZERO = new Decimal(0);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** YTD usage of the annual tax-free allowance (Sparerpauschbetrag). */
export interface AllowanceUsage {
  /** Calendar year this covers. */
  year: number;
  /** Holder's annual allowance (from DB; never hard-coded). */
  allowanceAnnual: string;
  /** Tf-adjusted realized gains from FIFO lots closed this year (display currency). */
  realizedGainsAdjusted: string;
  /** Dividend/interest/coupon income received this year (display currency). */
  incomeYtd: string;
  /** Total used = realizedGainsAdjusted + incomeYtd, clamped to [0, allowanceAnnual]. */
  usedYtd: string;
  /** remaining = allowanceAnnual − usedYtd (never negative). */
  remaining: string;
  /** Effective Kapitalertragsteuer rate (default 0.25, configured per-holder). */
  taxRate: string;
  /** Tax saved by using the allowance = remaining × taxRate (informational). */
  taxSavingAvailable: string;
  /** Currency of all monetary amounts (= the TradeLog displayCurrency). */
  currency: string;
}

/** A single harvest suggestion: one open position that could be (partially) realized tax-free. */
export interface HarvestSuggestion {
  instrumentId: string;
  /** Gross unrealized gain of the WHOLE open position (display currency, from TradeLog). */
  unrealizedGross: string;
  /** Tf rate applied (0–1). */
  tfRate: string;
  /** Tf-adjusted unrealized gain = unrealizedGross × (1 − tfRate). */
  unrealizedAdjusted: string;
  /**
   * How much gross gain you can realize tax-free given the remaining allowance.
   * = min(unrealizedGross, remaining / (1 − tfRate))
   * When tfRate = 1 (full exemption), the full position is harvestable; we return
   * unrealizedGross directly.
   */
  harvestableGross: string;
  /**
   * Tax saved if you realize exactly `harvestableGross` = min(unrealizedAdjusted,
   * remaining) × taxRate.
   */
  taxSaving: string;
}

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface AllowanceUsageInput {
  /** FIFO trade log (must have been computed with method:"fifo"). */
  tradeLog: TradeLog;
  /**
   * Tf rates keyed by instrumentId. Only instruments with assetClass etf or
   * mutual_fund should have a non-zero rate; everything else defaults to 0.
   * Values are in [0, 1].
   */
  tfRates: Record<string, string | number>;
  /**
   * Annual Sparerpauschbetrag for this holder (e.g. "1000" for €1,000).
   * Must come from the DB; never hard-code.
   */
  allowanceAnnual: string;
  /**
   * KapSt rate (e.g. "0.25" for 25%). Caller should store this in the DB.
   * Default: "0.25".
   */
  taxRate?: string;
  /** Tax year to compute. Defaults to the current UTC calendar year. */
  year?: number;
}

export interface HarvestSuggestionsInput extends AllowanceUsageInput {
  /** Pre-computed allowance usage. If omitted it is computed from the tradeLog. */
  usage?: AllowanceUsage;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Compute YTD Sparerpauschbetrag usage for a holder.
 *
 * Algorithm:
 *   1. Walk every CLOSED trade; for each leg whose taxYear === year, tf-adjust the gain
 *      (gain × (1 − tfRate)).  Accumulate per-trade (keyed by instrumentId).
 *   2. Sum dividendsByYear for `year` (already includes interest/coupons).
 *   3. used = tf-adjusted gains + income, clamped to [0, allowanceAnnual].
 *   4. remaining = allowanceAnnual − used.
 */
export function allowanceUsageYTD(input: AllowanceUsageInput): AllowanceUsage {
  const year = input.year ?? new Date().getUTCFullYear();
  const allowance = D(input.allowanceAnnual);
  const taxRate = D(input.taxRate ?? "0.25");
  const currency = input.tradeLog.displayCurrency;

  // Step 1: tf-adjusted realized gains from closed FIFO legs this year.
  let realizedAdjusted = ZERO;
  for (const trade of input.tradeLog.trades) {
    const tfRaw = input.tfRates[trade.instrumentId];
    const tfRate = tfRaw !== undefined ? D(tfRaw) : ZERO;
    const multiplier = Decimal.max(ZERO, D(1).minus(tfRate));

    for (const leg of trade.legs) {
      if (leg.taxYear !== year) continue;
      const gain = D(leg.gain);
      if (gain.isZero()) continue;
      // Only count POSITIVE gains against the allowance (losses can't eat the allowance).
      if (gain.gt(ZERO)) {
        realizedAdjusted = realizedAdjusted.plus(gain.times(multiplier));
      }
    }
  }

  // Step 2: income this year (dividends + interest + coupons) from dividendsByYear.
  const incomeEntry = input.tradeLog.dividendsByYear.find((e) => e.year === year);
  const incomeYtd = incomeEntry ? D(incomeEntry.amount) : ZERO;
  const positiveIncome = Decimal.max(ZERO, incomeYtd);

  // Step 3: total used, clamped to [0, allowance].
  const rawUsed = realizedAdjusted.plus(positiveIncome);
  const usedYtd = Decimal.min(Decimal.max(ZERO, rawUsed), allowance);

  // Step 4: remaining.
  const remaining = Decimal.max(ZERO, allowance.minus(usedYtd));

  // Tax saving available = remaining × taxRate (before Soli etc.).
  const taxSavingAvailable = remaining.times(taxRate);

  return {
    year,
    allowanceAnnual: allowance.toFixed(2),
    realizedGainsAdjusted: realizedAdjusted.toFixed(2),
    incomeYtd: positiveIncome.toFixed(2),
    usedYtd: usedYtd.toFixed(2),
    remaining: remaining.toFixed(2),
    taxRate: taxRate.toString(),
    taxSavingAvailable: taxSavingAvailable.toFixed(2),
    currency,
  };
}

/**
 * Generate harvest suggestions: open positions ordered by descending tf-adjusted
 * unrealized gain, each showing how much could be realized tax-free against the
 * remaining allowance.
 *
 * Suggestions are INDEPENDENT — each is evaluated against the same `remaining`
 * value; no sequential allocation is done (the user decides which to act on).
 * Only positions with a positive unrealized gain are returned.
 */
export function harvestSuggestions(input: HarvestSuggestionsInput): HarvestSuggestion[] {
  const usage =
    input.usage ??
    allowanceUsageYTD({
      tradeLog: input.tradeLog,
      tfRates: input.tfRates,
      allowanceAnnual: input.allowanceAnnual,
      taxRate: input.taxRate,
      year: input.year,
    });

  const remaining = D(usage.remaining);
  const taxRate = D(usage.taxRate);

  if (remaining.lte(ZERO)) return [];

  const suggestions: HarvestSuggestion[] = [];

  for (const trade of input.tradeLog.trades) {
    if (trade.status !== "open") continue;

    const grossGain = D(trade.unrealizedPnL);
    if (grossGain.lte(ZERO)) continue; // only harvestable when in profit

    const tfRaw = input.tfRates[trade.instrumentId];
    const tfRate = tfRaw !== undefined ? D(tfRaw) : ZERO;

    // Guard against degenerate tfRate = 1 (full exemption — not currently in scope but
    // let's be safe). If tfRate were 1, the adjusted gain would be 0 and harvestable
    // would be the full position.
    const ONE = D(1);
    const exemptFraction = Decimal.min(ONE, Decimal.max(ZERO, tfRate));
    const multiplier = ONE.minus(exemptFraction);

    let adjustedGain: Decimal;
    let harvestableGross: Decimal;

    if (multiplier.isZero()) {
      // Full exemption: entire position is tax-free.
      adjustedGain = ZERO;
      harvestableGross = grossGain;
    } else {
      adjustedGain = grossGain.times(multiplier);
      // harvestableGross = min(grossGain, remaining / multiplier)
      const maxGross = remaining.div(multiplier);
      harvestableGross = Decimal.min(grossGain, maxGross);
    }

    // Tax saving = min(adjustedGain, remaining) × taxRate
    const adjustedCapped = Decimal.min(adjustedGain, remaining);
    const taxSaving = adjustedCapped.times(taxRate);

    suggestions.push({
      instrumentId: trade.instrumentId,
      unrealizedGross: grossGain.toFixed(2),
      tfRate: exemptFraction.toString(),
      unrealizedAdjusted: adjustedGain.toFixed(2),
      harvestableGross: harvestableGross.toFixed(2),
      taxSaving: taxSaving.toFixed(2),
    });
  }

  // Sort by descending tf-adjusted unrealized gain (best harvest opportunity first).
  suggestions.sort((a, b) => D(b.unrealizedAdjusted).cmp(D(a.unrealizedAdjusted)));

  return suggestions;
}

// Re-export Trade type so callers don't need a separate import.
export type { TradeLog, Trade };
