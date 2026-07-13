import type React from "react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Coins, ScrollText, PiggyBank, Receipt, FileText } from "lucide-react";
import { ReportCard } from "@/components/reports/report-card";
import { EmptyState } from "@/components/empty-state";
import {
  loadIncomeStats,
  loadTrades,
  loadContributions,
  loadNetworthTax,
  loadTaxYearDetail,
  loadPreferences,
  loadDocuments,
} from "@/lib/server-api";
import { formatMoney, formatMoneyCompact, formatPercent } from "@/lib/utils";
import type { TrendTone } from "@/components/reports/trend-chip";
import { indonesianFinalTax } from "@portfolio/core";

const ICONS = {
  income: { icon: Coins, bg: "rgba(14,159,110,.12)", fg: "#0E9F6E" },
  trades: { icon: ScrollText, bg: "rgba(224,165,58,.14)", fg: "var(--gold-fg)" },
  savings: { icon: PiggyBank, bg: "rgba(124,92,252,.12)", fg: "#7C5CFC" },
  tax: { icon: Receipt, bg: "rgba(13,148,136,.12)", fg: "var(--color-chart-3)" },
  documents: { icon: FileText, bg: "rgba(59,130,246,.12)", fg: "#3B82F6" },
} as const;

export default async function ReportsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("Reports");
  const te = await getTranslations("Empty");
  const openLabel = t("open");

  // loadPreferences() used to be awaited before anything else — a full serial round trip
  // blocking the whole page. The loaders that don't need costBasis/taxRegime are kicked
  // off immediately instead; only the two that do (loadTrades, loadNetworthTax) wait on it.
  const prefsPromise = loadPreferences();
  const incomePromise = loadIncomeStats();
  const contributionsPromise = loadContributions();
  const documentsPromise = loadDocuments("tax_report");

  const prefs = await prefsPromise;
  const costBasis = prefs?.costBasisMode ?? "purchase_price";
  const taxRegime = prefs?.taxRegime ?? "DE";

  const [income, trades, contributions, taxHolders, taxReports] = await Promise.all([
    incomePromise,
    // Cost basis is a single global preference — thread it in so this tile's
    // realized-P&L figures agree with Trades/Holdings.
    loadTrades(undefined, costBasis),
    contributionsPromise,
    loadNetworthTax(undefined, taxRegime),
    documentsPromise,
  ]);
  // Indonesian final tax needs the same disposals/dividendRows the Tax page itself
  // recomputes over (see tax/page.tsx) — only fetched when relevant, and only when
  // there's something to compute over.
  const idDetailByHolder =
    taxRegime === "ID" && taxHolders.length > 0
      ? await loadTaxYearDetail(taxHolders)
      : null;

  const cards: React.ReactNode[] = [];

  // ── Income ──────────────────────────────────────────────────────────────
  if (income.status === "ok") {
    const s = income.data;
    const currency = s.displayCurrency;
    const m = (n: number) => formatMoney(n, currency, locale);
    // The footer metrics sit three-up beside the "Open ›" link — the narrowest cells on
    // the card — so they get the compact form; the full-width headline above keeps
    // full precision.
    const mc = (n: number) => formatMoneyCompact(n, currency, locale);
    // Full-year outlook (actuals-to-date + rest-of-year forecast) vs last year, not just
    // actuals-to-date vs last year — matches the /income page's own headline delta.
    const lastYearTotal = Number(s.lastYear);
    const fullYearDeltaAbs = Number(s.forecastFullYear) - lastYearTotal;
    const deltaPct = lastYearTotal > 0 ? fullYearDeltaAbs / lastYearTotal : null;
    const deltaTone: TrendTone =
      deltaPct === null || deltaPct === 0 ? "neutral" : deltaPct > 0 ? "up" : "down";

    // Realized-to-date vs. forecasted-remainder, same green as the card icon — the
    // forecast segment is drawn as a diagonal-stripe hatch, matching the "Projected"
    // segment styling on the Income page's own per-year bar chart.
    // Tooltip labels are translated via the `Reports.income.tooltip*` keys
    // (added in the #478 review follow-up). Previously English literals were
    // passed inline with a TODO; the keys live alongside the rest of the
    // Reports-income strings for consistency.
    const thisYearAmt = Number(s.thisYear);
    const forecastFullYearAmt = Number(s.forecastFullYear);
    const remainingAmt = Math.max(0, forecastFullYearAmt - thisYearAmt);
    const splitBar =
      forecastFullYearAmt > 0
        ? [
            {
              pct: (thisYearAmt / forecastFullYearAmt) * 100,
              color: ICONS.income.fg,
              label: t("income.tooltipReceived"),
              amount: m(thisYearAmt),
            },
            {
              pct: (remainingAmt / forecastFullYearAmt) * 100,
              color: ICONS.income.fg,
              striped: true,
              label: t("income.tooltipForecast"),
              amount: m(remainingAmt),
            },
          ]
        : undefined;

    cards.push(
      <ReportCard
        key="income"
        icon={ICONS.income.icon}
        iconBg={ICONS.income.bg}
        iconFg={ICONS.income.fg}
        title={t("income.title")}
        trend={
          deltaPct !== null
            ? { label: t("income.trendVsLastYear", { pct: formatPercent(deltaPct, locale) }), tone: deltaTone, arrow: true }
            : undefined
        }
        value={m(Number(s.thisYear))}
        caption={t("income.caption")}
        splitBar={splitBar}
        metrics={[
          { label: t("income.captionEstimated"), value: mc(Number(s.forecastFullYear)) },
          { label: t("income.metricTtm"), value: mc(Number(s.ttm)) },
          { label: t("income.metricLifetime"), value: mc(Number(s.lifetimeTotal)) },
        ]}
        href="/income"
        openLabel={openLabel}
      />,
    );
  }

  // ── Realized P&L (trades) ────────────────────────────────────────────────
  if (trades.status === "ok" && trades.data.trades.length > 0) {
    const log = trades.data;
    const currency = log.displayCurrency;
    const m = (n: number) => formatMoney(n, currency, locale);
    const mc = (n: number) => formatMoneyCompact(n, currency, locale);
    const currentYear = new Date().getUTCFullYear();
    const ytdEntry = log.realizedByYear.find((y) => y.year === currentYear);
    // No entry for the current year means no trades closed this year — 0, not the
    // all-time total (a prior fallback here conflated the two whenever `realizedByYear`
    // had no current-year row, e.g. every closed trade was from an earlier year).
    const ytdRealized = ytdEntry ? Number(ytdEntry.amount) : 0;

    const closedTrades = log.trades.filter((tr) => tr.status === "closed");
    const winSum = closedTrades
      .filter((tr) => Number(tr.totalReturn) > 0)
      .reduce((sum, tr) => sum + Number(tr.totalReturn), 0);
    const lossSum = closedTrades
      .filter((tr) => Number(tr.totalReturn) < 0)
      .reduce((sum, tr) => sum + Math.abs(Number(tr.totalReturn)), 0);
    const totalAbs = winSum + lossSum;
    const splitBar =
      totalAbs > 0
        ? [
            {
              pct: (winSum / totalAbs) * 100,
              color: "var(--color-success)",
              label: t("trades.tooltipWins"),
              amount: m(winSum),
            },
            {
              pct: (lossSum / totalAbs) * 100,
              color: "var(--color-destructive)",
              label: t("trades.tooltipLosses"),
              amount: m(lossSum),
            },
          ]
        : undefined;
    const avgHoldingDays =
      closedTrades.length > 0
        ? Math.round(closedTrades.reduce((sum, tr) => sum + tr.avgHoldingDays, 0) / closedTrades.length)
        : null;

    cards.push(
      <ReportCard
        key="trades"
        icon={ICONS.trades.icon}
        iconBg={ICONS.trades.bg}
        iconFg={ICONS.trades.fg}
        title={t("trades.title")}
        trend={
          log.winRate !== null
            ? {
                label: t("trades.trend", { pct: formatPercent(log.winRate, locale).replace("+", "") }),
                tone: log.winRate >= 0.5 ? "up" : "down",
              }
            : undefined
        }
        value={m(ytdRealized)}
        caption={t("trades.caption")}
        splitBar={splitBar}
        metrics={[
          { label: t("trades.metricAllTime"), value: mc(Number(log.totalRealized)) },
          {
            label: t("trades.metricAvgHold"),
            value: avgHoldingDays !== null ? t("trades.days", { count: avgHoldingDays }) : "—",
          },
          { label: t("trades.metricClosed"), value: String(closedTrades.length) },
        ]}
        href="/trades"
        openLabel={openLabel}
      />,
    );
  }

  // ── Savings (contributions) ─────────────────────────────────────────────
  if (contributions.status === "ok") {
    const s = contributions.data;
    const currency = s.displayCurrency;
    const m = (n: number) => formatMoney(n, currency, locale);
    const mc = (n: number) => formatMoneyCompact(n, currency, locale);
    const netContributed = Number(s.netContributed);
    const currentValue = Number(s.currentValue);
    const gain = Math.max(0, currentValue - netContributed);
    const total = netContributed + gain;
    const splitBar =
      total > 0
        ? [
            {
              pct: (netContributed / total) * 100,
              color: "var(--color-chart-4)",
              label: t("savings.tooltipContributed"),
              amount: m(netContributed),
            },
            {
              pct: (gain / total) * 100,
              color: "var(--color-success)",
              label: t("savings.tooltipGain"),
              amount: m(gain),
            },
          ]
        : undefined;
    const totalReturnPct = s.totalReturnPct ?? s.simpleGainPct;

    cards.push(
      <ReportCard
        key="savings"
        icon={ICONS.savings.icon}
        iconBg={ICONS.savings.bg}
        iconFg={ICONS.savings.fg}
        title={t("savings.title")}
        trend={
          s.xirr !== null
            ? { label: t("savings.trend", { pct: formatPercent(s.xirr, locale) }), tone: s.xirr >= 0 ? "up" : "down" }
            : undefined
        }
        value={m(currentValue)}
        caption={t("savings.caption")}
        splitBar={splitBar}
        metrics={[
          { label: t("savings.metricMonthly"), value: mc(Number(s.monthlyAverage)) },
          {
            label: t("savings.metricReturn"),
            value: totalReturnPct !== null ? formatPercent(totalReturnPct, locale) : "—",
          },
        ]}
        href="/savings"
        openLabel={openLabel}
      />,
    );
  }

  // ── Tax ──────────────────────────────────────────────────────────────────
  if (taxRegime === "ID" && idDetailByHolder) {
    // Indonesian final tax: 0.1% on sale proceeds + 10% on dividend/coupon gross,
    // withheld at source — no Sparerpauschbetrag/Abgeltungsteuer headline here.
    // Same recompute-over-the-same-disposals approach as tax/page.tsx's ID branch.
    const currency = taxHolders[0]?.currency ?? "IDR";
    const m = (n: number) => formatMoney(n, currency, locale);
    const mc = (n: number) => formatMoneyCompact(n, currency, locale);
    let totalTax = 0;
    let totalProceeds = 0;
    let totalDividendGross = 0;
    for (const entry of taxHolders) {
      const detail = idDetailByHolder.get(entry.holder.id);
      if (!detail) continue;
      const idTax = indonesianFinalTax({
        disposals: detail.disposals.map((d) => ({ symbol: d.symbol, when: d.when, proceeds: d.proceeds })),
        dividends: detail.dividendRows.map((d) => ({ symbol: d.symbol, currency: d.currency, gross: d.gross })),
        byYear: [],
      });
      totalTax += Number(idTax.estimatedTax);
      totalProceeds += Number(idTax.totalProceeds);
      totalDividendGross += Number(idTax.totalDividendGross);
    }

    cards.push(
      <ReportCard
        key="tax"
        icon={ICONS.tax.icon}
        iconBg={ICONS.tax.bg}
        iconFg={ICONS.tax.fg}
        title={t("tax.title")}
        trend={{ label: t("tax.idTrend"), tone: "neutral" }}
        value={m(totalTax)}
        caption={t("tax.idCaption")}
        metrics={[
          { label: t("tax.idMetricSales"), value: mc(totalProceeds) },
          { label: t("tax.idMetricDividends"), value: mc(totalDividendGross) },
        ]}
        href="/tax"
        openLabel={openLabel}
      />,
    );
  } else if (taxHolders.length > 0) {
    // German Sparerpauschbetrag only — headline mirrors tax/page.tsx's own fields,
    // no derived tax-owed math invented here.
    const currency = taxHolders[0].currency;
    const m = (n: number) => formatMoney(n, currency, locale);
    const mc = (n: number) => formatMoneyCompact(n, currency, locale);
    const sum = (f: (h: (typeof taxHolders)[number]) => number) =>
      taxHolders.reduce((acc, h) => acc + f(h), 0);
    const usedYtd = sum((h) => Number(h.allowanceUsage.usedYtd));
    const allowanceAnnual = sum((h) => Number(h.allowanceUsage.allowanceAnnual));
    const realizedGains = sum((h) => Number(h.allowanceUsage.realizedGainsAdjusted));
    const incomeYtd = sum((h) => Number(h.allowanceUsage.incomeYtd));
    const usedPct = allowanceAnnual > 0 ? Math.round((usedYtd / allowanceAnnual) * 100) : 0;

    cards.push(
      <ReportCard
        key="tax"
        icon={ICONS.tax.icon}
        iconBg={ICONS.tax.bg}
        iconFg={ICONS.tax.fg}
        title={t("tax.title")}
        trend={
          allowanceAnnual > 0
            ? { label: t("tax.trend", { pct: usedPct }), tone: usedPct >= 100 ? "down" : "neutral" }
            : undefined
        }
        value={m(usedYtd)}
        caption={t("tax.caption")}
        metrics={[
          { label: t("tax.metricRealized"), value: mc(realizedGains) },
          { label: t("tax.metricIncome"), value: mc(incomeYtd) },
        ]}
        href="/tax"
        openLabel={openLabel}
      />,
    );
  }

  // ── Tax reports (inbox) ──────────────────────────────────────────────────
  // Always shown (unlike the KPI cards above, which need real data to render) — this is a
  // discovery entry point to the inbox even with zero documents yet, since the upload flow
  // lives there.
  const latestYear = taxReports.reduce<number | null>(
    (max, d) => (d.taxYear != null && (max === null || d.taxYear > max) ? d.taxYear : max),
    null,
  );
  const fromTr = taxReports.filter((d) => d.source === "pytr").length;
  const fromUpload = taxReports.length - fromTr;
  cards.push(
    <ReportCard
      key="documents"
      icon={ICONS.documents.icon}
      iconBg={ICONS.documents.bg}
      iconFg={ICONS.documents.fg}
      title={t("documents.title")}
      value={String(taxReports.length)}
      caption={t("documents.caption")}
      metrics={[
        { label: t("documents.metricLatestYear"), value: latestYear !== null ? String(latestYear) : "—" },
        { label: t("documents.metricSources"), value: t("documents.metricSourcesValue", { fromTr, fromUpload }) },
      ]}
      href="/reports/documents"
      openLabel={openLabel}
    />,
  );

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
      </header>

      {cards.length > 0 ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 @min-[1500px]:grid-cols-3">
          {cards}
        </div>
      ) : (
        <EmptyState
          icon={Receipt}
          title={te("noPortfolioTitle")}
          description={te("noPortfolioBody")}
        />
      )}
    </div>
  );
}
