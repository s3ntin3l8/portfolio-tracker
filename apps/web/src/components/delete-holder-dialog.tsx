"use client";

import { useState } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import type { AccountHolder } from "@portfolio/api-client";
import { Button } from "@/components/ui/button";
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
import { useApiClient } from "@/lib/api";
import { useRouter } from "@/i18n/navigation";

/**
 * A confirm modal for deleting an account holder (mirrors {@link DeletePortfolioDialog}).
 * Deleting a holder only unassigns it from any portfolios — they revert to standard and are
 * never deleted. Pass a `DropdownMenuItem` (with `onSelect={(e) => e.preventDefault()}`) as
 * `trigger` to embed it inside an overflow menu without the menu unmounting the dialog.
 */
export function DeleteHolderDialog({
  holder,
  trigger,
}: {
  holder: AccountHolder;
  trigger: React.ReactNode;
}) {
  const t = useTranslations("AccountHolders");
  const tf = useTranslations("PortfolioForm");
  const api = useApiClient();
  const router = useRouter();

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  function onOpenChange(next: boolean) {
    if (!next) {
      setError(false);
      setBusy(false);
    }
    setOpen(next);
  }

  async function handleDelete() {
    setBusy(true);
    setError(false);
    try {
      await api.deleteAccountHolder(holder.id);
      router.refresh();
      setOpen(false);
    } catch {
      setError(true);
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("deleteTitle", { name: holder.name })}</DialogTitle>
          <DialogDescription>{t("deleteWarning")}</DialogDescription>
        </DialogHeader>

        {error && (
          <div
            role="alert"
            className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            <AlertCircle className="size-4 shrink-0" />
            {t("error")}
          </div>
        )}

        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="ghost" disabled={busy}>
              {tf("cancel")}
            </Button>
          </DialogClose>
          <Button type="button" variant="destructive" onClick={handleDelete} disabled={busy}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            {t("confirmDelete")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
