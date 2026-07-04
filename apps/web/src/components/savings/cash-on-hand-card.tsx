import { useTranslations } from "next-intl";
import { Coins } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { BrokerageIcon } from "@/components/brokerage-icon";
import { formatMoney } from "@/lib/utils";

/** Assumed money-market annual return used for the idle-cash nudge estimate —
 *  stated explicitly in the copy so it reads as an assumption, not a quote. */
const ASSUMED_IDLE_RATE = 0.04;

/**
 * "Cash on hand": idle balances the portfolio(s) currently carry, one row per
 * currency. `loadHoldings()`'s `cash` is only per-currency (not per brokerage
 * account, unlike the design mock's per-account rows), so this card is
 * deliberately scoped to what that data actually supports — see the PR report
 * for why. Each row reuses `BrokerageIcon`'s monogram/tint fallback (passing the
 * currency code through it) rather than inventing new badge-color logic.
 */
export function CashOnHandCard({
  cash,
  locale,
}: {
  cash: Record<string, string>;
  locale: string;
}) {
  const t = useTranslations("Savings");

  const entries = Object.entries(cash).filter(([, v]) => Number(v) > 0);
  if (entries.length === 0) return null;

  const totalLabel = entries
    .map(([ccy, amount]) => formatMoney(Number(amount), ccy, locale))
    .join(" · ");
  const idleEstimateLabel = entries
    .map(([ccy, amount]) => formatMoney(Number(amount) * ASSUMED_IDLE_RATE, ccy, locale))
    .join(" · ");
  const rateLabel = new Intl.NumberFormat(locale, {
    style: "percent",
    maximumFractionDigits: 1,
  }).format(ASSUMED_IDLE_RATE);

  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-bold">{t("cashOnHandTitle")}</h2>
            <p className="text-xs text-muted-foreground">{t("cashOnHandSubtitle")}</p>
          </div>
          <p className="tabular shrink-0 text-lg font-extrabold">{totalLabel}</p>
        </div>

        <div className="flex flex-col">
          {entries.map(([ccy, amount]) => (
            <div
              key={ccy}
              className="flex items-center gap-3 border-t border-border py-3 first:border-t-0 first:pt-0"
            >
              <BrokerageIcon brokerage={ccy} className="size-9 rounded-xl" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-bold">{ccy}</p>
                <p className="text-xs text-muted-foreground">{t("cashMeta")}</p>
              </div>
              <p className="tabular shrink-0 text-sm font-bold">
                {formatMoney(Number(amount), ccy, locale)}
              </p>
            </div>
          ))}
        </div>

        <div className="flex items-start gap-2.5 rounded-xl bg-warning/10 p-3">
          <Coins className="mt-0.5 size-4 shrink-0 text-warning" />
          <p className="text-xs leading-relaxed text-warning/90">
            <b className="text-warning">{t("cashNudgeLead", { amount: totalLabel })}</b>{" "}
            {t("cashNudgeSuggestion", { rate: rateLabel, amount: idleEstimateLabel })}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
