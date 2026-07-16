"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { ExternalLink, CalendarClock } from "lucide-react";
import type { InstrumentFundamentals } from "@portfolio/api-client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { StatCard } from "@/components/stat-card";
import { useApiClient } from "@/lib/api";
import { formatMoney, formatMoneyCompact, formatPercent, formatRatio } from "@/lib/utils";
import {
  RevenueEarningsChart,
  RevenueEarningsChartLegend,
  type RevenueEarningsYear,
} from "@/components/charts/revenue-earnings-chart";

type LoadState = "loading" | "ok" | "empty" | "error";

const RECOMMENDATION_TONE: Record<string, "success" | "warning" | "destructive"> = {
  strong_buy: "success",
  buy: "success",
  hold: "warning",
  sell: "destructive",
  strong_sell: "destructive",
};

/** Known Yahoo `recommendationKey` values we have a translation for. Anything else
 *  (Yahoo's set isn't formally documented) falls back to the raw string, untranslated. */
const KNOWN_RECOMMENDATIONS = new Set(["strong_buy", "buy", "hold", "sell", "strong_sell"]);

/**
 * The Instrument-detail "Fundamentals" card: market cap / PE / EPS / dividend yield /
 * 52-week range / beta / 1Y target stat grid, an intraday snapshot (prev close, day
 * range, volume — labeled "as of" the cache's refresh time), analyst recommendations,
 * a revenue-vs-earnings mini chart, next earnings + ex-dividend dates, and an external
 * link. Client-fetched on mount (not server-preloaded) so a slow/unreachable provider
 * doesn't block the rest of the page — mirrors `GoldTicker`'s fetch-on-mount pattern.
 *
 * Coverage-driven: Yahoo's fundamentals coverage varies by asset class (equities get the
 * full set; ETFs get a reduced set — no PE/EPS/analyst data) and can be entirely absent
 * for an unresolved symbol. Only present fields render; the card renders nothing at all
 * when the fetch comes back empty or fails, rather than a grid full of placeholder dashes.
 */
export function InstrumentFundamentalsCard({ instrumentId }: { instrumentId: string }) {
  const t = useTranslations("Instrument");
  const locale = useLocale();
  const api = useApiClient();
  const [data, setData] = useState<InstrumentFundamentals | null>(null);
  const [state, setState] = useState<LoadState>("loading");

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const result = await api.getInstrumentFundamentals(instrumentId);
        if (!active) return;
        setData(result);
        setState(result ? "ok" : "empty");
      } catch {
        if (active) setState("error");
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [api, instrumentId]);

  if (state === "empty" || state === "error") return null;

  if (state === "loading") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t("fundamentalsTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-3 gap-2.5 sm:gap-4 lg:grid-cols-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-[74px]" />
          ))}
        </CardContent>
      </Card>
    );
  }

  if (!data) return null; // exhaustiveness guard; state === "ok" implies data is set

  const money = (v: string | null | undefined) =>
    v != null ? formatMoney(Number(v), data.currency, locale) : null;
  const moneyCompact = (v: string | null | undefined) =>
    v != null ? formatMoneyCompact(Number(v), data.currency, locale) : null;
  const ratio = (v: number | null | undefined) => (v != null ? formatRatio(v, locale) : null);
  const pct = (v: number | null | undefined) => (v != null ? formatPercent(v, locale) : null);

  // Coverage-driven stat grid — only fields the provider actually returned.
  const stats: Array<{ label: string; value: string }> = [];
  const push = (label: string, value: string | null) => {
    if (value != null) stats.push({ label, value });
  };
  push(t("marketCapLabel"), moneyCompact(data.marketCap));
  push(t("trailingPeLabel"), ratio(data.trailingPE));
  push(t("forwardPeLabel"), ratio(data.forwardPE));
  push(t("epsLabel"), money(data.trailingEps));
  push(t("dividendYieldLabel"), pct(data.dividendYield));
  push(t("betaLabel"), ratio(data.beta));
  if (data.fiftyTwoWeekLow != null && data.fiftyTwoWeekHigh != null) {
    stats.push({
      label: t("fiftyTwoWeekRangeLabel"),
      value: `${money(data.fiftyTwoWeekLow)} – ${money(data.fiftyTwoWeekHigh)}`,
    });
  }
  push(t("targetPriceLabel"), money(data.targetMeanPrice));
  push(t("expenseRatioLabel"), pct(data.expenseRatio));

  // Intraday snapshot — separate grid, labeled with the cache's refresh date since these
  // can be up to a day stale under the self-heal cache.
  const intraday: Array<{ label: string; value: string }> = [];
  const pushIntraday = (label: string, value: string | null) => {
    if (value != null) intraday.push({ label, value });
  };
  pushIntraday(t("previousCloseLabel"), money(data.previousClose));
  if (data.dayLow != null && data.dayHigh != null) {
    intraday.push({
      label: t("dayRangeLabel"),
      value: `${money(data.dayLow)} – ${money(data.dayHigh)}`,
    });
  }
  pushIntraday(t("volumeLabel"), data.volume != null ? data.volume.toLocaleString(locale) : null);
  pushIntraday(
    t("averageVolumeLabel"),
    data.averageVolume != null ? data.averageVolume.toLocaleString(locale) : null,
  );

  const financials: RevenueEarningsYear[] =
    data.financials?.map((f) => ({
      year: f.year,
      revenue: Number(f.revenue),
      earnings: Number(f.earnings),
    })) ?? [];

  const recommendationTone = data.recommendationKey
    ? (RECOMMENDATION_TONE[data.recommendationKey] ?? "warning")
    : undefined;
  const analystTotal = data.analystTrend
    ? data.analystTrend.strongBuy +
      data.analystTrend.buy +
      data.analystTrend.hold +
      data.analystTrend.sell +
      data.analystTrend.strongSell
    : 0;

  if (
    stats.length === 0 &&
    intraday.length === 0 &&
    financials.length === 0 &&
    !data.analystTrend
  ) {
    return null; // every field came back empty — nothing worth showing
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>{t("fundamentalsTitle")}</CardTitle>
          {data.externalUrl && (
            <a
              href={data.externalUrl}
              target="_blank"
              rel="noreferrer"
              aria-label={t("viewOnYahoo")}
              className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              {t("viewOnYahoo")}
              <ExternalLink className="size-3.5" />
            </a>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {stats.length > 0 && (
          <div className="grid grid-cols-3 gap-2.5 sm:gap-4 lg:grid-cols-5">
            {stats.map((s) => (
              <StatCard key={s.label} label={s.label} value={s.value} />
            ))}
          </div>
        )}

        {(data.earningsDate || data.exDividendDate) && (
          <div className="flex flex-wrap gap-2.5">
            {data.earningsDate && (
              <div className="flex items-center gap-2.5 rounded-xl bg-muted/50 px-3.5 py-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-amber-500/15 text-amber-600 dark:text-amber-400">
                  <CalendarClock className="size-4.5" />
                </span>
                <div>
                  <p className="text-sm font-semibold">{t("nextEarningsLabel")}</p>
                  <p className="tabular text-xs text-muted-foreground">
                    {new Date(data.earningsDate).toLocaleDateString(locale, {
                      year: "numeric",
                      month: "short",
                      day: "numeric",
                    })}
                  </p>
                </div>
              </div>
            )}
            {data.exDividendDate && (
              <div className="flex items-center gap-2.5 rounded-xl bg-muted/50 px-3.5 py-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-amber-500/15 text-amber-600 dark:text-amber-400">
                  <CalendarClock className="size-4.5" />
                </span>
                <div>
                  <p className="text-sm font-semibold">{t("exDividendLabel")}</p>
                  <p className="tabular text-xs text-muted-foreground">
                    {new Date(data.exDividendDate).toLocaleDateString(locale, {
                      year: "numeric",
                      month: "short",
                      day: "numeric",
                    })}
                    {data.dividendRate != null && ` · ${money(data.dividendRate)}`}
                  </p>
                </div>
              </div>
            )}
          </div>
        )}

        {data.analystTrend && analystTotal > 0 && (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-semibold">{t("analystRecommendationsLabel")}</p>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                {data.recommendationKey && (
                  <Badge variant={recommendationTone}>
                    {KNOWN_RECOMMENDATIONS.has(data.recommendationKey)
                      ? t(`recommendation.${data.recommendationKey}`)
                      : data.recommendationKey}
                  </Badge>
                )}
                {data.numberOfAnalystOpinions != null &&
                  t("analystCount", { count: data.numberOfAnalystOpinions })}
              </div>
            </div>
            <div className="flex h-2 overflow-hidden rounded-full bg-muted">
              <div
                className="bg-success"
                style={{
                  width: `${
                    ((data.analystTrend.strongBuy + data.analystTrend.buy) / analystTotal) * 100
                  }%`,
                }}
              />
              <div
                className="bg-warning"
                style={{ width: `${(data.analystTrend.hold / analystTotal) * 100}%` }}
              />
              <div
                className="bg-destructive"
                style={{
                  width: `${
                    ((data.analystTrend.sell + data.analystTrend.strongSell) / analystTotal) * 100
                  }%`,
                }}
              />
            </div>
            {data.targetMeanPrice != null && (
              <p className="text-xs text-muted-foreground">
                {t("targetMeanCaption", { target: money(data.targetMeanPrice) ?? "—" })}
              </p>
            )}
          </div>
        )}

        {financials.length > 0 && (
          <div>
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-semibold">{t("revenueVsEarningsLabel")}</p>
              <RevenueEarningsChartLegend />
            </div>
            <RevenueEarningsChart data={financials} currency={data.currency} />
          </div>
        )}

        {intraday.length > 0 && (
          <div>
            <p className="mb-2 text-[11px] text-muted-foreground">
              {t("asOfLabel", {
                date: new Date(data.asOf).toLocaleDateString(locale, {
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                }),
              })}
            </p>
            <div className="grid grid-cols-2 gap-2.5 sm:gap-4 lg:grid-cols-4">
              {intraday.map((s) => (
                <StatCard key={s.label} label={s.label} value={s.value} />
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
