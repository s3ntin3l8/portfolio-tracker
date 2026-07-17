"use client";

import type { DriftRow } from "@portfolio/api-client";
import type { useTranslations } from "next-intl";

const DRIFT_BADGE_STYLE: Record<DriftRow["status"], { color: string; backgroundColor: string }> = {
  on_target: { color: "#0E9F6E", backgroundColor: "rgba(16,163,114,.14)" },
  over: { color: "#E5484D", backgroundColor: "rgba(229,72,77,.13)" },
  under: { color: "var(--gold-fg)", backgroundColor: "rgba(224,165,58,.16)" },
};

export function DriftBadge({
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
