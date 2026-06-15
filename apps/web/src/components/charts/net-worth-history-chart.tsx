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
 */
export function NetWorthHistoryChart({
  initial,
  currency,
}: {
  initial: NetWorthPoint[];
  currency: string;
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
      setData(await api.getNetWorthHistory(r));
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
