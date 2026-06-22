"use client";

import { useMemo } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Download } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DeleteTransactionButton } from "@/components/delete-transaction-button";
import { TransactionSourcesSection } from "@/components/transaction-sources-section";
import { Link } from "@/i18n/navigation";
import { useApiClient } from "@/lib/api";
import { formatMoney } from "@/lib/utils";
import { txAmount, txNetAmount, SOURCE_ICON } from "@/components/transactions-table";
import type { TxRow } from "@/components/transactions-table";

const TYPE_VARIANT: Record<string, "success" | "destructive" | "default"> = {
  buy: "success",
  sell: "destructive",
};

interface TransactionDetailSheetProps {
  tx: TxRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void;
}

export function TransactionDetailSheet({
  tx,
  open,
  onOpenChange,
  onDeleted,
}: TransactionDetailSheetProps) {
  const t = useTranslations("Transactions");
  const tt = useTranslations("TxType");
  const tm = useTranslations("Manage");
  const locale = useLocale();
  const api = useApiClient();

  const m = (n: number, currency: string) => formatMoney(n, currency, locale);
  const df = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "medium" }),
    [locale],
  );

  if (!tx) return null;

  const amount = txAmount(tx);
  const netAmount = txNetAmount(tx);
  const Icon = SOURCE_ICON[tx.source] ?? null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="p-0" side="bottom">
        <SheetHeader className="px-6 pt-6">
          <SheetTitle className="flex items-center gap-2">
            {tx.instrument?.symbol && (
              <span className="font-semibold">{tx.instrument.symbol}</span>
            )}
            {tx.instrument?.symbol && <span className="text-muted-foreground">·</span>}
            <Badge variant={TYPE_VARIANT[tx.type] ?? "default"}>{tt(tx.type)}</Badge>
          </SheetTitle>
          {tx.instrument?.name && (
            <p className="text-sm text-muted-foreground">{tx.instrument.name}</p>
          )}
        </SheetHeader>

        <div className="overflow-y-auto px-6 pb-6 pt-4">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-3">
            {/* Date */}
            <div>
              <dt className="text-muted-foreground">{t("date")}</dt>
              <dd className="tabular font-medium">{df.format(new Date(tx.executedAt))}</dd>
            </div>

            {/* Type */}
            <div>
              <dt className="text-muted-foreground">{t("type")}</dt>
              <dd>
                <Badge variant={TYPE_VARIANT[tx.type] ?? "default"}>{tt(tx.type)}</Badge>
              </dd>
            </div>

            {/* Instrument */}
            {tx.instrument && (
              <div>
                <dt className="text-muted-foreground">{t("instrument")}</dt>
                <dd className="font-medium">
                  {tx.instrument.symbol ?? "—"}
                  {tx.instrument.name && (
                    <span className="block text-xs text-muted-foreground">
                      {tx.instrument.name}
                    </span>
                  )}
                </dd>
              </div>
            )}

            {/* Quantity */}
            <div>
              <dt className="text-muted-foreground">{t("quantity")}</dt>
              <dd className="tabular font-medium">
                {Number(tx.quantity) || "—"}
              </dd>
            </div>

            {/* Amount (gross notional) */}
            <div>
              <dt className="text-muted-foreground">{t("amount")}</dt>
              <dd className="tabular font-medium">{m(amount, tx.currency)}</dd>
            </div>

            {/* Fees */}
            <div>
              <dt className="text-muted-foreground">{t("fees")}</dt>
              <dd className="tabular font-medium">
                {Number(tx.fees) !== 0 ? m(Number(tx.fees), tx.currency) : "—"}
              </dd>
            </div>

            {/* Tax */}
            <div>
              <dt className="text-muted-foreground">{t("tax")}</dt>
              <dd className="tabular font-medium">
                {tx.tax && Number(tx.tax) !== 0 ? m(Number(tx.tax), tx.currency) : "—"}
              </dd>
            </div>

            {/* Net Amount */}
            <div>
              <dt className="text-muted-foreground">{t("netAmount")}</dt>
              <dd className="tabular font-medium">{m(netAmount, tx.currency)}</dd>
            </div>

            {/* Currency */}
            <div>
              <dt className="text-muted-foreground">{t("fxRate")}</dt>
              <dd className="tabular font-medium">
                {tx.fxRate ? Number(tx.fxRate).toFixed(4) : "—"}
              </dd>
            </div>

            {/* Source */}
            <div>
              <dt className="text-muted-foreground">{t("source")}</dt>
              <dd>
                <span className="flex items-center gap-1.5 text-xs">
                  {Icon && <Icon className="size-3.5" />}
                  {t(`sources.${tx.source}`)}
                </span>
              </dd>
            </div>
          </dl>

          {/* Import provenance — source rows with per-source download buttons */}
          {(tx.sources?.length ?? 0) > 0 && (
            <div className="mt-4">
              <TransactionSourcesSection
                portfolioId={tx.portfolioId}
                txId={tx.id}
                sources={tx.sources!}
                hasFullTaxDetail={tx.hasFullTaxDetail ?? false}
              />
            </div>
          )}

          {/* Retention hint — shown when source rows exist but no document was retained */}
          {(tx.sources?.length ?? 0) > 0 &&
            !tx.hasDocument &&
            !tx.sources?.some((s) => s.documentId) && (
            <p className="mt-2 text-xs text-muted-foreground">
              {t("sourcesSection.notRetained")}
            </p>
          )}

          {/* Actions footer */}
          <div className="mt-6 flex flex-wrap items-center gap-2 border-t border-border pt-4">
            {tx.hasDocument && (
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  try {
                    const { url } = await api.getTransactionDocumentUrl(
                      tx.portfolioId,
                      tx.id,
                    );
                    window.open(url, "_blank", "noopener,noreferrer");
                  } catch {
                    // Signed URL fetch failed — silently ignore (e.g. doc deleted).
                  }
                }}
              >
                <Download className="size-3.5" />
                {tm("downloadReceipt")}
              </Button>
            )}
            <Button variant="outline" size="sm" asChild>
              <Link href={`/transactions/${tx.id}/edit`}>{tm("edit")}</Link>
            </Button>
            <DeleteTransactionButton
              portfolioId={tx.portfolioId}
              txId={tx.id}
              onDeleted={onDeleted}
            />
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

