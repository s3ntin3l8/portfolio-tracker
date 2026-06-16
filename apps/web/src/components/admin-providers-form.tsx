"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { AlertCircle, ArrowDown, ArrowUp, Check, Loader2 } from "lucide-react";
import type { AdminProvider, ApiClient } from "@portfolio/api-client";
import { Button } from "@/components/ui/button";

/** The slice of the API client this form needs (injectable for tests). */
export type AdminProvidersClient = Pick<ApiClient, "updateAdminProviders">;

/** A read-only "X / Y today" (or "X this month") badge from a provider's usage figures. */
function UsageBadge({ usage }: { usage: AdminProvider["usage"] }) {
  const t = useTranslations("Admin");
  if (!usage || usage.used === null) return null;
  const window = {
    minute: t("usageMinute"),
    day: t("usageDay"),
    month: t("usageMonth"),
  }[usage.window];
  const used = usage.used.toLocaleString();
  const text =
    usage.limit !== null
      ? t("usageUsedOfLimit", { used, limit: usage.limit.toLocaleString(), window })
      : t("usageUsed", { used, window });
  return (
    <span className="text-xs tabular-nums text-muted-foreground">
      {text}
      {usage.source === "local" && ` (${t("usageLocalHint")})`}
    </span>
  );
}

// Order + enabled flags only — id/label/configured are immutable here.
const signature = (rows: AdminProvider[]) =>
  rows.map((r) => `${r.id}:${r.enabled ? 1 : 0}`).join(",");

export function AdminProvidersForm({
  client,
  initialProviders,
  onSuccess,
}: {
  client: AdminProvidersClient;
  initialProviders: AdminProvider[];
  onSuccess?: () => void;
}) {
  const t = useTranslations("Admin");
  const [rows, setRows] = useState(initialProviders);
  // Baseline the form diffs against; advances on a successful save.
  const [baseline, setBaseline] = useState(initialProviders);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [saved, setSaved] = useState(false);

  const dirty = signature(rows) !== signature(baseline);

  function toggle(id: string) {
    setRows((rs) =>
      rs.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r)),
    );
    setSaved(false);
  }

  function move(index: number, dir: -1 | 1) {
    setRows((rs) => {
      const j = index + dir;
      if (j < 0 || j >= rs.length) return rs;
      const next = [...rs];
      [next[index], next[j]] = [next[j], next[index]];
      return next;
    });
    setSaved(false);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!dirty || busy) return;
    setBusy(true);
    setError(false);
    setSaved(false);
    try {
      // Priority is the current display order (lower = tried first).
      const updated = await client.updateAdminProviders(
        rows.map((r, i) => ({ id: r.id, enabled: r.enabled, priority: i + 1 })),
      );
      setRows(updated);
      setBaseline(updated);
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
          {t("updateError")}
        </div>
      )}

      <ul className="divide-y divide-border rounded-md border border-border">
        {rows.map((p, i) => (
          <li
            key={p.id}
            className="flex items-center gap-3 px-3 py-2.5 text-sm"
          >
            <span className="text-xs tabular-nums text-muted-foreground">
              {i + 1}
            </span>
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="font-medium">{p.label}</span>
              {!p.configured ? (
                <span className="text-xs text-muted-foreground">
                  {t("notConfigured")}
                </span>
              ) : (
                <UsageBadge usage={p.usage} />
              )}
            </div>

            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t("moveUp")}
                disabled={i === 0}
                onClick={() => move(i, -1)}
              >
                <ArrowUp className="size-4" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t("moveDown")}
                disabled={i === rows.length - 1}
                onClick={() => move(i, 1)}
              >
                <ArrowDown className="size-4" />
              </Button>
            </div>

            <Button
              type="button"
              variant={p.enabled ? "default" : "outline"}
              size="sm"
              aria-pressed={p.enabled}
              disabled={!p.configured}
              onClick={() => toggle(p.id)}
            >
              {p.enabled ? t("enabled") : t("disabled")}
            </Button>
          </li>
        ))}
      </ul>

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
