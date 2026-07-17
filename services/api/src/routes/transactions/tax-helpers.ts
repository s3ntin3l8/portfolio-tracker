import type { FastifyInstance } from "fastify";
import { and, eq, inArray } from "drizzle-orm";
import { dividendEvents, instruments, lossCarryforward } from "@portfolio/db";
import type { CoreTransaction, PortfolioSummary, IncomeEntry } from "@portfolio/core";
import { cashFlow, projectCoupons, projectDividends, convert, toDateKey } from "@portfolio/core";
import { getFxRates, makeFxRateFn } from "../../services/fx.js";
import type { InstrumentMeta } from "../../services/valuation.js";

export async function lossCarryForwardFor(
  app: FastifyInstance,
  holderId: string,
  taxYear: number,
): Promise<{ stock?: string; general?: string }> {
  const rows = await app.db
    .select({ pot: lossCarryforward.pot, amount: lossCarryforward.amount })
    .from(lossCarryforward)
    .where(and(eq(lossCarryforward.holderId, holderId), eq(lossCarryforward.taxYear, taxYear)));
  const result: { stock?: string; general?: string } = {};
  for (const r of rows) {
    if (r.pot === "stock") result.stock = r.amount;
    else if (r.pot === "general") result.general = r.amount;
  }
  return result;
}

/**
 * Compute the gross rest-of-year (today → Dec 31) dividend + coupon income forecast for
 * one portfolio, in `display` currency.  Used by the tax endpoints to feed
 * `forecastIncomeRestOfYear` into `allowanceUsageYTD`.
 *
 * - Projected-from-history dividends are grossed up via each instrument's trailing-12-month
 *   withholding ratio (gross = net + tax, default ratio 1.0 when no withholding recorded).
 * - Announced dividend_events amounts and projected bond coupons are already gross.
 * - Returns "0" when `year` is not the current UTC calendar year.
 */
export async function restOfYearForecastGross(
  app: FastifyInstance,
  coreTxns: CoreTransaction[],
  summary: PortfolioSummary,
  display: string,
  year: number,
  now: Date = new Date(),
): Promise<string> {
  if (year !== now.getUTCFullYear()) return "0";

  const heldIds = summary.holdings.filter((h) => Number(h.quantity) > 0).map((h) => h.instrumentId);
  if (heldIds.length === 0) return "0";

  const heldQtyMap = new Map<string, string>(
    summary.holdings.filter((h) => Number(h.quantity) > 0).map((h) => [h.instrumentId, h.quantity]),
  );

  const qtyAt = (_instrumentId: string, _at: Date): string => heldQtyMap.get(_instrumentId) ?? "0";

  const pastDivEvents: IncomeEntry[] = coreTxns
    .filter((t) => t.type === "dividend" && t.instrumentId)
    .map((t) => ({
      instrumentId: t.instrumentId,
      symbol: null,
      name: null,
      assetClass: null,
      type: t.type,
      price: t.price,
      currency: t.currency,
      executedAt: t.executedAt,
    }));

  const yearAgo = new Date(now);
  yearAgo.setUTCFullYear(yearAgo.getUTCFullYear() - 1);
  const grossUpNet = new Map<string, number>();
  const grossUpTax = new Map<string, number>();
  for (const t of coreTxns) {
    if (t.type !== "dividend" || !t.instrumentId || t.executedAt < yearAgo) continue;
    const net = Number(cashFlow(t).toString());
    const tax = Number(t.tax ?? "0");
    if (net <= 0) continue;
    grossUpNet.set(t.instrumentId, (grossUpNet.get(t.instrumentId) ?? 0) + net);
    grossUpTax.set(t.instrumentId, (grossUpTax.get(t.instrumentId) ?? 0) + tax);
  }

  const projectedDivs = projectDividends(pastDivEvents, heldQtyMap, qtyAt, now);

  const todayStr = toDateKey(now);
  const yearEndStr = toDateKey(new Date(Date.UTC(now.getUTCFullYear(), 11, 31)));

  const announcedRows =
    heldIds.length > 0
      ? await app.db
          .select()
          .from(dividendEvents)
          .where(inArray(dividendEvents.instrumentId, heldIds))
      : [];

  const futureByInstrument = new Map<
    string,
    { exDate: string; amount: string; currency: string }[]
  >();
  for (const row of announcedRows) {
    const qty = heldQtyMap.get(row.instrumentId);
    if (!qty) continue;
    const totalAmount = String(Number(row.amountPerShare) * Number(qty));
    const list = futureByInstrument.get(row.instrumentId) ?? [];
    list.push({ exDate: row.exDate, amount: totalAmount, currency: row.currency });
    futureByInstrument.set(row.instrumentId, list);
  }

  const instrumentsWithAnnounced = new Set(
    [...futureByInstrument.entries()]
      .filter(([_, rows]) => rows.some((r) => r.exDate > todayStr && r.exDate <= yearEndStr))
      .map(([id]) => id),
  );
  const blendedProjected = projectedDivs.filter(
    (d) => d.instrumentId && !instrumentsWithAnnounced.has(d.instrumentId!),
  );
  const announcedRestOfYear = [...futureByInstrument.values()]
    .flat()
    .filter((d) => d.exDate > todayStr && d.exDate <= yearEndStr);

  const bondRows =
    heldIds.length > 0
      ? await app.db
          .select()
          .from(instruments)
          .where(and(inArray(instruments.id, heldIds), eq(instruments.assetClass, "bond")))
      : [];
  const qtyById = new Map(summary.holdings.map((h) => [h.instrumentId, h.quantity]));
  const bondPositions = bondRows
    .filter((b) => b.faceValue && b.couponRate && b.maturityDate)
    .map((b) => ({
      instrumentId: b.id,
      symbol: b.symbol,
      name: b.name,
      quantity: qtyById.get(b.id) ?? "0",
      faceValue: b.faceValue as string,
      couponRate: b.couponRate as string,
      couponSchedule: b.couponSchedule,
      maturityDate: b.maturityDate as string,
      currency: b.currency,
    }));
  const yearEnd = new Date(Date.UTC(now.getUTCFullYear(), 11, 31, 23, 59, 59, 999));
  const restOfYearCoupons = projectCoupons(bondPositions, yearEnd, now);

  const allCcys = new Set<string>([
    ...blendedProjected.map((d) => d.currency),
    ...announcedRestOfYear.map((d) => d.currency),
    ...restOfYearCoupons.map((c) => c.currency),
  ]);
  if (allCcys.size === 0) return "0";

  const rates = await getFxRates(app.db, [...allCcys], display);
  const fx = makeFxRateFn(rates, display);

  let totalGross = 0;

  for (const d of blendedProjected) {
    const net = Number(convert(d.amount, d.currency, display, fx));
    const instrumentId = d.instrumentId!;
    const netSum = grossUpNet.get(instrumentId) ?? 0;
    const taxSum = grossUpTax.get(instrumentId) ?? 0;
    const ratio = netSum > 0 ? (netSum + taxSum) / netSum : 1.0;
    totalGross += net * ratio;
  }

  for (const d of announcedRestOfYear) {
    totalGross += Number(convert(d.amount, d.currency, display, fx));
  }

  for (const c of restOfYearCoupons) {
    totalGross += Number(convert(c.amount, c.currency, display, fx));
  }

  return totalGross > 0 ? totalGross.toFixed(2) : "0";
}

export function buildTfRates(
  trades: { instrumentId: string }[],
  metaById: Map<string, InstrumentMeta>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const t of trades) {
    const meta = metaById.get(t.instrumentId);
    if (!meta) continue;
    if (meta.partialExemptionRate !== null) {
      result[t.instrumentId] = meta.partialExemptionRate;
    } else if (meta.assetClass === "etf") {
      result[t.instrumentId] = "0.30";
    } else if (meta.assetClass === "mutual_fund") {
      result[t.instrumentId] = "0.15";
    }
  }
  return result;
}
