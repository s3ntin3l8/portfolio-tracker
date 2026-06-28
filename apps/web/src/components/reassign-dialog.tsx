"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { PortfolioPicker, type PickablePortfolio } from "@/components/portfolio-picker";

/**
 * A small dialog that moves transactions to another portfolio. Reused by the per-transaction
 * row action, the multi-select bar, and the import-history "Reassign all to…" action. The
 * caller owns the actual API call (single tx, selection, or whole import) via `onConfirm`.
 */
export function ReassignDialog({
  open,
  onOpenChange,
  portfolios,
  excludePortfolioId,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  portfolios: PickablePortfolio[];
  /** Hide this portfolio from the target list (the rows already live there). */
  excludePortfolioId?: string;
  /** Move to the chosen portfolio. Resolve to close; throw to surface an error. */
  onConfirm: (targetPortfolioId: string) => Promise<void>;
}) {
  const t = useTranslations("Transactions.reassign");
  const targets = excludePortfolioId
    ? portfolios.filter((p) => p.id !== excludePortfolioId)
    : portfolios;
  const [value, setValue] = useState<string>(targets[0]?.id ?? "");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!value) return;
    setBusy(true);
    try {
      await onConfirm(value);
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label>{t("target")}</Label>
          <PortfolioPicker
            portfolios={targets}
            value={value}
            onChange={setValue}
            ariaLabel={t("target")}
            triggerClassName="w-full"
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            {t("cancel")}
          </Button>
          <Button onClick={() => void submit()} disabled={busy || !value}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : t("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
