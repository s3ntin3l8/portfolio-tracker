import { Decimal } from "decimal.js";
import { convert, type FxRateFn } from "./networth.js";

// ---------------------------------------------------------------------------
// Internal date helpers
// ---------------------------------------------------------------------------

/** Whole-month count between two UTC dates (b − a, may be negative). */
function monthsBetween(a: Date, b: Date): number {
  return (
    (b.getUTCFullYear() - a.getUTCFullYear()) * 12 +
    (b.getUTCMonth() - a.getUTCMonth())
  );
}

/** Return a new Date advanced by `months` UTC months. */
function addUTCMonths(date: Date, months: number): Date {
  const d = new Date(date);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

/**
 * Infer the most likely payment cadence from a list of payment dates.
 * Returns the interval in months: 1 (monthly), 3 (quarterly), 6 (semiannual), 12 (annual).
 */
function inferIntervalMonths(dates: Date[]): number {
  if (dates.length < 2) return 12;
  const sorted = [...dates].sort((a, b) => a.getTime() - b.getTime());
  const spacings: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const m = monthsBetween(sorted[i - 1], sorted[i]);
    // Ignore noise (< 1 month duplicate) and multi-year gaps (skipped year).
    if (m >= 1 && m <= 14) spacings.push(m);
  }
  if (spacings.length === 0) return 12;
  const avg = spacings.reduce((s, x) => s + x, 0) / spacings.length;
  if (avg <= 1.5) return 1;
  if (avg <= 4.5) return 3;
  if (avg <= 9) return 6;
  return 12;
}

/**
 * Per-share YoY growth factor = lastYear / yearBefore per-share annual totals,
 * clamped to [0.5, 2.0]. One-off guard: per-payment amounts that exceed 2× the
 * instrument's median per-payment amount are excluded before summing (special dividends).
 * Returns 1.0 when there is insufficient data (< 2 calendar years).
 */
function computeGrowthFactor(perShareByYear: Map<number, number[]>): number {
  const years = [...perShareByYear.keys()].sort((a, b) => a - b);
  if (years.length < 2) return 1.0;
  const lastYear = years[years.length - 1];
  const yearBefore = years[years.length - 2];

  const withoutOneOffs = (amounts: number[]): number[] => {
    if (amounts.length === 0) return [];
    const sorted = [...amounts].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    return amounts.filter((a) => median <= 0 || a <= 2 * median);
  };

  const lastSum = withoutOneOffs(perShareByYear.get(lastYear) ?? []).reduce(
    (s, x) => s + x,
    0,
  );
  const prevSum = withoutOneOffs(perShareByYear.get(yearBefore) ?? []).reduce(
    (s, x) => s + x,
    0,
  );

  if (prevSum <= 0 || lastSum <= 0) return 1.0;
  return Math.min(2.0, Math.max(0.5, lastSum / prevSum));
}

/** A held bond position with the schedule fields needed to project coupons. */
export interface BondPosition {
  instrumentId: string;
  symbol: string;
  name?: string | null;
  /** Units held. */
  quantity: string;
  /** Face (par) value per unit. */
  faceValue: string;
  /** Annual coupon rate as a decimal (e.g. "0.06" for 6%). */
  couponRate: string;
  /** Payment frequency; defaults to semiannual when unknown. */
  couponSchedule: string | null;
  /** Maturity date (YYYY-MM-DD) — coupon dates are anchored to it. */
  maturityDate: string;
  currency: string;
}

/** A future coupon payment for a held bond, in the instrument's own currency. */
export interface ProjectedCoupon {
  instrumentId: string;
  symbol: string;
  name?: string | null;
  date: string; // YYYY-MM-DD
  amount: string;
  currency: string;
}

const PERIODS_PER_YEAR: Record<string, number> = {
  annual: 1,
  semiannual: 2,
  quarterly: 4,
  monthly: 12,
};

/**
 * Project the coupon payments due on held bonds within a given horizon.
 *
 * `horizon` may be a number of months (default 12) or an explicit `Date`
 * (e.g. Dec 31 of the current year for the rest-of-year window). Coupon dates
 * are anchored to the maturity date and stepped back by the payment interval;
 * each amount is `faceValue × quantity × couponRate ÷ periodsPerYear`.
 */
export function projectCoupons(
  positions: BondPosition[],
  horizon: number | Date = 12,
  now: Date = new Date(),
): ProjectedCoupon[] {
  let horizonEnd: Date;
  if (horizon instanceof Date) {
    horizonEnd = horizon;
  } else {
    horizonEnd = new Date(now);
    horizonEnd.setUTCMonth(horizonEnd.getUTCMonth() + horizon);
  }

  const out: ProjectedCoupon[] = [];
  for (const p of positions) {
    const periods = PERIODS_PER_YEAR[p.couponSchedule ?? "semiannual"] ?? 2;
    const intervalMonths = 12 / periods;
    if (intervalMonths <= 0) continue;

    const maturity = new Date(`${p.maturityDate}T00:00:00.000Z`);
    if (Number.isNaN(maturity.getTime())) continue;
    if (new Decimal(p.quantity).lte(0)) continue;

    const amount = new Decimal(p.faceValue)
      .mul(p.quantity)
      .mul(p.couponRate)
      .div(periods)
      .toString();

    // Walk coupon dates back from maturity, collecting those in (now, horizonEnd].
    const d = new Date(maturity);
    while (d > now) {
      if (d <= horizonEnd) {
        out.push({
          instrumentId: p.instrumentId,
          symbol: p.symbol,
          name: p.name,
          date: d.toISOString().slice(0, 10),
          amount,
          currency: p.currency,
        });
      }
      d.setUTCMonth(d.getUTCMonth() - intervalMonths);
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** A dividend payment projected from last year's actual payout, in instrument currency. */
export interface ProjectedDividend {
  instrumentId: string;
  symbol?: string | null;
  name?: string | null;
  /** YYYY-MM-DD — the projected payment date. */
  date: string;
  /** Total projected cash in `currency`, scaled by quantity change. */
  amount: string;
  currency: string;
  /** Calendar year the estimate is derived from (e.g. 2025 for a 2026 projection). */
  basisYear: number;
  /**
   * How this estimate was derived:
   * - "flat"  — straight replay of historical amount (no growth adjustment)
   * - "grown" — YoY per-share growth factor applied
   */
  source: "flat" | "grown";
  /** The per-share YoY growth multiplier applied when `source === "grown"`. */
  growthApplied?: number;
  /** True when the projected quantity includes assumed continued savings-plan accumulation. */
  assumesContributions?: boolean;
}

/**
 * Project equity dividends for the rest of the current year by replaying
 * each instrument's actual payments from last year's same window (now → Dec 31)
 * shifted forward one year, scaled by the quantity change.
 *
 * Scaling is split-consistent because `qtyAt` should return quantities in
 * current share terms (i.e. with all corporate actions applied regardless of
 * the `asOf` date — see `computeHoldings`).
 *
 * Only instruments still held (`heldQty` with qty > 0) are projected.
 * Instruments with no last-year payment in the window are skipped — they
 * will be covered by announced data once that feature lands.
 */
export function projectDividends(
  pastDividends: IncomeEntry[],
  heldQty: Map<string, string>,
  qtyAt: (instrumentId: string, at: Date) => string,
  now: Date = new Date(),
): ProjectedDividend[] {
  // Source window: last year's equivalent of (now, Dec 31].
  const lastYearEnd = new Date(
    Date.UTC(now.getUTCFullYear() - 1, 11, 31, 23, 59, 59, 999),
  );
  const pastStart = new Date(now);
  pastStart.setUTCFullYear(pastStart.getUTCFullYear() - 1);

  const nowStr = now.toISOString().slice(0, 10);

  const out: ProjectedDividend[] = [];

  for (const e of pastDividends) {
    if (e.type !== "dividend" || !e.instrumentId) continue;

    // Filter to the source window (pastStart, lastYearEnd].
    if (e.executedAt <= pastStart || e.executedAt > lastYearEnd) continue;

    // Only project for still-held instruments.
    const currentQtyStr = heldQty.get(e.instrumentId);
    if (!currentQtyStr || new Decimal(currentQtyStr).lte(0)) continue;

    const currentQty = new Decimal(currentQtyStr);
    const histQtyStr = qtyAt(e.instrumentId, e.executedAt);
    const histQty = new Decimal(histQtyStr);

    // Scale by qty change; fall back to raw amount if no historical position.
    const amount = histQty.lte(0)
      ? new Decimal(e.price)
      : new Decimal(e.price).mul(currentQty).div(histQty);

    // Shift date one year forward.
    const projected = new Date(e.executedAt);
    projected.setUTCFullYear(projected.getUTCFullYear() + 1);
    const dateStr = projected.toISOString().slice(0, 10);

    // Skip projected dates that aren't strictly in the future.
    if (dateStr <= nowStr) continue;

    out.push({
      instrumentId: e.instrumentId,
      symbol: e.symbol ?? null,
      name: e.name ?? null,
      date: dateStr,
      amount: amount.toString(),
      currency: e.currency,
      basisYear: e.executedAt.getUTCFullYear(),
      source: "flat",
    });
  }

  return out.sort((a, b) => a.date.localeCompare(b.date));
}

// ---------------------------------------------------------------------------
// Next-year cadence-based dividend projection engine
// ---------------------------------------------------------------------------

/**
 * Project equity dividends for the full next calendar year using cadence detection,
 * optional YoY per-share growth, and optional share-accumulation from regular buys.
 *
 * This engine replaces the TTM scalar approach for `forecastNextYear`:
 *
 * - **Cadence**: infers each instrument's payment frequency (monthly / quarterly /
 *   semiannual / annual) from the spacing of its last 24 months of payments, then
 *   generates the correct number of future payment dates within
 *   `(Dec 31 this year, Dec 31 next year]`.
 *
 * - **YoY growth** (`applyGrowth`, default `true`): computes a per-share growth
 *   multiplier = lastYear / yearBefore per-share annual totals, clamped to [0.5, 2.0].
 *   One-off guard: payments exceeding 2× the instrument's median per-payment amount
 *   are excluded from the ratio (avoids special dividends inflating the growth rate).
 *   Requires ≥ 2 calendar years of data; defaults to 1.0 otherwise.
 *   Only applied to the *next*-year window — rest-of-year stays at current run-rate.
 *
 * - **Accumulation** (`accumulation`): optional map of instrument → shares-per-month
 *   rate (from recent savings-plan / buy transactions). Projected qty at a future date
 *   = currentQty + rate × monthsAhead. Flagged with `assumesContributions: true`.
 *
 * Each emitted `ProjectedDividend` carries `source: "flat" | "grown"` and optional
 * `growthApplied` / `assumesContributions` fields for UI display.
 *
 * Announced/paid data from `dividend_events` is blended at the API layer (same
 * pattern as `projectDividends`), not here.
 *
 * Only instruments still held (`heldQty` with qty > 0) are projected. Instruments
 * with no payment in the trailing 24 months are skipped.
 */
export function projectNextYearDividends(
  pastDividends: IncomeEntry[],
  heldQty: Map<string, string>,
  qtyAt: (instrumentId: string, at: Date) => string,
  now: Date = new Date(),
  opts: {
    /** Per-instrument monthly share accumulation rate (shares/month). */
    accumulation?: Map<string, string>;
    /** Apply YoY per-share growth factor. Default: true. */
    applyGrowth?: boolean;
  } = {},
): ProjectedDividend[] {
  const applyGrowth = opts.applyGrowth ?? true;
  const currentYear = now.getUTCFullYear();
  const nextYear = currentYear + 1;
  // Window: (Dec 31 thisYear, Dec 31 nextYear], exclusive/inclusive.
  const windowStart = new Date(Date.UTC(currentYear, 11, 31, 23, 59, 59, 999));
  const windowEnd = new Date(Date.UTC(nextYear, 11, 31, 23, 59, 59, 999));

  // Group past dividend payments by instrument.
  const byInstrument = new Map<string, IncomeEntry[]>();
  for (const e of pastDividends) {
    if (e.type !== "dividend" || !e.instrumentId) continue;
    const list = byInstrument.get(e.instrumentId) ?? [];
    list.push(e);
    byInstrument.set(e.instrumentId, list);
  }

  const out: ProjectedDividend[] = [];

  // Cut-off: require at least one payment within the trailing 24 months.
  // Cut-off: require at least one payment within the trailing 24 months.
  // Using 24 months (not 12) captures annual payers whose payment may be
  // 12–24 months back (e.g., a March annual payer when now is June).
  const cutoff24mo = addUTCMonths(now, -24);

  for (const [instrumentId, entries] of byInstrument) {
    const currentQtyStr = heldQty.get(instrumentId);
    if (!currentQtyStr || new Decimal(currentQtyStr).lte(0)) continue;
    const currentQty = new Decimal(currentQtyStr);

    // Sort ascending.
    const sorted = [...entries].sort(
      (a, b) => a.executedAt.getTime() - b.executedAt.getTime(),
    );

    // Skip instruments with no recent activity.
    const hasRecent = sorted.some((e) => e.executedAt >= cutoff24mo);
    if (!hasRecent) continue;

    // Compute per-share for each historical payment.
    const perShareAmounts = sorted.map((e) => {
      const histQtyStr = qtyAt(instrumentId, e.executedAt);
      const histQty = new Decimal(histQtyStr);
      // Fallback: treat raw price as the per-share amount when histQty unknown.
      const perShare = histQty.gt(0)
        ? new Decimal(e.price).div(histQty)
        : new Decimal(e.price);
      return { date: e.executedAt, year: e.executedAt.getUTCFullYear(), perShare };
    });

    // Per-year per-share arrays for growth computation.
    const perShareByYear = new Map<number, number[]>();
    for (const { year, perShare } of perShareAmounts) {
      const arr = perShareByYear.get(year) ?? [];
      arr.push(perShare.toNumber());
      perShareByYear.set(year, arr);
    }

    // Per-share base: average per-payment over the trailing 24 months.
    // Using 24 months (not 12) ensures annual payers whose most recent payment
    // falls 12–24 months ago are still captured and not silently skipped.
    const basePayments = perShareAmounts.filter((p) => p.date >= cutoff24mo);
    if (basePayments.length === 0) continue;
    const basePerShareSum = basePayments.reduce(
      (s, p) => s.add(p.perShare),
      new Decimal(0),
    );
    const perSharePerPayment = basePerShareSum.div(basePayments.length);

    // Infer cadence from recent dates (trailing 24 months).
    const recentDates = sorted
      .filter((e) => e.executedAt >= cutoff24mo)
      .map((e) => e.executedAt);
    const intervalMonths = inferIntervalMonths(recentDates);

    // Growth factor for the next-year window.
    const growthFactor = applyGrowth ? computeGrowthFactor(perShareByYear) : 1.0;
    const growthApplied =
      Math.abs(growthFactor - 1.0) > 0.001 ? growthFactor : undefined;
    const source: "flat" | "grown" = growthApplied !== undefined ? "grown" : "flat";

    // Accumulation rate (shares/month) for this instrument.
    const accRate = opts.accumulation
      ? new Decimal(opts.accumulation.get(instrumentId) ?? "0")
      : new Decimal(0);
    const hasAccumulation = accRate.gt(0);

    // Generate future payment dates from the most recent payment anchor.
    const lastPayment = sorted[sorted.length - 1].executedAt;
    let d = addUTCMonths(lastPayment, intervalMonths);
    // Step forward until we enter the target window.
    while (d <= windowStart) {
      d = addUTCMonths(d, intervalMonths);
    }
    // Emit one entry per generated date within the window.
    while (d <= windowEnd) {
      const monthsAhead = Math.max(0, monthsBetween(now, d));
      const projectedQty = hasAccumulation
        ? currentQty.add(accRate.mul(monthsAhead))
        : currentQty;
      const amount = perSharePerPayment.mul(growthFactor).mul(projectedQty);

      out.push({
        instrumentId,
        symbol: entries[0].symbol ?? null,
        name: entries[0].name ?? null,
        date: d.toISOString().slice(0, 10),
        amount: amount.toString(),
        currency: entries[0].currency,
        basisYear: currentYear,
        source,
        growthApplied,
        assumesContributions: hasAccumulation ? true : undefined,
      });

      d = addUTCMonths(d, intervalMonths);
    }
  }

  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** Trailing dividend/coupon income per instrument since `since`, in display currency. */
export function trailingIncomeByInstrument(
  txns: {
    instrumentId: string | null;
    type: string;
    price: string;
    currency: string;
    executedAt: Date;
  }[],
  since: Date,
  displayCurrency: string,
  fx: FxRateFn = () => "1",
): Record<string, string> {
  const acc: Record<string, Decimal> = {};
  for (const t of txns) {
    if (
      (t.type === "dividend" || t.type === "coupon") &&
      t.instrumentId &&
      t.executedAt >= since
    ) {
      const amt = convert(t.price, t.currency, displayCurrency, fx);
      acc[t.instrumentId] = (acc[t.instrumentId] ?? new Decimal(0)).add(amt);
    }
  }
  return Object.fromEntries(
    Object.entries(acc).map(([k, v]) => [k, v.toString()]),
  );
}

/** Trailing yield = trailing income ÷ market value, or null when value is zero. */
export function trailingYield(
  trailingIncome: string,
  marketValue: string,
): string | null {
  const mv = new Decimal(marketValue);
  if (mv.isZero()) return null;
  return new Decimal(trailingIncome).div(mv).toString();
}

/** One dividend/coupon cash event, enriched with the instrument's metadata. */
export interface IncomeEntry {
  instrumentId: string | null;
  symbol?: string | null;
  name?: string | null;
  assetClass?: string | null;
  type: string; // "dividend" | "coupon"
  price: string; // amount in `currency`
  currency: string;
  executedAt: Date;
}

export interface YearIncome {
  year: string;
  total: string;
  paymentCount: number;
}
export interface MonthIncome {
  month: string; // YYYY-MM
  total: string;
}
export interface InstrumentIncome {
  instrumentId: string | null;
  symbol: string | null;
  name: string | null;
  total: string;
  /** Share of lifetime income, as a fraction (0–1). */
  pct: number;
}
export interface AssetClassIncome {
  assetClass: string;
  total: string;
  pct: number;
}
export interface CurrencyIncome {
  currency: string;
  /** Sum in the currency's own units (pre-FX). */
  totalNative: string;
  /** Sum FX-converted to the display currency. */
  totalNormalized: string;
}

/** Aggregated dividend/coupon analytics, all monetary fields in display currency. */
export interface IncomeStats {
  byYear: YearIncome[]; // ascending
  monthly: MonthIncome[]; // ascending, only months with income
  ttm: string; // trailing 12 months
  thisYear: string; // current calendar year
  lastYear: string;
  deltaAbs: string; // thisYear − lastYear
  deltaPct: number | null; // null when lastYear is zero
  forecastNextYear: string; // projected coupons + TTM dividend run-rate
  /** Projected income from now to Dec 31 of the current year. */
  forecastRestOfYear: string;
  /** thisYear actuals + forecastRestOfYear (complete current-year outlook). */
  forecastFullYear: string;
  lifetimeTotal: string;
  byInstrument: InstrumentIncome[]; // descending by total
  byAssetClass: AssetClassIncome[]; // descending by total
  byCurrency: CurrencyIncome[]; // descending by normalized total
  paymentCount: number;
  averagePerPayment: string;
}

export interface AggregateIncomeInput {
  events: IncomeEntry[];
  displayCurrency: string;
  fx?: FxRateFn;
  now?: Date;
  /**
   * Coupons projected for the next 12 months (native currency). FX-normalized and
   * combined with the trailing-12-month dividend run-rate to forecast next year.
   */
  forecastCoupons?: { amount: string; currency: string }[];
  /**
   * Bond coupons due between now and Dec 31 of the current year (native currency).
   * Used in `forecastRestOfYear`.
   */
  restOfYearCoupons?: { amount: string; currency: string }[];
  /**
   * Dividends projected from last year's actual payments in the same calendar
   * window (now → Dec 31), scaled by quantity change (native currency).
   * Used in `forecastRestOfYear`.
   */
  projectedDividends?: { amount: string; currency: string }[];
  /**
   * Dividends projected for the full next calendar year by the cadence/growth engine
   * (native currency). When provided, `forecastNextYear` is computed from these
   * events + `forecastCoupons`. When absent, the TTM dividend run-rate is used as
   * a fallback (backward-compatible behaviour).
   */
  projectedDividendsNextYear?: { amount: string; currency: string }[];
  /** Current holding quantities (decimal string) keyed by instrument ID. */
  heldQty?: Map<string, string>;
  /** Function to get holding quantity (decimal string) at a historical date. */
  qtyAt?: (instrumentId: string, at: Date) => string;
}

const ZERO = () => new Decimal(0);

/**
 * Aggregate dividend/coupon cash events into the analytics the income page renders:
 * per-year and per-month totals, trailing-12-month income, this-vs-last-year delta, a
 * next-year forecast (exact projected coupons + trailing dividend run-rate), lifetime
 * cumulative, and breakdowns by holding, asset class, and currency. Amounts are
 * FX-converted to `displayCurrency`; `byCurrency` also keeps the pre-FX native sums.
 */
export function aggregateIncome(input: AggregateIncomeInput): IncomeStats {
  const { events, displayCurrency } = input;
  const fx: FxRateFn = input.fx ?? (() => "1");
  const now = input.now ?? new Date();

  const ttmStart = new Date(now);
  ttmStart.setUTCFullYear(ttmStart.getUTCFullYear() - 1);
  const currentYear = now.getUTCFullYear();

  const byYear = new Map<string, { total: Decimal; count: number }>();
  const byMonth = new Map<string, Decimal>();
  const byInstrument = new Map<
    string,
    { symbol: string | null; name: string | null; total: Decimal }
  >();
  const byClass = new Map<string, Decimal>();
  const byCurrency = new Map<string, { native: Decimal; normalized: Decimal }>();

  let lifetime = ZERO();
  let ttm = ZERO();
  let ttmDividends = ZERO();
  let thisYear = ZERO();
  let lastYear = ZERO();

  for (const e of events) {
    const amount = new Decimal(convert(e.price, e.currency, displayCurrency, fx));
    const year = String(e.executedAt.getUTCFullYear());
    const month = e.executedAt.toISOString().slice(0, 7);

    lifetime = lifetime.add(amount);

    const y = byYear.get(year) ?? { total: ZERO(), count: 0 };
    byYear.set(year, { total: y.total.add(amount), count: y.count + 1 });

    byMonth.set(month, (byMonth.get(month) ?? ZERO()).add(amount));

    const instKey = e.instrumentId ?? "—";
    const inst = byInstrument.get(instKey) ?? {
      symbol: e.symbol ?? null,
      name: e.name ?? null,
      total: ZERO(),
    };
    byInstrument.set(instKey, { ...inst, total: inst.total.add(amount) });

    const cls = e.assetClass ?? "equity";
    byClass.set(cls, (byClass.get(cls) ?? ZERO()).add(amount));

    const cur = byCurrency.get(e.currency) ?? { native: ZERO(), normalized: ZERO() };
    byCurrency.set(e.currency, {
      native: cur.native.add(e.price),
      normalized: cur.normalized.add(amount),
    });

    if (e.executedAt >= ttmStart) {
      ttm = ttm.add(amount);
      if (e.type === "dividend") {
        let scaledAmount = amount;
        if (e.instrumentId && input.heldQty) {
          const currentQtyStr = input.heldQty.get(e.instrumentId);
          if (currentQtyStr) {
            const currentQty = new Decimal(currentQtyStr);
            const histQtyStr = input.qtyAt ? input.qtyAt(e.instrumentId, e.executedAt) : "0";
            const histQty = new Decimal(histQtyStr);
            if (histQty.gt(0)) {
              scaledAmount = amount.mul(currentQty).div(histQty);
            }
          } else {
            scaledAmount = ZERO();
          }
        }
        ttmDividends = ttmDividends.add(scaledAmount);
      }
    }
    if (e.executedAt.getUTCFullYear() === currentYear) thisYear = thisYear.add(amount);
    else if (e.executedAt.getUTCFullYear() === currentYear - 1)
      lastYear = lastYear.add(amount);
  }

  const pct = (v: Decimal) => (lifetime.isZero() ? 0 : v.div(lifetime).toNumber());
  const deltaAbs = thisYear.sub(lastYear);
  const couponForecast = (input.forecastCoupons ?? []).reduce(
    (s, c) => s.add(convert(c.amount, c.currency, displayCurrency, fx)),
    ZERO(),
  );
  // Next-year dividend forecast: use the cadence/growth engine output when provided;
  // fall back to the TTM scalar for backward compatibility (e.g. in unit tests that
  // don't provide projectedDividendsNextYear).
  const nextYearDividendForecast =
    input.projectedDividendsNextYear !== undefined
      ? input.projectedDividendsNextYear.reduce(
          (s, d) => s.add(convert(d.amount, d.currency, displayCurrency, fx)),
          ZERO(),
        )
      : ttmDividends;
  const forecast = nextYearDividendForecast.add(couponForecast);

  const restOfYearCouponSum = (input.restOfYearCoupons ?? []).reduce(
    (s, c) => s.add(convert(c.amount, c.currency, displayCurrency, fx)),
    ZERO(),
  );
  const projectedDividendSum = (input.projectedDividends ?? []).reduce(
    (s, d) => s.add(convert(d.amount, d.currency, displayCurrency, fx)),
    ZERO(),
  );
  const forecastRestOfYear = restOfYearCouponSum.add(projectedDividendSum);
  const forecastFullYear = thisYear.add(forecastRestOfYear);

  const count = events.length;

  return {
    byYear: [...byYear.entries()]
      .map(([year, v]) => ({ year, total: v.total.toString(), paymentCount: v.count }))
      .sort((a, b) => a.year.localeCompare(b.year)),
    monthly: [...byMonth.entries()]
      .map(([month, total]) => ({ month, total: total.toString() }))
      .sort((a, b) => a.month.localeCompare(b.month)),
    ttm: ttm.toString(),
    thisYear: thisYear.toString(),
    lastYear: lastYear.toString(),
    deltaAbs: deltaAbs.toString(),
    deltaPct: lastYear.isZero() ? null : deltaAbs.div(lastYear).toNumber(),
    forecastNextYear: forecast.toString(),
    forecastRestOfYear: forecastRestOfYear.toString(),
    forecastFullYear: forecastFullYear.toString(),
    lifetimeTotal: lifetime.toString(),
    byInstrument: [...byInstrument.entries()]
      .map(([instrumentId, v]) => ({
        instrumentId: instrumentId === "—" ? null : instrumentId,
        symbol: v.symbol,
        name: v.name,
        total: v.total.toString(),
        pct: pct(v.total),
      }))
      .sort((a, b) => Number(b.total) - Number(a.total)),
    byAssetClass: [...byClass.entries()]
      .map(([assetClass, total]) => ({
        assetClass,
        total: total.toString(),
        pct: pct(total),
      }))
      .sort((a, b) => Number(b.total) - Number(a.total)),
    byCurrency: [...byCurrency.entries()]
      .map(([currency, v]) => ({
        currency,
        totalNative: v.native.toString(),
        totalNormalized: v.normalized.toString(),
      }))
      .sort((a, b) => Number(b.totalNormalized) - Number(a.totalNormalized)),
    paymentCount: count,
    averagePerPayment: count > 0 ? lifetime.div(count).toString() : "0",
  };
}
