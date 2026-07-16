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
import type { TargetWeight } from "@portfolio/api-client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A slice to display in the target form. */
export interface TargetSlice {
  key: string;
  /** Human-readable label shown in the form. */
  label: string;
  /** Current actual percentage, 0–100. Used to pre-fill if no target is set. */
  actualPct: number;
}

interface Props {
  /**
   * Whether this dialog scopes to a specific portfolio.
   * When undefined, targets are saved at the aggregate (networth) level.
   */
  portfolioId?: string;
  /** Allocation dimension, e.g. "asset_class". */
  dimension: string;
  /** Human-readable dimension label for the dialog title. */
  dimensionLabel: string;
  /** Slices from the current allocation breakdown. */
  slices: TargetSlice[];
  /** The "open dialog" trigger node. */
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
 * Modal for setting per-dimension target allocation weights.
 *
 * The user enters a `%` for each slice; the form validates that the sum equals
 * 100 (±0.5). On save, the entire (portfolioId?, dimension) set is replaced
 * atomically. After save, router.refresh() pulls the updated drift into RSC.
 */
export function TargetDialog({ portfolioId, dimension, dimensionLabel, slices, trigger }: Props) {
  const t = useTranslations("TargetDialog");
  const api = useApiClient();
  const router = useRouter();

  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<{ key: string; label: string; targetPct: number }[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch existing targets and pre-fill the form.
  const fetchTargets = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const existing = portfolioId
        ? await api.getPortfolioTargets(portfolioId, dimension)
        : await api.getNetworthTargets(dimension);

      const targetByKey = new Map(existing.map((tw) => [tw.key, tw.targetPct]));
      setRows(
        slices.map((s) => ({
          key: s.key,
          label: s.label,
          // Pre-fill with existing target; fall back to actual pct; fall back to 0.
          targetPct: targetByKey.get(s.key) ?? Math.round(s.actualPct),
        })),
      );
    } catch {
      setError(t("loadError"));
    } finally {
      setLoading(false);
    }
  }, [api, portfolioId, dimension, slices, t]);

  // Handle dialog open/close — fetch targets on open.
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
      if (portfolioId) {
        await api.putPortfolioTargets(portfolioId, dimension, targets);
      } else {
        await api.putNetworthTargets(dimension, targets);
      }
      setOpen(false);
      router.refresh();
    } catch {
      setError(t("saveError"));
    } finally {
      setSaving(false);
    }
  }

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
          <DialogTitle>{t("title", { dimension: dimensionLabel })}</DialogTitle>
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
