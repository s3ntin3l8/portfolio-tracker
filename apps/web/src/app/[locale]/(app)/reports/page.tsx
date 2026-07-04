import type React from "react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Coins, ScrollText, PiggyBank, Receipt } from "lucide-react";
import { ReportCard } from "@/components/reports/report-card";
import { EmptyState } from "@/components/empty-state";
import {
  loadIncomeStats,
  loadTrades,
  loadContributions,
  loadNetworthTax,
} from "@/lib/server-api";
import { formatMoney, formatPercent } from "@/lib/utils";
import type { TrendTone } from "@/components/reports/trend-chip";

const ICONS = {
  income: { icon: Coins, bg: "rgba(14,159,110,.12)", fg: "#0E9F6E" },
  trades: { icon: ScrollText, bg: "rgba(224,165,58,.14)", fg: "var(--gold-fg)" },
  savings: { icon: PiggyBank, bg: "rgba(124,92,252,.12)", fg: "#7C5CFC" },
  tax: { icon: Receipt, bg: "rgba(13,148,136,.12)", fg: "var(--color-chart-3)" },
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

  const [income, trades, contributions, taxHolders] = await Promise.all([
    loadIncomeStats(),
    loadTrades(),
    loadContributions(),
    loadNetworthTax(),
  ]);

  const cards: React.ReactNode[] = [];

  // ── Income ──────────────────────────────────────────────────────────────
  if (income.status === "ok") {
    const s = income.data;
    const currency = s.displayCurrency;
    const m = (n: number) => formatMoney(n, currency, locale);
    const deltaTone: TrendTone =
      s.deltaPct === null || s.deltaPct === 0 ? "neutral" : s.deltaPct > 0 ? "up" : "down";

    // Top two asset classes by income contribution, as a two-segment split bar.
    const topTwo = [...s.byAssetClass].sort((a, b) => Number(b.total) - Number(a.total)).slice(0, 2);
    const topSum = topTwo.reduce((sum, c) => sum + Number(c.total), 0);
    const splitBar =
      topTwo.length === 2 && topSum > 0
        ? topTwo.map((c, i) => ({
            pct: (Number(c.total) / topSum) * 100,
            color: i === 0 ? "var(--color-chart-1)" : "var(--color-chart-3)",
          }))
        : undefined;

    cards.push(
      <ReportCard
        key="income"
        icon={ICONS.income.icon}
        iconBg={ICONS.income.bg}
        iconFg={ICONS.income.fg}
        title={t("income.title")}
        trend={
          s.deltaPct !== null
            ? { label: t("income.trendVsLastYear", { pct: formatPercent(s.deltaPct, locale) }), tone: deltaTone, arrow: true }
            : undefined
        }
        value={m(Number(s.thisYear))}
        caption={t("income.caption")}
        splitBar={splitBar}
        metrics={[
          { label: t("income.metricTtm"), value: m(Number(s.ttm)) },
          { label: t("income.metricLifetime"), value: m(Number(s.lifetimeTotal)) },
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
    const currentYear = new Date().getUTCFullYear();
    const ytdEntry = log.realizedByYear.find((y) => y.year === currentYear);
    const ytdRealized = ytdEntry ? Number(ytdEntry.amount) : Number(log.totalRealized);

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
            { pct: (winSum / totalAbs) * 100, color: "var(--color-success)" },
            { pct: (lossSum / totalAbs) * 100, color: "var(--color-destructive)" },
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
    const netContributed = Number(s.netContributed);
    const currentValue = Number(s.currentValue);
    const gain = Math.max(0, currentValue - netContributed);
    const total = netContributed + gain;
    const splitBar =
      total > 0
        ? [
            { pct: (netContributed / total) * 100, color: "var(--color-chart-4)" },
            { pct: (gain / total) * 100, color: "var(--color-success)" },
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
          { label: t("savings.metricMonthly"), value: m(Number(s.monthlyAverage)) },
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

  // ── Tax (German Sparerpauschbetrag only — headline mirrors tax/page.tsx's own
  // fields, no derived tax-owed math invented here) ───────────────────────
  if (taxHolders.length > 0) {
    const currency = taxHolders[0].currency;
    const m = (n: number) => formatMoney(n, currency, locale);
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
          { label: t("tax.metricRealized"), value: m(realizedGains) },
          { label: t("tax.metricIncome"), value: m(incomeYtd) },
        ]}
        href="/tax"
        openLabel={openLabel}
      />,
    );
  }

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-extrabold tracking-tight">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
      </header>

      {cards.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-2">{cards}</div>
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
