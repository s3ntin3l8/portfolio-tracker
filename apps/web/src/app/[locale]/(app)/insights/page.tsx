import { getTranslations, setRequestLocale } from "next-intl/server";
import { Scale } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { RebalancingCard } from "@/components/insights/rebalancing-card";
import { BestWorstCard } from "@/components/insights/best-worst-card";
import {
  loadNetWorth,
  loadNetWorthHistory,
  loadHoldings,
  loadPreferences,
  getSelectedPortfolioId,
} from "@/lib/server-api";
import { bestAndWorst } from "@/lib/movers";
import { formatPercent } from "@/lib/utils";
import { isIntradayPoint } from "@portfolio/api-client";

const TIMING = typeof process !== "undefined" && process.env?.TIMING_ENABLED === "true";

export default async function InsightsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  // eslint-disable-next-line react-hooks/purity
  const t0 = TIMING ? performance.now() : 0;
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("Insights");
  const td = await getTranslations("Dashboard");
  const tc = await getTranslations("AssetClass");
  const te = await getTranslations("Empty");

  // Cost basis is a single global preference — thread it into loadNetWorth so this
  // page's summary agrees with Holdings on P&L cost basis (it previously silently
  // defaulted to purchase_price regardless of the user's choice elsewhere).
  // loadHoldings() below only feeds the day-change "Best & worst" movers, which are
  // priced off today's move, not cost basis — no threading needed there.
  // loadPreferences() used to be awaited before anything else — a full serial round trip
  // blocking the whole page. The loaders that don't need costBasis are kicked off
  // immediately instead; only loadNetWorth waits on it.
  const prefsPromise = loadPreferences();
  const historyPromise = loadNetWorthHistory("all");
  const holdingsPromise = loadHoldings();
  const selectedIdPromise = getSelectedPortfolioId();

  const prefs = await prefsPromise;
  const costBasis = prefs?.costBasisMode ?? "purchase_price";

  const [result, history, holdingsView, selectedId] = await Promise.all([
    loadNetWorth(costBasis),
    historyPromise,
    holdingsPromise,
    selectedIdPromise,
  ]);

  if (TIMING) {
    // eslint-disable-next-line react-hooks/purity
    const durationMs = performance.now() - t0;
    console.log(
      JSON.stringify({
        level: "info",
        msg: `[timing] InsightsPage data fetch`,
        durationMs: Math.round(durationMs * 100) / 100,
      }),
    );
  }

  if (result.status !== "ok") {
    return (
      <div className="space-y-5">
        <header className="space-y-1">
          <h1 className="text-2xl font-bold">{t("title")}</h1>
          <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
        </header>
        <EmptyState
          icon={Scale}
          title={result.status === "empty" ? te("noPortfolioTitle") : te("unavailableTitle")}
          description={result.status === "empty" ? te("noPortfolioBody") : te("unavailableBody")}
        />
      </div>
    );
  }

  const summary = result.data;
  const allocation = summary.allocation;

  // "since Jan {year}" — the earliest inception-scoped snapshot's year (range="all" is
  // always day-grained, so every point here carries `.date`, never intraday `.at`).
  const firstPoint = history.find((p) => !isIntradayPoint(p));
  const sinceYear = firstPoint ? Number((firstPoint as { date: string }).date.slice(0, 4)) : new Date().getUTCFullYear();

  const filteredClasses = allocation?.byAssetClass.filter((s) => Number(s.value) > 0) ?? [];
  const assetClassSlices = filteredClasses.map((s) => ({
    key: s.key,
    label: s.key === "cash" ? tc("cash") : tc(s.key),
    actualPct: s.pct,
  }));
  const topClass = filteredClasses.length > 0 ? [...filteredClasses].sort((a, b) => b.pct - a.pct)[0] : null;
  const marketCount = allocation?.byRegion.filter((s) => Number(s.value) > 0).length ?? 0;
  const currencyCount = allocation?.byCurrency.filter((s) => Number(s.value) > 0).length ?? 0;

  const movers = bestAndWorst(
    holdingsView.status === "ok" ? holdingsView.holdings.filter((h) => Number(h.quantity) !== 0) : [],
  );

  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
      </header>

      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <div className="space-y-4">
          {/* XIRR hero — reference stacks label → figure → caption with tight 4px gaps. */}
          <div
            className="rounded-[20px] p-6 text-white"
            style={{ background: "linear-gradient(135deg,#11211a,#1d3a2c)" }}
          >
            <p className="text-xs font-semibold text-white/70">{t("xirr.label")}</p>
            <p className="tabular mt-1 text-[36px] font-extrabold leading-none sm:text-[40px]">
              {summary.xirr !== null ? formatPercent(summary.xirr, locale) : "—"}
            </p>
            <p className="mt-1 text-xs font-medium leading-[1.5] text-white/70">
              {t("xirr.caption", { year: sinceYear })}
            </p>
          </div>

          <RebalancingCard
            portfolioId={selectedId ?? undefined}
            slices={assetClassSlices}
            drift={summary.drift?.asset_class}
          />
        </div>

        <div className="space-y-4">
          {allocation && (
            <div className="grid grid-cols-2 gap-4">
              {/* Concentration — reference: big 22px figure + "Top: … · tone" subtext. */}
              <div className="rounded-[20px] bg-card p-4 shadow-card">
                <p className="text-xs font-semibold text-text-2">{t("concentration.label")}</p>
                <p className="tabular mt-1 text-[22px] font-extrabold leading-none">
                  {allocation.concentration.top1Pct.toFixed(0)}%
                </p>
                {topClass && (
                  <p className="mt-1 text-xs font-medium text-text-2">
                    {t("concentration.top", {
                      label: topClass.key === "cash" ? tc("cash") : tc(topClass.key),
                      tone: td(
                        allocation.concentration.label === "diversified"
                          ? "concentrationDiversified"
                          : allocation.concentration.label === "moderate"
                            ? "concentrationModerate"
                            : "concentrationConcentrated",
                      ).toLowerCase(),
                    })}
                  </p>
                )}
              </div>

              {/* Diversification — reference: "{n} classes" big, "{x} markets · {y} currencies". */}
              <div className="rounded-[20px] bg-card p-4 shadow-card">
                <p className="text-xs font-semibold text-text-2">{t("diversification.label")}</p>
                <p className="mt-1 text-[22px] font-extrabold leading-none">
                  {t("diversification.value", { count: assetClassSlices.length })}
                </p>
                <p className="mt-1 text-xs font-medium text-text-2">
                  {t("diversification.caption", { markets: marketCount, currencies: currencyCount })}
                </p>
              </div>
            </div>
          )}

          {movers && (
            <BestWorstCard
              best={movers.best}
              worst={movers.worst}
              title={t("bestWorst.title")}
              bestLabel={t("bestWorst.best")}
              worstLabel={t("bestWorst.worst")}
              locale={locale}
            />
          )}
        </div>
      </div>
    </div>
  );
}
