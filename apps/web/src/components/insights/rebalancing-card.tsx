"use client";

import { useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { Pencil, Info, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { useApiClient } from "@/lib/api";
import { useRouter } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import type { DriftRow, TargetWeight } from "@portfolio/api-client";

const COLORS = [
  "var(--color-chart-1)",
  "var(--color-chart-2)",
  "var(--color-chart-3)",
  "var(--color-chart-4)",
  "var(--color-chart-5)",
];

export interface RebalancingSlice {
  key: string;
  label: string;
  actualPct: number;
}

function sum(rows: { targetPct: number }[]): number {
  return rows.reduce((acc, r) => acc + r.targetPct, 0);
}

/**
 * Focused inline "Rebalancing" card for the Insights screen: read view (actual → target,
 * signed drift, dots) that flips to an inline edit form on "Edit". Reuses the same
 * target-setting API (`getPortfolioTargets`/`putPortfolioTargets` or the networth-scoped
 * equivalents) as {@link TargetDialog} — this is a new presentation over the same
 * persistence, not a second target-setting implementation.
 */
export function RebalancingCard({
  portfolioId,
  slices,
  drift,
}: {
  /** Undefined = aggregate ("all portfolios") scope; set = single-portfolio scope. */
  portfolioId?: string;
  /** Asset-class allocation slices (same order/colors as the Holdings donut). */
  slices: RebalancingSlice[];
  /** Saved-target drift rows for the `asset_class` dimension, when the user has any. */
  drift?: DriftRow[];
}) {
  const t = useTranslations("Insights.rebalancingCard");
  const td = useTranslations("TargetDialog");
  const api = useApiClient();
  const router = useRouter();

  const [editing, setEditing] = useState(false);
  const [rows, setRows] = useState<{ key: string; label: string; targetPct: number }[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const driftByKey = new Map((drift ?? []).map((d) => [d.key, d]));
  const hasTargets = (drift ?? []).length > 0;
  const maxAbsDrift = (drift ?? []).reduce((m, d) => Math.max(m, Math.abs(d.driftPct)), 0);
  const onTarget = hasTargets && (drift ?? []).every((d) => d.status === "on_target");

  const fetchTargets = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const existing = portfolioId
        ? await api.getPortfolioTargets(portfolioId, "asset_class")
        : await api.getNetworthTargets("asset_class");
      const targetByKey = new Map(existing.map((tw) => [tw.key, tw.targetPct]));
      setRows(
        slices.map((s) => ({
          key: s.key,
          label: s.label,
          targetPct: targetByKey.get(s.key) ?? Math.round(s.actualPct),
        })),
      );
    } catch {
      setError(td("loadError"));
    } finally {
      setLoading(false);
    }
  }, [api, portfolioId, slices, td]);

  function startEdit() {
    setEditing(true);
    void fetchTargets();
  }

  function resetToDefault() {
    setRows(slices.map((s) => ({ key: s.key, label: s.label, targetPct: Math.round(s.actualPct) })));
  }

  function updateRow(key: string, value: string) {
    const pct = parseFloat(value);
    setRows((prev) =>
      prev.map((r) => (r.key === key ? { ...r, targetPct: Number.isNaN(pct) ? 0 : pct } : r)),
    );
  }

  const total = sum(rows);
  const sumOk = Math.abs(total - 100) <= 0.5;

  async function handleSave() {
    if (!sumOk) return;
    setSaving(true);
    setError(null);
    try {
      const targets: TargetWeight[] = rows.map((r) => ({ key: r.key, targetPct: r.targetPct }));
      if (portfolioId) {
        await api.putPortfolioTargets(portfolioId, "asset_class", targets);
      } else {
        await api.putNetworthTargets("asset_class", targets);
      }
      setEditing(false);
      router.refresh();
    } catch {
      setError(td("saveError"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-bold">{t("title")}</h2>
        <div className="flex items-center gap-2">
          {hasTargets && !editing && (
            <span className="rounded-lg bg-warning/15 px-[9px] py-1 text-[11px] font-bold text-warning">
              {t("drift", { pct: maxAbsDrift.toFixed(1) })}
            </span>
          )}
          {!editing && (
            <Button variant="outline" size="sm" className="h-7 gap-1 text-xs" onClick={startEdit}>
              <Pencil className="size-3" />
              {t("edit")}
            </Button>
          )}
        </div>
      </div>

      {!editing && (
        <p className="mt-1 text-xs text-muted-foreground">
          {t("subtitle", { status: onTarget ? t("statusOnTarget") : t("statusDrifting") })}
        </p>
      )}

      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}

      {editing ? (
        loading ? (
          <div className="flex justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="mt-3 space-y-3">
            {rows.map((row, i) => (
              <div key={row.key} className="flex items-center gap-3">
                <span
                  className="size-2.5 shrink-0 rounded-full"
                  style={{ background: COLORS[i % COLORS.length] }}
                />
                <span className="flex-1 text-sm">{row.label}</span>
                <div className="flex w-24 items-center gap-1">
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    step={0.1}
                    value={row.targetPct === 0 ? "" : String(row.targetPct)}
                    placeholder="0"
                    className="h-7 text-right tabular text-sm"
                    onChange={(e) => updateRow(row.key, e.target.value)}
                  />
                  <span className="shrink-0 text-sm text-muted-foreground">%</span>
                </div>
              </div>
            ))}

            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={resetToDefault}
                className="text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                {t("reset")}
              </button>
              <span
                className={cn(
                  "text-xs tabular",
                  sumOk ? "text-muted-foreground" : "font-medium text-destructive",
                )}
              >
                {td("total")}: {total.toFixed(1)}% {!sumOk && td("mustEqual100")}
              </span>
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <Button variant="outline" size="sm" onClick={() => setEditing(false)}>
                {td("cancel")}
              </Button>
              <Button size="sm" onClick={handleSave} disabled={!sumOk || saving}>
                {saving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
                {td("save")}
              </Button>
            </div>
          </div>
        )
      ) : (
        <div className="mt-3 space-y-2.5">
          {slices.map((s, i) => {
            const d = driftByKey.get(s.key);
            return (
              <div key={s.key} className="flex items-center gap-2 text-sm">
                <span
                  className="size-2.5 shrink-0 rounded-full"
                  style={{ background: COLORS[i % COLORS.length] }}
                />
                <span className="flex-1 truncate">{s.label}</span>
                <span className="tabular text-muted-foreground">{s.actualPct.toFixed(1)}%</span>
                {d && (
                  <>
                    <span className="text-muted-foreground">→</span>
                    <span className="tabular text-muted-foreground">{d.targetPct.toFixed(0)}%</span>
                    <span
                      className={cn(
                        "tabular w-14 text-right font-medium",
                        d.status === "over" && "text-warning",
                        d.status === "under" && "text-destructive",
                        d.status === "on_target" && "text-success",
                      )}
                    >
                      {d.driftPct > 0 ? "+" : ""}
                      {d.driftPct.toFixed(1)}pp
                    </span>
                  </>
                )}
              </div>
            );
          })}

          {!hasTargets && <p className="text-xs text-muted-foreground">{t("noTargets")}</p>}

          <div className="mt-3 flex items-start gap-2 rounded-lg bg-muted/60 p-3 text-xs text-muted-foreground">
            <Info className="mt-0.5 size-3.5 shrink-0" />
            <span>{t("note")}</span>
          </div>
        </div>
      )}
    </Card>
  );
}
