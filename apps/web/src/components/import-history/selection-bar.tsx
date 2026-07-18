"use client";

import { useTranslations } from "next-intl";
import { Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

export interface SelectionBarProps {
  selectionMode: boolean;
  selected: Set<string>;
  confirmingBulk: boolean;
  bulkBusy: boolean;
  selectedConfirmedTx: number;
  onBulkDelete: () => void;
  onSetConfirmingBulk: (v: boolean) => void;
  onExitSelection: () => void;
}

export function SelectionBar({
  selectionMode,
  selected,
  confirmingBulk,
  bulkBusy,
  selectedConfirmedTx,
  onBulkDelete,
  onSetConfirmingBulk,
  onExitSelection,
}: SelectionBarProps) {
  const t = useTranslations("ImportHistory");
  if (!selectionMode) return null;

  return (
    <div className="mx-6 mb-3 flex min-h-12 items-center justify-between gap-3 rounded-lg border border-border bg-card/60 px-4 py-2 text-sm">
      <span className="text-muted-foreground">
        {selected.size > 0 ? t("selectedCount", { count: selected.size }) : t("selectPrompt")}
      </span>
      {confirmingBulk ? (
        <span className="flex items-center gap-2">
          <span className="text-muted-foreground">
            {t("bulkConfirmPrompt", { count: selectedConfirmedTx })}
          </span>
          <Button size="sm" variant="destructive" disabled={bulkBusy} onClick={onBulkDelete}>
            {bulkBusy && <Spinner size="xs" />}
            {t("deleteSelected")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={bulkBusy}
            onClick={() => onSetConfirmingBulk(false)}
          >
            {t("cancel")}
          </Button>
        </span>
      ) : (
        <span className="flex items-center gap-1">
          {selected.size > 0 && (
            <Button size="sm" variant="destructive" disabled={bulkBusy} onClick={onBulkDelete}>
              {bulkBusy ? <Spinner size="xs" /> : <Trash2 className="size-3.5" />}
              {t("deleteSelected")}
            </Button>
          )}
          <Button
            size="icon"
            variant="ghost"
            className="size-8"
            title={t("cancelSelection")}
            aria-label={t("cancelSelection")}
            disabled={bulkBusy}
            onClick={onExitSelection}
          >
            <X className="size-4" />
          </Button>
        </span>
      )}
    </div>
  );
}
