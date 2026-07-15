import { Decimal } from "decimal.js";

const D = (v: string | number) => new Decimal(v);
const ZERO = new Decimal(0);

export interface NetWorthPoint {
  date: string;
  netWorth: string;
}

export interface DrawdownResult {
  maxDrawdownPct: string;
  peakDate: string | null;
  troughDate: string | null;
  recoveryDate?: string;
  recoveryDays?: number;
  currentDrawdownPct: string;
}

export function maxDrawdown(series: NetWorthPoint[]): DrawdownResult {
  if (series.length === 0) {
    return { maxDrawdownPct: "0", peakDate: null, troughDate: null, currentDrawdownPct: "0" };
  }

  let peak = D(series[0].netWorth);
  let peakDate = series[0].date;
  let maxDd = ZERO;
  let maxDdPeakDate = series[0].date;
  let maxDdTroughDate = series[0].date;
  let peakAtMaxDd = peak; // value at the peak that produced max drawdown

  const lastValue = D(series[series.length - 1].netWorth);

  for (const point of series) {
    const value = D(point.netWorth);
    if (value.gt(peak)) {
      peak = value;
      peakDate = point.date;
    }
    const dd = value.div(peak).sub(1);
    if (dd.lt(maxDd)) {
      maxDd = dd;
      maxDdPeakDate = peakDate;
      maxDdTroughDate = point.date;
      peakAtMaxDd = peak;
    }
  }

  const currentDrawdown = lastValue.div(peak).sub(1);

  if (maxDd.isZero()) {
    return {
      maxDrawdownPct: "0",
      peakDate: series[0].date,
      troughDate: series[0].date,
      currentDrawdownPct: currentDrawdown.toString(),
    };
  }

  const peakValue = peakAtMaxDd;
  let recoveryDate: string | undefined;
  for (const point of series) {
    const value = D(point.netWorth);
    if (value.gte(peakValue) && point.date > maxDdTroughDate) {
      recoveryDate = point.date;
      break;
    }
  }

  let recoveryDays: number | undefined;
  if (recoveryDate) {
    const trough = new Date(maxDdTroughDate);
    const recovery = new Date(recoveryDate);
    recoveryDays = Math.round((recovery.getTime() - trough.getTime()) / 86_400_000);
  }

  return {
    maxDrawdownPct: maxDd.toString(),
    peakDate: maxDdPeakDate,
    troughDate: maxDdTroughDate,
    ...(recoveryDate ? { recoveryDate, recoveryDays } : {}),
    currentDrawdownPct: currentDrawdown.toString(),
  };
}
