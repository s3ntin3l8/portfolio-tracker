"use client";

import { useState } from "react";
import { useTranslations, useLocale } from "next-intl";
import { LineChart } from "lucide-react";
import type { Candle } from "@portfolio/api-client";
import { PriceChart } from "@/components/charts/price-chart";
import { InstrumentRangeToggle } from "@/components/charts/instrument-range-toggle";
import { EmptyState } from "@/components/empty-state";
import { useApiClient } from "@/lib/api";
import { useMediaQuery } from "@/lib/use-media-query";
import { toApiRange, type InstrumentPriceRange } from "@/lib/instrument-price-range";
import type { LastPriceInfo } from "@/lib/instrument-price";
import { cn, formatMoney, formatSignedMoney, formatPercent } from "@/lib/utils";

/**
 * The Instrument-detail "Price history" card body: a "Last price · today's change" headline
 * (derived once from the initial candle window — it's a "today" fact, not tied to whichever
 * chart range is currently zoomed in), the chart, and a client-driven 1M/6M/1Y/All range
 * toggle. The server page loads the initial (1Y) window; switching chips refetches from the
 * same `/instruments/:id/history` endpoint with a different `range` — a real network
 * round-trip (unlike the Activity banners), since the server component only fetches one
 * window up front.
 */
export function InstrumentPriceCard({
  instrumentId,
  initialHistory,
  initialRange = "1y",
  currency,
  lastPrice,
}: {
  instrumentId: string;
  initialHistory: Candle[];
  initialRange?: InstrumentPriceRange;
  currency: string;
  /** Precomputed "today" headline (last close ± prior close) — frozen at the initial 1Y
   *  load, not recomputed as the user browses other ranges. Null when there's no history. */
  lastPrice: LastPriceInfo | null;
}) {
  const t = useTranslations("Instrument");
  const locale = useLocale();
  const api = useApiClient();
  const isDesktop = useMediaQuery("(min-width: 768px)");
  const [range, setRange] = useState<InstrumentPriceRange>(initialRange);
  const [history, setHistory] = useState<Candle[]>(initialHistory);
  const [loading, setLoading] = useState(false);

  async function handleChange(next: InstrumentPriceRange) {
    if (next === range || loading) return;
    setRange(next);
    setLoading(true);
    try {
      const data = await api.getInstrumentHistory(instrumentId, toApiRange(next));
      setHistory(data);
    } catch {
      // Keep whatever was showing rather than blank the chart on a failed refetch.
    } finally {
      setLoading(false);
    }
  }

  const changeTone =
    lastPrice?.change == null ? "neutral" : lastPrice.change >= 0 ? "up" : "down";

  return (
    <div className="space-y-4">
      {lastPrice && (
        <div>
          <p className="text-xs font-semibold text-muted-foreground">{t("lastPriceLabel")}</p>
          <div className="mt-0.5 flex items-baseline gap-3">
            <span className="tabular text-3xl font-extrabold">
              {formatMoney(lastPrice.price, lastPrice.currency, locale)}
            </span>
            {lastPrice.change != null && lastPrice.changePct != null && (
              <span
                className={cn(
                  "tabular text-sm font-bold",
                  changeTone === "up" && "text-success",
                  changeTone === "down" && "text-destructive",
                )}
              >
                {t("dayChangeToday", {
                  change: formatSignedMoney(lastPrice.change, lastPrice.currency, locale),
                  pct: formatPercent(lastPrice.changePct, locale),
                })}
              </span>
            )}
          </div>
        </div>
      )}
      <div className={loading ? "opacity-60 transition-opacity" : "transition-opacity"}>
        {history.length > 0 ? (
          <PriceChart data={history} currency={history[0]?.currency ?? currency} showYAxis={isDesktop} />
        ) : (
          <EmptyState icon={LineChart} title={t("priceHistory")} description={t("noHistory")} />
        )}
      </div>
      <InstrumentRangeToggle value={range} onChange={handleChange} disabled={loading} />
    </div>
  );
}
