"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { ChevronRight, Target } from "lucide-react";
import { Card } from "@/components/ui/card";
import { formatMoney } from "@/lib/utils";
import {
  SparplanTargetEditor,
  type TargetSleeve,
} from "@/components/savings/sparplan-target-editor";
import type { Props } from "./sparplan-types";
import { nextExecution, shortDate } from "./sparplan-utils";
import { PlanRow } from "./plan-row";
import { AllocationSection, SEG_COLORS } from "./allocation-section";

export function SparplanSection({
  data,
  currency,
  locale,
  portfolioId,
  drift,
  contributionSplit,
}: Props) {
  const t = useTranslations("Savings");
  const td = useTranslations("DriftBadge");
  const [targetsOpen, setTargetsOpen] = useState(false);

  if (data.plans.length === 0) {
    return null;
  }

  const activePlans = data.plans.filter((p) => p.status === "active");
  const stoppedPlans = data.plans.filter((p) => p.status === "stopped");

  const driftByKey = new Map(drift?.map((d) => [d.key, d]) ?? []);
  const nameByKey = new Map(
    data.plans.map((p) => [p.instrumentId, p.name ?? p.symbol ?? p.instrumentId]),
  );

  const orderedKeys = [
    ...activePlans.map((p) => p.instrumentId),
    ...(drift ?? [])
      .map((d) => d.key)
      .filter((k) => !activePlans.some((p) => p.instrumentId === k)),
  ];
  const colorByKey = new Map(orderedKeys.map((k, i) => [k, SEG_COLORS[i % SEG_COLORS.length]]));

  const targetSleeves: TargetSleeve[] = (activePlans.length > 0 ? activePlans : data.plans).map(
    (p) => ({
      key: p.instrumentId,
      name: p.symbol ?? p.name ?? p.instrumentId,
      color: colorByKey.get(p.instrumentId) ?? SEG_COLORS[0],
    }),
  );

  const monthlyTotal = formatMoney(Number(data.activeMonthlyTotalDisplay), currency, locale);
  const nextDue =
    activePlans.length > 0
      ? activePlans.map(nextExecution).reduce((min, d) => (d < min ? d : min))
      : null;

  return (
    <Card className="min-w-0 rounded-[20px] p-5">
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
          {nextDue && (
            <>
              {" "}
              {" · "}
              {t("planNext", { date: shortDate(nextDue, locale) })}
            </>
          )}
        </p>
      )}

      {portfolioId && targetsOpen && (
        <div className="mt-4">
          <SparplanTargetEditor
            portfolioId={portfolioId}
            sleeves={targetSleeves}
            onClose={() => setTargetsOpen(false)}
          />
        </div>
      )}

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
