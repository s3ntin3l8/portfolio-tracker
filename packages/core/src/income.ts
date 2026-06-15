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
