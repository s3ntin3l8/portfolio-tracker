"use client";

import { useEffect, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import {
  AlertCircle,
  AlertTriangle,
  Archive,
  ArchiveRestore,
  ArrowDownLeft,
  ArrowLeft,
  ArrowLeftRight,
  ArrowRight,
  ArrowUpRight,
  Check,
  CircleSlash,
  Coins,
  Download,
  FolderInput,
  Loader2,
  MoreHorizontal,
  Pencil,
  Receipt,
  Scale,
  Split,
  Trash2,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Sheet, SheetClose, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { BrokerageIcon } from "@/components/brokerage-icon";
import {
  TransactionSourcesSection,
  TAX_COMPONENT_LABELS,
} from "@/components/transaction-sources-section";
import { Link, useRouter } from "@/i18n/navigation";
import { useApiClient } from "@/lib/api";
import { cn, formatMoney, formatSignedMoney, anomalyLabel, type AnomalyTranslator } from "@/lib/utils";
import {
  txAmount,
  txNetAmount,
  SOURCE_ICON,
} from "@/components/transactions-table";
import type { TxRow } from "@/components/transactions-table";
import type { PickablePortfolio } from "@/components/portfolio-picker";
import type { Anomaly, TransactionStatus } from "@portfolio/api-client";

/**
 * Per-transaction-type header badge — a lucide icon plus the reference's shared (theme-
 * independent) tint. Every `TxType` key maps to one of a handful of visual families
 * (inflow-green / outflow-red / income-gold / share-event-purple / transfer-teal); an
 * unknown type falls back to a neutral receipt so the badge is never blank.
 * Colours transcribed from `Pocket Prototype.dc.html` (the `TYPE`/cash-flow helper maps).
 */
const TYPE_BADGE: Record<string, { icon: LucideIcon; bg: string; fg: string }> = {
  buy: { icon: ArrowRight, bg: "rgba(16,163,114,.14)", fg: "#0E9F6E" },
  savings_plan: { icon: ArrowRight, bg: "rgba(16,163,114,.14)", fg: "#0E9F6E" },
  sell: { icon: ArrowLeft, bg: "rgba(229,72,77,.15)", fg: "#E5484D" },
  dividend: { icon: Coins, bg: "rgba(224,165,58,.16)", fg: "var(--gold-fg)" },
  coupon: { icon: Coins, bg: "rgba(224,165,58,.16)", fg: "var(--gold-fg)" },
  interest: { icon: ArrowDownLeft, bg: "rgba(16,163,114,.14)", fg: "#0E9F6E" },
  deposit: { icon: ArrowDownLeft, bg: "rgba(16,163,114,.14)", fg: "#0E9F6E" },
  bonus_cash: { icon: ArrowDownLeft, bg: "rgba(16,163,114,.14)", fg: "#0E9F6E" },
  loan_drawdown: { icon: ArrowDownLeft, bg: "rgba(16,163,114,.14)", fg: "#0E9F6E" },
  withdrawal: { icon: ArrowUpRight, bg: "rgba(229,72,77,.15)", fg: "#E5484D" },
  fee: { icon: ArrowUpRight, bg: "rgba(229,72,77,.15)", fg: "#E5484D" },
  tax: { icon: ArrowUpRight, bg: "rgba(229,72,77,.15)", fg: "#E5484D" },
  loan_repayment: { icon: ArrowUpRight, bg: "rgba(229,72,77,.15)", fg: "#E5484D" },
  split: { icon: Split, bg: "rgba(124,92,252,.16)", fg: "#7C5CFC" },
  bonus: { icon: Split, bg: "rgba(124,92,252,.16)", fg: "#7C5CFC" },
  rights: { icon: Split, bg: "rgba(124,92,252,.16)", fg: "#7C5CFC" },
  transfer_in: { icon: ArrowLeftRight, bg: "rgba(13,148,136,.16)", fg: "#0D9488" },
  transfer_out: { icon: ArrowLeftRight, bg: "rgba(13,148,136,.16)", fg: "#0D9488" },
  adjustment: { icon: Scale, bg: "rgba(13,148,136,.16)", fg: "#0D9488" },
};
const DEFAULT_BADGE = { icon: Receipt, bg: "var(--border)", fg: "var(--text-mute)" };

/** Source pill tint (reference `SRC` map); unknown sources fall back to neutral. */
const SOURCE_PILL: Record<string, { bg: string; fg: string }> = {
  screenshot: { bg: "rgba(124,92,252,.16)", fg: "#7C5CFC" },
  csv: { bg: "rgba(13,148,136,.16)", fg: "#0D9488" },
  pytr: { bg: "rgba(13,148,136,.16)", fg: "#0D9488" },
  pdf: { bg: "rgba(229,72,77,.13)", fg: "#E5484D" },
};
const DEFAULT_PILL = { bg: "var(--border)", fg: "var(--text-mute)" };

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

/** A section heading — small uppercase label above a card (reference `--text-3`, .04em). */
function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-2 ml-0.5 mt-5 text-[12px] font-bold uppercase tracking-[.04em] text-text-3 first:mt-0">
      {children}
    </p>
  );
}

/** A rounded card wrapping label/value rows separated by hairline dividers. */
function DetailCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="divide-y divide-line overflow-hidden rounded-[18px] border border-border bg-card">
      {children}
    </div>
  );
}

/** One label-left / value-right row inside a {@link DetailCard}. */
function Row({
  label,
  children,
  strong = false,
  color,
}: {
  label: string;
  children: React.ReactNode;
  /** The total row: heavier label + larger value. */
  strong?: boolean;
  /** Explicit value colour (e.g. green net) — overrides the default foreground. */
  color?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3.5 px-4 py-[13px]">
      <span
        className={cn(
          "shrink-0 text-text-2",
          strong ? "text-[14px] font-bold text-foreground" : "text-[13px] font-medium",
        )}
      >
        {label}
      </span>
      <span
        className={cn(
          "tabular min-w-0 text-right font-bold",
          strong ? "text-[16px] font-extrabold" : "text-[13px]",
          color,
        )}
      >
        {children}
      </span>
    </div>
  );
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
  const ts = useTranslations("Manage.status");
  const ta = useTranslations("Anomalies");
  const locale = useLocale();
  const api = useApiClient();
  const router = useRouter();
  const [dismissing, setDismissing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [statusBusy, setStatusBusy] = useState(false);
  const [clientRate, setClientRate] = useState<string | null>(null);

  const m = (n: number, currency: string) => formatMoney(n, currency, locale);
  const df = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "medium" }),
    [locale],
  );
  const numFmt = useMemo(() => new Intl.NumberFormat(locale), [locale]);

  // Client-side FX rate lookup: when the row wasn't converted server-side (displayRate is
  // null or "1"), try to fetch a rate for the pair so we can still show the "≈ in" line.
  useEffect(() => {
    if (!tx) return;
    if (tx.displayRate != null && tx.displayRate !== "1") return;
    if (!tx.currency || !scopeCurrency || tx.currency === scopeCurrency) return;
    let cancelled = false;
    fetch(
      `/api/backend/fx-rate?from=${encodeURIComponent(tx.currency)}&to=${encodeURIComponent(scopeCurrency)}&date=${tx.executedAt.slice(0, 10)}`,
    )
      .then((r) => r.json())
      .then((data) => { if (!cancelled) setClientRate(data.rate ?? null); })
      .catch(() => { if (!cancelled) setClientRate(null); });
    return () => { cancelled = true; };
  }, [tx, scopeCurrency]);

  if (!tx) return null;

  const amount = txAmount(tx);
  const netAmount = txNetAmount(tx);

  const effectiveDisplayRate = tx.displayRate != null && tx.displayRate !== "1" ? tx.displayRate : clientRate;
  const effectiveDisplayCurrency = tx.displayCurrency ?? scopeCurrency;
  const showApproxDisplay =
    effectiveDisplayRate != null &&
    effectiveDisplayCurrency != null &&
    effectiveDisplayCurrency !== tx.currency;
  const netAmountDisplay = showApproxDisplay && netAmount != null
    ? netAmount * Number(effectiveDisplayRate)
    : null;
  const qty = Number(tx.quantity);
  const badge = TYPE_BADGE[tx.type] ?? DEFAULT_BADGE;
  const BadgeIcon = badge.icon;
  const pill = SOURCE_PILL[tx.source] ?? DEFAULT_PILL;
  const SourceIcon = SOURCE_ICON[tx.source] ?? null;
  const status = tx.status ?? "normal";
  const canReassign = portfolios.length > 1;
  const hasSources = (tx.sources?.length ?? 0) > 0;
  // Merged per-component tax breakdown across every source row (union of keys, later source
  // wins on overlap — same rule the server's cross-source merge uses). Promoted into its own
  // Details rows below instead of the sources-section footnote (see `showTaxBreakdown` below).
  const mergedTaxComponents = (tx.sources ?? []).reduce<Record<string, string>>((acc, s) => {
    if (s.taxComponents) Object.assign(acc, s.taxComponents);
    return acc;
  }, {});
  const taxComponentEntries = Object.entries(mergedTaxComponents).filter(
    ([, v]) => v && Number(v) !== 0,
  );
  // The legacy per-transaction receipt only shows when no source row carries its own doc.
  const showReceipt = tx.hasDocument && !tx.sources?.some((s) => s.hasDocument);
  // The owning account/portfolio — resolve the full record via the portfolios prop (for
  // its brokerage + logo); fall back to the row's own name when it isn't in the list.
  const account = portfolios.find((p) => p.id === tx.portfolioId) ?? null;
  const accountName = account?.name ?? tx.portfolioName ?? null;

  // 34×34 card icon-button (reference header cluster: var(--card) + subtle shadow).
  const iconBtn =
    "flex size-[34px] shrink-0 items-center justify-center rounded-[11px] bg-card text-foreground shadow-[0_1px_2px_rgba(15,27,20,.08)] transition-colors hover:bg-secondary";

  const title = tx.instrument?.symbol
    ? `${tt(tx.type)} · ${tx.instrument.symbol}`
    : tt(tx.type);

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

  const onDelete = async () => {
    setDeleting(true);
    try {
      await api.deleteTransaction(tx.portfolioId, tx.id);
      router.refresh();
      onDeleted();
      onOpenChange(false);
    } finally {
      setDeleting(false);
      setConfirmingDelete(false);
    }
  };

  const downloadReceipt = async () => {
    try {
      const { url } = await api.getTransactionDocumentUrl(tx.portfolioId, tx.id);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch {
      // Signed URL fetch failed — silently ignore (e.g. doc deleted).
    }
  };

  const setStatus = async (next: TransactionStatus) => {
    if (next === status || statusBusy) return;
    setStatusBusy(true);
    try {
      await api.setTransactionStatus(tx.portfolioId, tx.id, next);
      router.refresh();
    } finally {
      setStatusBusy(false);
    }
  };

  // Secondary actions live in the header "⋯" overflow so the footer stays Edit + Delete.
  const canSetStatus = status !== "draft";
  const hasOverflow = (canReassign && onReassign) || showReceipt || canSetStatus;

  // handleOnly: drag-to-close is restricted to the handle so content scrolling and the
  // close gesture don't conflict (#472). SheetContent is the single scroll container.
  return (
    <Sheet open={open} onOpenChange={onOpenChange} handleOnly>
      <SheetContent className="p-0" side="bottom" hideClose>
        {/* ── Sticky header: type badge + title/date, then the icon-button cluster ── */}
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
              <p className="truncate text-xs font-medium text-text-2">
                {df.format(new Date(tx.executedAt))}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {hasOverflow && (
                // Non-modal: this menu is nested inside the Sheet's Dialog. A modal
                // dropdown stacks a second dismissable layer, so re-clicking the trigger
                // (or selecting an item) dismisses BOTH layers and closes the whole sheet.
                <DropdownMenu modal={false}>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className={iconBtn}
                      aria-label={tm("actions")}
                      title={tm("actions")}
                    >
                      <MoreHorizontal className="size-[18px]" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {canReassign && onReassign && (
                      <DropdownMenuItem onClick={() => onReassign(tx)}>
                        <FolderInput className="size-4" />
                        {tm("reassign")}
                      </DropdownMenuItem>
                    )}
                    {showReceipt && (
                      <DropdownMenuItem onClick={downloadReceipt}>
                        <Download className="size-4" />
                        {tm("downloadReceipt")}
                      </DropdownMenuItem>
                    )}
                    {canSetStatus && (
                      <>
                        {(canReassign || showReceipt) && <DropdownMenuSeparator />}
                        <DropdownMenuLabel>{ts("label")}</DropdownMenuLabel>
                        <DropdownMenuItem
                          onClick={() => setStatus("normal")}
                          disabled={status === "normal" || statusBusy}
                        >
                          <ArchiveRestore className="size-4" />
                          {ts("normal")}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => setStatus("archived")}
                          disabled={status === "archived" || statusBusy}
                        >
                          <Archive className="size-4" />
                          {ts("archived")}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => setStatus("cash_neutral")}
                          disabled={status === "cash_neutral" || statusBusy}
                        >
                          <CircleSlash className="size-4" />
                          {ts("cashNeutral")}
                        </DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
              <SheetClose className={iconBtn} aria-label="Close">
                <X className="size-[18px]" strokeWidth={2.2} />
              </SheetClose>
            </div>
          </div>
        </SheetHeader>

        {/* Note: no nested overflow-y-auto — SheetContent is the single scroll
            container (#472). */}
        <div className="px-5 pb-7 pt-1.5">
          {/* ── Hero amount + source pill ── */}
          <div className="py-2.5 pb-[18px] text-center">
            <div
              className={cn(
                "tabular text-[34px] font-extrabold leading-none",
                netAmount > 0 ? "text-success" : "text-foreground",
              )}
            >
              {formatSignedMoney(netAmount, tx.currency, locale)}
            </div>
            {showApproxDisplay && netAmountDisplay !== null && (
              <div className="tabular mt-0.5 text-[13px] font-medium text-text-2">
                {t("approxDisplay", { amount: m(netAmountDisplay, effectiveDisplayCurrency!) })}
              </div>
            )}
            <div className="mt-2.5">
              <span
                className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[10px] font-bold uppercase tracking-[.04em]"
                style={{ background: pill.bg, color: pill.fg }}
              >
                {SourceIcon && <SourceIcon className="size-3" />}
                {t(`sources.${tx.source}`)}
              </span>
            </div>
          </div>

          {/* ── Breakdown ── */}
          <SectionHeading>{t("breakdown")}</SectionHeading>
          <DetailCard>
            {/* qty stays "0" for income rows by convention (see TxRow doc comments) — fall
                back to the informational shares/perShare pair (parsed from a settlement PDF,
                or — when `sharesEstimated` — derived read-time from holdings history, #508:
                flagged with the same "≈" treatment as the display-currency conversion above,
                since a derived value can otherwise look identically authoritative next to a
                real one parsed from a settlement PDF). */}
            {(qty !== 0 || tx.shares != null) && (
              <Row label={t("quantity")}>
                {qty !== 0
                  ? numFmt.format(qty)
                  : tx.sharesEstimated
                    ? t("approxDisplay", { amount: numFmt.format(Number(tx.shares)) })
                    : numFmt.format(Number(tx.shares))}
              </Row>
            )}
            {(qty !== 0 || tx.perShare != null) && (
              <Row label={t("price")}>
                {qty !== 0
                  ? m(Number(tx.price), tx.currency)
                  : tx.sharesEstimated
                    ? t("approxDisplay", {
                        amount: m(Number(tx.perShare), tx.nativeCurrency ?? tx.currency),
                      })
                    : m(Number(tx.perShare), tx.nativeCurrency ?? tx.currency)}
              </Row>
            )}
            {tx.grossNative != null && tx.nativeCurrency && (
              <Row label={t("grossNative")}>{m(Number(tx.grossNative), tx.nativeCurrency)}</Row>
            )}
            <Row label={t("amount")}>{m(amount, tx.currency)}</Row>
            {Number(tx.fees) !== 0 && (
              <Row label={t("fees")}>{m(Number(tx.fees), tx.currency)}</Row>
            )}
            {tx.tax != null && Number(tx.tax) !== 0 && (
              <Row label={t("tax")}>{m(Number(tx.tax), tx.currency)}</Row>
            )}
            <Row label={t("netAmount")} strong color={netAmount > 0 ? "text-success" : undefined}>
              {formatSignedMoney(netAmount, tx.currency, locale)}
            </Row>
          </DetailCard>

          {/* ── Details ── */}
          <SectionHeading>{t("details")}</SectionHeading>
          <DetailCard>
            <Row label={t("date")}>{df.format(new Date(tx.executedAt))}</Row>
            {tx.instrument?.symbol && (
              <Row label={t("instrument")}>
                <span>{tx.instrument.symbol}</span>
                {(tx.instrument.displayName ?? tx.instrument.name) && (
                  <span className="block text-[11px] font-medium text-text-2">
                    {tx.instrument.displayName ?? tx.instrument.name}
                  </span>
                )}
              </Row>
            )}
            {accountName && (
              <Row label={t("portfolio")}>
                <span className="flex items-center justify-end gap-2.5">
                  {account?.brokerage && (
                    <BrokerageIcon brokerage={account.brokerage} className="size-9 rounded-[10px]" />
                  )}
                  <span className="min-w-0 leading-tight">
                    <span className="block truncate">{accountName}</span>
                    {account?.brokerage && (
                      <span className="block truncate text-[11px] font-medium text-text-2">
                        {account.brokerage}
                      </span>
                    )}
                  </span>
                </span>
              </Row>
            )}
            <Row label={t("currency")}>{tx.currency}</Row>
            {tx.fxRate && <Row label={t("fxRate")}>{Number(tx.fxRate).toFixed(4)}</Row>}
            {taxComponentEntries.map(([key, value]) => (
              <Row key={key} label={TAX_COMPONENT_LABELS[key] ?? key}>
                {m(Number(value), tx.currency)}
              </Row>
            ))}
            {/* Source is only surfaced here when there are no provenance rows below. */}
            {!hasSources && (
              <Row label={t("source")}>
                <span className="inline-flex items-center gap-1.5">
                  {SourceIcon && <SourceIcon className="size-3.5" />}
                  {t(`sources.${tx.source}`)}
                </span>
              </Row>
            )}
          </DetailCard>

          {/* ── Import provenance — source rows with per-source download buttons ── */}
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

          {/* Retention hint — shown when source rows exist but no document was retained */}
          {hasSources && !tx.hasDocument && !tx.sources?.some((s) => s.hasDocument) && (
            <p className="mt-2 text-xs text-muted-foreground">
              {t("sourcesSection.notRetained")}
            </p>
          )}

          {/* ── Data-integrity warning + dismiss ── */}
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
                onClick={dismissAnomaly}
              >
                {ta("dismiss")}
              </Button>
            </div>
          )}

          {/* ── Draft resolve — prominent for draft rows (confirm/discard the import) ── */}
          {status === "draft" && onResolve && (
            <div className="mt-5 flex gap-2.5">
              <Button
                className="flex-1"
                disabled={resolving}
                onClick={() => onResolve(tx, "confirm")}
              >
                {resolving ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Check className="size-4" />
                )}
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

          {/* ── Primary action pair: Edit + Delete (reference footer) ── */}
          {confirmingDelete ? (
            <div className="mt-5 flex gap-2.5">
              <Button
                variant="destructive"
                className="flex-1"
                disabled={deleting}
                onClick={onDelete}
              >
                {deleting && <Loader2 className="size-4 animate-spin" />}
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
              {/* Edit — reference neutral button: card background + border (lighter than page).
                  Opens the edit sheet in place when the caller wires `onEdit`; otherwise
                  falls back to the standalone edit page. */}
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
      </SheetContent>
    </Sheet>
  );
}
