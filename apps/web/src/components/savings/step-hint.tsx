"use client";

import type { DetectedPlan } from "@portfolio/api-client";
import type { useTranslations } from "next-intl";
import { TrendingUp, TrendingDown } from "lucide-react";
import { cn, formatMoney } from "@/lib/utils";

export function StepHint({
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
      {isIncrease ? <TrendingUp className="size-3" /> : <TrendingDown className="size-3" />}
    </span>
  );
}
