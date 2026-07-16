import { useTranslations } from "next-intl";
import { Card } from "@/components/ui/card";
import { formatPercent } from "@/lib/utils";
import type { InsightsStreaks } from "@portfolio/api-client";

export function StreaksCard({ streaks, locale }: { streaks: InsightsStreaks; locale: string }) {
  const t = useTranslations("Insights.streaks");
  const winRate = streaks.totalMonths > 0 ? streaks.positiveMonths / streaks.totalMonths : 0;
  const bestReturn = streaks.bestStreak ? Number(streaks.bestStreak.totalReturnPct) : null;
  const worstReturn = streaks.worstStreak ? Number(streaks.worstStreak.totalReturnPct) : null;

  return (
    <Card className="rounded-[20px] bg-card p-4 shadow-card">
      <p className="text-xs font-semibold text-text-2">{t("title")}</p>

      <div className="mt-2 flex gap-4">
        <div className="flex-1">
          <p className="text-xs text-text-2">{t("bestRun")}</p>
          {streaks.bestStreak ? (
            <>
              <p className="text-lg font-extrabold text-success">{streaks.bestStreak.length}mo</p>
              <p className="text-xs text-text-2">
                {bestReturn !== null ? formatPercent(bestReturn, locale) : ""}
              </p>
              <p className="text-[10px] text-text-2">
                {streaks.bestStreak.start.slice(0, 7)} → {streaks.bestStreak.end.slice(0, 7)}
              </p>
            </>
          ) : (
            <p className="text-lg font-extrabold text-text-2">—</p>
          )}
        </div>
        <div className="flex-1">
          <p className="text-xs text-text-2">{t("worstRun")}</p>
          {streaks.worstStreak ? (
            <>
              <p className="text-lg font-extrabold text-destructive">
                {streaks.worstStreak.length}mo
              </p>
              <p className="text-xs text-text-2">
                {worstReturn !== null ? formatPercent(worstReturn, locale) : ""}
              </p>
              <p className="text-[10px] text-text-2">
                {streaks.worstStreak.start.slice(0, 7)} → {streaks.worstStreak.end.slice(0, 7)}
              </p>
            </>
          ) : (
            <p className="text-lg font-extrabold text-text-2">—</p>
          )}
        </div>
      </div>

      {streaks.bestMonth && (
        <div className="mt-2 flex gap-3 text-[10px] text-text-2">
          <span>
            {t("bestMonth")}:{" "}
            <span className="font-semibold text-success">
              {formatPercent(Number(streaks.bestMonth.returnPct), locale)}
            </span>{" "}
            ({streaks.bestMonth.date})
          </span>
          {streaks.worstMonth && (
            <span>
              {t("worstMonth")}:{" "}
              <span className="font-semibold text-destructive">
                {formatPercent(Number(streaks.worstMonth.returnPct), locale)}
              </span>{" "}
              ({streaks.worstMonth.date})
            </span>
          )}
        </div>
      )}

      <div className="mt-2 text-[10px] text-text-2">
        <span>
          {t("positiveMonths", {
            pct: Math.round(winRate * 100),
            pos: streaks.positiveMonths,
            total: streaks.totalMonths,
          })}
        </span>
      </div>
    </Card>
  );
}
