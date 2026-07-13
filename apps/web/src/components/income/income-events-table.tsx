"use client";

import { useState } from "react";
import { useTranslations, useLocale } from "next-intl";
import type { IncomeEvent, UpcomingPayment } from "@portfolio/api-client";
import { monogram } from "@/lib/brokerages";
import { formatMoney, cn } from "@/lib/utils";
import { useApiClient } from "@/lib/api";
import { useRouter } from "@/i18n/navigation";
import { TransactionDetailSheet } from "@/components/transaction-detail-sheet";
import type { TxRow } from "@/components/transactions-table";

/** Unified row type: historical events + upcoming payments merged into one table. */
export type IncomeEventRow = IncomeEvent & {
  status?: UpcomingPayment["status"];
  growthApplied?: number;
  assumesContributions?: boolean;
  perShare?: string;
  quantity?: string;
};

/**
 * Reference "Payments timeline" grid template — shared by the column header
 * (see {@link TimelineColumnHeader}) and every data row so columns line up.
 * Date | Instrument | Type | Shares | Per share | Amount.
 */
export const TIMELINE_GRID =
  "grid-cols-[76px_minmax(0,1.3fr)_minmax(0,0.9fr)_76px_92px_116px]";

/** Desktop-only column-header row for the payments timeline. */
export function TimelineColumnHeader() {
  const t = useTranslations("Income");
  return (
    <div
      className={cn(
        "hidden gap-3.5 border-b border-line px-0.5 py-2.5 text-[10px] font-bold uppercase tracking-wide text-text-3 sm:grid",
        TIMELINE_GRID,
      )}
    >
      <div>{t("date")}</div>
      <div>{t("instrument")}</div>
      <div>{t("type")}</div>
      <div className="text-right">{t("shares")}</div>
      <div className="text-right">{t("perShare")}</div>
      <div className="text-right">{t("amount")}</div>
    </div>
  );
}

/** 36×36 rounded-square badge; dashed outline for forecast rows (reference).
 *  Tinted by payment type — green for dividends, teal for coupons/interest. */
function TimelineBadge({ label, type, forecast }: { label: string; type: string; forecast: boolean }) {
  const tone =
    type === "coupon" || type === "interest"
      ? { bg: "rgba(13,148,136,.16)", fg: "#0D9488" }
      : { bg: "rgba(16,163,114,.14)", fg: "#0E9F6E" };
  return (
    <span
      className="inline-flex size-9 shrink-0 items-center justify-center rounded-[11px] text-[10px] font-extrabold"
      style={
        forecast
          ? { backgroundColor: "transparent", color: tone.fg, border: `1.5px dashed ${tone.fg}` }
          : { backgroundColor: tone.bg, color: tone.fg }
      }
      aria-hidden
    >
      {monogram(label)}
    </span>
  );
}

export function IncomeEventsTable({ rows }: { rows: IncomeEventRow[] }) {
  const t = useTranslations("Income");
  const tt = useTranslations("TxType");
  const locale = useLocale();
  const df = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" });
  const api = useApiClient();
  const router = useRouter();
  const [detailTx, setDetailTx] = useState<TxRow | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);

  // Received (non-forecast) rows carry the underlying transaction id/portfolio — open the
  // same detail sheet used on the Activity page. Forecast rows have no backing transaction.
  const openRow = async (e: IncomeEventRow) => {
    if (!e.transactionId || !e.portfolioId) return;
    setLoadingId(e.transactionId);
    try {
      const list = await api.listTransactions(e.portfolioId);
      setDetailTx(list.find((r) => r.id === e.transactionId) ?? null);
    } finally {
      setLoadingId(null);
    }
  };

  return (
    <div>
      {rows.map((e, i) => {
        const forecast = Boolean(e.status);
        const clickable = !forecast && Boolean(e.transactionId && e.portfolioId);
        const label = e.symbol ?? e.displayName ?? e.name ?? "—";
        const typeLabel = tt(e.type);
        const dateLabel = df.format(new Date(e.date));
        const amountLabel = formatMoney(Number(e.amount), e.currency, locale);
        const amountClass = forecast
          ? "text-text-2"
          : Number(e.amount) >= 0
            ? "text-success"
            : "text-destructive";
        const shares =
          e.quantity != null
            ? Number(e.quantity).toLocaleString(locale, { maximumFractionDigits: 4 })
            : "—";
        const perShare = e.perShare != null ? formatMoney(Number(e.perShare), e.currency, locale) : "—";
        // Forecast growth/contribution assumptions no longer have a dedicated row —
        // surface them on hover so the number's basis stays discoverable.
        const title = [
          e.growthApplied !== undefined
            ? t("growthHint", { pct: `${e.growthApplied >= 1 ? "+" : ""}${((e.growthApplied - 1) * 100).toFixed(1)}%` })
            : null,
          e.assumesContributions ? t("contributionsHint") : null,
        ]
          .filter(Boolean)
          .join(" · ") || undefined;

        const estTag = forecast && (
          <span className="shrink-0 rounded-[5px] bg-line px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-text-3">
            {t("est")}
          </span>
        );

        return (
          <div
            key={`${e.instrumentId}-${e.date}-${i}`}
            title={title}
            style={forecast ? { opacity: 0.78 } : undefined}
            role={clickable ? "button" : undefined}
            tabIndex={clickable ? 0 : undefined}
            onClick={clickable ? () => openRow(e) : undefined}
            onKeyDown={
              clickable
                ? (ev) => {
                    if (ev.key === "Enter" || ev.key === " ") {
                      ev.preventDefault();
                      void openRow(e);
                    }
                  }
                : undefined
            }
            className={cn(
              i > 0 && "border-t border-line",
              clickable && "cursor-pointer transition-colors hover:bg-muted/40",
              loadingId === e.transactionId && "opacity-60",
            )}
          >
            {/* Desktop: 6-column grid. */}
            <div className={cn("hidden items-center gap-3.5 px-0.5 py-[11px] sm:grid", TIMELINE_GRID)}>
              <span className="tabular whitespace-nowrap text-xs font-semibold text-text-2">{dateLabel}</span>
              <div className="flex min-w-0 items-center gap-2.5">
                <TimelineBadge label={label} type={e.type} forecast={forecast} />
                <span className="truncate text-[13px] font-bold">{label}</span>
                {estTag}
              </div>
              <span className="truncate text-xs font-medium text-text-2">{typeLabel}</span>
              <span className="tabular text-right text-[13px] font-semibold text-text-mute">{shares}</span>
              <span className="tabular text-right text-[13px] font-semibold text-text-mute">{perShare}</span>
              <span className={cn("tabular whitespace-nowrap text-right text-sm font-bold", amountClass)}>
                {amountLabel}
              </span>
            </div>

            {/* Mobile: flex row. */}
            <div className="flex items-center gap-3 px-0.5 py-[11px] sm:hidden">
              <TimelineBadge label={label} type={e.type} forecast={forecast} />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-[13px] font-bold">{label}</span>
                  {estTag}
                </div>
                <span className="truncate text-[11px] font-medium text-text-2">
                  {typeLabel} {" · "} {dateLabel}
                </span>
              </div>
              <span className={cn("tabular shrink-0 text-sm font-bold", amountClass)}>{amountLabel}</span>
            </div>
          </div>
        );
      })}

      <TransactionDetailSheet
        tx={detailTx}
        open={!!detailTx}
        onOpenChange={(o) => {
          if (!o) setDetailTx(null);
        }}
        onDeleted={() => {
          setDetailTx(null);
          router.refresh();
        }}
      />
    </div>
  );
}
