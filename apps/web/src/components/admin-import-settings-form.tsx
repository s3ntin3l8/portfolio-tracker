"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { AlertCircle, Check, Loader2 } from "lucide-react";
import type { ApiClient, ImportStrategy } from "@portfolio/api-client";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/** The slice of the API client this form needs (injectable for tests). */
export type AdminImportSettingsClient = Pick<ApiClient, "updateAdminImportSettings">;

const STRATEGIES: ImportStrategy[] = ["parser_first", "vision_only"];

/**
 * Picks the first-choice extraction strategy for the unstructured import path
 * (screenshots + PDFs). "parser_first" runs the deterministic broker parser before the
 * vision-LLM; "vision_only" always uses the vision-LLM. CSV imports are unaffected.
 */
export function AdminImportSettingsForm({
  client,
  initialStrategy,
  onSuccess,
}: {
  client: AdminImportSettingsClient;
  initialStrategy: ImportStrategy;
  onSuccess?: () => void;
}) {
  const t = useTranslations("Admin");
  const [strategy, setStrategy] = useState<ImportStrategy>(initialStrategy);
  // Baseline the form diffs against; advances on a successful save.
  const [baseStrategy, setBaseStrategy] = useState<ImportStrategy>(initialStrategy);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [saved, setSaved] = useState(false);

  const dirty = strategy !== baseStrategy;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!dirty || busy) return;
    setBusy(true);
    setError(false);
    setSaved(false);
    try {
      const { strategy: next } = await client.updateAdminImportSettings({ strategy });
      setStrategy(next);
      setBaseStrategy(next);
      setSaved(true);
      onSuccess?.();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {error && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          <AlertCircle className="size-4 shrink-0" />
          {t("importStrategyError")}
        </div>
      )}

      <div className="space-y-2">
        <Label id="import-strategy-label">{t("importStrategyLabel")}</Label>
        <div role="radiogroup" aria-labelledby="import-strategy-label" className="space-y-2">
          {STRATEGIES.map((s) => {
            const active = strategy === s;
            return (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => {
                  setStrategy(s);
                  setSaved(false);
                }}
                className={cn(
                  "flex w-full items-start gap-3 rounded-[14px] border p-3.5 text-left transition-colors",
                  active
                    ? "border-primary bg-primary/5"
                    : "border-border bg-card hover:bg-background/60",
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "mt-0.5 flex size-[18px] shrink-0 items-center justify-center rounded-full border-2 transition-colors",
                    active ? "border-primary" : "border-border",
                  )}
                >
                  {active && <span className="size-2 rounded-full bg-primary" />}
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-bold">{t(`importStrategyOption_${s}`)}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {t(`importStrategyHint_${s}`)}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={busy || !dirty}>
          {busy && <Loader2 className="size-4 animate-spin" />}
          {busy ? t("importStrategySaving") : t("importStrategySave")}
        </Button>
        {saved && !dirty && (
          <span className="flex items-center gap-1 text-sm text-muted-foreground">
            <Check className="size-4" />
            {t("importStrategySaved")}
          </span>
        )}
      </div>
    </form>
  );
}
