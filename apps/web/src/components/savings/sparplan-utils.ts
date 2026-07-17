import type { useTranslations } from "next-intl";
import type { DetectedPlan } from "@portfolio/api-client";

export function cadenceLabel(months: number, t: ReturnType<typeof useTranslations>): string {
  if (months === 1) return t("cadenceMonthlyLabel");
  if (months === 3) return t("cadenceQuarterlyLabel");
  if (months === 6) return t("cadenceSemiAnnualLabel");
  return t("cadenceAnnualLabel");
}

export function addMonths(dateStr: string, months: number): Date {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

export function nextExecution(plan: DetectedPlan): Date {
  return addMonths(plan.lastExecution, plan.cadenceMonths);
}

export function shortDate(d: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" }).format(d);
}
