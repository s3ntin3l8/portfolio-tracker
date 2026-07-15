import type { FastifyInstance } from "fastify";
import { Decimal } from "decimal.js";
import { and, eq, inArray } from "drizzle-orm";
import { dividendEvents, instruments } from "@portfolio/db";
import {
  computeHoldings,
  trailingIncomeByInstrument,
  trailingYield,
  aggregateIncome,
  projectCoupons,
  projectDividends,
  projectNextYearDividends,
  type CoreTransaction,
  type PortfolioSummary,
  convert,
} from "@portfolio/core";
import { getFxRates, makeFxRateFn } from "../../services/fx.js";
import { corporateActionsFor, instrumentMeta } from "./shared.js";

export async function buildIncomeStats(
  app: FastifyInstance,
  coreTxns: CoreTransaction[],
  summary: PortfolioSummary,
  display: string,
  portfolioIdOf?: (txId: string) => string | undefined,
) {
  const now = new Date();
  const incomeTxns = coreTxns.filter((t) => t.type === "dividend" || t.type === "coupon");
  const interestTxns = coreTxns.filter((t) => t.type === "interest");

  const ccys = [...new Set([...incomeTxns, ...interestTxns].map((t) => t.currency))];
  const rates = await getFxRates(app.db, ccys, display);
  const fx = makeFxRateFn(rates, display);

  const meta = await instrumentMeta(app, [
    ...incomeTxns.map((t) => t.instrumentId),
    ...summary.holdings.map((h) => h.instrumentId),
  ]);

  const enriched = incomeTxns
    .map((t) => {
      const im = t.instrumentId ? meta.get(t.instrumentId) : undefined;
      return {
        transactionId: t.id ?? null,
        portfolioId: (t.id && portfolioIdOf?.(t.id)) ?? null,
        instrumentId: t.instrumentId,
        symbol: im?.symbol ?? null,
        name: im?.name ?? null,
        displayName: im?.displayName ?? null,
        assetClass: im?.assetClass ?? null,
        type: t.type,
        date: t.executedAt.toISOString().slice(0, 10),
        price: t.price,
        currency: t.currency,
        executedAt: t.executedAt,
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date));

  const since = new Date(now);
  since.setUTCFullYear(since.getUTCFullYear() - 1);
  const trailing = trailingIncomeByInstrument(coreTxns, since, display, fx);

  const sumInterest = (rows: typeof interestTxns) =>
    rows
      .reduce(
        (sum, t) => sum.plus(new Decimal(convert(t.price, t.currency, display, fx))),
        new Decimal(0),
      )
      .toString();
  const interest = {
    ytd: sumInterest(
      interestTxns.filter((t) => t.executedAt.getUTCFullYear() === now.getUTCFullYear()),
    ),
    ttm: sumInterest(interestTxns.filter((t) => t.executedAt >= since)),
    lifetime: sumInterest(interestTxns),
    currency: display,
  };

  const yields = summary.holdings
    .filter(
      (h) =>
        h.marketValueDisplay !== null &&
        Number(h.marketValueDisplay) !== 0 &&
        Number(trailing[h.instrumentId] ?? 0) > 0,
    )
    .map((h) => {
      const trailingIncome = trailing[h.instrumentId] ?? "0";
      const im = meta.get(h.instrumentId);
      const marketValue = h.marketValueDisplay as string;
      const costBasis = h.costBasisDisplay;
      return {
        instrumentId: h.instrumentId,
        symbol: im?.symbol ?? "—",
        name: im?.name ?? null,
        displayName: im?.displayName ?? null,
        assetClass: im?.assetClass ?? null,
        trailingIncome,
        marketValue,
        costBasis,
        yield: trailingYield(trailingIncome, marketValue),
        yieldOnCost: trailingYield(trailingIncome, costBasis),
        currency: display,
      };
    })
    .sort((a, b) => Number(b.yield ?? 0) - Number(a.yield ?? 0));

  const heldIds = summary.holdings.map((h) => h.instrumentId);
  const bondRows = heldIds.length
    ? await app.db
        .select()
        .from(instruments)
        .where(and(inArray(instruments.id, heldIds), eq(instruments.assetClass, "bond")))
    : [];
  const qtyById = new Map(summary.holdings.map((h) => [h.instrumentId, h.quantity]));
  const positions = bondRows
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
  const upcomingCoupons12mo = projectCoupons(positions, 12, now);
  const yearEnd = new Date(Date.UTC(now.getUTCFullYear(), 11, 31, 23, 59, 59, 999));
  const restOfYearCoupons = projectCoupons(positions, yearEnd, now);

  const corpActions = await corporateActionsFor(app, heldIds);
  const heldQtyMap = new Map(
    summary.holdings
      .filter((h) => Number(h.quantity) > 0)
      .map((h) => [h.instrumentId, h.quantity]),
  );
  const holdingsCache = new Map<number, Map<string, string>>();
  const qtyAt = (instrumentId: string, at: Date): string => {
    const key = at.getTime();
    if (!holdingsCache.has(key)) {
      const hs = computeHoldings(coreTxns, corpActions, at);
      holdingsCache.set(key, new Map(hs.map((h) => [h.instrumentId, h.quantity])));
    }
    return holdingsCache.get(key)!.get(instrumentId) ?? "0";
  };
  const pastDivs = enriched.filter((e) => e.type === "dividend");

  const accCutoff = new Date(now);
  accCutoff.setUTCFullYear(accCutoff.getUTCFullYear() - 1);
  const sharesAccumulated = new Map<string, number>();
  for (const t of coreTxns) {
    if (
      (t.type !== "buy" && t.type !== "savings_plan") ||
      t.kind === "saveback" ||
      !t.instrumentId ||
      t.executedAt < accCutoff
    )
      continue;
    sharesAccumulated.set(
      t.instrumentId,
      (sharesAccumulated.get(t.instrumentId) ?? 0) + Number(t.quantity),
    );
  }
  const accumulation = new Map<string, string>(
    [...sharesAccumulated.entries()].map(([id, total]) => [
      id,
      String(total / 12),
    ]),
  );

  const projectedDividends = projectDividends(pastDivs, heldQtyMap, qtyAt, now, {
    accumulation,
  });

  const projectedNextYear = projectNextYearDividends(
    pastDivs,
    heldQtyMap,
    qtyAt,
    now,
    { accumulation, applyGrowth: true },
  );

  const todayStr = now.toISOString().slice(0, 10);
  const nextYearEndStr = new Date(
    Date.UTC(now.getUTCFullYear() + 1, 11, 31),
  )
    .toISOString()
    .slice(0, 10);
  const announcedRows =
    heldIds.length > 0
      ? await app.db
          .select()
          .from(dividendEvents)
          .where(inArray(dividendEvents.instrumentId, heldIds))
      : [];

  const futureAnnouncedByInstrument = new Map<
    string,
    {
      exDate: string;
      amount: string;
      currency: string;
      status: "announced" | "paid";
      perShare: string;
      quantity: string;
    }[]
  >();
  for (const row of announcedRows) {
    const qty = heldQtyMap.get(row.instrumentId);
    if (!qty) continue;
    const totalAmount = String(Number(row.amountPerShare) * Number(qty));
    const list = futureAnnouncedByInstrument.get(row.instrumentId) ?? [];
    list.push({
      exDate: row.exDate,
      amount: totalAmount,
      currency: row.currency,
      status: row.status,
      perShare: row.amountPerShare,
      quantity: qty,
    });
    futureAnnouncedByInstrument.set(row.instrumentId, list);
  }

  const yearEndStr = new Date(Date.UTC(now.getUTCFullYear(), 11, 31))
    .toISOString()
    .slice(0, 10);
  const instrumentsWithAnnouncedRestOfYear = new Set(
    [...futureAnnouncedByInstrument.entries()]
      .filter(([_, rows]) =>
        rows.some((r) => r.exDate > todayStr && r.exDate <= yearEndStr),
      )
      .map(([id]) => id),
  );
  const blendedProjected = projectedDividends.filter(
    (d) => d.instrumentId && !instrumentsWithAnnouncedRestOfYear.has(d.instrumentId),
  );
  const futureAnnouncedRestOfYear = [...futureAnnouncedByInstrument.values()]
    .flat()
    .filter((d) => d.exDate > todayStr && d.exDate <= yearEndStr);
  const allRestOfYearDividends = [
    ...blendedProjected.map((d) => ({ amount: d.amount, currency: d.currency })),
    ...futureAnnouncedRestOfYear.map((d) => ({ amount: d.amount, currency: d.currency })),
  ];

  const instrumentsWithAnnouncedNextYear = new Set(
    [...futureAnnouncedByInstrument.entries()]
      .filter(([_, rows]) =>
        rows.some((r) => r.exDate > yearEndStr && r.exDate <= nextYearEndStr),
      )
      .map(([id]) => id),
  );
  const blendedNextYear = projectedNextYear.filter(
    (d) => d.instrumentId && !instrumentsWithAnnouncedNextYear.has(d.instrumentId),
  );
  const futureAnnouncedNextYear = [...futureAnnouncedByInstrument.values()]
    .flat()
    .filter((d) => d.exDate > yearEndStr && d.exDate <= nextYearEndStr);
  const allNextYearDividends = [
    ...blendedNextYear.map((d) => ({ amount: d.amount, currency: d.currency })),
    ...futureAnnouncedNextYear.map((d) => ({ amount: d.amount, currency: d.currency })),
  ];

  const stats = aggregateIncome({
    events: enriched,
    displayCurrency: display,
    fx,
    now,
    forecastCoupons: upcomingCoupons12mo,
    restOfYearCoupons,
    projectedDividends: allRestOfYearDividends,
    projectedDividendsNextYear: allNextYearDividends,
    heldQty: heldQtyMap,
    qtyAt,
  });

  const threeYearsAgo = new Date(now);
  threeYearsAgo.setUTCFullYear(threeYearsAgo.getUTCFullYear() - 3);
  const events = enriched
    .filter((e) => e.executedAt >= threeYearsAgo)
    .map((e) => {
      let perShare: string | undefined;
      let quantity: string | undefined;
      if (e.type === "dividend" && e.instrumentId) {
        const q = qtyAt(e.instrumentId, e.executedAt);
        const qNum = Number(q);
        if (qNum > 0) {
          perShare = String(Number(e.price) / qNum);
          quantity = q;
        }
      }
      return {
        transactionId: e.transactionId,
        portfolioId: e.portfolioId,
        instrumentId: e.instrumentId,
        symbol: e.symbol,
        name: e.name,
        displayName: e.displayName ?? null,
        type: e.type,
        date: e.date,
        amount: e.price,
        currency: e.currency,
        perShare,
        quantity,
      };
    });

  const upcomingAnnounced: {
    instrumentId: string;
    symbol: string;
    name: string | null;
    displayName: string | null;
    date: string;
    amount: string;
    currency: string;
    kind: "dividend";
    status: "announced" | "paid";
    perShare: string;
    quantity: string;
  }[] = [];
  for (const [instrumentId, entries] of futureAnnouncedByInstrument) {
    const im = meta.get(instrumentId);
    for (const entry of entries) {
      if (entry.exDate <= todayStr || entry.exDate > nextYearEndStr) continue;
      upcomingAnnounced.push({
        instrumentId,
        symbol: im?.symbol ?? "",
        name: im?.name ?? null,
        displayName: im?.displayName ?? null,
        date: entry.exDate,
        amount: entry.amount,
        currency: entry.currency,
        kind: "dividend",
        status: entry.status,
        perShare: entry.perShare,
        quantity: entry.quantity,
      });
    }
  }

  const upcoming = [
    ...upcomingCoupons12mo.map((c) => ({
      instrumentId: c.instrumentId,
      symbol: c.symbol,
      name: c.name,
      date: c.date,
      amount: c.amount,
      currency: c.currency,
      kind: "coupon" as const,
      status: "scheduled" as const,
      growthApplied: undefined as number | undefined,
      assumesContributions: undefined as boolean | undefined,
      perShare: undefined as string | undefined,
      quantity: undefined as string | undefined,
    })),
    ...blendedProjected.map((d) => ({
      instrumentId: d.instrumentId,
      symbol: d.symbol ?? "",
      name: d.name,
      date: d.date,
      amount: d.amount,
      currency: d.currency,
      kind: "dividend" as const,
      status: "projected" as const,
      growthApplied: undefined as number | undefined,
      assumesContributions: d.assumesContributions,
      perShare: d.perShare,
      quantity: d.quantity,
    })),
    ...blendedNextYear.map((d) => ({
      instrumentId: d.instrumentId,
      symbol: d.symbol ?? "",
      name: d.name,
      date: d.date,
      amount: d.amount,
      currency: d.currency,
      kind: "dividend" as const,
      status: (d.source === "grown" ? "grown" : "projected") as
        | "projected"
        | "grown",
      growthApplied: d.growthApplied,
      assumesContributions: d.assumesContributions,
      perShare: d.perShare,
      quantity: d.quantity,
    })),
    ...upcomingAnnounced.map((d) => ({
      ...d,
      growthApplied: undefined as number | undefined,
      assumesContributions: undefined as boolean | undefined,
    })),
  ].sort((a, b) => a.date.localeCompare(b.date));

  const threeYearsAgoStr = threeYearsAgo.toISOString().slice(0, 7);
  const monthly = stats.monthly.filter((m) => m.month >= threeYearsAgoStr);

  return { displayCurrency: display, ...stats, monthly, yields, upcoming, events, interest };
}
