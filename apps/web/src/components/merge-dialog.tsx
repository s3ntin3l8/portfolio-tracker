"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Loader2, GitMerge } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useApiClient } from "@/lib/api";
import { formatMoney, cn } from "@/lib/utils";
import type { MergePreview } from "@portfolio/api-client";
import type { TxRow } from "@/components/transactions-table";

/**
 * Merge two duplicate transactions — the manual recovery when cross-source dedup misses a
 * pair (e.g. a CSV row and its PDF settlement note land as two separate rows, see
 * parsers/dedup.ts). The user picks which row survives: its core economic fields
 * (quantity/price/date/type) win, the other's sources/documents fold onto it, and the scalar
 * rollup (tax/fees/executedPrice/fxRate/venue) is recomputed by source rank. A live,
 * server-computed preview (services/merge.ts's `previewMerge`) shows the result before
 * confirming, and the same guardrails (same instrument, compatible type, no loan legs) block
 * the confirm button with an explanation when the two rows can't be merged.
 */
export function MergeDialog({
  open,
  onOpenChange,
  rowA,
  rowB,
  onMerged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rowA: TxRow;
  rowB: TxRow;
  /** Called after a successful merge so the caller can clear selection + refresh. */
  onMerged: () => void;
}) {
  const t = useTranslations("Transactions.merge");
  const locale = useLocale();
  const api = useApiClient();
  const [survivorId, setSurvivorId] = useState(rowA.id);
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [busy, setBusy] = useState(false);

  const absorbedId = survivorId === rowA.id ? rowB.id : rowA.id;
  const survivorRow = survivorId === rowA.id ? rowA : rowB;

  // Re-fetch the server-computed preview whenever the survivor choice changes (or the dialog
  // opens). Stale-response guard: an in-flight request from a prior survivor pick is dropped
  // if the user flips the choice again before it resolves.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      setLoadingPreview(true);
      try {
        const res = await api.previewMergeTransactions(
          survivorRow.portfolioId,
          survivorId,
          absorbedId,
        );
        if (!cancelled) setPreview(res);
      } finally {
        if (!cancelled) setLoadingPreview(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, survivorId, absorbedId, survivorRow.portfolioId, api]);

  async function submit() {
    setBusy(true);
    try {
      await api.mergeTransactions(survivorRow.portfolioId, survivorId, absorbedId);
      onOpenChange(false);
      onMerged();
    } finally {
      setBusy(false);
    }
  }

  function optionLabel(row: TxRow) {
    const date = new Date(row.executedAt).toLocaleDateString(locale);
    const price = formatMoney(Number(row.price), row.currency, locale);
    return `${row.source} · ${row.quantity} @ ${price} · ${date}`;
  }

  const blocked = preview && !preview.ok;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitMerge className="size-4" />
            {t("title")}
          </DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          {[rowA, rowB].map((row) => (
            <button
              key={row.id}
              type="button"
              onClick={() => setSurvivorId(row.id)}
              className={cn(
                "w-full rounded-lg border px-3 py-2 text-left text-sm transition-colors",
                survivorId === row.id
                  ? "border-primary bg-primary/5"
                  : "border-border hover:bg-muted/50",
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{optionLabel(row)}</span>
                {survivorId === row.id && (
                  <span className="shrink-0 text-xs text-primary">{t("survives")}</span>
                )}
              </div>
            </button>
          ))}
        </div>

        {loadingPreview && (
          <div className="flex items-center justify-center py-4 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
          </div>
        )}

        {!loadingPreview && preview?.ok && preview.merged && (
          <div className="space-y-1 rounded-lg border border-border bg-card/60 px-3 py-2 text-sm">
            <div className="font-medium">{t("previewTitle")}</div>
            <div className="text-muted-foreground">
              {t("previewLine", {
                quantity: preview.merged.quantity,
                price: formatMoney(Number(preview.merged.price), preview.merged.currency, locale),
                date: new Date(preview.merged.executedAt).toLocaleDateString(locale),
              })}
            </div>
            {preview.merged.fees != null && (
              <div className="text-muted-foreground">
                {t("previewFees", {
                  fees: formatMoney(Number(preview.merged.fees), preview.merged.currency, locale),
                })}
              </div>
            )}
            {preview.merged.documentCount > 0 && (
              <div className="text-muted-foreground">
                {t("previewDocuments", { count: preview.merged.documentCount })}
              </div>
            )}
          </div>
        )}

        {!loadingPreview && blocked && preview?.blockedReason && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {t(`blocked.${preview.blockedReason}`)}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            {t("cancel")}
          </Button>
          <Button onClick={() => void submit()} disabled={busy || loadingPreview || !preview?.ok}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : t("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
