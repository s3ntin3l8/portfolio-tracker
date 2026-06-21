"use client";

import { useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import {
  ScanLine,
  FileSpreadsheet,
  PencilLine,
  Landmark,
  Pencil,
  Loader2,
  Trash2,
  Download,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SortableTableHead } from "@/components/ui/sortable-table-head";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DeleteTransactionButton } from "@/components/delete-transaction-button";
import { Link, useRouter } from "@/i18n/navigation";
import { useApiClient } from "@/lib/api";
import { cashFlow } from "@portfolio/core";
import { formatMoney } from "@/lib/utils";
import { useTableSort } from "@/lib/table-sort";
import type { ColDef } from "@/lib/table-sort";
import type { CoreTransaction } from "@portfolio/core";

export const SOURCE_ICON: Record<string, LucideIcon> = {
  screenshot: ScanLine,
  csv: FileSpreadsheet,
  manual: PencilLine,
  pytr: Landmark,
};

const TYPE_VARIANT: Record<string, "success" | "destructive" | "default"> = {
  buy: "success",
  sell: "destructive",
};

export interface TxRow {
  id: string;
  portfolioId: string;
  portfolioName?: string;
  type: string;
  quantity: string;
  price: string;
  fees: string;
  tax?: string | null;
  fxRate?: string | null;
  currency: string;
  executedAt: string;
  source: string;
  instrument: { symbol?: string | null; name?: string | null } | null;
  /** True when the parent import has a retained source document (#231). */
  hasDocument?: boolean;
}

/** Compute the signed cash-flow (actual cash movement) for a TxRow via core. */
function txNetAmount(tx: TxRow): number {
  return cashFlow({
    instrumentId: null,
    type: tx.type as CoreTransaction["type"],
    quantity: tx.quantity,
    price: tx.price,
    fees: tx.fees,
    currency: tx.currency,
    executedAt: new Date(tx.executedAt),
  }).toNumber();
}

/**
 * Transactions table with row selection and batch delete. When `showPortfolio` is set
 * (the aggregate "All portfolios" view) a Portfolio column is shown and a batch delete
 * is fanned out per portfolio, since the delete endpoint is portfolio-scoped.
 */
const TX_COLS: ColDef<TxRow>[] = [
  { key: "date", get: (r) => r.executedAt, type: "date" },
  { key: "type", get: (r) => r.type, type: "text" },
  { key: "instrument", get: (r) => r.instrument?.symbol ?? "", type: "text" },
  { key: "portfolio", get: (r) => r.portfolioName ?? "", type: "text" },
  { key: "quantity", get: (r) => r.quantity, type: "numeric" },
  {
    key: "amount",
    get: (r) => {
      const qty = Number(r.quantity);
      const price = Number(r.price);
      if (qty > 0) return qty * price; // trade: notional (qty×price)
      // Income (dividend/coupon/interest/bonus_cash) and deposits/withdrawals:
      // show GROSS = net price + withheld tax. For trades-with-tax or deposit/withdrawal
      // (where tax is null) this is just price. For dividend reversals both are negative.
      return price + (r.tax ? Number(r.tax) : 0);
    },
    type: "numeric",
  },
  { key: "fees", get: (r) => Number(r.fees), type: "numeric" },
  { key: "tax", get: (r) => (r.tax ? Number(r.tax) : 0), type: "numeric" },
  { key: "netAmount", get: (r) => txNetAmount(r), type: "numeric" },
  { key: "fxRate", get: (r) => (r.fxRate ? Number(r.fxRate) : 0), type: "numeric" },
  { key: "source", get: (r) => r.source, type: "text" },
];

// Cash/non-investment legs hidden by the "Investments only" filter. This is a pure
// display filter — it never affects any computed figure (see CLAUDE.md "one boundary
// per portfolio"; counting is set by the portfolio's cash boundary, not this toggle).
const NON_INVESTMENT_TYPES = new Set([
  "deposit",
  "withdrawal",
  "fee",
  "interest",
  "bonus_cash",
  "loan_drawdown",
  "loan_repayment",
]);

export function TransactionsTable({
  rows,
  showPortfolio = false,
  defaultInvestmentsOnly = false,
}: {
  rows: TxRow[];
  showPortfolio?: boolean;
  defaultInvestmentsOnly?: boolean;
}) {
  const t = useTranslations("Transactions");
  const tt = useTranslations("TxType");
  const tm = useTranslations("Manage");
  const tb = useTranslations("Transactions.batch");
  const locale = useLocale();
  const api = useApiClient();
  const router = useRouter();

  const { sortKey, sortDir, toggle: toggleSort, sort } = useTableSort<TxRow>(TX_COLS);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [investmentsOnly, setInvestmentsOnly] = useState(defaultInvestmentsOnly);

  // Display-only filter; does not touch any calculation.
  const visibleRows = useMemo(
    () => (investmentsOnly ? rows.filter((r) => !NON_INVESTMENT_TYPES.has(r.type)) : rows),
    [rows, investmentsOnly],
  );

  const m = (n: number, currency: string) => formatMoney(n, currency, locale);
  const df = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "medium" }),
    [locale],
  );

  const allSelected = visibleRows.length > 0 && selected.size === visibleRows.length;

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(visibleRows.map((r) => r.id)));
  }

  async function onBatchDelete() {
    setBusy(true);
    try {
      // Group by portfolio — the delete endpoint is scoped to one portfolio.
      const byPortfolio = new Map<string, string[]>();
      for (const r of rows) {
        if (!selected.has(r.id)) continue;
        const ids = byPortfolio.get(r.portfolioId) ?? [];
        ids.push(r.id);
        byPortfolio.set(r.portfolioId, ids);
      }
      await Promise.all(
        [...byPortfolio.entries()].map(([portfolioId, ids]) =>
          api.bulkDeleteTransactions(portfolioId, ids),
        ),
      );
      setSelected(new Set());
      router.refresh();
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  // checkbox + date + type + instrument + [portfolio] + qty + amount + fees(sm) +
  // tax + netAmount + fxRate(sm) + source(sm) + actions = 12 or 13
  const colSpan = showPortfolio ? 13 : 12;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1 text-sm">
        <Button
          size="sm"
          variant={investmentsOnly ? "ghost" : "secondary"}
          onClick={() => setInvestmentsOnly(false)}
        >
          {t("filterAll")}
        </Button>
        <Button
          size="sm"
          variant={investmentsOnly ? "secondary" : "ghost"}
          onClick={() => setInvestmentsOnly(true)}
        >
          {t("filterInvestments")}
        </Button>
      </div>

      {selected.size > 0 && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card/60 px-4 py-2 text-sm">
          <span className="text-muted-foreground">
            {tb("selected", { count: selected.size })}
          </span>
          {confirming ? (
            <span className="flex items-center gap-2">
              <span className="text-muted-foreground">{tb("confirmPrompt")}</span>
              <Button
                size="sm"
                variant="destructive"
                onClick={onBatchDelete}
                disabled={busy}
              >
                {busy && <Loader2 className="size-3.5 animate-spin" />}
                {tb("confirm")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setConfirming(false)}
                disabled={busy}
              >
                {tb("cancel")}
              </Button>
            </span>
          ) : (
            <Button
              size="sm"
              variant="destructive"
              onClick={() => setConfirming(true)}
            >
              <Trash2 className="size-3.5" />
              {tb("delete")}
            </Button>
          )}
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <input
                  type="checkbox"
                  className="size-4 align-middle accent-primary"
                  aria-label={tb("selectAll")}
                  checked={allSelected}
                  onChange={toggleAll}
                />
              </TableHead>
              <SortableTableHead colKey="date" sortKey={sortKey} sortDir={sortDir} onToggle={toggleSort}>{t("date")}</SortableTableHead>
              <SortableTableHead colKey="type" sortKey={sortKey} sortDir={sortDir} onToggle={toggleSort}>{t("type")}</SortableTableHead>
              <SortableTableHead colKey="instrument" sortKey={sortKey} sortDir={sortDir} onToggle={toggleSort}>{t("instrument")}</SortableTableHead>
              {showPortfolio && <SortableTableHead colKey="portfolio" sortKey={sortKey} sortDir={sortDir} onToggle={toggleSort}>{t("portfolio")}</SortableTableHead>}
              <SortableTableHead colKey="quantity" sortKey={sortKey} sortDir={sortDir} onToggle={toggleSort} className="text-right">{t("quantity")}</SortableTableHead>
              <SortableTableHead colKey="amount" sortKey={sortKey} sortDir={sortDir} onToggle={toggleSort} className="text-right">{t("amount")}</SortableTableHead>
              <SortableTableHead colKey="fees" sortKey={sortKey} sortDir={sortDir} onToggle={toggleSort} className="hidden text-right sm:table-cell">{t("fees")}</SortableTableHead>
              <SortableTableHead colKey="tax" sortKey={sortKey} sortDir={sortDir} onToggle={toggleSort} className="text-right">{t("tax")}</SortableTableHead>
              <SortableTableHead colKey="netAmount" sortKey={sortKey} sortDir={sortDir} onToggle={toggleSort} className="text-right">{t("netAmount")}</SortableTableHead>
              <SortableTableHead colKey="fxRate" sortKey={sortKey} sortDir={sortDir} onToggle={toggleSort} className="hidden text-right sm:table-cell">{t("fxRate")}</SortableTableHead>
              <SortableTableHead colKey="source" sortKey={sortKey} sortDir={sortDir} onToggle={toggleSort} className="hidden sm:table-cell">{t("source")}</SortableTableHead>
              <TableHead className="text-right">
                <span className="sr-only">{tm("actions")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sort(visibleRows).map((tx) => {
              const Icon = SOURCE_ICON[tx.source] ?? PencilLine;
              const qty = Number(tx.quantity);
              const price = Number(tx.price);
              const amount =
                qty > 0
                  ? qty * price // trade: notional
                  : price + (tx.tax ? Number(tx.tax) : 0); // income/cash: gross
              const netAmount = txNetAmount(tx);
              const isSelected = selected.has(tx.id);
              return (
                <TableRow key={tx.id} data-state={isSelected ? "selected" : undefined}>
                  <TableCell>
                    <input
                      type="checkbox"
                      className="size-4 align-middle accent-primary"
                      aria-label={tb("selectRow")}
                      checked={isSelected}
                      onChange={() => toggle(tx.id)}
                    />
                  </TableCell>
                  <TableCell className="tabular whitespace-nowrap text-muted-foreground">
                    {df.format(new Date(tx.executedAt))}
                  </TableCell>
                  <TableCell>
                    <Badge variant={TYPE_VARIANT[tx.type] ?? "default"}>
                      {tt(tx.type)}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="font-medium">{tx.instrument?.symbol ?? "—"}</div>
                    {tx.instrument?.name && (
                      <div className="text-xs text-muted-foreground">
                        {tx.instrument.name}
                      </div>
                    )}
                  </TableCell>
                  {showPortfolio && (
                    <TableCell className="text-muted-foreground">
                      {tx.portfolioName ?? "—"}
                    </TableCell>
                  )}
                  <TableCell className="tabular text-right">{qty || "—"}</TableCell>
                  <TableCell className="tabular text-right">
                    {m(amount, tx.currency)}
                  </TableCell>
                  <TableCell className="tabular hidden text-right sm:table-cell">
                    {Number(tx.fees) !== 0 ? m(Number(tx.fees), tx.currency) : "—"}
                  </TableCell>
                  <TableCell className="tabular text-right">
                    {tx.tax && Number(tx.tax) !== 0 ? m(Number(tx.tax), tx.currency) : "—"}
                  </TableCell>
                  <TableCell className="tabular text-right">
                    {m(netAmount, tx.currency)}
                  </TableCell>
                  <TableCell className="tabular hidden text-right sm:table-cell">
                    {tx.fxRate ? Number(tx.fxRate).toFixed(4) : "—"}
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Icon className="size-3.5" />
                      {t(`sources.${tx.source}`)}
                    </span>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      {tx.hasDocument && (
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={tm("downloadReceipt")}
                          onClick={async () => {
                            try {
                              const { url } = await api.getTransactionDocumentUrl(tx.portfolioId, tx.id);
                              window.open(url, "_blank", "noopener,noreferrer");
                            } catch {
                              // Signed URL fetch failed — silently ignore (e.g. doc deleted).
                            }
                          }}
                        >
                          <Download className="size-4" />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        asChild
                        aria-label={tm("edit")}
                      >
                        <Link href={`/transactions/${tx.id}/edit`}>
                          <Pencil className="size-4" />
                        </Link>
                      </Button>
                      <DeleteTransactionButton
                        portfolioId={tx.portfolioId}
                        txId={tx.id}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
            {visibleRows.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={colSpan}
                  className="py-8 text-center text-sm text-muted-foreground"
                >
                  {t("empty")}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
