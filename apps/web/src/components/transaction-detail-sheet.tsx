"use client";

import { useEffect, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { AlertCircle, AlertTriangle, Check, MoreHorizontal, Pencil, Trash2, X } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { TransactionSourcesSection } from "@/components/transaction-sources-section";
import { Link, useRouter } from "@/i18n/navigation";
import { useApiClient } from "@/lib/api";
import { useMediaQuery } from "@/lib/use-media-query";
import { formatMoney, anomalyLabel, type AnomalyTranslator } from "@/lib/utils";
import { txAmount, txNetAmount } from "@/components/transactions-table";
import type { TxRow } from "@/components/transactions-table";
import type { PickablePortfolio } from "@/components/portfolio-picker";
import type { Anomaly } from "@portfolio/api-client";
import { TYPE_BADGE, DEFAULT_BADGE } from "./transaction-detail-sheet/constants";
import {
  SectionHeading,
  HeroAmount,
  BreakdownCard,
  DetailsCard,
} from "./transaction-detail-sheet/cards";
import { OverflowMenuContent } from "./transaction-detail-sheet/overflow-menu";
import { useTransactionActions } from "./transaction-detail-sheet/action-hooks";
import { mergeTaxComponents } from "./transaction-detail-sheet/merge-tax-components";

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
  /** Open the edit sheet for this transaction. When provided, "Edit" opens a modal in
   *  place; without it, "Edit" falls back to navigating to the standalone edit page. */
  onEdit?: (tx: TxRow) => void;
  /** Queue this transaction for reassignment (opens the table's ReassignDialog). */
  onReassign?: (tx: TxRow) => void;
  /** Confirm/discard this transaction when it is a draft. */
  onResolve?: (tx: TxRow, action: "confirm" | "discard") => void;
  /** True while this row's draft is being confirmed/discarded (spinner + disable). */
  resolving?: boolean;
  /** The scope currency for the "≈ in" display. Defaults to IDR. */
  scopeCurrency?: string;
}

export function TransactionDetailSheet({
  tx,
  anomaly,
  open,
  onOpenChange,
  onDeleted,
  portfolios = [],
  onEdit,
  onReassign,
  onResolve,
  resolving = false,
  scopeCurrency = "IDR",
}: TransactionDetailSheetProps) {
  const t = useTranslations("Transactions");
  const tt = useTranslations("TxType");
  const tm = useTranslations("Manage");
  const td = useTranslations("Manage.delete");
  const ta = useTranslations("Anomalies");
  const locale = useLocale();
  const api = useApiClient();
  const router = useRouter();
  const isDesktop = useMediaQuery("(min-width: 860px)");
  const [clientRate, setClientRate] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const { dismissing, deleting, statusBusy, dismissAnomaly, onDelete, downloadReceipt, setStatus } =
    useTransactionActions(api, router, tx);

  const resetConfirmDelete = () => setConfirmingDelete(false);
  const handleDelete = () => onDelete(onDeleted, onOpenChange, resetConfirmDelete);

  const m = (n: number, currency: string) => formatMoney(n, currency, locale);
  const df = useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: "medium" }), [locale]);
  const numFmt = useMemo(() => new Intl.NumberFormat(locale), [locale]);

  useEffect(() => {
    if (!tx) return;
    if (tx.displayRate != null && tx.displayRate !== "1") return;
    if (!tx.currency || !scopeCurrency || tx.currency === scopeCurrency) return;
    let cancelled = false;
    fetch(
      `/api/backend/fx-rate?from=${encodeURIComponent(tx.currency)}&to=${encodeURIComponent(scopeCurrency)}&date=${tx.executedAt.slice(0, 10)}`,
    )
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) setClientRate(data.rate ?? null);
      })
      .catch(() => {
        if (!cancelled) setClientRate(null);
      });
    return () => {
      cancelled = true;
    };
  }, [tx, scopeCurrency]);

  if (!tx) return null;

  const amount = txAmount(tx);
  const netAmount = txNetAmount(tx);
  const effectiveDisplayRate =
    tx.displayRate != null && tx.displayRate !== "1" ? tx.displayRate : clientRate;
  const effectiveDisplayCurrency = tx.displayCurrency ?? scopeCurrency;
  const showApproxDisplay =
    effectiveDisplayRate != null &&
    effectiveDisplayCurrency != null &&
    effectiveDisplayCurrency !== tx.currency;
  const netAmountDisplay =
    showApproxDisplay && netAmount != null ? netAmount * Number(effectiveDisplayRate) : null;
  const qty = Number(tx.quantity);
  const badge = TYPE_BADGE[tx.type] ?? DEFAULT_BADGE;
  const BadgeIcon = badge.icon;
  const status = tx.status ?? "normal";
  const canReassign = portfolios.length > 1;
  const hasSources = (tx.sources?.length ?? 0) > 0;
  const taxComponentEntries = Object.entries(mergeTaxComponents(tx.sources ?? [])).filter(
    ([, v]) => v && Number(v) !== 0,
  );
  const showReceipt = tx.hasDocument && !tx.sources?.some((s) => s.hasDocument);
  const account = portfolios.find((p) => p.id === tx.portfolioId) ?? null;
  const accountName = account?.name ?? tx.portfolioName ?? null;

  const iconBtn =
    "flex size-[34px] shrink-0 items-center justify-center rounded-[11px] bg-card text-foreground shadow-[0_1px_2px_rgba(15,27,20,.08)] transition-colors hover:bg-secondary";

  const title = tx.instrument?.symbol ? `${tt(tx.type)} · ${tx.instrument.symbol}` : tt(tx.type);
  // v2 design: the header subtitle is "{date} · {portfolio}", not just the date.
  const subtitle = accountName
    ? `${df.format(new Date(tx.executedAt))} · ${accountName}`
    : df.format(new Date(tx.executedAt));

  const canSetStatus = status !== "draft";
  const hasOverflow = (canReassign && onReassign) || showReceipt || canSetStatus;

  const closeButton = (
    <button
      type="button"
      className={iconBtn}
      aria-label="Close"
      onClick={() => onOpenChange(false)}
    >
      <X className="size-[18px]" strokeWidth={2.2} />
    </button>
  );

  const overflowMenu = hasOverflow && (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button type="button" className={iconBtn} aria-label={tm("actions")} title={tm("actions")}>
          <MoreHorizontal className="size-[18px]" />
        </button>
      </DropdownMenuTrigger>
      <OverflowMenuContent
        tx={tx}
        canReassign={canReassign}
        showReceipt={showReceipt}
        canSetStatus={canSetStatus}
        statusLabel={status}
        statusBusy={statusBusy}
        onReassign={onReassign}
        onDownload={downloadReceipt}
        onSetStatus={setStatus}
      />
    </DropdownMenu>
  );

  const body = (
    <>
      <div className="px-5 pb-7 pt-1.5">
        <HeroAmount
          netAmount={netAmount}
          currency={tx.currency}
          source={tx.source}
          showApproxDisplay={showApproxDisplay}
          netAmountDisplay={netAmountDisplay}
          effectiveDisplayCurrency={effectiveDisplayCurrency}
          m={m}
          locale={locale}
        />

        <SectionHeading>{t("breakdown")}</SectionHeading>
        <BreakdownCard
          type={tx.type}
          qty={qty}
          price={tx.price}
          currency={tx.currency}
          fees={tx.fees}
          tax={tx.tax}
          shares={tx.shares}
          sharesEstimated={tx.sharesEstimated}
          perShare={tx.perShare}
          nativeCurrency={tx.nativeCurrency}
          grossNative={tx.grossNative}
          amount={amount}
          netAmount={netAmount}
          m={m}
          t={t}
          numFmt={numFmt}
          locale={locale}
        />

        <SectionHeading>{t("details")}</SectionHeading>
        <DetailsCard
          executedAt={tx.executedAt}
          instrument={tx.instrument}
          currency={tx.currency}
          fxRate={tx.fxRate}
          source={tx.source}
          accountName={accountName}
          account={account}
          taxComponentEntries={taxComponentEntries}
          hasSources={hasSources}
          df={df}
          m={m}
        />

        {hasSources && (
          <div className="mt-5">
            <TransactionSourcesSection
              portfolioId={tx.portfolioId}
              txId={tx.id}
              sources={tx.sources!}
              hasFullTaxDetail={tx.hasFullTaxDetail ?? false}
              showTaxBreakdown={false}
            />
          </div>
        )}

        {hasSources && !tx.hasDocument && !tx.sources?.some((s) => s.hasDocument) && (
          <p className="mt-2 text-xs text-muted-foreground">{t("sourcesSection.notRetained")}</p>
        )}

        {anomaly && (
          <div className="mt-5 rounded-[16px] border border-amber-400/40 bg-amber-50/40 p-3 text-sm dark:bg-amber-950/10">
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
              onClick={() => dismissAnomaly(anomaly, onOpenChange)}
            >
              {ta("dismiss")}
            </Button>
          </div>
        )}

        {status === "draft" && onResolve && (
          <div className="mt-5 flex gap-2.5">
            <Button
              className="flex-1"
              disabled={resolving}
              onClick={() => onResolve(tx, "confirm")}
            >
              {resolving ? <Spinner size="sm" /> : <Check className="size-4" />}
              {tm("status.confirmDraft")}
            </Button>
            <Button
              variant="outline"
              className="flex-1"
              disabled={resolving}
              onClick={() => onResolve(tx, "discard")}
            >
              <X className="size-4" />
              {tm("status.discardDraft")}
            </Button>
          </div>
        )}

        {confirmingDelete ? (
          <div className="mt-5 flex gap-2.5">
            <Button
              variant="destructive"
              className="flex-1"
              disabled={deleting}
              onClick={handleDelete}
            >
              {deleting && <Spinner size="sm" />}
              {td("confirm")}
            </Button>
            <Button
              variant="outline"
              className="flex-1"
              disabled={deleting}
              onClick={() => setConfirmingDelete(false)}
            >
              {td("cancel")}
            </Button>
          </div>
        ) : (
          <div className="mt-5 flex gap-2.5">
            {onEdit ? (
              <Button
                variant="outline"
                className="flex-1 border-border bg-card hover:bg-secondary"
                onClick={() => onEdit(tx)}
              >
                <Pencil className="size-4" />
                {tm("edit")}
              </Button>
            ) : (
              <Button
                variant="outline"
                className="flex-1 border-border bg-card hover:bg-secondary"
                asChild
              >
                <Link href={`/transactions/${tx.id}/edit`}>
                  <Pencil className="size-4" />
                  {tm("edit")}
                </Link>
              </Button>
            )}
            <Button
              className="flex-1 border-none bg-[rgba(229,72,77,.12)] text-[#E5484D] hover:bg-[rgba(229,72,77,.2)]"
              aria-label={td("label")}
              onClick={() => setConfirmingDelete(true)}
            >
              <Trash2 className="size-4" />
              {td("label")}
            </Button>
          </div>
        )}
      </div>
    </>
  );

  if (isDesktop) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          hideClose
          className="flex w-[calc(100%-4rem)] max-w-[480px] flex-col gap-0 overflow-hidden rounded-[22px] border-0 bg-background p-0 shadow-[0_30px_80px_rgba(0,0,0,.4)] max-h-[calc(100vh-64px)]"
        >
          <div className="sticky top-0 z-[2] gap-0 bg-background px-5 pb-2.5 pt-4">
            <div className="flex items-center gap-3">
              <span
                className="flex size-11 shrink-0 items-center justify-center rounded-[13px]"
                style={{ background: badge.bg, color: badge.fg }}
              >
                <BadgeIcon className="size-[22px]" strokeWidth={2.2} />
              </span>
              <div className="min-w-0 flex-1">
                <DialogTitle className="truncate text-[18px] font-extrabold leading-none">
                  {title}
                </DialogTitle>
                <p className="truncate text-xs font-medium text-text-2">{subtitle}</p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {overflowMenu}
                {closeButton}
              </div>
            </div>
          </div>
          <div className="overflow-y-auto">{body}</div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange} handleOnly>
      <SheetContent className="p-0" side="bottom" hideClose>
        <SheetHeader className="sticky top-0 z-[2] gap-0 bg-background px-5 pb-2.5 pt-1">
          <div className="flex items-center gap-3">
            <span
              className="flex size-11 shrink-0 items-center justify-center rounded-[13px]"
              style={{ background: badge.bg, color: badge.fg }}
            >
              <BadgeIcon className="size-[22px]" strokeWidth={2.2} />
            </span>
            <div className="min-w-0 flex-1">
              <SheetTitle className="truncate text-[18px]">{title}</SheetTitle>
              <p className="truncate text-xs font-medium text-text-2">{subtitle}</p>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {overflowMenu}
              {closeButton}
            </div>
          </div>
        </SheetHeader>
        {body}
      </SheetContent>
    </Sheet>
  );
}
