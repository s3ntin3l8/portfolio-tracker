"use client";

import { useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { AlertCircle, AlertTriangle, Check, Download, FolderInput, Loader2, X } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DeleteTransactionButton } from "@/components/delete-transaction-button";
import { TransactionStatusButton } from "@/components/transaction-status-button";
import { TransactionSourcesSection } from "@/components/transaction-sources-section";
import { Link, useRouter } from "@/i18n/navigation";
import { useApiClient } from "@/lib/api";
import { formatMoney, anomalyLabel, type AnomalyTranslator } from "@/lib/utils";
import { txAmount, txNetAmount, SOURCE_ICON } from "@/components/transactions-table";
import type { TxRow } from "@/components/transactions-table";
import type { PickablePortfolio } from "@/components/portfolio-picker";
import type { Anomaly } from "@portfolio/api-client";

const TYPE_VARIANT: Record<string, "success" | "destructive" | "default"> = {
  buy: "success",
  sell: "destructive",
};

interface TransactionDetailSheetProps {
  tx: TxRow | null;
  /** The worst-severity anomaly flagged on this transaction, if any. */
  anomaly?: Anomaly | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void;
  /** All of the user's portfolios — enables the "Reassign…" action (shown only when at
   *  least two exist). The reference has no inline row actions; single-row edit/delete/
   *  reassign/draft-resolve all live here, opened by clicking the row. */
  portfolios?: PickablePortfolio[];
  /** Queue this transaction for reassignment (opens the table's ReassignDialog). */
  onReassign?: (tx: TxRow) => void;
  /** Confirm/discard this transaction when it is a draft. */
  onResolve?: (tx: TxRow, action: "confirm" | "discard") => void;
  /** True while this row's draft is being confirmed/discarded (spinner + disable). */
  resolving?: boolean;
}

export function TransactionDetailSheet({
  tx,
  anomaly,
  open,
  onOpenChange,
  onDeleted,
  portfolios = [],
  onReassign,
  onResolve,
  resolving = false,
}: TransactionDetailSheetProps) {
  const t = useTranslations("Transactions");
  const tt = useTranslations("TxType");
  const tm = useTranslations("Manage");
  const ta = useTranslations("Anomalies");
  const locale = useLocale();
  const api = useApiClient();
  const router = useRouter();
  const [dismissing, setDismissing] = useState(false);

  const m = (n: number, currency: string) => formatMoney(n, currency, locale);
  const df = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "medium" }),
    [locale],
  );

  if (!tx) return null;

  const amount = txAmount(tx);
  const netAmount = txNetAmount(tx);
  const Icon = SOURCE_ICON[tx.source] ?? null;
  const status = tx.status ?? "normal";
  const canReassign = portfolios.length > 1;

  const dismissAnomaly = async () => {
    if (!anomaly) return;
    setDismissing(true);
    try {
      await api.dismissAnomaly(tx.portfolioId, tx.id, anomaly.code);
      onOpenChange(false);
      router.refresh();
    } catch {
      // Leave the sheet open on failure so the user can retry.
    } finally {
      setDismissing(false);
    }
  };

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

            {/* Source — only for transactions with no source rows (e.g. manual entries);
                otherwise the Data sources section below covers provenance. */}
            {(tx.sources?.length ?? 0) === 0 && (
              <div>
                <dt className="text-muted-foreground">{t("source")}</dt>
                <dd>
                  <span className="flex items-center gap-1.5 text-xs">
                    {Icon && <Icon className="size-3.5" />}
                    {t(`sources.${tx.source}`)}
                  </span>
                </dd>
              </div>
            )}
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
            !tx.sources?.some((s) => s.hasDocument) && (
            <p className="mt-2 text-xs text-muted-foreground">
              {t("sourcesSection.notRetained")}
            </p>
          )}

          {/* Data-integrity warning + dismiss */}
          {anomaly && (
            <div className="mt-4 rounded-md border border-amber-400/40 bg-amber-50/40 p-3 text-sm dark:bg-amber-950/10">
              <div className="flex items-start gap-2">
                {anomaly.severity === "error" ? (
                  <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
                ) : (
                  <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
                )}
                <p className="text-muted-foreground">
                  {anomalyLabel(anomaly, ta as AnomalyTranslator, locale)}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="mt-3"
                disabled={dismissing}
                onClick={dismissAnomaly}
              >
                {ta("dismiss")}
              </Button>
            </div>
          )}

          {/* Actions footer — the reference has no inline row actions, so every single-row
              action for the row you clicked lives here. */}
          <div className="mt-6 flex flex-wrap items-center gap-2 border-t border-border pt-4">
            {status === "draft" && onResolve && (
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={resolving}
                  onClick={() => onResolve(tx, "confirm")}
                >
                  {resolving ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Check className="size-3.5" />
                  )}
                  {tm("status.confirmDraft")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={resolving}
                  onClick={() => onResolve(tx, "discard")}
                >
                  <X className="size-3.5" />
                  {tm("status.discardDraft")}
                </Button>
              </>
            )}
            {tx.hasDocument && !tx.sources?.some((s) => s.hasDocument) && (
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
            {canReassign && onReassign && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => onReassign(tx)}
              >
                <FolderInput className="size-3.5" />
                {tm("reassign")}
              </Button>
            )}
            {status !== "draft" && (
              <TransactionStatusButton
                portfolioId={tx.portfolioId}
                txId={tx.id}
                status={status}
              />
            )}
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

