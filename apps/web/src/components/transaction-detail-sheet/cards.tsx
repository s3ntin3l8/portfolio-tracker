"use client";

import { useTranslations } from "next-intl";
import { cn, formatSignedMoney } from "@/lib/utils";
import { BrokerageIcon } from "@/components/brokerage-icon";
import { SOURCE_ICON } from "@/components/transactions-table";
import { TAX_COMPONENT_LABELS } from "@/components/transaction-sources-section";
import { SOURCE_PILL, DEFAULT_PILL } from "./constants";

export function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-2 ml-0.5 mt-5 text-[12px] font-bold uppercase tracking-[.04em] text-text-3 first:mt-0">
      {children}
    </p>
  );
}

export function DetailCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="divide-y divide-line overflow-hidden rounded-[18px] border border-border bg-card">
      {children}
    </div>
  );
}

export function DetailRow({
  label,
  children,
  strong = false,
  color,
}: {
  label: string;
  children: React.ReactNode;
  strong?: boolean;
  color?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3.5 px-4 py-[13px]">
      <span
        className={cn(
          "shrink-0 text-text-2",
          strong ? "text-[14px] font-bold text-foreground" : "text-[13px] font-medium",
        )}
      >
        {label}
      </span>
      <span
        className={cn(
          "tabular min-w-0 text-right font-bold",
          strong ? "text-[16px] font-extrabold" : "text-[13px]",
          color,
        )}
      >
        {children}
      </span>
    </div>
  );
}

export function HeroAmount({
  netAmount,
  currency,
  source,
  showApproxDisplay,
  netAmountDisplay,
  effectiveDisplayCurrency,
  m,
  locale,
}: {
  netAmount: number;
  currency: string;
  source: string;
  showApproxDisplay: boolean;
  netAmountDisplay: number | null;
  effectiveDisplayCurrency: string | null;
  m: (n: number, currency: string) => string;
  locale: string;
}) {
  const t = useTranslations("Transactions");
  const pill = SOURCE_PILL[source] ?? DEFAULT_PILL;
  const SourceIcon = SOURCE_ICON[source] ?? null;

  return (
    <div className="py-2.5 pb-[18px] text-center">
      <div
        className={cn(
          "tabular text-[34px] font-extrabold leading-none",
          netAmount > 0 ? "text-success" : "text-foreground",
        )}
      >
        {formatSignedMoney(netAmount, currency, locale)}
      </div>
      {showApproxDisplay && netAmountDisplay !== null && (
        <div className="tabular mt-0.5 text-[13px] font-medium text-text-2">
          {t("approxDisplay", { amount: m(netAmountDisplay, effectiveDisplayCurrency!) })}
        </div>
      )}
      <div className="mt-2.5">
        <span
          className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[10px] font-bold uppercase tracking-[.04em]"
          style={{ background: pill.bg, color: pill.fg }}
        >
          {SourceIcon && <SourceIcon className="size-3" />}
          {t(`sources.${source}`)}
        </span>
      </div>
    </div>
  );
}

export function BreakdownCard({
  type,
  qty,
  price,
  currency,
  fees,
  tax,
  shares,
  sharesEstimated,
  perShare,
  nativeCurrency,
  grossNative,
  amount,
  netAmount,
  m,
  t,
  numFmt,
  locale,
}: {
  /** Drives the v2 design's type-specific labels — income (dividend/coupon) shows
   *  Shares/Per share/Gross/Net income instead of Quantity/Price·unit/Amount/Net amount. */
  type: string;
  qty: number;
  price: string;
  currency: string;
  fees: string;
  tax: string | null | undefined;
  shares?: string | null;
  sharesEstimated?: boolean;
  perShare?: string | null;
  nativeCurrency?: string | null;
  grossNative?: string | null;
  amount: number;
  netAmount: number;
  m: (n: number, currency: string) => string;
  t: (key: string, params?: Record<string, string | number | Date>) => string;
  numFmt: Intl.NumberFormat;
  locale: string;
}) {
  const isIncome = type === "dividend" || type === "coupon";

  return (
    <DetailCard>
      {(qty !== 0 || shares != null) && (
        <DetailRow label={isIncome ? t("shares") : t("quantity")}>
          {qty !== 0
            ? numFmt.format(qty)
            : sharesEstimated
              ? t("approxDisplay", { amount: numFmt.format(Number(shares)) })
              : numFmt.format(Number(shares))}
        </DetailRow>
      )}
      {(qty !== 0 || perShare != null) && (
        <DetailRow label={isIncome ? t("perShare") : t("priceUnit")}>
          {qty !== 0
            ? m(Number(price), currency)
            : sharesEstimated
              ? t("approxDisplay", {
                  amount: m(Number(perShare), nativeCurrency ?? currency),
                })
              : m(Number(perShare), nativeCurrency ?? currency)}
        </DetailRow>
      )}
      {grossNative != null && nativeCurrency && (
        <DetailRow label={t("grossNative")}>{m(Number(grossNative), nativeCurrency)}</DetailRow>
      )}
      <DetailRow label={isIncome ? t("gross") : t("amount")}>{m(amount, currency)}</DetailRow>
      {Number(fees) !== 0 && <DetailRow label={t("fees")}>{m(Number(fees), currency)}</DetailRow>}
      {tax != null && Number(tax) !== 0 && (
        <DetailRow label={t("taxWithheld")}>{m(Number(tax), currency)}</DetailRow>
      )}
      <DetailRow
        label={isIncome ? t("netIncome") : t("netAmount")}
        strong
        color={netAmount > 0 ? "text-success" : undefined}
      >
        {formatSignedMoney(netAmount, currency, locale)}
      </DetailRow>
    </DetailCard>
  );
}

export function DetailsCard({
  executedAt,
  instrument,
  currency,
  fxRate,
  source,
  accountName,
  account,
  taxComponentEntries,
  hasSources,
  df,
  m,
}: {
  executedAt: string;
  instrument: { symbol?: string | null; name?: string | null; displayName?: string | null } | null;
  currency: string;
  fxRate?: string | null;
  source: string;
  accountName: string | null;
  account: { brokerage?: string | null } | null;
  taxComponentEntries: [string, string][];
  hasSources: boolean;
  df: Intl.DateTimeFormat;
  m: (n: number, currency: string) => string;
}) {
  const t = useTranslations("Transactions");
  const SourceIcon = SOURCE_ICON[source] ?? null;

  return (
    <DetailCard>
      <DetailRow label={t("date")}>{df.format(new Date(executedAt))}</DetailRow>
      {instrument?.symbol && (
        <DetailRow label={t("instrument")}>
          <span>{instrument.symbol}</span>
          {(instrument.displayName ?? instrument.name) && (
            <span className="block text-[11px] font-medium text-text-2">
              {instrument.displayName ?? instrument.name}
            </span>
          )}
        </DetailRow>
      )}
      {accountName && (
        <DetailRow label={t("portfolio")}>
          <span className="flex items-center justify-end gap-2.5">
            {account?.brokerage && (
              <BrokerageIcon brokerage={account.brokerage} className="size-9 rounded-[10px]" />
            )}
            <span className="min-w-0 leading-tight">
              <span className="block truncate">{accountName}</span>
              {account?.brokerage && (
                <span className="block truncate text-[11px] font-medium text-text-2">
                  {account.brokerage}
                </span>
              )}
            </span>
          </span>
        </DetailRow>
      )}
      <DetailRow label={t("currency")}>{currency}</DetailRow>
      {fxRate && <DetailRow label={t("fxRate")}>{Number(fxRate).toFixed(4)}</DetailRow>}
      {taxComponentEntries.map(([key, value]) => (
        <DetailRow key={key} label={TAX_COMPONENT_LABELS[key] ?? key}>
          {m(Number(value), currency)}
        </DetailRow>
      ))}
      {!hasSources && (
        <DetailRow label={t("source")}>
          <span className="inline-flex items-center gap-1.5">
            {SourceIcon && <SourceIcon className="size-3.5" />}
            {t(`sources.${source}`)}
          </span>
        </DetailRow>
      )}
    </DetailCard>
  );
}
