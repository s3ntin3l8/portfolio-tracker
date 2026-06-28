"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useApiClient } from "@/lib/api";
import { useRouter } from "@/i18n/navigation";

/** A per-row delete control with an inline two-step confirm (no modal needed). */
export function DeleteTransactionButton({
  portfolioId,
  txId,
  onDeleted,
  className,
}: {
  portfolioId: string;
  txId: string;
  /** Called after the delete succeeds (after router.refresh). */
  onDeleted?: () => void;
  /** Extra classes for the idle icon trigger (e.g. compact sizing). */
  className?: string;
}) {
  const t = useTranslations("Manage.delete");
  const api = useApiClient();
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onDelete() {
    setBusy(true);
    try {
      await api.deleteTransaction(portfolioId, txId);
      router.refresh();
      onDeleted?.();
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  if (confirming) {
    return (
      <span className="flex items-center justify-end gap-1">
        <Button
          size="sm"
          variant="destructive"
          onClick={onDelete}
          disabled={busy}
        >
          {busy && <Loader2 className="size-3.5 animate-spin" />}
          {t("confirm")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setConfirming(false)}
          disabled={busy}
        >
          {t("cancel")}
        </Button>
      </span>
    );
  }

  return (
    <Button
      size="icon"
      variant="ghost"
      aria-label={t("label")}
      onClick={() => setConfirming(true)}
      className={className}
    >
      <Trash2 className="size-4" />
    </Button>
  );
}
