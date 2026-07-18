"use client";

import { useTranslations } from "next-intl";
import { Eye, EyeOff, Pencil, ShieldOff, Trash2 } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import type { AdminVisionProvider, ProviderCredentialInput } from "@portfolio/api-client";
import { useCredentialDialog } from "@/components/admin/use-credential-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

/** Cell showing the current credential state + pencil edit button (Dialog) + inline clear. */
export function VisionCredentialCell({
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

  // Ollama is a URL-based provider — edit a URL, not an API key.
  const isUrlProvider = provider.id === "ollama";
  const hasCredential = isUrlProvider ? provider.hasUrl : provider.hasKey;

  const {
    dialogOpen,
    apiKey,
    setApiKey,
    showKey,
    setShowKey,
    busy,
    error,
    handleDialogChange,
    handleSave,
    handleClear,
  } = useCredentialDialog({
    onSave: async (value) => {
      const body: ProviderCredentialInput = isUrlProvider
        ? { urlOverride: value }
        : { apiKey: value };
      await onSet(provider.id, body);
    },
    onClear: async () => {
      await onClear(provider.id);
    },
    errorMessage: t("credentialError"),
  });

  // Encryption disabled — only key-based (non-URL) providers need encryption.
  if (!encryptionEnabled && !isUrlProvider) {
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
  if (hasCredential) {
    display = (
      <span className="font-mono text-xs text-muted-foreground">
        {provider.keyHint ?? (isUrlProvider ? t("visionUrlSet") : "••••")}
      </span>
    );
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
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void handleSave();
              }}
              className="space-y-3"
            >
              <div className="relative">
                <Input
                  type={isUrlProvider ? "url" : showKey ? "text" : "password"}
                  placeholder={
                    isUrlProvider ? t("visionUrlPlaceholder") : t("credentialPlaceholder")
                  }
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  className="pr-8 font-mono"
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
                    {showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                )}
              </div>
              {error && <p className="text-sm text-destructive">{error}</p>}
              <Button type="submit" disabled={busy || !apiKey.trim()}>
                {busy ? <Spinner size="sm" /> : t("credentialSave")}
              </Button>
            </form>
          </DialogContent>
        </Dialog>

        {hasCredential && (
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
