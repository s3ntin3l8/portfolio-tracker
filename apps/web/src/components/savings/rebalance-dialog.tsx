"use client";

import { useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { Target, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useApiClient } from "@/lib/api";
import { useRouter } from "@/i18n/navigation";
import { formatMoney } from "@/lib/utils";
import type { DetectedPlan, DriftRow, SparplanContributionSplit, TargetWeight } from "@portfolio/api-client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Props {
  portfolioId: string;
  plans: DetectedPlan[];
  activeMonthlyTotalDisplay: string;
  currency: string;
  /** Existing drift rows (from the API response) — drives the recommended split display. */
  drift?: DriftRow[];
  /** Existing contribution split (from the API response). */
  contributionSplit?: SparplanContributionSplit[];
  /** Override the default trigger button. */
  trigger?: React.ReactNode;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sum(rows: { targetPct: number }[]): number {
  return rows.reduce((acc, r) => acc + r.targetPct, 0);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Modal for setting per-instrument target allocation weights across savings plans.
 *
 * The user enters a `%` for each plan instrument; the form validates that the sum equals
 * 100 (±0.5). On save, the `instrument` dimension targets for the portfolio are replaced
 * atomically, then router.refresh() pulls the updated drift back into the server component.
 *
 * Below the form, when drift and contributionSplit are supplied, a read-only
 * "Recommended monthly split" section shows how to deploy the next contribution.
 */
export function RebalanceDialog({
  portfolioId,
  plans,
  activeMonthlyTotalDisplay,
  currency,
  drift,
  contributionSplit,
  trigger,
}: Props) {
  const t = useTranslations("RebalanceDialog");
  const api = useApiClient();
  const router = useRouter();

  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<{ key: string; label: string; targetPct: number }[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Build the form rows from existing targets (or 0) on open.
  const fetchTargets = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const existing = await api.getPortfolioTargets(portfolioId, "instrument");
      const targetByKey = new Map(existing.map((tw: TargetWeight) => [tw.key, tw.targetPct]));
      setRows(
        plans.map((p) => ({
          key: p.instrumentId,
          label: p.name ?? p.symbol ?? p.instrumentId,
          targetPct: targetByKey.get(p.instrumentId) ?? 0,
        })),
      );
    } catch {
      setError(t("loadError"));
    } finally {
      setLoading(false);
    }
  }, [api, portfolioId, plans, t]);

  function handleOpenChange(value: boolean) {
    setOpen(value);
    if (value) {
      void fetchTargets();
    }
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
      const targets: TargetWeight[] = rows.map((r) => ({
        key: r.key,
        targetPct: r.targetPct,
      }));
      await api.putPortfolioTargets(portfolioId, "instrument", targets);
      setOpen(false);
      router.refresh();
    } catch {
      setError(t("saveError"));
    } finally {
      setSaving(false);
    }
  }

  // Build a label map from plans for the recommended split section.
  const labelByKey = new Map(plans.map((p) => [p.instrumentId, p.name ?? p.symbol ?? p.instrumentId]));
  const splitByKey = new Map(contributionSplit?.map((s) => [s.key, s]) ?? []);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs">
            <Target className="h-3 w-3" />
            {t("trigger")}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-3 py-2">
            {rows.map((row) => (
              <div key={row.key} className="flex items-center gap-3">
                <Label className="flex-1 text-sm font-normal">{row.label}</Label>
                <div className="flex items-center gap-1 w-24">
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
                  <span className="text-sm text-muted-foreground shrink-0">%</span>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Sum indicator */}
        {!loading && (
          <div
            className={`text-xs text-right tabular ${
              sumOk ? "text-muted-foreground" : "text-destructive font-medium"
            }`}
          >
            {t("total")}: {total.toFixed(1)}% {!sumOk && t("mustEqual100")}
          </div>
        )}

        {/* Recommended split (read-only, shown when drift data is available) */}
        {!loading && drift && drift.length > 0 && contributionSplit && contributionSplit.length > 0 && (
          <div className="border-t pt-3 mt-1">
            <p className="text-xs font-medium text-muted-foreground mb-2">
              {t("recommendedSplit")}{" "}
              <span className="tabular">
                ({formatMoney(Number(activeMonthlyTotalDisplay), currency, "en")})
              </span>
            </p>
            <div className="space-y-1">
              {drift.map((d) => {
                const s = splitByKey.get(d.key);
                if (!s) return null;
                const label = labelByKey.get(d.key) ?? d.key;
                return (
                  <div key={d.key} className="flex items-center justify-between gap-2 text-sm">
                    <span className="text-muted-foreground truncate flex-1">{label}</span>
                    <span className="tabular font-medium shrink-0">
                      {formatMoney(Number(s.amount), currency, "en")}
                    </span>
                    <span className="text-xs text-muted-foreground shrink-0 w-12 text-right">
                      {s.sharePct.toFixed(1)}%
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {error && <p className="text-xs text-destructive">{error}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            {t("cancel")}
          </Button>
          <Button onClick={handleSave} disabled={!sumOk || saving || loading}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
            {t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
