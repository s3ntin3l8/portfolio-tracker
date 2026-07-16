"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Coins } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatMoney } from "@/lib/utils";
import type { ImportContract } from "@/components/import-flow/types";

export interface ContractReviewProps {
  contracts: ImportContract[];
  onUpdate: (index: number, patch: Partial<ImportContract>) => void;
  /** Present only when the contract card owns the confirm action (no flat drafts). */
  onConfirm?: () => void | Promise<void>;
  onDiscard?: () => void | Promise<void>;
}

/**
 * Review step for financed gold contracts (Pegadaian / Galeri 24 cicilan). Shows the
 * contract economics read off the document and lets the user correct the gram weight
 * (the one figure that comes from a separate receipt page) before confirming. The
 * transaction legs are re-derived server-side on confirm, so only the contract is edited.
 */
export function ContractReview({ contracts, onUpdate, onConfirm, onDiscard }: ContractReviewProps) {
  const t = useTranslations("Import.contract");
  const [busy, setBusy] = useState(false);

  async function run(fn?: () => void | Promise<void>) {
    if (!fn) return;
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {contracts.map((c, i) => {
        const money = (v: string) => formatMoney(Number(v), c.currency);
        const rows: { label: string; value: string }[] = [
          { label: t("purchasePrice"), value: money(c.purchasePrice) },
          { label: t("downPayment"), value: money(c.downPayment) },
          { label: t("principal"), value: money(c.principal) },
          { label: t("marginTotal"), value: money(c.marginTotal) },
          { label: t("adminFee"), value: money(c.adminFee) },
          { label: t("discount"), value: money(c.discount) },
          { label: t("installment"), value: money(c.monthlyInstallment) },
          { label: t("tenor"), value: t("tenor", { count: c.tenorMonths }) },
        ];
        return (
          <Card key={c.contractNo ?? i}>
            <CardHeader className="space-y-1">
              <div className="flex items-center gap-2 font-medium">
                <Coins className="size-4 text-primary" />
                {t("title")}
                {c.provider && (
                  <span className="text-sm text-muted-foreground">· {c.provider}</span>
                )}
              </div>
              <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
              {c.contractNo && (
                <p className="text-xs text-muted-foreground">
                  {t("contractNo")}: {c.contractNo}
                </p>
              )}
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Editable gram weight — the figure that comes from the receipt page. */}
              <div className="space-y-1.5">
                <Label htmlFor={`grams-${i}`}>{t("grams")}</Label>
                <Input
                  id={`grams-${i}`}
                  inputMode="decimal"
                  value={c.grams}
                  onChange={(e) => onUpdate(i, { grams: e.target.value })}
                  className="max-w-40"
                />
                <p className="text-xs text-muted-foreground">{t("gramsHint")}</p>
              </div>

              <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
                {rows.map((r) => (
                  <div key={r.label} className="flex flex-col">
                    <dt className="text-muted-foreground">{r.label}</dt>
                    <dd className="font-medium tabular-nums">{r.value}</dd>
                  </div>
                ))}
              </dl>

              {c.schedule.length > 0 && (
                <p className="text-sm text-muted-foreground">
                  {t("schedule", { count: c.schedule.length })}
                </p>
              )}
            </CardContent>
          </Card>
        );
      })}

      {onConfirm && (
        <div className="flex items-center justify-end gap-2">
          {onDiscard && (
            <Button variant="outline" onClick={() => run(onDiscard)} disabled={busy}>
              {t("discard")}
            </Button>
          )}
          <Button onClick={() => run(onConfirm)} disabled={busy}>
            {busy && <Spinner size="sm" className="mr-2" />}
            {t("confirm")}
          </Button>
        </div>
      )}
    </div>
  );
}
