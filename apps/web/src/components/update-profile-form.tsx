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

export function UpdateProfileForm({
  client,
  initialName,
  onSuccess,
}: {
  client: UpdateProfileClient;
  initialName: string;
  onSuccess?: () => void;
}) {
  const t = useTranslations("Settings");
  const [name, setName] = useState(initialName);
  // Baseline the form diffs against; advances on a successful save so the button
  // re-disables and "Saved" shows without waiting for the server-data refresh.
  const [baseName, setBaseName] = useState(initialName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [saved, setSaved] = useState(false);

  const dirty = name.trim() !== baseName.trim();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!dirty || busy) return;
    setBusy(true);
    setError(false);
    setSaved(false);
    try {
      // A blank name is treated as "no change" (never overwrite the name with empty).
      const nextName = name.trim();
      await client.updateMe(nextName ? { name: nextName } : {});
      setBaseName(nextName || baseName);
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
