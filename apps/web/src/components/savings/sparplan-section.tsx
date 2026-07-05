"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { TrendingUp, TrendingDown, ChevronRight, Target } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatMoney, cn } from "@/lib/utils";
import { monogram, softTintFor } from "@/lib/brokerages";
import { SparplanTargetEditor, type TargetSleeve } from "@/components/savings/sparplan-target-editor";
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

// Per-state pill tint (reference: 800/9 pill, green on-target / red over / gold under).
const DRIFT_BADGE_STYLE: Record<DriftRow["status"], { color: string; backgroundColor: string }> = {
  on_target: { color: "#0E9F6E", backgroundColor: "rgba(16,163,114,.14)" },
  over: { color: "#E5484D", backgroundColor: "rgba(229,72,77,.13)" },
  under: { color: "var(--gold-fg)", backgroundColor: "rgba(224,165,58,.16)" },
};

/** Per-plan deviation badge — a small tinted pill (reference: 800/9, padding 2×6, radius 6). */
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
  const absPct = Math.abs(driftPct).toFixed(1);
  const label =
    status === "on_target"
      ? t("driftOnTarget")
      : status === "over"
        ? `+${absPct}pp`
        : `−${absPct}pp`;
  return (
    <span
      className="shrink-0 rounded-[6px] px-1.5 py-0.5 text-[9px] font-extrabold"
      style={DRIFT_BADGE_STYLE[status]}
    >
      {label}
      {status !== "on_target" && (
        <span className="sr-only">
          {status === "over" ? td("over", { pct: absPct }) : td("under", { pct: absPct })}
        </span>
      )}
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
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate text-[13px] font-bold">{label}</span>
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

// Segment/legend colors, assigned per sleeve in drift order (reference: purple/teal/gold …).
const SEG_COLORS = ["#7C5CFC", "#0D9488", "var(--gold-fg)", "#0E9F6E", "#3B82F6", "#F97316"];

/**
 * "Allocation · target vs actual" block (reference: last block in the Savings-plans
 * card). Only rendered when instrument targets are set (drift present): an actual-weight
 * segmented bar, a target-vs-now legend, a gold drift callout naming the most off-target
 * sleeve, and the recommended per-sleeve split of the next monthly top-up.
 */
function AllocationSection({
  drift,
  contributionSplit,
  nameByKey,
  colorByKey,
  monthlyTotalLabel,
  currency,
  locale,
  t,
}: {
  drift: DriftRow[];
  contributionSplit?: SparplanContributionSplit[];
  nameByKey: Map<string, string>;
  colorByKey: Map<string, string>;
  monthlyTotalLabel: string;
  currency: string;
  locale: string;
  t: ReturnType<typeof useTranslations>;
}) {
  const splitByKey = new Map((contributionSplit ?? []).map((s) => [s.key, s]));
  const nameOf = (key: string) => nameByKey.get(key) ?? key;

  // Gold callout names the single most off-target sleeve (largest |drift|).
  const worst = drift
    .filter((d) => d.status !== "on_target")
    .sort((a, b) => Math.abs(b.driftPct) - Math.abs(a.driftPct))[0];

  let strong: string;
  let rest: string;
  if (!worst) {
    strong = t("driftOnTargetStrong");
    rest = t("driftOnTargetRest");
  } else {
    const name = nameOf(worst.key);
    const pct = Math.abs(worst.driftPct).toFixed(1);
    const target = `${worst.targetPct.toFixed(0)}%`;
    if (worst.status === "under") {
      const s = splitByKey.get(worst.key);
      strong = t("driftUnderStrong", { name, pct });
      rest = t("driftUnderRest", {
        amount: s ? formatMoney(Number(s.amount), currency, locale) : "—",
        target,
      });
    } else {
      strong = t("driftOverStrong", { name, pct });
      rest = t("driftOverRest", { target });
    }
  }

  return (
    <div className="mt-4 border-t border-line pt-4">
      <p className="mb-[9px] text-[11px] font-semibold uppercase tracking-wide text-text-3">
        {t("allocTitle")}
      </p>

      {/* Actual-weight segmented bar. */}
      <div className="mb-2.5 flex h-[9px] gap-0.5 overflow-hidden rounded-md">
        {drift.map((d) => (
          <span
            key={d.key}
            className="h-full rounded-[3px]"
            style={{ width: `${d.actualPct.toFixed(1)}%`, backgroundColor: colorByKey.get(d.key) }}
          />
        ))}
      </div>

      {/* target vs now legend. */}
      <div className="mb-3 flex flex-col gap-1.5">
        {drift.map((d) => (
          <div key={d.key} className="flex items-center gap-2 text-[11px] font-semibold">
            <span
              className="size-2 shrink-0 rounded-[2px]"
              style={{ backgroundColor: colorByKey.get(d.key) }}
            />
            <span className="min-w-0 flex-1 truncate text-text-2">{nameOf(d.key)}</span>
            <span className="tabular text-text-3">
              {t("allocTarget", { pct: `${d.targetPct.toFixed(0)}%` })}
            </span>
            <span className="tabular w-[62px] text-right">
              {t("allocNow", { pct: `${d.actualPct.toFixed(0)}%` })}
            </span>
          </div>
        ))}
      </div>

      {/* Gold drift callout. */}
      <div
        className="flex items-start gap-2.5 rounded-xl px-[13px] py-[11px]"
        style={{ backgroundColor: "rgba(224,165,58,.14)" }}
      >
        <svg
          width="17"
          height="17"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--gold-fg)"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="mt-px shrink-0"
          aria-hidden
        >
          <path d="M12 2v20M2 12h20" />
        </svg>
        <p className="text-xs font-medium leading-[1.45]">
          <b style={{ color: "var(--warn-strong)" }}>{strong}</b>
          <span style={{ color: "var(--warn-soft)" }}>{rest}</span>
        </p>
      </div>

      {/* Recommended next top-up split. */}
      {contributionSplit && contributionSplit.length > 0 && (
        <div className="mt-3.5">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-text-3">
            {t("recommendedTopUp", { total: monthlyTotalLabel })}
          </p>
          <div className="flex flex-col gap-1.5">
            {contributionSplit.map((s) => (
              <div key={s.key} className="flex items-center gap-2 text-xs font-semibold">
                <span className="min-w-0 flex-1 truncate text-text-2">{nameOf(s.key)}</span>
                <span className="tabular">{formatMoney(Number(s.amount), currency, locale)}</span>
                <span className="tabular w-[42px] text-right text-text-3">
                  {s.sharePct.toFixed(0)}%
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function SparplanSection({ data, currency, locale, portfolioId, drift, contributionSplit }: Props) {
  const t = useTranslations("Savings");
  const td = useTranslations("DriftBadge");
  const [targetsOpen, setTargetsOpen] = useState(false);

  if (data.plans.length === 0) {
    return null;
  }

  const activePlans = data.plans.filter((p) => p.status === "active");
  const stoppedPlans = data.plans.filter((p) => p.status === "stopped");

  // Build a drift-row lookup by instrumentId.
  const driftByKey = new Map(drift?.map((d) => [d.key, d]) ?? []);
  // instrumentId → display name, for the allocation legend / split / callout.
  const nameByKey = new Map(
    data.plans.map((p) => [p.instrumentId, p.name ?? p.symbol ?? p.instrumentId]),
  );

  // One color per sleeve, keyed by instrumentId in a stable order (active plans first,
  // then any drift-only keys). Shared by the target editor, the allocation bar & legend.
  const orderedKeys = [
    ...activePlans.map((p) => p.instrumentId),
    ...(drift ?? [])
      .map((d) => d.key)
      .filter((k) => !activePlans.some((p) => p.instrumentId === k)),
  ];
  const colorByKey = new Map(orderedKeys.map((k, i) => [k, SEG_COLORS[i % SEG_COLORS.length]]));

  // Sleeves offered in the "Set targets" editor (reference: short name per plan).
  const targetSleeves: TargetSleeve[] = (activePlans.length > 0 ? activePlans : data.plans).map(
    (p) => ({
      key: p.instrumentId,
      name: p.symbol ?? p.name ?? p.instrumentId,
      color: colorByKey.get(p.instrumentId) ?? SEG_COLORS[0],
    }),
  );

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
            <button
              type="button"
              onClick={() => setTargetsOpen((v) => !v)}
              aria-expanded={targetsOpen}
              className="flex items-center gap-1.5 rounded-[9px] border border-border bg-card px-2.5 py-1 text-[11px] font-bold text-text-mute transition-transform active:scale-95"
            >
              <Target className="size-3" />
              {t("setTargets")}
            </button>
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

      {/* Inline "Set targets" editor — expands between the sub-header and the plan list. */}
      {portfolioId && targetsOpen && (
        <div className="mt-4">
          <SparplanTargetEditor
            portfolioId={portfolioId}
            sleeves={targetSleeves}
            onClose={() => setTargetsOpen(false)}
          />
        </div>
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

      {/* Allocation · target vs actual — only when instrument targets are set. */}
      {drift && drift.length > 0 && (
        <AllocationSection
          drift={drift}
          contributionSplit={contributionSplit}
          nameByKey={nameByKey}
          colorByKey={colorByKey}
          monthlyTotalLabel={monthlyTotal}
          currency={currency}
          locale={locale}
          t={t}
        />
      )}
    </Card>
  );
}
