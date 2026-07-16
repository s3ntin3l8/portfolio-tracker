"use client";

import { useState } from "react";
import { AlertCircle } from "lucide-react";
import { useTranslations } from "next-intl";
import type { AccountHolder } from "@portfolio/api-client";
import { ConfirmActionDialog } from "@/components/ui/confirm-action-dialog";
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
    <>
      <span
        className="contents"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
      >
        {trigger}
      </span>

      <ConfirmActionDialog
        open={open}
        onOpenChange={onOpenChange}
        title={t("deleteTitle", { name: holder.name })}
        description={t("deleteWarning")}
        confirmLabel={t("confirmDelete")}
        variant="destructive"
        busy={busy}
        onConfirm={handleDelete}
      >
        {error && (
          <div
            role="alert"
            className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            <AlertCircle className="size-4 shrink-0" />
            {t("error")}
          </div>
        )}
      </ConfirmActionDialog>
    </>
  );
}
