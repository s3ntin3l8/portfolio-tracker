"use client";

import { useState } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

/**
 * A reusable confirmation dialog modelled after {@link DeleteHolderDialog}.
 * Supports an optional "type to confirm" flow for destructive actions.
 *
 * When `requiresTyping` is true the user must type the word "Delete" before the
 * confirm button is enabled. The `entityLabel` is shown prominently in the
 * description so the user knows exactly what they're acting on.
 */
export function ConfirmActionDialog({
  trigger,
  title,
  description,
  entityLabel,
  confirmLabel,
  confirmVariant = "destructive",
  requiresTyping = false,
  onConfirm,
}: {
  trigger: React.ReactNode;
  title: string;
  description: string;
  entityLabel: string;
  confirmLabel: string;
  confirmVariant?: "destructive" | "default";
  requiresTyping?: boolean;
  onConfirm: () => Promise<void>;
}) {
  const t = useTranslations("Admin");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [typed, setTyped] = useState("");

  function onOpenChange(next: boolean) {
    if (!next) {
      setError(false);
      setBusy(false);
      setTyped("");
    }
    setOpen(next);
  }

  async function handleConfirm() {
    setBusy(true);
    setError(false);
    try {
      await onConfirm();
      setOpen(false);
    } catch {
      setError(true);
      setBusy(false);
    }
  }

  const canConfirm = requiresTyping ? typed === "Delete" : true;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {entityLabel && (
          <p className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm font-medium text-foreground">
            {entityLabel}
          </p>
        )}

        {requiresTyping && (
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">
              {t("confirmActionTypeToConfirm")}
            </label>
            <Input
              placeholder={t("confirmActionInputPlaceholder")}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoFocus
            />
          </div>
        )}

        {error && (
          <div
            role="alert"
            className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            <AlertCircle className="size-4 shrink-0" />
            {t("updateError")}
          </div>
        )}

        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="ghost" disabled={busy}>
              {t("confirmActionCancel")}
            </Button>
          </DialogClose>
          <Button
            type="button"
            variant={confirmVariant}
            onClick={handleConfirm}
            disabled={busy || !canConfirm}
          >
            {busy && <Loader2 className="size-4 animate-spin" />}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
