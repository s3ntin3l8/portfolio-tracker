import { Decimal } from "decimal.js";
import { convert, type FxRateFn } from "./networth.js";

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
 * Project the coupon payments due on held bonds within `horizonMonths`.
 * Coupon dates are anchored to the maturity date and stepped back by the payment
 * interval; each amount is `faceValue × quantity × couponRate ÷ periodsPerYear`.
 */
export function projectCoupons(
  positions: BondPosition[],
  horizonMonths = 12,
  now: Date = new Date(),
): ProjectedCoupon[] {
  const horizonEnd = new Date(now);
  horizonEnd.setUTCMonth(horizonEnd.getUTCMonth() + horizonMonths);

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
      if (e.type === "dividend") ttmDividends = ttmDividends.add(amount);
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
  const forecast = ttmDividends.add(couponForecast);
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
