"use client";

import { BrokerageIcon } from "@/components/brokerage-icon";
import type { PickablePortfolio } from "@/components/portfolio-picker";
import { computeTxTotal, formatMoney, totalLabelKey } from "./totals";

/**
 * Desktop-only sticky rail beside the manual transaction form (`add-transaction-form.tsx`),
 * mirroring the mockup's live total — the same figure the mobile inline total card shows,
 * plus the portfolio/type context a modal has room for. See `pricing-fields.tsx`'s inline
 * card, which this replaces on desktop (never both at once).
 */
export function SummaryRail({
  portfolio,
  type,
  quantity,
  price,
  fees,
  tax,
  currency,
  t,
  tt,
}: {
  portfolio?: PickablePortfolio;
  type: string;
  quantity: string;
  price: string;
  fees: string;
  tax: string;
  currency: string;
  t: (key: string) => string;
  tt: (key: string) => string;
}) {
  const total = computeTxTotal(type, quantity, price, fees, tax);
  const showBreakdown = total?.kind === "trade-buy" || total?.kind === "trade-sell";
  const sign = total?.kind === "trade-sell" ? "− " : "+ ";

  return (
    <aside className="sticky top-0 flex flex-col gap-3 self-start">
      <div className="flex flex-col gap-3.5 rounded-[18px] border border-border bg-card-2 p-4">
        <div className="text-[11px] font-bold uppercase tracking-[.06em] text-text-3">
          {t("summary")}
        </div>

        {portfolio && (
          <div className="flex items-center gap-2.5">
            <BrokerageIcon
              brokerage={portfolio.brokerage}
              className="size-[34px] shrink-0 rounded-[10px]"
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-bold text-foreground">
                {portfolio.name}
              </span>
              <span className="block truncate text-[11px] font-medium text-text-2">
                {[portfolio.brokerage, portfolio.accountHolder].filter(Boolean).join(" · ")}
              </span>
            </span>
          </div>
        )}

        <div className="flex items-center justify-between border-t border-line pt-3">
          <span className="text-xs font-medium text-text-2">{t("type")}</span>
          <span className="text-xs font-bold text-foreground">{tt(type)}</span>
        </div>

        {showBreakdown && (
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-text-2">{t("subtotal")}</span>
            <span className="text-[13px] font-semibold text-foreground">
              {formatMoney(total.subtotal, currency)}
            </span>
          </div>
        )}
        {showBreakdown && total.fees !== 0 && (
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-text-2">{t("fees")}</span>
            <span className="text-[13px] font-semibold text-foreground">
              {sign + formatMoney(total.fees, currency)}
            </span>
          </div>
        )}
        {showBreakdown && total.tax !== 0 && (
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-text-2">{t("tax")}</span>
            <span className="text-[13px] font-semibold text-foreground">
              {sign + formatMoney(total.tax, currency)}
            </span>
          </div>
        )}

        <div className="flex items-center justify-between border-t border-border pt-3">
          <span className="text-[13px] font-semibold text-text-2">
            {t(total ? totalLabelKey(total.kind) : "totalEstimated")}
          </span>
          <span className="text-[18px] font-extrabold text-foreground">
            {total ? formatMoney(total.total, currency) : "—"}
          </span>
        </div>
      </div>
    </aside>
  );
}
