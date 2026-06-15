"use client";

import { useTranslations } from "next-intl";
import { PiggyBank } from "lucide-react";
import { PriceChart } from "@/components/charts/price-chart";
import { EmptyState } from "@/components/empty-state";

/**
 * Cumulative contributions over time. Takes the per-month net-contribution
 * series and renders the running total as an area, reusing {@link PriceChart}.
 */
export function ContributionsChart({
  series,
  currency,
}: {
  series: { month: string; contributed: string }[];
  currency: string;
}) {
  const te = useTranslations("Empty");

  let running = 0;
  const points = series.map((s) => {
    running += Number(s.contributed);
    return { date: s.month, close: running.toString() };
  });

  if (points.length < 2) {
    return (
      <EmptyState
        icon={PiggyBank}
        title={te("historyTitle")}
        description={te("historyBody")}
      />
    );
  }

  return <PriceChart data={points} currency={currency} />;
}
