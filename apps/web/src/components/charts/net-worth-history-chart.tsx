"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { LineChart } from "lucide-react";
import type { NetWorthPoint } from "@portfolio/api-client";
import { PriceChart } from "@/components/charts/price-chart";
import { RangeToggle, type ChartRange } from "@/components/charts/range-toggle";
import { EmptyState } from "@/components/empty-state";
import { useApiClient } from "@/lib/api";

/**
 * Net-worth-over-time with a selectable range. Initial data (1y) is rendered
 * server-side; changing the range refetches the snapshot series client-side.
 * When `selectedId` is set the refetch is scoped to that portfolio; otherwise
 * it uses the cross-portfolio aggregate.
 */
export function NetWorthHistoryChart({
  initial,
  currency,
  selectedId = null,
}: {
  initial: NetWorthPoint[];
  currency: string;
  /** A specific portfolio id to scope the history to, or null for the aggregate. */
  selectedId?: string | null;
}) {
  const te = useTranslations("Empty");
  const api = useApiClient();
  const [range, setRange] = useState<ChartRange>("1y");
  const [data, setData] = useState<NetWorthPoint[]>(initial);
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
      // keep the last good series on a failed refetch
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <RangeToggle value={range} onChange={pick} disabled={loading} />
      </div>
      {data.length > 1 ? (
        <PriceChart
          data={data.map((p) => ({ date: p.date, close: p.netWorth }))}
          currency={currency}
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
