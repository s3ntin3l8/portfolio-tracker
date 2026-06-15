"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { AlertCircle, Check, Loader2 } from "lucide-react";
import type { ApiClient } from "@portfolio/api-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** The slice of the API client this form needs (injectable for tests). */
export type UpdateProfileClient = Pick<ApiClient, "updateMe">;

const CURRENCIES = ["IDR", "USD", "EUR", "SGD"];

export function UpdateProfileForm({
  client,
  initialName,
  initialCurrency,
  onSuccess,
}: {
  client: UpdateProfileClient;
  initialName: string;
  initialCurrency: string;
  onSuccess?: () => void;
}) {
  const t = useTranslations("Settings");
  const [name, setName] = useState(initialName);
  const [currency, setCurrency] = useState(initialCurrency);
  // Baseline the form diffs against; advances on a successful save so the button
  // re-disables and "Saved" shows without waiting for the server-data refresh.
  const [baseName, setBaseName] = useState(initialName);
  const [baseCurrency, setBaseCurrency] = useState(initialCurrency);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [saved, setSaved] = useState(false);

  const dirty = name.trim() !== baseName.trim() || currency !== baseCurrency;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!dirty || busy) return;
    setBusy(true);
    setError(false);
    setSaved(false);
    try {
      // Only send changed fields; an empty/blank name is treated as "no change".
      const nextName = name.trim();
      await client.updateMe({
        ...(nextName && nextName !== baseName.trim() ? { name: nextName } : {}),
        ...(currency !== baseCurrency ? { displayCurrency: currency } : {}),
      });
      setBaseName(nextName || baseName);
      setBaseCurrency(currency);
      setSaved(true);
      onSuccess?.();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="max-w-md space-y-4">
      {error && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          <AlertCircle className="size-4 shrink-0" />
          {t("updateError")}
        </div>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="profile-name">{t("name")}</Label>
        <Input
          id="profile-name"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setSaved(false);
          }}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="profile-currency">{t("displayCurrency")}</Label>
        <select
          id="profile-currency"
          value={currency}
          onChange={(e) => {
            setCurrency(e.target.value);
            setSaved(false);
          }}
          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {CURRENCIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground">{t("displayCurrencyHint")}</p>
      </div>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={busy || !dirty}>
          {busy && <Loader2 className="size-4 animate-spin" />}
          {busy ? t("saving") : t("save")}
        </Button>
        {saved && !dirty && (
          <span className="flex items-center gap-1 text-sm text-muted-foreground">
            <Check className="size-4" />
            {t("saved")}
          </span>
        )}
      </div>
    </form>
  );
}
