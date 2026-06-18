"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { LineChart } from "lucide-react";
import type { PerformancePoint } from "@portfolio/api-client";
import { PriceChart } from "@/components/charts/price-chart";
import { RangeToggle, type ChartRange } from "@/components/charts/range-toggle";
import { EmptyState } from "@/components/empty-state";
import { useApiClient } from "@/lib/api";
import { cn } from "@/lib/utils";

type ChartMode = "performance" | "value";

export function NetWorthHistoryChart({
  initial,
  currency,
  selectedId = null,
}: {
  initial: PerformancePoint[];
  currency: string;
  selectedId?: string | null;
}) {
  const te = useTranslations("Empty");
  const t = useTranslations("Chart");
  const api = useApiClient();
  const [range, setRange] = useState<ChartRange>("1y");
  const [mode, setMode] = useState<ChartMode>("performance");
  const [data, setData] = useState<PerformancePoint[]>(initial);
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

  const chartData =
    mode === "performance"
      ? data.map((p) => ({ date: p.date, close: p.pct ?? "0" }))
      : selectedId
        ? data.map((p) => ({ date: p.date, close: p.marketValue ?? p.netWorth }))
        : data.map((p) => ({ date: p.date, close: p.netWorth }));

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
              aria-pressed={mode === m}
              className={cn(
                "px-3 py-1 font-medium transition-colors",
                mode === m
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
      {data.length > 1 ? (
        <PriceChart
          data={chartData}
          currency={currency}
          unit={mode === "performance" ? "percent" : "currency"}
        />
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
