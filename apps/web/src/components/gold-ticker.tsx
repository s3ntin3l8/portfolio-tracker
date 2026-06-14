"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Coins } from "lucide-react";
import type { Quote } from "@portfolio/api-client";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useApiClient } from "@/lib/api";
import { formatMoney } from "@/lib/utils";

// Gold spot ref: works against the fixture locally (GOLD) and GoldAPI/TwelveData
// live (which price XAU→currency per gram regardless of symbol).
const GOLD_REF = {
  symbol: "GOLD",
  market: "XAU",
  assetClass: "gold",
  currency: "IDR",
} as const;
const REFRESH_MS = 60_000;

type State = "loading" | "ok" | "error";

/** Live gold spot ticker — fetches on mount and refreshes every minute. */
export function GoldTicker() {
  const t = useTranslations("Gold");
  const locale = useLocale();
  const api = useApiClient();
  const [quote, setQuote] = useState<Quote | null>(null);
  const [state, setState] = useState<State>("loading");

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const q = await api.getQuote(GOLD_REF);
        if (active) {
          setQuote(q);
          setState("ok");
        }
      } catch {
        if (active) setState("error");
      }
    }
    void load();
    const id = setInterval(load, REFRESH_MS);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [api]);

  // Stay out of the way when no quote source is reachable.
  if (state === "error") return null;

  return (
    <Card>
      <CardContent className="flex items-center justify-between p-5">
        <div className="flex items-center gap-3">
          <span className="rounded-full bg-amber-500/15 p-2 text-amber-600 dark:text-amber-400">
            <Coins className="size-5" />
          </span>
          <div>
            <p className="text-sm font-medium">{t("title")}</p>
            <p className="text-xs text-muted-foreground">{t("perGram")}</p>
          </div>
        </div>
        <div className="text-right">
          {state === "loading" || !quote ? (
            <Skeleton className="ml-auto h-7 w-28" />
          ) : (
            <>
              <p className="tabular text-xl font-semibold">
                {formatMoney(Number(quote.price), quote.currency, locale)}
              </p>
              <p className="text-xs text-muted-foreground">
                {t("asOf", {
                  time: new Date(quote.asOf).toLocaleTimeString(locale, {
                    hour: "2-digit",
                    minute: "2-digit",
                  }),
                })}
              </p>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
