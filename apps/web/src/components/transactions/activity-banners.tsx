import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { FlowBreakdownRow } from "@/components/transactions/flow-breakdown-row";
import type { AllBannerData, IncomeBannerData, TradeBannerData } from "@/lib/transaction-banners";

const CARD = "rounded-[20px] bg-card p-[22px] shadow-card";

const TONE_CLASS: Record<"up" | "down" | "neutral", string> = {
  up: "text-success",
  down: "text-destructive",
  neutral: "text-muted-foreground",
};

function StatBlock({
  label,
  value,
  sub,
  tone = "neutral",
  bordered = false,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "up" | "down" | "neutral";
  bordered?: boolean;
}) {
  return (
    <div className={cn("min-w-0", bordered && "border-l border-line pl-2.5 sm:pl-4 lg:pl-6")}>
      <p className="truncate text-[11px] font-semibold text-text-2 sm:text-xs">{label}</p>
      <p className="tabular mt-1 truncate text-sm font-extrabold sm:text-xl lg:text-[26px]">
        {value}
      </p>
      {sub && (
        <p
          className={cn(
            "tabular mt-0.5 truncate text-[11px] font-bold sm:text-xs",
            TONE_CLASS[tone],
          )}
        >
          {sub}
        </p>
      )}
    </div>
  );
}

function Breakdown({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="col-span-full border-t border-line pt-4 lg:col-span-2 lg:border-l lg:border-t-0 lg:pl-6 lg:pt-0">
      <p className="mb-2.5 text-[11px] font-semibold uppercase tracking-[.04em] text-text-3">
        {label}
      </p>
      <div className="flex flex-col gap-2.5">{children}</div>
    </div>
  );
}

/** "All" filter banner: 3 headline tiles + a "Cash flow mix" breakdown. */
export function AllFilterBanner({
  data,
  cashFlowMixLabel,
}: {
  data: AllBannerData;
  cashFlowMixLabel: string;
}) {
  return (
    <div className={CARD}>
      {/* Invested / Proceeds / Income stay on one line even on mobile (3 columns); the
          cash-flow-mix breakdown wraps to a full-width row below. */}
      <div className="grid grid-cols-3 gap-2.5 sm:gap-4 lg:grid-cols-5 lg:items-center">
        {data.tiles.map((t, i) => (
          <StatBlock
            key={i}
            label={t.label}
            value={t.value}
            sub={t.sub}
            tone={t.tone}
            bordered={i > 0}
          />
        ))}
        <Breakdown label={cashFlowMixLabel}>
          {data.mix.map((m, i) => (
            <FlowBreakdownRow key={i} {...m} />
          ))}
        </Breakdown>
      </div>
    </div>
  );
}

/** "Income" filter banner: Received · YTD + Projected · 12mo, plus a "By source" breakdown. */
export function IncomeFilterBanner({
  data,
  receivedLabel,
  projectedLabel,
  bySourceLabel,
}: {
  data: IncomeBannerData;
  receivedLabel: string;
  projectedLabel: string;
  bySourceLabel: string;
}) {
  return (
    <div className={CARD}>
      <div className="grid grid-cols-2 gap-2.5 sm:gap-4 lg:grid-cols-4 lg:items-center">
        <StatBlock
          label={receivedLabel}
          value={data.ytd}
          sub={data.trendLabel}
          tone={data.trendTone}
        />
        <StatBlock
          label={projectedLabel}
          value={data.projected}
          sub={data.projectedNote}
          tone="neutral"
          bordered
        />
        <Breakdown label={bySourceLabel}>
          {data.bySource.length > 0 ? (
            data.bySource.map((m, i) => <FlowBreakdownRow key={i} {...m} />)
          ) : (
            <p className="text-xs text-muted-foreground">—</p>
          )}
        </Breakdown>
      </div>
    </div>
  );
}

/** "Buys"/"Sells" filter banner: total + order count, average order, per-symbol breakdown. */
export function TradeFilterBanner({
  data,
  totalLabel,
  ordersNote,
  averageLabel,
  averageNote,
  headingLabel,
}: {
  data: TradeBannerData;
  totalLabel: string;
  ordersNote: string;
  averageLabel: string;
  averageNote: string;
  headingLabel: string;
}) {
  return (
    <div className={CARD}>
      <div className="grid grid-cols-2 gap-2.5 sm:gap-4 lg:grid-cols-4 lg:items-center">
        <StatBlock label={totalLabel} value={data.total} sub={ordersNote} tone="neutral" />
        <StatBlock
          label={averageLabel}
          value={data.avg}
          sub={averageNote}
          tone="neutral"
          bordered
        />
        <Breakdown label={headingLabel}>
          {data.bySymbol.map((m, i) => (
            <FlowBreakdownRow key={i} {...m} />
          ))}
        </Breakdown>
      </div>
    </div>
  );
}

/**
 * A distinct, always-visible (not gated by the "Show flagged" row-toggle, since these are
 * portfolio-scoped and carry no `transactionId` to flag a row with) banner for cash/position
 * reconciliation-gap anomalies against a connected broker.
 */
export function ReconciliationBanner({
  title,
  detail,
  tag,
}: {
  title: string;
  detail: string;
  tag: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-amber-400/40 bg-card px-4 py-3.5 shadow-[0_1px_2px_rgba(15,27,20,.04)]">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-amber-500/15 text-amber-600 dark:text-amber-400">
        <AlertTriangle className="size-4.5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-bold">{title}</p>
        <p className="text-xs text-muted-foreground">{detail}</p>
      </div>
      <span className="shrink-0 rounded-md bg-amber-500/15 px-2 py-1 text-[9px] font-bold uppercase tracking-wide text-amber-700 dark:text-amber-400">
        {tag}
      </span>
    </div>
  );
}
