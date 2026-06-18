"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  ShieldOff,
  Trash2,
} from "lucide-react";
import type {
  AdminVisionProvider,
  AdminVisionProvidersResponse,
  ApiClient,
  ProviderCredentialInput,
} from "@portfolio/api-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** The slice of the API client this form needs (injectable for tests). */
export type AdminVisionProvidersClient = Pick<
  ApiClient,
  | "updateAdminVisionProviders"
  | "setAdminVisionProviderCredential"
  | "clearAdminVisionProviderCredential"
>;

/** Inline key-set / clear form for one vision provider. */
function VisionCredentialEditor({
  provider,
  encryptionEnabled,
  onSet,
  onClear,
}: {
  provider: AdminVisionProvider;
  encryptionEnabled: boolean;
  onSet: (id: string, body: ProviderCredentialInput) => Promise<void>;
  onClear: (id: string) => Promise<void>;
}) {
  const t = useTranslations("Admin");
  const [open, setOpen] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Ollama is a URL-based provider — expose a URL field, not an API key field.
  const isUrlProvider = provider.id === "ollama";

  async function handleSet(e: React.FormEvent) {
    e.preventDefault();
    if (!apiKey.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const body: ProviderCredentialInput = isUrlProvider
        ? { urlOverride: apiKey.trim() }
        : { apiKey: apiKey.trim() };
      await onSet(provider.id, body);
      setApiKey("");
      setOpen(false);
    } catch {
      setError(t("credentialError"));
    } finally {
      setBusy(false);
    }
  }

  async function handleClear() {
    setBusy(true);
    setError(null);
    try {
      await onClear(provider.id);
    } catch {
      setError(t("credentialError"));
    } finally {
      setBusy(false);
    }
  }

  if (!encryptionEnabled && !isUrlProvider) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
        <ShieldOff className="size-3 shrink-0" />
        {t("encryptionDisabled")}
      </div>
    );
  }

  const hasCredential = isUrlProvider ? provider.hasUrl : provider.hasKey;
  const hint = isUrlProvider ? provider.keyHint : provider.keyHint;
  const placeholder = isUrlProvider
    ? t("visionUrlPlaceholder")
    : t("credentialPlaceholder");
  const setLabel = t("credentialSet");
  const rotateLabel = t("credentialRotate");

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        {hasCredential ? (
          <>
            <span className="flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs font-mono text-muted-foreground">
              <KeyRound className="size-3 shrink-0" />
              {hint ?? (isUrlProvider ? t("visionUrlSet") : "••••")}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-xs"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
            >
              {rotateLabel}
              {open ? <ChevronUp className="ml-1 size-3" /> : <ChevronDown className="ml-1 size-3" />}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-xs text-destructive hover:text-destructive"
              disabled={busy}
              onClick={handleClear}
              aria-label={t("credentialClear")}
            >
              {busy ? <Loader2 className="size-3 animate-spin" /> : <Trash2 className="size-3" />}
            </Button>
          </>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-xs"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
          >
            {setLabel}
            {open ? <ChevronUp className="ml-1 size-3" /> : <ChevronDown className="ml-1 size-3" />}
          </Button>
        )}
      </div>

      {open && (
        <form onSubmit={handleSet} className="flex gap-2">
          <div className="relative flex-1">
            <Input
              type={isUrlProvider ? "url" : showKey ? "text" : "password"}
              placeholder={placeholder}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className="h-7 pr-8 text-xs font-mono"
              autoComplete="off"
              autoFocus
            />
            {!isUrlProvider && (
              <button
                type="button"
                onClick={() => setShowKey((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label={showKey ? t("credentialHide") : t("credentialShow")}
              >
                {showKey ? <EyeOff className="size-3" /> : <Eye className="size-3" />}
              </button>
            )}
          </div>
          <Button
            type="submit"
            size="sm"
            className="h-7 text-xs"
            disabled={busy || !apiKey.trim()}
          >
            {busy ? <Loader2 className="size-3 animate-spin" /> : t("credentialSave")}
          </Button>
        </form>
      )}

      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

const signature = (rows: AdminVisionProvider[]) =>
  rows.map((r) => `${r.id}:${r.enabled ? 1 : 0}`).join(",");

export function AdminVisionProvidersForm({
  client,
  initialProviders,
  encryptionEnabled,
  onSuccess,
}: {
  client: AdminVisionProvidersClient;
  initialProviders: AdminVisionProvider[];
  encryptionEnabled: boolean;
  onSuccess?: () => void;
}) {
  const t = useTranslations("Admin");
  const [rows, setRows] = useState(initialProviders);
  const [baseline, setBaseline] = useState(initialProviders);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [saved, setSaved] = useState(false);

  const dirty = signature(rows) !== signature(baseline);

  function refreshFromResponse(res: AdminVisionProvidersResponse) {
    setRows(res.providers);
    setBaseline(res.providers);
    onSuccess?.();
  }

  function toggle(id: string) {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r)));
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
      const updated = await client.updateAdminVisionProviders(
        rows.map((r, i) => ({ id: r.id, enabled: r.enabled, priority: i + 1 })),
      );
      refreshFromResponse(updated);
      setSaved(true);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  async function handleSetCredential(id: string, body: ProviderCredentialInput) {
    const updated = await client.setAdminVisionProviderCredential(id, body);
    refreshFromResponse(updated);
  }

  async function handleClearCredential(id: string) {
    const updated = await client.clearAdminVisionProviderCredential(id);
    refreshFromResponse(updated);
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
          <li key={p.id} className="space-y-2 px-3 py-2.5 text-sm">
            <div className="flex items-center gap-3">
              <span className="text-xs tabular-nums text-muted-foreground">{i + 1}</span>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="font-medium">{p.label}</span>
                {!p.configured && (
                  <span className="text-xs text-muted-foreground">{t("notConfigured")}</span>
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
            </div>

            <div className="pl-6">
              <VisionCredentialEditor
                provider={p}
                encryptionEnabled={encryptionEnabled}
                onSet={handleSetCredential}
                onClear={handleClearCredential}
              />
            </div>
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
