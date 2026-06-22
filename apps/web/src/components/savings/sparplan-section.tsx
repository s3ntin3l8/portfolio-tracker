import { useTranslations } from "next-intl";
import { TrendingUp, TrendingDown, ArrowRight } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatMoney } from "@/lib/utils";
import type { SparplanStats, DetectedPlan } from "@portfolio/api-client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Props {
  data: SparplanStats;
  currency: string;
  locale: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cadenceLabel(months: number, t: ReturnType<typeof useTranslations>): string {
  if (months === 1) return t("cadenceMonthly");
  if (months === 3) return t("cadenceQuarterly");
  if (months === 6) return t("cadenceSemiAnnual");
  return t("cadenceAnnual");
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StepHistory({
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
  const since = curr.since.slice(0, 7); // YYYY-MM
  const isIncrease = Number(curr.amount) > Number(prev.amount);

  return (
    <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
      {isIncrease ? (
        <TrendingUp className="h-3 w-3 text-success shrink-0" />
      ) : (
        <TrendingDown className="h-3 w-3 text-destructive shrink-0" />
      )}
      <span>
        {t("stepSince", {
          from: formatMoney(Number(prev.amountDisplay), plan.currency, locale),
          to: formatMoney(Number(curr.amountDisplay), plan.currency, locale),
          date: since,
        })}
      </span>
    </div>
  );
}

function PlanRow({
  plan,
  locale,
  t,
}: {
  plan: DetectedPlan;
  locale: string;
  t: ReturnType<typeof useTranslations>;
}) {
  const label = plan.name ?? plan.symbol ?? plan.instrumentId;
  const amountLabel = `${formatMoney(Number(plan.currentAmountDisplay), plan.currency, locale)} ${cadenceLabel(plan.cadenceMonths, t)}`;

  return (
    <div className="flex items-start justify-between gap-4 py-3 border-b last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-sm truncate">{label}</span>
          {plan.symbol && plan.name && (
            <span className="text-xs text-muted-foreground shrink-0">{plan.symbol}</span>
          )}
          {plan.source === "heuristic" && (
            <Badge variant="outline" className="text-xs shrink-0">
              {t("sourceHeuristic")}
            </Badge>
          )}
        </div>
        <StepHistory plan={plan} locale={locale} t={t} />
        <p className="text-xs text-muted-foreground mt-0.5">
          {t("firstSince", { date: plan.firstExecution.slice(0, 7) })}
          {" · "}
          {plan.executionCount}{" "}
          {t("executionCount", { count: plan.executionCount })}
        </p>
      </div>
      <div className="text-right shrink-0">
        <p className="font-semibold text-sm tabular">{amountLabel}</p>
        <Badge
          variant={plan.status === "active" ? "default" : "outline"}
          className="mt-1 text-xs"
        >
          {plan.status === "active" ? t("statusActive") : t("statusStopped")}
        </Badge>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function SparplanSection({ data, currency, locale }: Props) {
  const t = useTranslations("Savings");

  if (data.plans.length === 0) {
    return null;
  }

  const activePlans = data.plans.filter((p) => p.status === "active");
  const stoppedPlans = data.plans.filter((p) => p.status === "stopped");

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">{t("sparplanTitle")}</CardTitle>
          {data.activePlanCount > 0 && (
            <div className="text-right">
              <p className="text-xs text-muted-foreground">{t("detectedMonthly")}</p>
              <p className="font-semibold tabular text-sm">
                {formatMoney(Number(data.activeMonthlyTotalDisplay), currency, locale)}
                <span className="text-xs font-normal text-muted-foreground ml-1">
                  /{t("cadenceMonthlyShort")}
                </span>
              </p>
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {activePlans.length > 0 && (
          <div className="mb-2">
            {activePlans.map((plan) => (
              <PlanRow key={`${plan.instrumentId}-${plan.firstExecution}`} plan={plan} locale={locale} t={t} />
            ))}
          </div>
        )}
        {stoppedPlans.length > 0 && (
          <details className="group">
            <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground select-none flex items-center gap-1">
              <ArrowRight className="h-3 w-3 transition-transform group-open:rotate-90" />
              {t("stoppedPlans", { count: stoppedPlans.length })}
            </summary>
            <div className="mt-2">
              {stoppedPlans.map((plan) => (
                <PlanRow key={`${plan.instrumentId}-${plan.firstExecution}`} plan={plan} locale={locale} t={t} />
              ))}
            </div>
          </details>
        )}
      </CardContent>
    </Card>
  );
}
