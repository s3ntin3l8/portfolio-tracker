"use client";

import { useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { Target, Loader2, TrendingDown, TrendingUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
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
import type {
  DetectedPlan,
  DriftRow,
  SparplanContributionSplit,
  TargetWeight,
  TradeAction,
} from "@portfolio/api-client";

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
// Sub-components
// ---------------------------------------------------------------------------

interface TradeActionsProps {
  tradeActions: TradeAction[];
  /** null under the Indonesian regime (no allowance concept) — the footnote line is
   *  suppressed rather than showing a nonsense German figure. */
  allowanceUsed: string | null;
  remainingAllowance: string | null;
  currency: string;
  labelByKey: Map<string, string>;
}

function TradeActionsSection({
  tradeActions,
  allowanceUsed,
  remainingAllowance,
  currency,
  labelByKey,
}: TradeActionsProps) {
  const t = useTranslations("RebalanceDialog");
  const sells = tradeActions.filter((a) => a.side === "sell");
  const buys = tradeActions.filter((a) => a.side === "buy");

  return (
    <div className="border-t pt-3 mt-1 space-y-2">
      <p className="text-xs font-medium text-muted-foreground">{t("tradeActions")}</p>
      {sells.length > 0 && (
        <div className="space-y-1">
          {sells.map((a) => (
            <div key={a.key} className="flex items-center justify-between gap-2 text-sm">
              <span className="flex items-center gap-1 text-destructive shrink-0">
                <TrendingDown className="h-3 w-3" />
                {t("sell")}
              </span>
              <span className="text-muted-foreground truncate flex-1 text-xs">
                {labelByKey.get(a.key) ?? a.key}
              </span>
              <span className="tabular font-medium shrink-0">
                {formatMoney(Number(a.deltaValue), currency, "en")}
              </span>
            </div>
          ))}
        </div>
      )}
      {buys.length > 0 && (
        <div className="space-y-1">
          {buys.map((a) => (
            <div key={a.key} className="flex items-center justify-between gap-2 text-sm">
              <span className="flex items-center gap-1 text-green-600 dark:text-green-400 shrink-0">
                <TrendingUp className="h-3 w-3" />
                {t("buy")}
              </span>
              <span className="text-muted-foreground truncate flex-1 text-xs">
                {labelByKey.get(a.key) ?? a.key}
              </span>
              <span className="tabular font-medium shrink-0">
                {formatMoney(Number(a.deltaValue), currency, "en")}
              </span>
            </div>
          ))}
        </div>
      )}
      {sells.length > 0 && allowanceUsed !== null && remainingAllowance !== null && (
        <p className="text-xs text-muted-foreground border-t pt-2">
          {t("allowanceUsed", {
            used: formatMoney(Number(allowanceUsed), currency, "en"),
            remaining: formatMoney(Number(remainingAllowance), currency, "en"),
          })}
        </p>
      )}
    </div>
  );
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
 *
 * Phase D: a "Include sales (tax-aware)" toggle switches to trade recommendations
 * with sells capped by the remaining Sparerpauschbetrag allowance.
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

  // Phase D: tax-aware sales toggle state.
  const [includeSales, setIncludeSales] = useState(false);
  const [salesLoading, setSalesLoading] = useState(false);
  const [tradeActions, setTradeActions] = useState<TradeAction[] | null>(null);
  const [allowanceUsed, setAllowanceUsed] = useState<string | null>(null);
  const [remainingAllowance, setRemainingAllowance] = useState<string | null>(null);
  const [taxUnavailable, setTaxUnavailable] = useState(false);
  const [salesError, setSalesError] = useState<string | null>(null);

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

  // Fetch trade recommendations when the toggle is turned on. Under the Indonesian
  // regime the backend never sets `taxUnavailable` (no allowance/FSA concept to
  // require) and omits `allowanceUsed`/`remainingAllowance` — those fields simply stay
  // null so the footnote line above is suppressed instead of showing a nonsense
  // German figure, while the sell/buy recommendations themselves still render.
  const fetchTradeRecommendations = useCallback(async () => {
    setSalesLoading(true);
    setSalesError(null);
    try {
      const result = await api.getPortfolioSparplan(portfolioId, true);
      if (result.taxUnavailable) {
        setTaxUnavailable(true);
        setTradeActions(null);
      } else {
        setTaxUnavailable(false);
        setTradeActions(result.tradeActions ?? []);
        setAllowanceUsed(result.allowanceUsed ?? null);
        setRemainingAllowance(result.remainingAllowance ?? null);
      }
    } catch {
      setSalesError(t("loadSalesError"));
    } finally {
      setSalesLoading(false);
    }
  }, [api, portfolioId, t]);

  function handleOpenChange(value: boolean) {
    setOpen(value);
    if (value) {
      void fetchTargets();
      // Reset toggle state when reopening.
      setIncludeSales(false);
      setTradeActions(null);
      setAllowanceUsed(null);
      setRemainingAllowance(null);
      setTaxUnavailable(false);
      setSalesError(null);
    }
  }

  function handleToggleSales(checked: boolean) {
    setIncludeSales(checked);
    if (checked && tradeActions === null) {
      void fetchTradeRecommendations();
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
  const labelByKey = new Map(
    plans.map((p) => [p.instrumentId, p.name ?? p.symbol ?? p.instrumentId]),
  );
  const splitByKey = new Map(contributionSplit?.map((s) => [s.key, s]) ?? []);

  // Whether the toggle can be enabled (known unavailable only after first fetch).
  const toggleDisabled = taxUnavailable;

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

        {/* Phase D: Toggle between contributions-only and tax-aware sales */}
        {!loading && drift && drift.length > 0 && (
          <div className="border-t pt-3 mt-1">
            <div
              className="flex items-center gap-2"
              title={toggleDisabled ? t("toggleDisabled") : undefined}
            >
              <Switch
                id="include-sales-toggle"
                checked={includeSales}
                onCheckedChange={handleToggleSales}
                disabled={toggleDisabled}
                aria-label={includeSales ? t("toggleSales") : t("toggleContributions")}
              />
              <Label
                htmlFor="include-sales-toggle"
                className={`text-xs cursor-pointer ${toggleDisabled ? "text-muted-foreground/50" : "text-muted-foreground"}`}
              >
                {includeSales ? t("toggleSales") : t("toggleContributions")}
              </Label>
              {salesLoading && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
            </div>
            {toggleDisabled && (
              <p className="text-xs text-muted-foreground/70 mt-1">{t("toggleDisabled")}</p>
            )}
          </div>
        )}

        {/* Recommended split (contributions-only mode) */}
        {!loading &&
          !includeSales &&
          drift &&
          drift.length > 0 &&
          contributionSplit &&
          contributionSplit.length > 0 && (
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

        {/* Phase D: Trade recommendations (tax-aware sales mode). Under the Indonesian
            regime allowanceUsed/remainingAllowance are null (no allowance concept) —
            the sell/buy list still renders; only the allowance footnote is
            suppressed (inside TradeActionsSection). */}
        {!loading && includeSales && !salesLoading && tradeActions && tradeActions.length > 0 && (
          <TradeActionsSection
            tradeActions={tradeActions}
            allowanceUsed={allowanceUsed}
            remainingAllowance={remainingAllowance}
            currency={currency}
            labelByKey={labelByKey}
          />
        )}

        {/* No trade actions when all instruments are on-target */}
        {!loading && includeSales && !salesLoading && tradeActions && tradeActions.length === 0 && (
          <div className="border-t pt-3 mt-1">
            <p className="text-xs text-muted-foreground">{t("tradeActions")}: —</p>
          </div>
        )}

        {salesError && <p className="text-xs text-destructive">{salesError}</p>}
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
