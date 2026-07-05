import { useTranslations } from "next-intl";
import { TrendingUp, TrendingDown, ChevronRight } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatMoney, cn } from "@/lib/utils";
import { monogram, softTintFor } from "@/lib/brokerages";
import { RebalanceDialog } from "@/components/savings/rebalance-dialog";
import type { SparplanStats, DetectedPlan, DriftRow, SparplanContributionSplit } from "@portfolio/api-client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Props {
  data: SparplanStats;
  currency: string;
  locale: string;
  /** Present when a single portfolio is selected (enables rebalance dialog + drift badges). */
  portfolioId?: string;
  /** Per-instrument drift rows from the API (populated when targets are set). */
  drift?: DriftRow[];
  /** Recommended contribution split (populated when drift is present). */
  contributionSplit?: SparplanContributionSplit[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Noun cadence label ("Monthly", "Quarterly", …) for the reference's meta line. */
function cadenceLabel(months: number, t: ReturnType<typeof useTranslations>): string {
  if (months === 1) return t("cadenceMonthlyLabel");
  if (months === 3) return t("cadenceQuarterlyLabel");
  if (months === 6) return t("cadenceSemiAnnualLabel");
  return t("cadenceAnnualLabel");
}

/** Add whole months to a YYYY-MM-DD date (UTC), returning a Date. */
function addMonths(dateStr: string, months: number): Date {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

/** The plan's next projected execution: last execution + one cadence. */
function nextExecution(plan: DetectedPlan): Date {
  return addMonths(plan.lastExecution, plan.cadenceMonths);
}

function shortDate(d: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" }).format(d);
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** Inline step-increase/decrease hint shown after the plan name. */
function StepHint({
  plan,
  locale,
  t,
}: {
  plan: DetectedPlan;
  locale: string;
  t: ReturnType<typeof useTranslations>;
}) {
  if (plan.levels.length <= 1) return null;
  const prev = plan.levels[plan.levels.length - 2];
  const curr = plan.levels[plan.levels.length - 1];
  const isIncrease = Number(curr.amount) > Number(prev.amount);
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-0.5",
        isIncrease ? "text-success" : "text-destructive",
      )}
      title={t("stepSince", {
        from: formatMoney(Number(prev.amountDisplay), plan.currency, locale),
        to: formatMoney(Number(curr.amountDisplay), plan.currency, locale),
        date: curr.since.slice(0, 7),
      })}
    >
      {isIncrease ? (
        <TrendingUp className="size-3" />
      ) : (
        <TrendingDown className="size-3" />
      )}
    </span>
  );
}

/** Tiny colored drift badge (reference: 800/9, green on-target / red over / gold under). */
function DriftBadge({
  driftRow,
  t,
  td,
}: {
  driftRow: DriftRow;
  t: ReturnType<typeof useTranslations>;
  td: ReturnType<typeof useTranslations>;
}) {
  const { driftPct, status } = driftRow;
  if (status === "on_target") {
    return (
      <span className="shrink-0 text-[9px] font-extrabold uppercase tracking-wide text-success">
        {t("driftOnTarget")}
      </span>
    );
  }
  const absPct = Math.abs(driftPct).toFixed(1);
  return (
    <span
      className={cn(
        "shrink-0 text-[9px] font-extrabold uppercase tracking-wide",
        status === "over" ? "text-destructive" : "text-warning",
      )}
    >
      {status === "over" ? `+${absPct}pp` : `−${absPct}pp`}
      <span className="sr-only">
        {status === "over" ? td("over", { pct: absPct }) : td("under", { pct: absPct })}
      </span>
    </span>
  );
}

function PlanRow({
  plan,
  driftRow,
  locale,
  t,
  td,
}: {
  plan: DetectedPlan;
  driftRow?: DriftRow;
  locale: string;
  t: ReturnType<typeof useTranslations>;
  td: ReturnType<typeof useTranslations>;
}) {
  const label = plan.name ?? plan.symbol ?? plan.instrumentId;
  const tone = softTintFor(label);
  const amount = formatMoney(Number(plan.currentAmountDisplay), plan.currency, locale);

  return (
    <div className="flex items-center gap-3">
      {/* 40×40 rounded-square monogram — soft tint + colored initials (reference). */}
      <span
        className="inline-flex size-10 shrink-0 items-center justify-center rounded-[12px] text-xs font-extrabold"
        style={{ backgroundColor: tone.bg, color: tone.fg }}
        aria-hidden
      >
        {monogram(label)}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[13px] font-bold">{label}</span>
          <StepHint plan={plan} locale={locale} t={t} />
          {driftRow && <DriftBadge driftRow={driftRow} t={t} td={td} />}
          {plan.source === "heuristic" && (
            <Badge variant="outline" className="h-4 shrink-0 px-1 text-[9px] font-semibold">
              {t("sourceHeuristic")}
            </Badge>
          )}
        </div>
        <p className="mt-0.5 truncate text-[11px] font-medium text-text-2">
          {cadenceLabel(plan.cadenceMonths, t)}
          {plan.status === "active" && (
            <> {" · "}{t("planNext", { date: shortDate(nextExecution(plan), locale) })}</>
          )}
        </p>
      </div>

      <div className="shrink-0 text-right">
        <p className="tabular text-[13px] font-bold">{amount}</p>
        {driftRow ? (
          <p className="tabular mt-0.5 text-[10px] font-semibold text-text-3">
            {t("nowPct", { pct: driftRow.actualPct.toFixed(0) })}
          </p>
        ) : (
          plan.status === "stopped" && (
            <p className="mt-0.5 text-[10px] font-semibold text-text-3">{t("statusStopped")}</p>
          )
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function SparplanSection({ data, currency, locale, portfolioId, drift, contributionSplit }: Props) {
  const t = useTranslations("Savings");
  const td = useTranslations("DriftBadge");

  if (data.plans.length === 0) {
    return null;
  }

  const activePlans = data.plans.filter((p) => p.status === "active");
  const stoppedPlans = data.plans.filter((p) => p.status === "stopped");

  // Build a drift-row lookup by instrumentId.
  const driftByKey = new Map(drift?.map((d) => [d.key, d]) ?? []);

  // Header total subtitle: "{monthly}/mo total · next {date}".
  const monthlyTotal = formatMoney(Number(data.activeMonthlyTotalDisplay), currency, locale);
  const nextDue =
    activePlans.length > 0
      ? activePlans
          .map(nextExecution)
          .reduce((min, d) => (d < min ? d : min))
      : null;

  return (
    <Card className="rounded-[20px] p-5">
      {/* Header: title + "Set targets" trigger + active pill */}
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-base font-bold">{t("sparplanTitle")}</h2>
        <div className="flex shrink-0 items-center gap-2">
          {portfolioId && (
            <RebalanceDialog
              portfolioId={portfolioId}
              plans={activePlans.length > 0 ? activePlans : data.plans}
              activeMonthlyTotalDisplay={data.activeMonthlyTotalDisplay}
              currency={currency}
              drift={drift}
              contributionSplit={contributionSplit}
              trigger={
                <button
                  type="button"
                  className="rounded-[9px] border border-border bg-card px-2.5 py-1 text-[11px] font-bold text-text-2 transition-transform active:scale-95"
                >
                  {t("setTargets")}
                </button>
              }
            />
          )}
          {activePlans.length > 0 && (
            <span className="shrink-0 rounded-lg bg-success/15 px-2 py-1 text-[11px] font-bold text-success">
              {t("activeCount", { count: activePlans.length })}
            </span>
          )}
        </div>
      </div>

      {data.activePlanCount > 0 && (
        <p className="mt-0.5 text-xs font-medium text-text-2">
          {t("planTotalMonthly", { amount: monthlyTotal })}
          {nextDue && <> {" · "}{t("planNext", { date: shortDate(nextDue, locale) })}</>}
        </p>
      )}

      {/* Stacked plan list (reference: flex column, gap 12px — not a bordered table). */}
      {activePlans.length > 0 && (
        <div className="mt-4 space-y-3">
          {activePlans.map((plan) => (
            <PlanRow
              key={`${plan.instrumentId}-${plan.firstExecution}`}
              plan={plan}
              driftRow={driftByKey.get(plan.instrumentId)}
              locale={locale}
              t={t}
              td={td}
            />
          ))}
        </div>
      )}

      {stoppedPlans.length > 0 && (
        <details className="group mt-3">
          <summary className="flex cursor-pointer select-none items-center gap-1 text-xs font-medium text-text-2 hover:text-foreground">
            <ChevronRight className="size-3 transition-transform group-open:rotate-90" />
            {t("stoppedPlans", { count: stoppedPlans.length })}
          </summary>
          <div className="mt-3 space-y-3">
            {stoppedPlans.map((plan) => (
              <PlanRow
                key={`${plan.instrumentId}-${plan.firstExecution}`}
                plan={plan}
                driftRow={driftByKey.get(plan.instrumentId)}
                locale={locale}
                t={t}
                td={td}
              />
            ))}
          </div>
        </details>
      )}
    </Card>
  );
}
