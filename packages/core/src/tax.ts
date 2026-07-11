/**
 * German tax optimization helpers — Sparerpauschbetrag (§20 EStG) headroom tracking
 * and tax-free harvest suggestions.
 *
 * Scope:
 *   - Sparerpauschbetrag: annual investment-income tax-free allowance per holder.
 *   - Teilfreistellung: partial exemption for equity/mixed funds (§20 Abs. 9 InvStG).
 *   - FIFO lot ordering: tax-correct gain attribution (oldest-lot-first disposal).
 *   - Harvest suggestions: open positions whose tf-adjusted gain fits the remaining allowance.
 *   - Vorabpauschale (§18(3) InvStG): trade-log.ts owns the share-accounting side (per-
 *     instrument accrual pool + disposal credit — see Trade.vorabByYear/TradeLeg.vorabCredit);
 *     this module owns the tax-netting side (Teilfreistellung, applied per-instrument in the
 *     same loop that tf-adjusts realized gains, then netted into the FSA usage below).
 *   - Verlustverrechnungstopf (loss pot) two-pot netting: Aktienverlusttopf (stock — losses
 *     from selling shares can only offset OTHER stock-sale gains) and Allgemeiner Verlusttopf
 *     (general — fund/bond/derivative gains/losses, all dividend/interest/coupon income
 *     regardless of instrument type, and Vorabpauschale net). Each pot self-nets and floors
 *     at 0 independently — no cross-pot spill (a stock loss can never offset a fund gain).
 *     Gold and crypto are excluded from BOTH pots entirely: they're §23 EStG private-sale
 *     income, a wholly separate regime from §20 Kapitalerträge and this €1,000 allowance.
 *   - Cross-year loss carry-forward: a settled €-figure per pot from the prior year's tax
 *     certificate, subtracted from that pot's net gain/loss BEFORE its floor. Passed in raw
 *     (already Teilfreistellung-adjusted when the underlying loss was originally booked —
 *     never re-adjusted here).
 *
 * Explicitly OUT OF SCOPE: church-tax surtax calculation, Günstigerprüfung.
 *
 * All money amounts are Decimal strings (never floats). Caller supplies:
 *   - A merged TradeLog computed with method:"fifo"
 *   - Teilfreistellung rates per instrument (0–1; 0 = no exemption)
 *   - The holder's annual allowance and tax year
 */

import { Decimal } from "decimal.js";
import type { TradeLog, Trade, YearTax } from "./trade-log.js";

const D = (v: string | number) => new Decimal(v);
const ZERO = new Decimal(0);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * One Verlusttopf's (loss pot's) netting result. See the file header for what each pot
 * contains and why they never spill into each other.
 */
export interface PotUsage {
  /**
   * Tf-adjusted net gain/loss for this pot this year (display currency, before carry-
   * forward and before the floor — CAN be negative, a net loss). For the general pot this
   * already includes dividend/interest/coupon income and the Vorabpauschale net (accrual
   * − credit); for the stock pot it's realized share-sale gains/losses only.
   */
  netGainLoss: string;
  /**
   * Prior-year loss carry-forward subtracted from netGainLoss before the floor (raw euro
   * figure from the tax certificate — never negative, never further tf-adjusted here).
   */
  carryForwardApplied: string;
  /**
   * max(0, netGainLoss − carryForwardApplied) — this pot's own contribution to usedYtd,
   * computed independently of the other pot (no cross-pot spill).
   */
  used: string;
}

/** YTD usage of the annual tax-free allowance (Sparerpauschbetrag). */
export interface AllowanceUsage {
  /** Calendar year this covers. */
  year: number;
  /** Holder's annual allowance (from DB; never hard-coded). */
  allowanceAnnual: string;
  /**
   * Tf-adjusted realized gains/losses from FIFO lots closed this year, summed across both
   * pots (display currency). Symmetric — CAN be negative (a net loss year); losses are no
   * longer silently dropped, they net within their own pot (see stockPot/generalPot).
   */
  realizedGainsAdjusted: string;
  /** Gross dividend/interest/coupon income this year (net received + withholding, display currency, never negative). */
  incomeYtd: string;
  /**
   * Tf-adjusted Vorabpauschale accrued this year (§18(3) InvStG advance lump-sum fund tax),
   * from Trade.vorabByYear, tf-adjusted per-instrument (display currency, never negative).
   * Folded into generalPot's netGainLoss — reported separately here for visibility only.
   */
  vorabpauschaleAccrued: string;
  /**
   * Tf-adjusted Vorabpauschale disposal credit realized this year (from TradeLeg.vorabCredit
   * on sells closed this year) — money already taxed via a prior accrual, credited back
   * against double-taxation on disposal (display currency, never negative). Folded into
   * generalPot's netGainLoss — reported separately here for visibility only.
   */
  vorabpauschaleCredited: string;
  /** Aktienverlusttopf — realized stock (assetClass="equity") gains/losses only. */
  stockPot: PotUsage;
  /**
   * Allgemeiner Verlusttopf — fund/bond/derivative gains/losses, all dividend/interest/
   * coupon income, and the Vorabpauschale net. Gold/crypto are excluded from both pots
   * (§23 EStG private-sale regime) — see the file header.
   */
  generalPot: PotUsage;
  /**
   * Total used = stockPot.used + generalPot.used, clamped to [0, allowanceAnnual]. Each
   * pot is floored at 0 independently before summing (no cross-pot spill) — this is NOT
   * the same as summing the raw (pre-floor) netGainLoss values and clamping once; a big
   * stock loss can no longer offset a fund gain, which is the whole point of the pots.
   */
  usedYtd: string;
  /**
   * max(0, (stockPot.used + generalPot.used) − allowanceAnnual) — the portion of this
   * year's gains/income that genuinely exceeds the tax-free allowance and is actually
   * taxable. Use this instead of re-deriving from realizedGainsAdjusted/incomeYtd/usedYtd
   * (those three no longer have the simple additive relationship they had pre-two-pot).
   */
  taxableExcess: string;
  /** remaining = allowanceAnnual − usedYtd (never negative). */
  remaining: string;
  /** Effective Kapitalertragsteuer rate (default 0.25, configured per-holder). */
  taxRate: string;
  /** Tax saved by using the allowance = remaining × taxRate (informational). */
  taxSavingAvailable: string;
  /** Currency of all monetary amounts (= the TradeLog displayCurrency). */
  currency: string;

  // --- Forecast (rest-of-year projected income) ---

  /**
   * Gross projected income for the remainder of the current year (equity dividends +
   * bond coupons, grossed up to match the Sparerpauschbetrag convention).
   * "0.00" when the requested year is not the current year or no projection is available.
   */
  forecastIncomeRestOfYear: string;
  /**
   * Projected full-year used = clamp(realizedGainsAdjusted + incomeYtd + forecastIncomeRestOfYear,
   * 0, allowanceAnnual).  Equals usedYtd when forecastIncomeRestOfYear is zero.
   */
  projectedUsedFullYear: string;
  /** projectedRemaining = allowanceAnnual − projectedUsedFullYear (never negative). */
  projectedRemaining: string;
  /** Estimated tax saving against the projected remaining = projectedRemaining × taxRate. */
  projectedTaxSavingAvailable: string;
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

export interface HarvestSummary {
  /** How many of the input suggestions actually received any allowance (fully-exempt
   *  positions, tfRate=1, always count even once the allowance is exhausted). */
  positionsUsed: number;
  /** Combined gross gain realizable across ALL suggestions TOGETHER, sequentially capped
   *  against the SHARED remaining allowance — see {@link harvestSummary}'s doc comment
   *  for why this differs from Σ harvestableGross. */
  combinedHarvestableGross: string;
  /** Tax saved if exactly `combinedHarvestableGross` (spread across these positions) is
   *  realized. Always ≤ remaining × taxRate. */
  combinedTaxSaving: string;
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
  /**
   * Gross projected income (equity dividends + bond coupons) for the rest of
   * the current year, in the TradeLog displayCurrency.  Must already be grossed
   * up to match the Sparerpauschbetrag convention (gross = net + withholding).
   *
   * Pass "0" (or omit) when the requested year differs from the current calendar
   * year, or when no forecast is available.
   */
  forecastIncomeRestOfYear?: string;
  /**
   * Instrument assetClass keyed by instrumentId (e.g. from the route's already-loaded
   * `metaById` — no new query needed). Drives the stock-vs-general pot split:
   * "equity" → stock pot; "gold"/"crypto" → excluded entirely (§23 EStG regime, not part
   * of these §20 pots); everything else (etf/mutual_fund/bond/derivative/unknown) →
   * general pot. Optional for backward compatibility — omitting it puts every instrument
   * in the general pot (today's behavior, now with symmetric loss netting).
   */
  assetClasses?: Record<string, string>;
  /**
   * Prior-year loss carry-forward per pot, as raw euro figures from the holder's tax
   * certificate — already Teilfreistellung-adjusted when the underlying loss was
   * originally booked; do NOT re-adjust here. Subtracted from each pot's net gain/loss
   * before that pot's own floor. Default `{0,0}` — omitting this leaves usedYtd
   * unchanged from a run with no carry-forward.
   */
  lossCarryForward?: { stock?: string; general?: string };
}

export interface HarvestSuggestionsInput extends AllowanceUsageInput {
  /** Pre-computed allowance usage. If omitted it is computed from the tradeLog. */
  usage?: AllowanceUsage;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Compute YTD Sparerpauschbetrag usage for a holder, via two-pot Verlustverrechnung.
 *
 * Algorithm:
 *   1. Walk every trade; skip it entirely if its assetClass is gold/crypto (§23 EStG, not
 *      part of these pots). Classify the rest as stock (assetClass="equity") or general
 *      (everything else). For each leg whose taxYear === year, tf-adjust the gain/loss
 *      SYMMETRICALLY (losses count now) and accumulate into that trade's pot subtotal. In
 *      the same per-trade loop (same instrumentId, same tfRate), tf-adjust this year's
 *      Vorabpauschale accrual (Trade.vorabByYear) and disposal credit (Σ leg.vorabCredit)
 *      into the GENERAL pot (Vorabpauschale is fund-only by construction).
 *   2. Sum dividendsByYear for `year` (gross = net + withholding; includes interest/coupons)
 *      into the general pot's subtotal too.
 *   3. Each pot's subtotal has that pot's own loss carry-forward subtracted, then floors at
 *      0 independently (no cross-pot spill — a stock loss can never offset a fund gain).
 *   4. usedYtd = stockPot.used + generalPot.used, clamped to [0, allowanceAnnual].
 *   5. remaining = allowanceAnnual − usedYtd.
 */
export function allowanceUsageYTD(input: AllowanceUsageInput): AllowanceUsage {
  const year = input.year ?? new Date().getUTCFullYear();
  const allowance = D(input.allowanceAnnual);
  const taxRate = D(input.taxRate ?? "0.25");
  const currency = input.tradeLog.displayCurrency;
  const assetClasses = input.assetClasses ?? {};

  // Step 1: per-trade tf-adjusted realized gain/loss (symmetric), bucketed into the stock
  // pot or the general pot. Vorabpauschale accrual/credit always lands in the general pot.
  let stockSubtotal = ZERO;
  let generalTradeSubtotal = ZERO;
  let vorabAccrued = ZERO;
  let vorabCredited = ZERO;
  for (const trade of input.tradeLog.trades) {
    const assetClass = assetClasses[trade.instrumentId];
    if (assetClass === "gold" || assetClass === "crypto") continue;
    const isStock = assetClass === "equity";

    const tfRaw = input.tfRates[trade.instrumentId];
    const tfRate = tfRaw !== undefined ? D(tfRaw) : ZERO;
    const multiplier = Decimal.max(ZERO, D(1).minus(tfRate));

    for (const leg of trade.legs) {
      if (leg.taxYear !== year) continue;
      // Symmetric: gains AND losses both count now — a loss-making leg nets against
      // other gains in the SAME pot below, rather than being silently dropped.
      const adjustedGain = D(leg.gain).times(multiplier);
      if (isStock) stockSubtotal = stockSubtotal.plus(adjustedGain);
      else generalTradeSubtotal = generalTradeSubtotal.plus(adjustedGain);

      const credit = D(leg.vorabCredit ?? "0");
      if (credit.gt(ZERO)) {
        vorabCredited = vorabCredited.plus(credit.times(multiplier));
      }
    }

    for (const va of trade.vorabByYear ?? []) {
      if (va.year !== year) continue;
      const amt = D(va.amount);
      if (amt.gt(ZERO)) {
        vorabAccrued = vorabAccrued.plus(amt.times(multiplier));
      }
    }
  }

  // Step 2: gross income this year (dividends + interest + coupons) from dividendsByYear.
  // YearTax.amount is net-received; .tax is the withheld amount.  The Sparerpauschbetrag
  // is consumed by GROSS Kapitalerträge (§20 EStG), so we must add withholding back.
  // Unfloored here (folds directly into the general pot's single subtotal below); the
  // reported `incomeYtd` field floors at 0 for display only — real dividend income is
  // never negative in practice, so this distinction rarely matters.
  const incomeEntry: YearTax | undefined = input.tradeLog.dividendsByYear.find(
    (e) => e.year === year,
  );
  const incomeGross = incomeEntry
    ? D(incomeEntry.amount).plus(D(incomeEntry.tax))
    : ZERO;
  const positiveIncome = Decimal.max(ZERO, incomeGross);

  // Step 3: general pot subtotal = trade gains/losses + income + Vorabpauschale net, all
  // netted together BEFORE the pot's single floor (matches the plan's netting order —
  // income is no longer separately floored at 0 before combining). Forecast (rest-of-year
  // projected income) is threaded in here too, but only for the PROJECTED variant — the
  // stock pot is unaffected by forecast (forecast is dividend/coupon income only).
  const vorabNet = vorabAccrued.minus(vorabCredited);
  const generalSubtotalNoForecast = generalTradeSubtotal.plus(incomeGross).plus(vorabNet);
  const forecastGross = Decimal.max(ZERO, D(input.forecastIncomeRestOfYear ?? "0"));
  const generalSubtotalWithForecast = generalSubtotalNoForecast.plus(forecastGross);

  // Step 4: each pot's own carry-forward + floor, independently — no cross-pot spill.
  // Carry-forward is a settled €-figure from the tax certificate, already tf-adjusted when
  // the underlying loss was originally booked; subtracted RAW, never re-multiplied by tf.
  const stockCF = Decimal.max(ZERO, D(input.lossCarryForward?.stock ?? "0"));
  const generalCF = Decimal.max(ZERO, D(input.lossCarryForward?.general ?? "0"));
  const stockUsed = Decimal.max(ZERO, stockSubtotal.minus(stockCF));
  const generalUsedYtd = Decimal.max(ZERO, generalSubtotalNoForecast.minus(generalCF));
  const generalUsedProjected = Decimal.max(ZERO, generalSubtotalWithForecast.minus(generalCF));

  // Step 5: sum the (already ≥0) pot usages, clamp to the annual allowance.
  const rawUsed = stockUsed.plus(generalUsedYtd);
  const usedYtd = Decimal.min(rawUsed, allowance);
  const remaining = Decimal.max(ZERO, allowance.minus(usedYtd));
  const taxSavingAvailable = remaining.times(taxRate);
  const taxableExcess = Decimal.max(ZERO, rawUsed.minus(allowance));

  // Step 6: forward projection — same pot math, general pot's subtotal includes forecast.
  const rawProjected = stockUsed.plus(generalUsedProjected);
  const projectedUsedFullYear = Decimal.min(rawProjected, allowance);
  const projectedRemaining = Decimal.max(ZERO, allowance.minus(projectedUsedFullYear));
  const projectedTaxSavingAvailable = projectedRemaining.times(taxRate);

  return {
    year,
    allowanceAnnual: allowance.toFixed(2),
    realizedGainsAdjusted: stockSubtotal.plus(generalTradeSubtotal).toFixed(2),
    incomeYtd: positiveIncome.toFixed(2),
    vorabpauschaleAccrued: vorabAccrued.toFixed(2),
    vorabpauschaleCredited: vorabCredited.toFixed(2),
    stockPot: {
      netGainLoss: stockSubtotal.toFixed(2),
      carryForwardApplied: stockCF.toFixed(2),
      used: stockUsed.toFixed(2),
    },
    generalPot: {
      netGainLoss: generalSubtotalNoForecast.toFixed(2),
      carryForwardApplied: generalCF.toFixed(2),
      used: generalUsedYtd.toFixed(2),
    },
    usedYtd: usedYtd.toFixed(2),
    taxableExcess: taxableExcess.toFixed(2),
    remaining: remaining.toFixed(2),
    taxRate: taxRate.toString(),
    taxSavingAvailable: taxSavingAvailable.toFixed(2),
    currency,
    forecastIncomeRestOfYear: forecastGross.toFixed(2),
    projectedUsedFullYear: projectedUsedFullYear.toFixed(2),
    projectedRemaining: projectedRemaining.toFixed(2),
    projectedTaxSavingAvailable: projectedTaxSavingAvailable.toFixed(2),
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
      assetClasses: input.assetClasses,
      lossCarryForward: input.lossCarryForward,
    });

  // Use projectedRemaining when available (accounts for rest-of-year forecast income).
  // Falls back to realized remaining when the forecast is zero (backward-compatible).
  const remaining = D(usage.projectedRemaining ?? usage.remaining);
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

/**
 * Combined "harvest ALL of these together" totals.
 *
 * Each `HarvestSuggestion.harvestableGross`/`taxSaving` is deliberately computed
 * INDEPENDENTLY against the FULL `remaining` allowance (see `harvestSuggestions`'s doc
 * comment — "no sequential allocation is done, the user decides which to act on"), which
 * is correct for a single row read in isolation ("if I harvest ONLY this one, this is the
 * ceiling"). Naively summing those per-row values across N suggestions is wrong: it
 * implies the same remaining allowance can be spent once per position, so the total can
 * come out to N× the real ceiling. This function instead walks `suggestions` in the order
 * given (harvestSuggestions already sorts best-first) and allocates the SHARED allowance
 * sequentially, so `combinedTaxSaving` is always ≤ `remaining × taxRate` — the true
 * maximum possible saving from harvesting some or all of the list together.
 */
export function harvestSummary(
  suggestions: HarvestSuggestion[],
  remaining: string,
  taxRate: string,
): HarvestSummary {
  const rate = D(taxRate);
  let allowanceLeft = D(remaining);
  let combinedGross = ZERO;
  let combinedAdjusted = ZERO;
  let positionsUsed = 0;

  for (const s of suggestions) {
    const tfRate = D(s.tfRate);
    const ONE = D(1);
    const exemptFraction = Decimal.min(ONE, Decimal.max(ZERO, tfRate));
    const multiplier = ONE.minus(exemptFraction);
    const unrealizedGross = D(s.unrealizedGross);

    if (multiplier.isZero()) {
      // Fully tax-exempt position (tfRate=1): harvestable regardless of remaining
      // allowance — mirrors harvestSuggestions' own guard for this degenerate case.
      combinedGross = combinedGross.plus(unrealizedGross);
      positionsUsed++;
      continue;
    }

    if (allowanceLeft.lte(ZERO)) continue;

    const adjustedTake = Decimal.min(D(s.unrealizedAdjusted), allowanceLeft);
    if (adjustedTake.lte(ZERO)) continue;

    const grossTake = Decimal.min(unrealizedGross, adjustedTake.div(multiplier));
    combinedGross = combinedGross.plus(grossTake);
    combinedAdjusted = combinedAdjusted.plus(adjustedTake);
    allowanceLeft = allowanceLeft.minus(adjustedTake);
    positionsUsed++;
  }

  return {
    positionsUsed,
    combinedHarvestableGross: combinedGross.toFixed(2),
    combinedTaxSaving: combinedAdjusted.times(rate).toFixed(2),
  };
}

// Re-export Trade type so callers don't need a separate import.
export type { TradeLog, Trade };
