import { txAmountDisplay, txNetAmountDisplay, type TxRow } from "@/components/transactions-table";
import { formatMoneyCompact, formatPercent } from "@/lib/utils";

/** Cash-in transaction types that count as "income" for the Activity banners — dividends,
 *  bond coupons, cash interest, and broker cash bonuses (same set the Income screen treats
 *  as recurring income, minus corporate-action share bonuses which carry no cash). Exported
 *  so `TransactionsTable` can classify its `typeFilter` selection the same way. */
export const ACTIVITY_INCOME_TYPES = new Set(["dividend", "coupon", "interest", "bonus_cash"]);
const INCOME_TYPES = ACTIVITY_INCOME_TYPES;

/** A single "dot + label + mini progress bar + right-aligned value" breakdown row, shared by
 *  all three Activity filter banners. */
export interface FlowMixRow {
  label: string;
  value: string;
  /** Bar width, 0-100. */
  pct: number;
  color: string;
}

const PALETTE = ["#0E9F6E", "#0D9488", "#7C5CFC", "#E0A53A", "#64748B"];

/** Sum is display-only (a banner footer, not a ledger figure) so it reuses the same plain-
 *  number `txAmountDisplay`/`txNetAmountDisplay` helpers the table's own Amount/Net Amount
 *  columns build on, rather than introducing a new Decimal dependency into the web app for
 *  this. Each row is already converted into the scope currency (its own trade-date FX rate,
 *  server-computed — see `TxRow.displayRate`), so every transaction contributes regardless
 *  of which currency it was made in (#465: banners used to silently drop non-dominant-
 *  currency rows from both the total and the count). */
function sumBy(rows: TxRow[], amount: (r: TxRow) => number): number {
  return rows.reduce((s, r) => s + amount(r), 0);
}

function barPct(value: number, max: number): number {
  if (max <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((value / max) * 100)));
}

/** This calendar year's net income to date, plus the year-over-year trend vs. the same
 *  Jan-1-to-today window last year (null when there's no comparable base). Shared by the
 *  "All" banner's Income tile and the "Income" banner's headline, so the two never disagree. */
function yoyIncome(incomeRows: TxRow[], now: Date): { ytdTotal: number; trendPct: number | null } {
  const year = now.getFullYear();
  const ytdRows = incomeRows.filter((r) => new Date(r.executedAt).getFullYear() === year);
  const ytdTotal = sumBy(ytdRows, txNetAmountDisplay);

  const lastYearCutoff = new Date(now);
  lastYearCutoff.setFullYear(year - 1);
  const lastYearRows = incomeRows.filter((r) => {
    const d = new Date(r.executedAt);
    return d.getFullYear() === year - 1 && d <= lastYearCutoff;
  });
  const lastYearTotal = sumBy(lastYearRows, txNetAmountDisplay);
  const trendPct = lastYearTotal !== 0 ? (ytdTotal - lastYearTotal) / Math.abs(lastYearTotal) : null;
  return { ytdTotal, trendPct };
}

export interface AllBannerData {
  currency: string;
  tiles: Array<{ label: string; value: string; sub: string; tone: "up" | "down" | "neutral" }>;
  mix: FlowMixRow[];
}

/**
 * The "All" filter banner: Invested / Proceeds (all-time buy/sell totals) + Income (current
 * calendar year, with a vs-last-year trend — matches {@link computeIncomeBanner}'s YTD figure)
 * tiles, plus a Buys/Sells/Income "cash flow mix" bar breakdown.
 */
export function computeAllBanner(
  rows: TxRow[],
  scopeCurrency: string,
  locale: string,
  labels: {
    invested: string;
    proceeds: string;
    incomeYtd: string;
    buysCount: (n: number) => string;
    sellsCount: (n: number) => string;
    vsLastYear: (pct: string) => string;
    buys: string;
    sells: string;
    income: string;
  },
  now: Date = new Date(),
): AllBannerData | null {
  if (rows.length === 0) return null;
  const buys = rows.filter((r) => r.type === "buy");
  const sells = rows.filter((r) => r.type === "sell");
  const incomeRows = rows.filter((r) => INCOME_TYPES.has(r.type));

  const investedTotal = sumBy(buys, txAmountDisplay);
  const proceedsTotal = sumBy(sells, txAmountDisplay);
  const { ytdTotal: incomeYtdTotal, trendPct } = yoyIncome(incomeRows, now);

  const money = (n: number) => formatMoneyCompact(n, scopeCurrency, locale);
  const max = Math.max(investedTotal, proceedsTotal, incomeYtdTotal, 1);

  return {
    currency: scopeCurrency,
    tiles: [
      { label: labels.invested, value: money(investedTotal), sub: labels.buysCount(buys.length), tone: "neutral" },
      { label: labels.proceeds, value: money(proceedsTotal), sub: labels.sellsCount(sells.length), tone: "neutral" },
      {
        label: labels.incomeYtd,
        value: money(incomeYtdTotal),
        sub: trendPct === null ? "" : labels.vsLastYear(formatPercent(trendPct, locale)),
        tone: trendPct === null ? "neutral" : trendPct >= 0 ? "up" : "down",
      },
    ],
    mix: [
      { label: labels.buys, value: money(investedTotal), pct: barPct(investedTotal, max), color: PALETTE[0] },
      { label: labels.sells, value: money(proceedsTotal), pct: barPct(proceedsTotal, max), color: PALETTE[1] },
      { label: labels.income, value: money(incomeYtdTotal), pct: barPct(incomeYtdTotal, max), color: PALETTE[3] },
    ],
  };
}

export interface IncomeBannerData {
  currency: string;
  ytd: string;
  trendLabel: string;
  trendTone: "up" | "down" | "neutral";
  projected: string;
  projectedNote: string;
  bySource: FlowMixRow[];
}

/**
 * The "Income" filter banner. "Received · YTD" is the current calendar year's net income to
 * date; "Projected · 12mo" is a trailing-12-month run-rate (the honest cheap proxy available
 * from data already on the page — not a real forecast model). "By source" splits the SAME
 * YTD total into dividends / coupons & interest / other, so it foots to the YTD figure above.
 */
export function computeIncomeBanner(
  rows: TxRow[],
  scopeCurrency: string,
  locale: string,
  labels: {
    vsLastYear: (pct: string) => string;
    new: string;
    perMonth: (amount: string) => string;
    dividends: string;
    couponsInterest: string;
    other: string;
  },
  now: Date = new Date(),
): IncomeBannerData | null {
  const incomeRows = rows.filter((r) => INCOME_TYPES.has(r.type));
  if (incomeRows.length === 0) return null;
  const money = (n: number) => formatMoneyCompact(n, scopeCurrency, locale);

  const { ytdTotal, trendPct } = yoyIncome(incomeRows, now);

  const trailingCutoff = new Date(now);
  trailingCutoff.setDate(trailingCutoff.getDate() - 365);
  const trailingRows = incomeRows.filter((r) => {
    const d = new Date(r.executedAt);
    return d >= trailingCutoff && d <= now;
  });
  const projectedTotal = sumBy(trailingRows, txNetAmountDisplay);

  const year = now.getFullYear();
  const ytdRows = incomeRows.filter((r) => new Date(r.executedAt).getFullYear() === year);
  const dividends = sumBy(ytdRows.filter((r) => r.type === "dividend"), txNetAmountDisplay);
  const coupons = sumBy(ytdRows.filter((r) => r.type === "coupon" || r.type === "interest"), txNetAmountDisplay);
  const other = sumBy(ytdRows.filter((r) => r.type === "bonus_cash"), txNetAmountDisplay);
  const sourceMax = Math.max(dividends, coupons, other, 1);
  const bySource: FlowMixRow[] = (
    [
      dividends > 0 && { label: labels.dividends, value: money(dividends), pct: barPct(dividends, sourceMax), color: PALETTE[0] },
      coupons > 0 && { label: labels.couponsInterest, value: money(coupons), pct: barPct(coupons, sourceMax), color: PALETTE[1] },
      other > 0 && { label: labels.other, value: money(other), pct: barPct(other, sourceMax), color: PALETTE[3] },
    ] as const
  ).filter((v): v is FlowMixRow => v !== false);

  return {
    currency: scopeCurrency,
    ytd: money(ytdTotal),
    trendLabel: trendPct === null ? labels.new : labels.vsLastYear(formatPercent(trendPct, locale)),
    trendTone: trendPct === null ? "neutral" : trendPct >= 0 ? "up" : "down",
    projected: money(projectedTotal),
    projectedNote: labels.perMonth(money(projectedTotal / 12)),
    bySource,
  };
}

export interface TradeBannerData {
  currency: string;
  total: string;
  count: number;
  avg: string;
  bySymbol: FlowMixRow[];
}

/**
 * The "Buys"/"Sells" filter banner: an all-time total + order count, an average-order
 * value, and a per-symbol breakdown (top 3 by amount) — mirrors the design's `_agg` helper.
 */
export function computeTradeBanner(
  rows: TxRow[],
  type: "buy" | "sell",
  scopeCurrency: string,
  locale: string,
): TradeBannerData | null {
  const typed = rows.filter((r) => r.type === type);
  if (typed.length === 0) return null;
  const money = (n: number) => formatMoneyCompact(n, scopeCurrency, locale);

  const total = sumBy(typed, txAmountDisplay);
  const count = typed.length;
  const avg = count > 0 ? total / count : 0;

  const bySymbol = new Map<string, number>();
  for (const r of typed) {
    const sym = r.instrument?.symbol ?? r.instrument?.name ?? "—";
    bySymbol.set(sym, (bySymbol.get(sym) ?? 0) + txAmountDisplay(r));
  }
  const top = [...bySymbol.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  const max = top.length > 0 ? top[0][1] : 1;

  return {
    currency: scopeCurrency,
    total: money(total),
    count,
    avg: money(avg),
    bySymbol: top.map(([sym, value], i) => ({
      label: sym,
      value: money(value),
      pct: barPct(value, max),
      color: PALETTE[i % PALETTE.length],
    })),
  };
}
