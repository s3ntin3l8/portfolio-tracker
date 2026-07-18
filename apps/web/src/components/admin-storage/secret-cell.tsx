"use client";

import { useTranslations } from "next-intl";
import { AlertCircle, Check, Eye, EyeOff } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
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
import type { StorageSecretInput } from "@portfolio/api-client";

/** Dialog for setting/rotating the S3 secret access key. */
export function SecretCell({
  encryptionEnabled,
  hasSecret,
  secretHint,
  onSet,
  onClear,
}: {
  encryptionEnabled: boolean;
  hasSecret: boolean;
  secretHint: string;
  onSet: (body: StorageSecretInput) => Promise<void>;
  onClear: () => Promise<void>;
}) {
  const t = useTranslations("Admin");
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
      await onSet({ apiKey: value });
    },
    onClear: async () => {
      await onClear();
    },
    errorMessage: t("credentialError"),
  });

  if (!encryptionEnabled) {
    return (
      <div className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
        <AlertCircle className="size-3" />
        {t("storageEncryptionRequired")}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground font-mono">
        {hasSecret ? secretHint : t("storageSecretNone")}
      </span>
      <Dialog open={dialogOpen} onOpenChange={handleDialogChange}>
        <DialogTrigger asChild>
          <Button variant="outline" size="sm" className="h-6 text-xs">
            {hasSecret ? t("credentialRotate") : t("credentialSet")}
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("storageSecretKey")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 pt-2">
            <div className="relative">
              <Input
                type={showKey ? "text" : "password"}
                placeholder={t("credentialPlaceholder")}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                className="pr-9"
              />
              <button
                type="button"
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                onClick={() => setShowKey((v) => !v)}
              >
                {showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
            {error && (
              <p className="flex items-center gap-1 text-xs text-destructive">
                <AlertCircle className="size-3" />
                {error}
              </p>
            )}
            <Button onClick={handleSave} disabled={busy || !apiKey.trim()} className="w-full">
              {busy ? <Spinner size="sm" /> : <Check className="size-4" />}
              {t("credentialSave")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      {hasSecret && (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 text-xs text-destructive hover:text-destructive"
          onClick={handleClear}
          disabled={busy}
        >
          {t("credentialClear")}
        </Button>
      )}
    </div>
  );
}
