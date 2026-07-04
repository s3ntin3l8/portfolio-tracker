"use client";

import { useState, useEffect } from "react";
import { useTranslations, useLocale } from "next-intl";
import { LineChart } from "lucide-react";
import type { HistoryPoint, PerformancePoint } from "@portfolio/api-client";
import { isIntradayPoint } from "@portfolio/api-client";

/** Narrow a HistoryPoint down to the day-grained (`date`) shape. */
function isDailyPoint(p: HistoryPoint): p is PerformancePoint {
  return !isIntradayPoint(p);
}
import { PriceChart } from "@/components/charts/price-chart";
import { RangeToggle, type ChartRange } from "@/components/charts/range-toggle";
import { EmptyState } from "@/components/empty-state";
import { useApiClient } from "@/lib/api";
import { cn } from "@/lib/utils";

type ChartMode = "performance" | "value";

/** True for the timestamped (1D/7D) ranges, read from the intraday snapshot table. */
function isIntradayRange(range: ChartRange): boolean {
  return range === "1d" || range === "7d";
}

/** Ranges shown as chips inside the compact "hero" variant (Holdings glance card). */
const HERO_RANGES: ChartRange[] = ["1d", "7d", "1m", "1y", "all"];

/** A resolved chart point — same numeric shape regardless of source range. */
export interface ChartSeriesPoint {
  date: string;
  close: number;
}

export function NetWorthHistoryChart({
  initial,
  currency,
  selectedId = null,
  variant = "card",
  initialRange,
  onSeriesChange,
}: {
  initial: HistoryPoint[];
  currency: string;
  selectedId?: string | null;
  /** "hero" renders a minimal (axis-less, white-on-brand) sparkline for the Holdings
   *  glance card: no mode toggle (always Value), and only 1D/7D/1M/1Y/ALL chips. */
  variant?: "card" | "hero";
  /** The range `initial` was fetched with. Defaults to "1y" for both variants (a
   *  day-grained range with reliable data, even for "hero" — see the state default
   *  below) — pass this explicitly when the caller fetched `initial` with a different
   *  range so the chip selection and the displayed series agree from first paint. */
  initialRange?: ChartRange;
  /** Fired whenever the rendered series (or range) changes — lets a "hero" caller derive
   *  its own period delta/pct pill from the same data the chart is already showing. */
  onSeriesChange?: (points: ChartSeriesPoint[], range: ChartRange) => void;
}) {
  const te = useTranslations("Empty");
  const t = useTranslations("Chart");
  const locale = useLocale();
  const api = useApiClient();
  const isHero = variant === "hero";
  // Default to a day-grained range even for the hero variant: intraday (1D/7D) snapshots
  // only backfill over time (PR #386), so defaulting to one would show the "collecting"
  // placeholder on a fresh install. Callers that already have reliable intraday data can
  // still open on 1D/7D via `initialRange`.
  const [range, setRange] = useState<ChartRange>(initialRange ?? "1y");
  const [mode, setMode] = useState<ChartMode>("performance");
  const [data, setData] = useState<HistoryPoint[]>(initial);
  const [loading, setLoading] = useState(false);

  async function pick(r: ChartRange) {
    if (r === range) return;
    setRange(r);
    setLoading(true);
    try {
      setData(
        selectedId
          ? await api.getPortfolioHistory(selectedId, r)
          : await api.getNetWorthHistory(r),
      );
    } catch {
      // keep last good series on failed refetch
    } finally {
      setLoading(false);
    }
  }

  const intraday = isIntradayRange(range);
  // No TWR pct/index on intraday points — the Performance toggle only applies to
  // the day-grained ranges, so intraday always renders as a Value chart. The hero
  // variant has no mode toggle at all — it always shows the raw value sparkline.
  const effectiveMode: ChartMode = isHero || intraday ? "value" : mode;

  const intradayLabelFmt = new Intl.DateTimeFormat(
    locale,
    range === "1d" ? { hour: "2-digit", minute: "2-digit" } : { day: "numeric", month: "short" },
  );

  const chartData = intraday
    ? data.filter(isIntradayPoint).map((p) => ({
        date: intradayLabelFmt.format(new Date(p.at)),
        close: selectedId ? (p.marketValue ?? p.netWorth) : p.netWorth,
      }))
    : effectiveMode === "performance"
      ? data.filter(isDailyPoint).map((p) => ({ date: p.date, close: p.pct ?? "0" }))
      : selectedId
        ? data
            .filter(isDailyPoint)
            .map((p) => ({ date: p.date, close: p.marketValue ?? p.netWorth }))
        : data.filter(isDailyPoint).map((p) => ({ date: p.date, close: p.netWorth }));

  // Let a "hero" caller (e.g. the Holdings glance card) derive its own period
  // delta/pct pill from exactly the series this chart is rendering.
  useEffect(() => {
    onSeriesChange?.(
      chartData.map((p) => ({ date: p.date, close: Number(p.close) })),
      range,
    );
    // chartData is a pure function of [data, range, effectiveMode, selectedId] — depending
    // on those (rather than the freshly-allocated chartData array) avoids an extra re-run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, range, effectiveMode, selectedId, onSeriesChange]);

  const collectingNote = (
    <p
      className={cn(
        "py-8 text-center text-sm",
        isHero ? "text-white/80" : "text-muted-foreground",
      )}
    >
      {t("collectingIntraday")}
    </p>
  );

  const chart = (
    <PriceChart
      data={chartData}
      currency={currency}
      unit={effectiveMode === "performance" ? "percent" : "currency"}
      theme={isHero ? "inverse" : "default"}
      minimal={isHero}
      height={isHero ? 72 : 280}
    />
  );

  if (isHero) {
    return (
      <div className="space-y-2.5">
        {intraday && data.length < 2 ? (
          collectingNote
        ) : data.length > 1 ? (
          chart
        ) : (
          <p className="py-8 text-center text-sm text-white/80">{te("historyTitle")}</p>
        )}
        <RangeToggle
          value={range}
          onChange={pick}
          disabled={loading}
          ranges={HERO_RANGES}
          theme="inverse"
        />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        {/* Mode toggle */}
        <div
          className="flex rounded-md border border-border overflow-hidden text-xs"
          role="group"
          aria-label={t("modeLabel")}
        >
          {(["performance", "value"] as ChartMode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              disabled={intraday && m === "performance"}
              aria-pressed={effectiveMode === m}
              className={cn(
                "px-3 py-1 font-medium transition-colors disabled:opacity-50",
                effectiveMode === m
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent",
              )}
            >
              {t(m === "performance" ? "modePerformance" : "modeValue")}
            </button>
          ))}
        </div>
        <RangeToggle value={range} onChange={pick} disabled={loading} />
      </div>
      {intraday && data.length < 2 ? (
        collectingNote
      ) : data.length > 1 ? (
        chart
      ) : (
        <EmptyState
          icon={LineChart}
          title={te("historyTitle")}
          description={te("historyBody")}
        />
      )}
    </div>
  );
}
