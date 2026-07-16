"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useApiClient } from "@/lib/api";
import { useRouter } from "@/i18n/navigation";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export function RetirementAgeForm({ age }: { age: number | null }) {
  const t = useTranslations("Settings");
  const api = useApiClient();
  const router = useRouter();
  const [value, setValue] = useState(age != null ? String(age) : "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const dirty = (value !== "" ? Number(value) : null) !== age;

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.putPreferences({
        retirementAge: value !== "" ? Number(value) : null,
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
        <label className="text-xs font-medium text-text-3">{t("retirementAge")}</label>
        <Input
          type="number"
          min={50}
          max={80}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setSaved(false);
          }}
          placeholder="67"
          className="h-8 text-sm"
        />
        <p className="px-0.5 text-xs text-muted-foreground">{t("retirementAgeHint")}</p>
      </div>
      <Button size="sm" disabled={!dirty || saving} onClick={handleSave}>
        {saving ? t("saving") : saved ? t("saved") : t("save")}
      </Button>
    </div>
  );
}
