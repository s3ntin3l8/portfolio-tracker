"use client";

import { useCallback, useState } from "react";
import { useTranslations } from "next-intl";
import { Eye, EyeOff, Pencil, ShieldOff, Trash2 } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { AdminProvider, ProviderCredentialInput } from "@portfolio/api-client";
import { useApiCall } from "@/lib/use-api-call";

export function CredentialCell({
  provider,
  encryptionEnabled,
  onSet,
  onClear,
}: {
  provider: AdminProvider;
  encryptionEnabled: boolean;
  onSet: (id: string, body: ProviderCredentialInput) => Promise<void>;
  onClear: (id: string) => Promise<void>;
}) {
  const t = useTranslations("Admin");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);

  const [setState, handleSet] = useApiCall(
    useCallback(
      async (e: React.FormEvent) => {
        e.preventDefault();
        if (!apiKey.trim()) return;
        await onSet(provider.id, { apiKey: apiKey.trim() });
        setApiKey("");
        setDialogOpen(false);
      },
      [apiKey, provider.id, onSet],
    ),
    { fallbackMessage: t("credentialError") },
  );
  const [clearState, handleClear] = useApiCall(
    useCallback(async () => {
      await onClear(provider.id);
    }, [provider.id, onClear]),
    { fallbackMessage: t("credentialError") },
  );

  const busy = setState.busy || clearState.busy;
  const error = setState.error || clearState.error;

  function handleDialogChange(open: boolean) {
    setDialogOpen(open);
    if (!open) {
      setApiKey("");
      setShowKey(false);
    }
  }

  // Keyless / always-available providers (e.g. Yahoo Finance): no key anywhere yet the
  // provider still works. `configured` stays true with no stored/env key only when a key
  // isn't required — a key-requiring provider with no key reports `configured: false`.
  // These need no key and no encryption, so short-circuit before both.
  const keyless = provider.keySource === null && provider.configured && !provider.hasKey;
  if (keyless) {
    return <span className="text-xs text-muted-foreground">{t("keyNotNeeded")}</span>;
  }

  // Encryption disabled — show indicator instead of the full editor.
  if (!encryptionEnabled) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        {provider.keySource === "env" && (
          <span className="rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            {t("keyFromEnv")}
          </span>
        )}
        <div className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
          <ShieldOff className="size-3 shrink-0" />
          {t("encryptionDisabled")}
        </div>
      </div>
    );
  }

  // Inline credential state display.
  let display: React.ReactNode;
  if (provider.hasKey) {
    display = <span className="font-mono text-xs text-muted-foreground">{provider.keyHint}</span>;
  } else if (provider.keySource === "env") {
    display = (
      <span className="rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">
        {t("keyFromEnv")}
      </span>
    );
  } else {
    display = <span className="text-xs text-muted-foreground">{t("keyNone")}</span>;
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        <div className="w-28 shrink-0 truncate">{display}</div>

        <Dialog open={dialogOpen} onOpenChange={handleDialogChange}>
          <DialogTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
              aria-label={t("editCredential")}
            >
              <Pencil className="size-3" />
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{provider.label}</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleSet} className="space-y-3">
              <div className="relative">
                <Input
                  type={showKey ? "text" : "password"}
                  placeholder={t("credentialPlaceholder")}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  className="pr-8 font-mono"
                  autoComplete="off"
                  autoFocus
                />
                <button
                  type="button"
                  onClick={() => setShowKey((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  aria-label={showKey ? t("credentialHide") : t("credentialShow")}
                >
                  {showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
              {error && <p className="text-sm text-destructive">{error}</p>}
              <Button type="submit" disabled={busy || !apiKey.trim()}>
                {busy ? <Spinner size="sm" /> : t("credentialSave")}
              </Button>
            </form>
          </DialogContent>
        </Dialog>

        {provider.hasKey && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0 text-destructive hover:text-destructive"
            disabled={busy}
            onClick={handleClear}
            aria-label={t("credentialClear")}
          >
            {busy ? <Spinner size="xs" /> : <Trash2 className="size-3" />}
          </Button>
        )}
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
