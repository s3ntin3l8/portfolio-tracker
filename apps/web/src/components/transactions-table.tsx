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
  ChevronRight,
  Search,
  X,
  AlertTriangle,
  AlertCircle,
  Check,
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
import { TransactionDetailSheet } from "@/components/transaction-detail-sheet";
import { Link, useRouter } from "@/i18n/navigation";
import { useApiClient } from "@/lib/api";
import { cashFlow } from "@portfolio/core";
import { formatMoney } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { useTableSort } from "@/lib/table-sort";
import type { ColDef } from "@/lib/table-sort";
import type { CoreTransaction } from "@portfolio/core";
import type { SourceSummary, Anomaly, TransactionStatus } from "@portfolio/api-client";
import { TransactionStatusButton } from "@/components/transaction-status-button";

export const SOURCE_ICON: Record<string, LucideIcon> = {
  screenshot: ScanLine,
  csv: FileSpreadsheet,
  manual: PencilLine,
  pytr: Landmark,
  pdf: FileSpreadsheet,
  ibkr: Landmark,
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
  /** Import dedup key; null for manually-entered transactions. */
  externalId?: string | null;
  /** True when at least one source row has per-component taxComponents. */
  hasFullTaxDetail?: boolean;
  /** Source-provenance rows — empty for manual transactions. */
  sources?: SourceSummary[];
  /** Visibility status; undefined ⇒ "normal". archived = ignored everywhere. */
  status?: TransactionStatus;
}

/** Compute the signed cash-flow (actual cash movement) for a TxRow via core. The status
 * is passed through so archived rows show 0 and cash_neutral rows show only fees. */
export function txNetAmount(tx: TxRow): number {
  return cashFlow({
    instrumentId: null,
    type: tx.type as CoreTransaction["type"],
    quantity: tx.quantity,
    price: tx.price,
    fees: tx.fees,
    currency: tx.currency,
    executedAt: new Date(tx.executedAt),
    status: tx.status,
  }).toNumber();
}

/**
 * Compute the gross amount for display: notional (qty×price) for trades,
 * or gross income (price + tax) for dividends/cash flows.
 */
export function txAmount(tx: TxRow): number {
  const qty = Number(tx.quantity);
  const price = Number(tx.price);
  return qty > 0
    ? qty * price // trade: notional
    : price + (tx.tax ? Number(tx.tax) : 0); // income/cash: gross
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
  anomalies = [],
}: {
  rows: TxRow[];
  showPortfolio?: boolean;
  defaultInvestmentsOnly?: boolean;
  /** Per-transaction anomalies keyed by transactionId; shows a flag icon on the row. */
  anomalies?: Anomaly[];
}) {
  const t = useTranslations("Transactions");
  const tt = useTranslations("TxType");
  const tm = useTranslations("Manage");
  const ta = useTranslations("Anomalies");
  const tb = useTranslations("Transactions.batch");
  const locale = useLocale();
  const api = useApiClient();
  const router = useRouter();

  const { sortKey, sortDir, toggle: toggleSort, sort } = useTableSort<TxRow>(TX_COLS);

  // Build a lookup: transactionId → worst-severity anomaly for that row.
  const anomalyByTxId = useMemo(() => {
    const m = new Map<string, Anomaly>();
    for (const a of anomalies) {
      if (!a.transactionId) continue;
      const existing = m.get(a.transactionId);
      // Prefer error over warning.
      if (!existing || (existing.severity === "warning" && a.severity === "error")) {
        m.set(a.transactionId, a);
      }
    }
    return m;
  }, [anomalies]);

  // Number of rows that actually carry a transaction-scoped anomaly (portfolio-scoped
  // anomalies like reconciliation_gap have no transactionId, so they don't filter to a row).
  const flaggedCount = anomalyByTxId.size;

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [investmentsOnly, setInvestmentsOnly] = useState(defaultInvestmentsOnly);
  const [typeFilter, setTypeFilter] = useState("all");
  const [instrumentFilter, setInstrumentFilter] = useState("all");
  const [yearFilter, setYearFilter] = useState("all");
  const [draftFilter, setDraftFilter] = useState<"all" | "drafts">("all");
  const [query, setQuery] = useState("");
  const [showFlagged, setShowFlagged] = useState(false);
  const [detailTx, setDetailTx] = useState<TxRow | null>(null);
  // Id of a single row currently being confirmed/discarded (shows a spinner on that row).
  const [resolvingId, setResolvingId] = useState<string | null>(null);

  const draftCount = useMemo(() => rows.filter((r) => r.status === "draft").length, [rows]);

  // Derive distinct options from `rows` so selects only show values present in the data.
  const typeOptions = useMemo(
    () => [...new Set(rows.map((r) => r.type))].sort(),
    [rows],
  );
  const instrumentOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of rows) {
      if (!r.instrument) continue;
      const key = r.instrument.symbol ?? r.instrument.name ?? "";
      if (key && !seen.has(key)) seen.set(key, r.instrument.symbol ?? r.instrument.name ?? key);
    }
    return [...seen.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [rows]);
  const yearOptions = useMemo(
    () =>
      [...new Set(rows.map((r) => String(new Date(r.executedAt).getFullYear())))].sort(
        (a, b) => Number(b) - Number(a),
      ),
    [rows],
  );

  // Display-only filters; none of these touch any calculation.
  const visibleRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter(
      (r) =>
        (!showFlagged || anomalyByTxId.has(r.id)) &&
        (draftFilter === "all" || r.status === "draft") &&
        (!investmentsOnly || !NON_INVESTMENT_TYPES.has(r.type)) &&
        (typeFilter === "all" || r.type === typeFilter) &&
        (instrumentFilter === "all" ||
          (r.instrument?.symbol ?? r.instrument?.name ?? "") === instrumentFilter) &&
        (yearFilter === "all" ||
          String(new Date(r.executedAt).getFullYear()) === yearFilter) &&
        (!q ||
          (r.instrument?.symbol ?? "").toLowerCase().includes(q) ||
          (r.instrument?.name ?? "").toLowerCase().includes(q) ||
          r.type.toLowerCase().includes(q) ||
          tt(r.type as Parameters<typeof tt>[0])
            .toLowerCase()
            .includes(q) ||
          (r.portfolioName ?? "").toLowerCase().includes(q) ||
          r.source.toLowerCase().includes(q)),
    );
  }, [rows, showFlagged, anomalyByTxId, draftFilter, investmentsOnly, typeFilter, instrumentFilter, yearFilter, query, tt]);


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

  // Ids of the currently-selected DRAFT rows (the only ones confirm/discard act on).
  const selectedDraftIds = useMemo(
    () => rows.filter((r) => selected.has(r.id) && r.status === "draft").map((r) => r.id),
    [rows, selected],
  );

  async function onBatchResolve(action: "confirm" | "discard") {
    setBusy(true);
    try {
      // Group by portfolio — the resolve endpoint is scoped to one portfolio.
      const byPortfolio = new Map<string, string[]>();
      for (const r of rows) {
        if (!selected.has(r.id) || r.status !== "draft") continue;
        const ids = byPortfolio.get(r.portfolioId) ?? [];
        ids.push(r.id);
        byPortfolio.set(r.portfolioId, ids);
      }
      await Promise.all(
        [...byPortfolio.entries()].map(([portfolioId, ids]) =>
          api.resolveDraftTransactions(portfolioId, ids, action),
        ),
      );
      setSelected(new Set());
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function onResolveOne(tx: TxRow, action: "confirm" | "discard") {
    setResolvingId(tx.id);
    try {
      await api.resolveDraftTransactions(tx.portfolioId, [tx.id], action);
      router.refresh();
    } finally {
      setResolvingId(null);
    }
  }

  // checkbox + date + type + instrument + [portfolio] + qty + amount + fees(sm) +
  // tax + netAmount + fxRate(sm) + source(sm) + actions = 12 or 13
  const colSpan = showPortfolio ? 13 : 12;

  // Anomaly banner — only when anomalies exist (only passed in single-portfolio view).
  const anomalyErrors = anomalies.filter((a) => a.severity === "error");
  const anomalyWarnings = anomalies.filter((a) => a.severity === "warning");
  const anomalyBanner =
    anomalyErrors.length > 0 || anomalyWarnings.length > 0 ? (
      <div
        role="alert"
        className={`flex items-center gap-3 rounded-lg border px-4 py-3 text-sm ${
          anomalyErrors.length > 0
            ? "border-destructive/40 bg-destructive/5 text-destructive"
            : "border-amber-400/40 bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-400"
        }`}
      >
        {anomalyErrors.length > 0 ? (
          <AlertCircle className="size-4 shrink-0" />
        ) : (
          <AlertTriangle className="size-4 shrink-0" />
        )}
        <span className="flex-1">
          {anomalyErrors.length > 0 && anomalyWarnings.length > 0
            ? ta("bannerBoth", { errors: anomalyErrors.length, warnings: anomalyWarnings.length })
            : anomalyErrors.length > 0
              ? ta("bannerError", { count: anomalyErrors.length })
              : ta("bannerWarning", { count: anomalyWarnings.length })}
        </span>
        {flaggedCount > 0 && (
          <Button
            type="button"
            size="sm"
            variant={showFlagged ? "secondary" : "outline"}
            aria-pressed={showFlagged}
            onClick={() => setShowFlagged((v) => !v)}
          >
            {ta("showFlagged")}
          </Button>
        )}
      </div>
    ) : null;

  return (
    <div className="space-y-3">
      {anomalyBanner}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <select
          aria-label={t("filterScope")}
          value={investmentsOnly ? "investments" : "all"}
          onChange={(e) => setInvestmentsOnly(e.target.value === "investments")}
          className="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        >
          <option value="all">{t("filterAll")}</option>
          <option value="investments">{t("filterInvestments")}</option>
        </select>
        {typeOptions.length > 1 && (
          <select
            aria-label={t("filterType")}
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            className="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          >
            <option value="all">{t("allTypes")}</option>
            {typeOptions.map((tp) => (
              <option key={tp} value={tp}>
                {tt(tp as Parameters<typeof tt>[0])}
              </option>
            ))}
          </select>
        )}
        {instrumentOptions.length > 1 && (
          <select
            aria-label={t("filterInstrument")}
            value={instrumentFilter}
            onChange={(e) => setInstrumentFilter(e.target.value)}
            className="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          >
            <option value="all">{t("allInstruments")}</option>
            {instrumentOptions.map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        )}
        {yearOptions.length > 1 && (
          <select
            aria-label={t("filterYear")}
            value={yearFilter}
            onChange={(e) => setYearFilter(e.target.value)}
            className="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          >
            <option value="all">{t("allYears")}</option>
            {yearOptions.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        )}
        {draftCount > 0 && (
          <select
            aria-label={t("filterDraftLabel")}
            value={draftFilter}
            onChange={(e) => setDraftFilter(e.target.value as "all" | "drafts")}
            className="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          >
            <option value="all">{t("draftShowAll")}</option>
            <option value="drafts">{t("draftOnly", { count: draftCount })}</option>
          </select>
        )}
        <div className="relative ml-auto flex items-center">
          <Search className="pointer-events-none absolute left-2 size-3.5 text-muted-foreground" />
          <Input
            type="text"
            placeholder={t("searchPlaceholder")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-8 w-44 pl-7 pr-7 text-xs"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label={t("searchClear")}
              className="absolute right-2 text-muted-foreground hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
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
            <span className="flex items-center gap-2">
              {selectedDraftIds.length > 0 && (
                <>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => onBatchResolve("confirm")}
                    disabled={busy}
                  >
                    {busy && <Loader2 className="size-3.5 animate-spin" />}
                    <Check className="size-3.5" />
                    {tb("confirmDrafts")}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onBatchResolve("discard")}
                    disabled={busy}
                  >
                    {tb("discardDrafts")}
                  </Button>
                </>
              )}
              <Button
                size="sm"
                variant="destructive"
                onClick={() => setConfirming(true)}
                disabled={busy}
              >
                <Trash2 className="size-3.5" />
                {tb("delete")}
              </Button>
            </span>
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
              const amount = txAmount(tx);
              const netAmount = txNetAmount(tx);
              const isSelected = selected.has(tx.id);
              const anomaly = anomalyByTxId.get(tx.id);
              const status = tx.status ?? "normal";
              return (
                <TableRow
                  key={tx.id}
                  data-state={isSelected ? "selected" : undefined}
                  className={`cursor-pointer ${status === "archived" ? "opacity-50" : ""} ${
                    status === "draft" ? "bg-amber-50/40 dark:bg-amber-950/10" : ""
                  }`}
                  onClick={() => setDetailTx(tx)}
                >
                  <TableCell>
                    <span onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        className="size-4 align-middle accent-primary"
                        aria-label={tb("selectRow")}
                        checked={isSelected}
                        onChange={() => toggle(tx.id)}
                      />
                    </span>
                  </TableCell>
                  <TableCell className="tabular whitespace-nowrap text-muted-foreground">
                    {df.format(new Date(tx.executedAt))}
                  </TableCell>
                  <TableCell>
                    <span className="flex flex-wrap items-center gap-1">
                      <Badge variant={TYPE_VARIANT[tx.type] ?? "default"}>
                        {tt(tx.type)}
                      </Badge>
                      {status === "draft" && (
                        <Badge
                          variant="outline"
                          className="border-amber-400/50 text-amber-600 dark:text-amber-400"
                        >
                          {tm("status.badgeDraft")}
                        </Badge>
                      )}
                      {status === "archived" && (
                        <Badge variant="outline">{tm("status.badgeArchived")}</Badge>
                      )}
                      {status === "cash_neutral" && (
                        <Badge variant="outline">{tm("status.badgeCashNeutral")}</Badge>
                      )}
                    </span>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1.5">
                      {anomaly && (
                        <span title={anomaly.code} aria-label={anomaly.code}>
                          {anomaly.severity === "error" ? (
                            <AlertCircle className="size-3.5 shrink-0 text-destructive" />
                          ) : (
                            <AlertTriangle className="size-3.5 shrink-0 text-amber-500" />
                          )}
                        </span>
                      )}
                      <div>
                        <div className="font-medium">{tx.instrument?.symbol ?? "—"}</div>
                        {tx.instrument?.name && (
                          <div className="text-xs text-muted-foreground">
                            {tx.instrument.name}
                          </div>
                        )}
                      </div>
                    </div>
                  </TableCell>
                  {showPortfolio && (
                    <TableCell className="text-muted-foreground">
                      {tx.portfolioName ?? "—"}
                    </TableCell>
                  )}
                  <TableCell className="tabular text-right">{Number(tx.quantity) || "—"}</TableCell>
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
                    <div
                      className="flex items-center justify-end gap-1"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={tm("viewDetails")}
                        onClick={() => setDetailTx(tx)}
                      >
                        <ChevronRight className="size-4" />
                      </Button>
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
                      {status === "draft" && (
                        <>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={tm("status.confirmDraft")}
                            title={tm("status.confirmDraft")}
                            disabled={resolvingId === tx.id}
                            onClick={() => onResolveOne(tx, "confirm")}
                            className="text-emerald-600 hover:text-emerald-700 dark:text-emerald-400"
                          >
                            {resolvingId === tx.id ? (
                              <Loader2 className="size-4 animate-spin" />
                            ) : (
                              <Check className="size-4" />
                            )}
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={tm("status.discardDraft")}
                            title={tm("status.discardDraft")}
                            disabled={resolvingId === tx.id}
                            onClick={() => onResolveOne(tx, "discard")}
                          >
                            <X className="size-4" />
                          </Button>
                        </>
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
                  {query.trim() || showFlagged ? t("noResults") : t("empty")}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <TransactionDetailSheet
        tx={detailTx}
        open={!!detailTx}
        onOpenChange={(o) => { if (!o) setDetailTx(null); }}
        onDeleted={() => { setDetailTx(null); router.refresh(); }}
      />
    </div>
  );
}
