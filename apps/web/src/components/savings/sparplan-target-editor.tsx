"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import { useApiClient } from "@/lib/api";
import { useRouter } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import type { TargetWeight } from "@portfolio/api-client";

export interface TargetSleeve {
  key: string;
  /** Short display name (reference uses the symbol/short name here, not the long name). */
  name: string;
  /** Swatch color, shared with the allocation bar/legend for the same sleeve. */
  color: string;
}

/**
 * Inline expanding "Set targets" editor for the Savings-plans card — a 1:1 recreation of
 * the reference's accordion panel (no modal): a `card-2` panel with a target-% number
 * input per sleeve, a live Total validation line, and Cancel / Save actions. Reads and
 * writes the `instrument`-dimension targets for the portfolio; a successful save refreshes
 * the server component so the drift/allocation view below updates.
 */
export function SparplanTargetEditor({
  portfolioId,
  sleeves,
  onClose,
}: {
  portfolioId: string;
  sleeves: TargetSleeve[];
  onClose: () => void;
}) {
  const t = useTranslations("Savings");
  const api = useApiClient();
  const router = useRouter();

  const [values, setValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed the draft from the saved targets (blank when none) once on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const existing = await api.getPortfolioTargets(portfolioId, "instrument");
        if (cancelled) return;
        const byKey = new Map(existing.map((tw: TargetWeight) => [tw.key, tw.targetPct]));
        const seed: Record<string, string> = {};
        for (const s of sleeves) {
          const v = byKey.get(s.key);
          seed[s.key] = v ? String(v) : "";
        }
        setValues(seed);
      } catch {
        if (!cancelled) setError(t("targetLoadError"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, portfolioId, sleeves, t]);

  const total = sleeves.reduce((sum, s) => sum + (parseFloat(values[s.key]) || 0), 0);
  const sumOk = Math.abs(total - 100) <= 0.5;

  async function handleSave() {
    if (!sumOk || saving) return;
    setSaving(true);
    setError(null);
    try {
      const targets: TargetWeight[] = sleeves.map((s) => ({
        key: s.key,
        targetPct: parseFloat(values[s.key]) || 0,
      }));
      await api.putPortfolioTargets(portfolioId, "instrument", targets);
      router.refresh();
      onClose();
    } catch {
      setError(t("targetSaveError"));
      setSaving(false);
    }
  }

  return (
    <div className="mb-[15px] rounded-[14px] border border-border bg-card-2 p-3.5">
      <p className="text-xs font-bold">{t("targetAllocation")}</p>
      <p className="mb-3 mt-px text-[11px] font-medium text-text-2">{t("targetHelper")}</p>

      {loading ? (
        <div className="flex justify-center py-4">
          <Loader2 className="size-4 animate-spin text-text-3" />
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-[9px]">
            {sleeves.map((s) => (
              <div key={s.key} className="flex items-center gap-2.5">
                <span
                  className="size-[9px] shrink-0 rounded-[3px]"
                  style={{ backgroundColor: s.color }}
                />
                <span className="min-w-0 flex-1 truncate text-xs font-semibold">{s.name}</span>
                <span className="flex shrink-0 items-center gap-1">
                  <input
                    type="number"
                    min={0}
                    max={100}
                    step={0.1}
                    value={values[s.key] ?? ""}
                    placeholder="0"
                    aria-label={s.name}
                    onChange={(e) => setValues((prev) => ({ ...prev, [s.key]: e.target.value }))}
                    className="tabular h-[30px] w-[60px] rounded-lg border border-border bg-card px-2 text-right text-[13px] font-bold text-foreground focus:outline-none"
                  />
                  <span className="text-xs font-semibold text-text-3">%</span>
                </span>
              </div>
            ))}
          </div>

          <p
            className={cn(
              "mt-2.5 text-right text-[11px] font-bold",
              sumOk ? "text-text-3" : "text-[#E5484D]",
            )}
          >
            {t("targetTotal", { pct: total.toFixed(1) })}
            {!sumOk && t("targetMustEqual")}
          </p>

          {error && <p className="mt-1 text-[11px] text-destructive">{error}</p>}

          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 rounded-[10px] border border-border bg-card py-[9px] text-xs font-bold text-text-mute transition-transform active:scale-95"
            >
              {t("targetCancel")}
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={!sumOk || saving}
              style={{ opacity: sumOk ? 1 : 0.45 }}
              className="flex flex-1 items-center justify-center gap-1 rounded-[10px] bg-pill py-[9px] text-xs font-bold text-white transition-transform active:scale-95"
            >
              {saving && <Loader2 className="size-3.5 animate-spin" />}
              {t("targetSave")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
