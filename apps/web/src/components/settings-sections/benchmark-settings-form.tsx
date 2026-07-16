"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useApiClient } from "@/lib/api";
import { useRouter } from "@/i18n/navigation";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export function BenchmarkSettingsForm({
  symbol,
  rate,
}: {
  symbol: string | null;
  rate: number | null;
}) {
  const t = useTranslations("Settings");
  const api = useApiClient();
  const router = useRouter();
  const [benchmarkSymbol, setBenchmarkSymbol] = useState(symbol ?? "");
  const [riskFreeRate, setRiskFreeRate] = useState(rate != null ? String(rate) : "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const dirty =
    (benchmarkSymbol || null) !== symbol ||
    (riskFreeRate !== "" ? Number(riskFreeRate) : null) !== rate;

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.putPreferences({
        benchmarkSymbol: benchmarkSymbol || null,
        riskFreeRate: riskFreeRate !== "" ? Number(riskFreeRate) : null,
      });
      setSaved(true);
      router.refresh();
    } catch {
      // silently fail
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <label className="text-xs font-medium text-text-3">{t("benchmarkSymbolLabel")}</label>
        <Input
          value={benchmarkSymbol}
          onChange={(e) => {
            setBenchmarkSymbol(e.target.value);
            setSaved(false);
          }}
          placeholder="^GSPC"
          className="h-8 text-sm"
        />
        <p className="px-0.5 text-xs text-muted-foreground">{t("benchmarkSymbolHint")}</p>
      </div>
      <div className="space-y-2">
        <label className="text-xs font-medium text-text-3">{t("riskFreeRateLabel")}</label>
        <Input
          type="number"
          step="0.001"
          min="0"
          max="1"
          value={riskFreeRate}
          onChange={(e) => {
            setRiskFreeRate(e.target.value);
            setSaved(false);
          }}
          placeholder="0.03"
          className="h-8 text-sm"
        />
        <p className="px-0.5 text-xs text-muted-foreground">{t("riskFreeRateHint")}</p>
      </div>
      <Button size="sm" disabled={!dirty || saving} onClick={handleSave}>
        {saving ? t("saving") : saved ? t("saved") : t("save")}
      </Button>
    </div>
  );
}
