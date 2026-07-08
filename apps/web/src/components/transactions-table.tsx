"use client";

import { Fragment, useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import {
  ScanLine,
  FileSpreadsheet,
  PencilLine,
  Landmark,
  ListChecks,
  Loader2,
  Trash2,
  Search,
  X,
  AlertTriangle,
  AlertCircle,
  Check,
  FolderInput,
  ArrowDownToLine,
  ArrowUpFromLine,
  ArrowDownCircle,
  ArrowUpCircle,
  ArrowRightLeft,
  ArrowLeftRight,
  Coins,
  Gem,
  Split,
  GitMerge,
  ChevronDown,
  Scale,
} from "lucide-react";
import { toast } from "sonner";
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
import { TransactionDetailSheet } from "@/components/transaction-detail-sheet";
import { EditTransactionSheet } from "@/components/edit-transaction-sheet";
import { useRouter } from "@/i18n/navigation";
import { useApiClient } from "@/lib/api";
import { cashFlow } from "@portfolio/core";
import { formatMoney, anomalyLabel, cn, type AnomalyTranslator } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { useTableSort } from "@/lib/table-sort";
import type { ColDef } from "@/lib/table-sort";
import type { CoreTransaction } from "@portfolio/core";
import type { SourceSummary, Anomaly, TransactionStatus } from "@portfolio/api-client";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ReassignDialog } from "@/components/reassign-dialog";
import { MergeDialog } from "@/components/merge-dialog";
import type { PickablePortfolio } from "@/components/portfolio-picker";
import {
  AllFilterBanner,
  IncomeFilterBanner,
  TradeFilterBanner,
  ReconciliationBanner,
} from "@/components/transactions/activity-banners";
import {
  computeAllBanner,
  computeIncomeBanner,
  computeTradeBanner,
  ACTIVITY_INCOME_TYPES,
} from "@/lib/transaction-banners";

export const SOURCE_ICON: Record<string, LucideIcon> = {
  screenshot: ScanLine,
  csv: FileSpreadsheet,
  manual: PencilLine,
  pytr: Landmark,
  pdf: FileSpreadsheet,
  ibkr: Landmark,
};

/** Per-kind icon + tint, matching the reference's `TYPE` map (buy/sell arrows, a coin for
 *  dividend/coupon, cash in/out arrows, a gem for share events, teal for transfers/merger).
 *  `loan_drawdown`/`loan_repayment` (gold cicilan) have no reference equivalent — grouped
 *  with cash in/out by cashflow direction. */
const TYPE_ICON: Record<string, { icon: LucideIcon; tone: "success" | "destructive" | "warning" | "violet" | "teal" }> = {
  buy: { icon: ArrowDownToLine, tone: "success" },
  savings_plan: { icon: ArrowDownToLine, tone: "success" },
  sell: { icon: ArrowUpFromLine, tone: "destructive" },
  dividend: { icon: Coins, tone: "warning" },
  coupon: { icon: Coins, tone: "warning" },
  deposit: { icon: ArrowDownCircle, tone: "success" },
  interest: { icon: ArrowDownCircle, tone: "success" },
  bonus_cash: { icon: ArrowDownCircle, tone: "success" },
  loan_drawdown: { icon: ArrowDownCircle, tone: "success" },
  withdrawal: { icon: ArrowUpCircle, tone: "destructive" },
  fee: { icon: ArrowUpCircle, tone: "destructive" },
  tax: { icon: ArrowUpCircle, tone: "destructive" },
  loan_repayment: { icon: ArrowUpCircle, tone: "destructive" },
  bonus: { icon: Gem, tone: "violet" },
  rights: { icon: Gem, tone: "violet" },
  split: { icon: Split, tone: "violet" },
  transfer_in: { icon: ArrowRightLeft, tone: "teal" },
  transfer_out: { icon: ArrowLeftRight, tone: "teal" },
  merger: { icon: GitMerge, tone: "teal" },
  // Manual signed cash true-up — a structural correction, not organic activity, so it
  // groups tonally with transfers/merger rather than a real cash in/out flow.
  adjustment: { icon: Scale, tone: "teal" },
};

const TYPE_TONE_CLASSES = {
  success: "bg-success/15 text-success",
  destructive: "bg-destructive/15 text-destructive",
  warning: "bg-warning/15 text-warning",
  violet: "bg-[#7C5CFC]/15 text-[#7C5CFC]",
  teal: "bg-[#0D9488]/15 text-[#0D9488]",
} as const;

// Reference SRCTYPE provenance tags: tinted 700 9px pills per source.
const SRC_TONES: Record<string, React.CSSProperties> = {
  csv: { background: "rgba(13,148,136,.16)", color: "#0D9488" },
  pdf: { background: "rgba(229,72,77,.13)", color: "#E5484D" },
  screenshot: { background: "rgba(124,92,252,.16)", color: "#7C5CFC" },
  pytr: { background: "rgba(13,148,136,.16)", color: "#0D9488" },
  ibkr: { background: "rgba(13,148,136,.16)", color: "#0D9488" },
  manual: { background: "var(--border)", color: "var(--text-mute)" },
};

/** Distinct source types backing a row's provenance chips — one chip per source (e.g. a
 *  CSV row later enriched by a PDF shows both), falling back to the single legacy `source`
 *  field when there's no `sources[]` breakdown (manual entries, or pre-provenance data). */
function sourceTypesFor(tx: TxRow): string[] {
  const types = (tx.sources ?? []).map((s) => s.sourceType).filter(Boolean);
  return types.length > 0 ? [...new Set(types)] : [tx.source];
}

/** One tinted pill per distinct source type on a row (see {@link sourceTypesFor}). */
function SourceChips({
  tx,
  t,
  chipClassName,
}: {
  tx: TxRow;
  t: (key: `sources.${string}`) => string;
  chipClassName: string;
}) {
  return (
    <>
      {sourceTypesFor(tx).map((type) => (
        <span key={type} className={chipClassName} style={SRC_TONES[type] ?? SRC_TONES.manual}>
          {t(`sources.${type}`)}
        </span>
      ))}
    </>
  );
}

function TypeIconChip({ type, className }: { type: string; className?: string }) {
  const entry = TYPE_ICON[type];
  if (!entry) return null;
  const Icon = entry.icon;
  return (
    <span
      className={cn(
        "inline-flex size-9 shrink-0 items-center justify-center rounded-[10px]",
        TYPE_TONE_CLASSES[entry.tone],
        className,
      )}
      aria-hidden
    >
      <Icon className="size-[18px]" strokeWidth={2.2} />
    </span>
  );
}

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
  instrument: {
    symbol?: string | null;
    name?: string | null;
    /** Clean human-readable name from provider enrichment; prefer over `name` for display. */
    displayName?: string | null;
    /** Present at runtime (from listTransactions) — needed to prefill the edit form. */
    assetClass?: string | null;
    unit?: string | null;
  } | null;
  /** Fields carried at runtime (listTransactions) that the edit form prefills from. */
  instrumentId?: string | null;
  description?: string | null;
  tags?: string[] | null;
  kind?: string | null;
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
  /** Low-confidence parse — draft rows flagged for review get an extra marker. */
  needsReview?: boolean;
}

/** Compute the signed cash-flow (actual cash movement) for a TxRow via core, for DISPLAY.
 * A `draft` previews the cash it will move once confirmed (drafts already carry an amber row
 * + "Draft" badge) — real balances are derived in @portfolio/core, which excludes drafts, so
 * showing the face value here never affects a computed total. `cash_neutral` (reward-funded,
 * genuinely ~0 cash) and `archived` (voided → 0) keep their real net. */
export function txNetAmount(tx: TxRow): number {
  const status = tx.status === "draft" ? "normal" : tx.status;
  return cashFlow({
    instrumentId: null,
    type: tx.type as CoreTransaction["type"],
    quantity: tx.quantity,
    price: tx.price,
    fees: tx.fees,
    currency: tx.currency,
    executedAt: new Date(tx.executedAt),
    status,
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
  { key: "instrument", get: (r) => r.instrument?.symbol ?? r.type, type: "text" },
  { key: "portfolio", get: (r) => r.portfolioName ?? "", type: "text" },
  { key: "quantity", get: (r) => r.quantity, type: "numeric" },
  { key: "price", get: (r) => Number(r.price), type: "numeric" },
  { key: "netAmount", get: (r) => txNetAmount(r), type: "numeric" },
  { key: "source", get: (r) => r.source, type: "text" },
];

export function TransactionsTable({
  rows,
  showPortfolio = false,
  anomalies = [],
  portfolios = [],
  showFilterBanners = true,
}: {
  rows: TxRow[];
  showPortfolio?: boolean;
  /** Per-transaction anomalies keyed by transactionId; shows a flag icon on the row. */
  anomalies?: Anomaly[];
  /** All of the user's portfolios — enables the "Reassign…" action (hidden when fewer
   *  than two are available, since there's nowhere to move rows to). */
  portfolios?: PickablePortfolio[];
  /** The Activity screen's filter-scoped summary banners (All/Income/Buys/Sells + the
   *  reconciliation banner). Only the top-level `/transactions` list wants these; the
   *  Instrument-detail page embeds this same table for its own "Transactions" section,
   *  which the design shows as a plain list with no banners. */
  showFilterBanners?: boolean;
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
  // Batch-select is off by default: checkboxes stay hidden until a long-press (long-click
  // on desktop / touch-and-hold on mobile) enters selection mode. Exiting clears both.
  const [selectionMode, setSelectionMode] = useState(false);
  const clearSelection = () => {
    setSelected(new Set());
    setSelectionMode(false);
  };
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  // Reference filter chips: All / Buys / Sells / Income (+ "Needs review · N").
  const [chipFilter, setChipFilter] = useState<"all" | "buy" | "sell" | "income" | "issues">("all");
  const [yearFilter, setYearFilter] = useState("all");
  const [draftFilter, setDraftFilter] = useState<"all" | "drafts">("all");
  const [query, setQuery] = useState("");
  const [showFlagged, setShowFlagged] = useState(false);
  // How many of the (already filtered+sorted) rows to render — the ledger can grow long
  // for old/frequent portfolios, pushing "Recent imports" far below the fold. Capped with
  // an explicit "Load more" button rather than infinite-scroll: scroll-triggered loading
  // never bottoms out, which would make Recent imports permanently unreachable by scroll.
  const PAGE_SIZE = 25;
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [detailTx, setDetailTx] = useState<TxRow | null>(null);
  const [editTx, setEditTx] = useState<TxRow | null>(null);

  // When the last flagged transaction is dismissed (router.refresh re-feeds an empty
  // anomalies list), clear the filter so the user isn't stranded on an empty list.
  // Adjusting state during render is React's recommended pattern over a setState-in-effect.
  if (showFlagged && flaggedCount === 0) {
    setShowFlagged(false);
  }
  // Same reset for the "Needs review · N" chip: it only renders while flaggedCount > 0
  // (see below), so leaving chipFilter on "issues" after the last anomaly is dismissed
  // would strand the user on an empty table with no visible way back to "all".
  if (chipFilter === "issues" && flaggedCount === 0) {
    setChipFilter("all");
  }
  // Id of a single row currently being confirmed/discarded (shows a spinner on that row).
  const [resolvingId, setResolvingId] = useState<string | null>(null);

  const draftCount = useMemo(() => rows.filter((r) => r.status === "draft").length, [rows]);

  // When the last draft is confirmed/discarded (router.refresh re-feeds rows with no
  // drafts), clear the filter so the user isn't stranded on an empty list. Adjusting
  // state during render is React's recommended pattern over a setState-in-effect.
  if (draftFilter === "drafts" && draftCount === 0) {
    setDraftFilter("all");
  }

  // Keep the open detail sheet in sync with `rows`: it's opened from a snapshot (onRowActivate
  // below), so once router.refresh() re-feeds updated rows (e.g. after confirming/discarding
  // the very row the sheet is showing), re-point it at the fresh copy instead of freezing on
  // the pre-refresh draft. Closes the sheet if the row no longer appears at all (e.g. deleted
  // elsewhere). Adjusting state during render, same pattern as the filters above.
  if (detailTx) {
    const freshDetailTx = rows.find((r) => r.id === detailTx.id) ?? null;
    if (freshDetailTx !== detailTx) {
      setDetailTx(freshDetailTx);
    }
  }

  // Re-cap the visible window whenever the effective view changes, so a newly narrowed
  // filter/search/sort starts short instead of inheriting a stale "loaded 200" from the
  // previous view. Tracks the prior signature in state (not a ref) per React's documented
  // "adjusting state when a value changes during render" pattern.
  const viewSignature = `${chipFilter}|${yearFilter}|${draftFilter}|${query}|${showFlagged}|${sortKey}`;
  const [prevViewSignature, setPrevViewSignature] = useState(viewSignature);
  if (viewSignature !== prevViewSignature) {
    setPrevViewSignature(viewSignature);
    setVisibleCount(PAGE_SIZE);
  }

  // Derive distinct options from `rows` so selects only show values present in the data.
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
        (chipFilter === "all" ||
          (chipFilter === "buy" && (r.type === "buy" || r.type === "savings_plan")) ||
          (chipFilter === "sell" && r.type === "sell") ||
          (chipFilter === "income" && ACTIVITY_INCOME_TYPES.has(r.type)) ||
          (chipFilter === "issues" && anomalyByTxId.has(r.id))) &&
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
  }, [rows, showFlagged, anomalyByTxId, draftFilter, chipFilter, yearFilter, query, tt]);

  // Whether any picker/search is narrowing the view, so the empty state can distinguish
  // "no transactions at all" from "no transactions match the current filter" — covers the
  // chip filter too, not just search/showFlagged, so an "issues"/"buy"/etc. filter with no
  // matches doesn't show the misleading "no transactions yet" copy.
  const hasActiveFilter =
    query.trim().length > 0 ||
    showFlagged ||
    chipFilter !== "all" ||
    yearFilter !== "all" ||
    draftFilter !== "all";

  // Which filter-scoped summary banner (if any) to show above the list — keyed directly
  // off the reference-style chip filter (All/Buys/Sells/Income).
  const tBanner = useTranslations("Transactions.banners");
  const activeBannerMode: "all" | "income" | "buy" | "sell" | null =
    chipFilter === "issues" ? null : chipFilter;

  // Banners are computed from the full (unfiltered-by-other-pickers) `rows` — they answer
  // "how much have I invested/received, all time / YTD", not "how much is in the current
  // table view" — mirroring the source design, whose equivalent aggregates ignore the other
  // filters too.
  const allBanner = useMemo(
    () =>
      activeBannerMode === "all"
        ? computeAllBanner(rows, locale, {
            invested: tBanner("invested"),
            proceeds: tBanner("proceeds"),
            incomeYtd: tBanner("incomeYtd"),
            buysCount: (n) => tBanner("buysCount", { count: n }),
            sellsCount: (n) => tBanner("sellsCount", { count: n }),
            vsLastYear: (pct) => tBanner("vsLastYear", { pct }),
            buys: tBanner("buys"),
            sells: tBanner("sells"),
            income: tBanner("income"),
          })
        : null,
    [activeBannerMode, rows, locale, tBanner],
  );
  const incomeBanner = useMemo(
    () =>
      activeBannerMode === "income"
        ? computeIncomeBanner(rows, locale, {
            vsLastYear: (pct) => tBanner("vsLastYear", { pct }),
            new: tBanner("newIncome"),
            perMonth: (amount) => tBanner("perMonth", { amount }),
            dividends: tBanner("dividends"),
            couponsInterest: tBanner("couponsInterest"),
            other: tBanner("otherIncome"),
          })
        : null,
    [activeBannerMode, rows, locale, tBanner],
  );
  const tradeBanner = useMemo(
    () =>
      activeBannerMode === "buy" || activeBannerMode === "sell"
        ? computeTradeBanner(rows, activeBannerMode, locale)
        : null,
    [activeBannerMode, rows, locale],
  );

  // Cash/position reconciliation-gap anomalies are portfolio-scoped (no transactionId), so
  // they never drive the row-level "Show flagged" toggle above — surfaced here instead,
  // independent of any filter. There can be more than one (e.g. a position_gap per ISIN),
  // so every one is rendered — not just the first — or the top banner's count would include
  // anomalies nothing on the page ever shows.
  const portfolioAnomalies = useMemo(
    () =>
      anomalies.filter(
        (a) =>
          a.scope === "portfolio" &&
          (a.code === "reconciliation_gap" ||
            a.code === "reconciliation_drift" ||
            a.code === "position_gap"),
      ),
    [anomalies],
  );

  const m = (n: number, currency: string) => formatMoney(n, currency, locale);
  // Reference row date cell: short, day-first "5 Jun" (`d + " " + SHORT[mo]`), regardless
  // of locale ordering; month-band label: "June 2026". UTC throughout so the day never
  // drifts against the ISO date used for month grouping.
  const monthShort = useMemo(
    () => new Intl.DateTimeFormat(locale, { month: "short", timeZone: "UTC" }),
    [locale],
  );
  const rowDate = (iso: string) => {
    const d = new Date(iso);
    return `${d.getUTCDate()} ${monthShort.format(d)}`;
  };
  const monthFmt = useMemo(
    () => new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" }),
    [locale],
  );

  const allSelected = visibleRows.length > 0 && selected.size === visibleRows.length;

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
    // Deselecting the last row leaves selection mode (hides the checkboxes again).
    if (next.size === 0) setSelectionMode(false);
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(visibleRows.map((r) => r.id)));
  }

  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFired = useRef(false);
  const pressStart = useRef<{ x: number; y: number } | null>(null);
  const clearLongPress = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };
  const startLongPress = (id: string, e: React.PointerEvent) => {
    longPressFired.current = false;
    pressStart.current = { x: e.clientX, y: e.clientY };
    clearLongPress();
    longPressTimer.current = setTimeout(() => {
      longPressFired.current = true;
      setSelectionMode(true);
      setSelected((prev) => new Set(prev).add(id));
    }, 450);
  };
  // Cancel the hold only on real movement (a scroll), not the sub-pixel finger jitter that
  // touch browsers report while holding still — a bare "cancel on any move" never fires on
  // touch. 10px threshold distinguishes a hold from a scroll/drag.
  const onPressMove = (e: React.PointerEvent) => {
    const start = pressStart.current;
    if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) {
      clearLongPress();
    }
  };
  // Row tap: swallow the click that follows a long-press; in selection mode toggle the row;
  // otherwise open the detail sheet.
  const onRowActivate = (tx: TxRow) => {
    if (longPressFired.current) {
      longPressFired.current = false;
      return;
    }
    if (selectionMode) toggle(tx.id);
    else setDetailTx(tx);
  };
  const longPressHandlers = (id: string) => ({
    onPointerDown: (e: React.PointerEvent) => startLongPress(id, e),
    onPointerUp: clearLongPress,
    onPointerLeave: clearLongPress,
    onPointerMove: onPressMove,
  });

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
      clearSelection();
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
      clearSelection();
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

  // Reassignment: the rows queued for a move (a single row, or the current selection). The
  // dialog is open whenever this is non-null; reassignable only when ≥2 portfolios exist.
  const canReassign = portfolios.length > 1;
  const [reassignRows, setReassignRows] = useState<TxRow[] | null>(null);
  const tr = useTranslations("Transactions.reassign");

  // Merge: only offered for exactly two selected rows in the SAME portfolio (a cross-portfolio
  // merge doesn't correspond to any real economic event — each portfolio is its own boundary).
  // The dialog itself re-validates server-side (same instrument, compatible type, no loan legs)
  // via the preview endpoint and surfaces a blocked reason when those guardrails fail.
  const selectedRows = useMemo(() => rows.filter((r) => selected.has(r.id)), [rows, selected]);
  const canMerge =
    selectedRows.length === 2 && selectedRows[0].portfolioId === selectedRows[1].portfolioId;
  const [mergeRows, setMergeRows] = useState<[TxRow, TxRow] | null>(null);

  async function doReassign(targetPortfolioId: string) {
    const queued = reassignRows ?? [];
    // Group by source portfolio — the reassign endpoint is scoped to one source portfolio.
    const byPortfolio = new Map<string, string[]>();
    for (const r of queued) {
      if (r.portfolioId === targetPortfolioId) continue;
      const ids = byPortfolio.get(r.portfolioId) ?? [];
      ids.push(r.id);
      byPortfolio.set(r.portfolioId, ids);
    }
    let moved = 0;
    let skipped = 0;
    const results = await Promise.all(
      [...byPortfolio.entries()].map(([pid, ids]) =>
        api.reassignTransactions(pid, ids, targetPortfolioId),
      ),
    );
    for (const r of results) {
      moved += r.moved;
      skipped += r.skippedConflicts + r.skippedLoans;
    }
    if (moved === 0) toast.info(tr("none"));
    else if (skipped > 0) toast.success(tr("successWithSkips", { moved, skipped }));
    else toast.success(tr("success", { count: moved }));
    setReassignRows(null);
    clearSelection();
    router.refresh();
  }

  // checkbox + date + transaction + [portfolio] + quantity + price + source + amount.
  const colSpan = showPortfolio ? 8 : 7;

  const sortedRows = sort(visibleRows);
  // Cap how many of the (filtered+sorted) rows actually render — see PAGE_SIZE/visibleCount
  // above. Select-all and the empty-state check deliberately keep reading `visibleRows` (the
  // full filtered set), not this window, so "select all" still covers everything filtered,
  // not just what's currently rendered. Memoized (unlike `sortedRows`, a bare re-sort call)
  // so it has a stable identity for `dayGroups`' dependency array below.
  const windowedRows = useMemo(
    () => sortedRows.slice(0, visibleCount),
    [sortedRows, visibleCount],
  );
  const hasMore = sortedRows.length > windowedRows.length;
  // The reference groups the ledger into month bands. That only reads coherently while the
  // list is in date order (the default, or an explicit Date sort); any other sort renders flat.
  const groupByMonth = sortKey === null || sortKey === "date";

  // Mobile (reference): a card per DAY rather than a table. Same ordered source list.
  const dayFmt = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      }),
    [locale],
  );
  const dayGroups = useMemo(() => {
    const groups: { day: string; label: string; rows: TxRow[] }[] = [];
    for (const tx of windowedRows) {
      const day = tx.executedAt.slice(0, 10);
      const last = groups[groups.length - 1];
      if (last && last.day === day) last.rows.push(tx);
      else groups.push({ day, label: dayFmt.format(new Date(tx.executedAt)), rows: [tx] });
    }
    return groups;
  }, [windowedRows, dayFmt]);

  // Anomaly banner — only when anomalies exist (only passed in single-portfolio view).
  // Counts must match what the page can actually surface, or "N warnings" promises rows
  // that "Show flagged only" can never show. Two anomalies can share one transaction (worst
  // severity wins in anomalyByTxId), so count DISTINCT flaggable rows rather than raw
  // transaction-scoped anomalies; portfolio-scoped ones are counted separately since every
  // one of those now renders its own ReconciliationBanner below (see portfolioAnomalies).
  const flaggedRowsBySeverity = [...anomalyByTxId.values()];
  const anomalyErrorsCount =
    flaggedRowsBySeverity.filter((a) => a.severity === "error").length +
    portfolioAnomalies.filter((a) => a.severity === "error").length;
  const anomalyWarningsCount =
    flaggedRowsBySeverity.filter((a) => a.severity === "warning").length +
    portfolioAnomalies.filter((a) => a.severity === "warning").length;
  const anomalyBanner =
    anomalyErrorsCount > 0 || anomalyWarningsCount > 0 ? (
      <div
        role="alert"
        className={`flex items-center gap-3 rounded-lg border px-4 py-3 text-sm ${
          anomalyErrorsCount > 0
            ? "border-destructive/40 bg-destructive/5 text-destructive"
            : "border-amber-400/40 bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-400"
        }`}
      >
        {anomalyErrorsCount > 0 ? (
          <AlertCircle className="size-4 shrink-0" />
        ) : (
          <AlertTriangle className="size-4 shrink-0" />
        )}
        <span className="flex-1">
          {anomalyErrorsCount > 0 && anomalyWarningsCount > 0
            ? ta("bannerBoth", { errors: anomalyErrorsCount, warnings: anomalyWarningsCount })
            : anomalyErrorsCount > 0
              ? ta("bannerError", { count: anomalyErrorsCount })
              : ta("bannerWarning", { count: anomalyWarningsCount })}
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

      {/* Hero filter banner sits above the chips/search + table (chips below drive it). */}
      {showFilterBanners && allBanner && (
        <AllFilterBanner data={allBanner} cashFlowMixLabel={tBanner("cashFlowMix")} />
      )}
      {showFilterBanners && incomeBanner && (
        <IncomeFilterBanner
          data={incomeBanner}
          receivedLabel={tBanner("receivedYtd")}
          projectedLabel={tBanner("projected12mo")}
          bySourceLabel={tBanner("bySource")}
        />
      )}
      {showFilterBanners && tradeBanner && (activeBannerMode === "buy" || activeBannerMode === "sell") && (
        <TradeFilterBanner
          data={tradeBanner}
          totalLabel={tBanner(activeBannerMode === "buy" ? "investedAllTime" : "proceedsAllTime")}
          ordersNote={tBanner("ordersCount", { count: tradeBanner.count })}
          averageLabel={tBanner("averageOrder")}
          averageNote={tBanner(activeBannerMode === "buy" ? "capitalDeployed" : "capitalReturned")}
          headingLabel={tBanner(activeBannerMode === "buy" ? "mostBought" : "mostSold")}
        />
      )}
      {showFilterBanners &&
        portfolioAnomalies.map((a, i) => (
          <ReconciliationBanner
            key={`${a.code}:${a.meta?.currency ?? a.meta?.isin ?? i}`}
            title={ta("reconciliationTitle")}
            detail={anomalyLabel(a, ta as AnomalyTranslator, locale)}
            tag={ta("portfolioTag")}
          />
        ))}

      <div className="flex flex-col gap-2 text-sm sm:flex-row sm:items-center">
        {/* Chips scroll horizontally on mobile (no awkward multi-line wrap); wrap on desktop. */}
        <div className="flex items-center gap-2 overflow-x-auto pb-0.5 [scrollbar-width:none] sm:flex-wrap sm:overflow-visible sm:pb-0 [&::-webkit-scrollbar]:hidden">
        {/* Reference tChips: rounded-full pills, active = white on var(--pill),
            inactive = 600 on card bg with a border; "Needs review · N" is tinted. */}
        {(
          [
            ["all", t("filterAll")],
            ["buy", tBanner("chipBuys")],
            ["sell", tBanner("chipSells")],
            ["income", tBanner("chipIncome")],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setChipFilter(key)}
            aria-pressed={chipFilter === key}
            className={cn(
              "whitespace-nowrap rounded-full px-3.5 py-[7px] text-xs",
              chipFilter === key
                ? "bg-pill font-bold text-white"
                : "border border-border bg-card font-semibold text-foreground",
            )}
          >
            {label}
          </button>
        ))}
        {anomalyByTxId.size > 0 && (
          <button
            type="button"
            onClick={() => setChipFilter(chipFilter === "issues" ? "all" : "issues")}
            aria-pressed={chipFilter === "issues"}
            className={cn(
              "whitespace-nowrap rounded-full border px-3 py-[7px] text-xs font-bold",
              chipFilter === "issues"
                ? "border-[var(--gold-fg)] bg-[var(--gold-fg)] text-white"
                : "border-[rgba(224,165,58,.34)] bg-[rgba(224,165,58,.12)] text-[var(--gold-fg)]",
            )}
          >
            {tBanner("chipIssues", { count: anomalyByTxId.size })}
          </button>
        )}
        {yearOptions.length > 1 && (
          // Styled dropdown (Radix) rather than a native <select> so the popup matches the
          // app's menus and the chevron has proper right padding.
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={t("filterYear")}
                className="flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-border bg-card pl-3 pr-2.5 text-xs font-semibold text-foreground transition-colors hover:bg-muted/50 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                {yearFilter === "all" ? t("allYears") : yearFilter}
                <ChevronDown className="size-3.5 shrink-0 text-text-3" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[9rem]">
              {["all", ...yearOptions].map((y) => (
                <DropdownMenuItem
                  key={y}
                  onSelect={() => setYearFilter(y)}
                  className="justify-between gap-3"
                >
                  {y === "all" ? t("allYears") : y}
                  {yearFilter === y && <Check className="size-4 text-primary" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {draftCount > 0 && (
          <select
            aria-label={t("filterDraftLabel")}
            value={draftFilter}
            onChange={(e) => setDraftFilter(e.target.value as "all" | "drafts")}
            className="h-8 rounded-full border border-border bg-card px-2.5 text-xs font-semibold text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          >
            <option value="all">{t("draftShowAll")}</option>
            <option value="drafts">{t("draftOnly", { count: draftCount })}</option>
          </select>
        )}
        </div>
        <div className="relative flex items-center sm:ml-auto">
          <Search className="pointer-events-none absolute left-2 size-3.5 text-muted-foreground" />
          <Input
            type="text"
            placeholder={t("searchPlaceholder")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-8 w-full pl-7 pr-7 text-xs sm:w-44"
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

      {selectionMode && (
        <div className="flex min-h-12 items-center justify-between gap-3 rounded-lg border border-border bg-card/60 px-4 py-2 text-sm">
          <span className="flex items-center gap-2 text-muted-foreground">
            {/* Exit selection mode (clearing the set also hides the checkboxes again). */}
            <button
              type="button"
              onClick={clearSelection}
              aria-label={tb("cancel")}
              title={tb("cancel")}
              className="flex size-8 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground"
            >
              <X className="size-4" />
            </button>
            {selected.size > 0 ? tb("selected", { count: selected.size }) : tb("selectPrompt")}
          </span>
          {selected.size > 0 &&
            (confirming ? (
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
                {canReassign && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setReassignRows(rows.filter((r) => selected.has(r.id)))}
                    disabled={busy}
                  >
                    <FolderInput className="size-3.5" />
                    {tb("reassign")}
                  </Button>
                )}
                {canMerge && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setMergeRows([selectedRows[0], selectedRows[1]])}
                    disabled={busy}
                  >
                    <GitMerge className="size-3.5" />
                    {tb("merge")}
                  </Button>
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
            ))}
        </div>
      )}

      {reassignRows && (
        <ReassignDialog
          open
          onOpenChange={(o) => {
            if (!o) setReassignRows(null);
          }}
          portfolios={portfolios}
          excludePortfolioId={
            // When every queued row shares one source portfolio, hide it from the targets.
            new Set(reassignRows.map((r) => r.portfolioId)).size === 1
              ? reassignRows[0]?.portfolioId
              : undefined
          }
          onConfirm={doReassign}
        />
      )}

      {mergeRows && (
        <MergeDialog
          open
          onOpenChange={(o) => {
            if (!o) setMergeRows(null);
          }}
          rowA={mergeRows[0]}
          rowB={mergeRows[1]}
          onMerged={() => {
            setMergeRows(null);
            clearSelection();
            router.refresh();
          }}
        />
      )}

      {/* ── Desktop table (md+) ── */}
      <div className="hidden overflow-x-auto rounded-xl bg-card shadow-card md:block">
        <Table>
          <TableHeader>
            <TableRow>
              {/* Checkbox column: a select-rows toggle until selection mode is entered, then
                  the "select all" checkbox. Fixed wide enough that both the toggle button and
                  the checkbox fit without the column ever needing to grow (table-layout:auto
                  otherwise resizes it per the widest content-box actually rendered, which
                  visibly shifted every column after it when swapping between the two). */}
              <TableHead className="w-16">
                {selectionMode ? (
                  <input
                    type="checkbox"
                    className="size-4 align-middle accent-primary"
                    aria-label={tb("selectAll")}
                    checked={allSelected}
                    onChange={toggleAll}
                  />
                ) : (
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-6"
                    title={tb("selectRows")}
                    aria-label={tb("selectRows")}
                    onClick={() => setSelectionMode(true)}
                  >
                    <ListChecks className="size-4" />
                  </Button>
                )}
              </TableHead>
              <SortableTableHead colKey="date" sortKey={sortKey} sortDir={sortDir} onToggle={toggleSort}>{t("date")}</SortableTableHead>
              <SortableTableHead colKey="instrument" sortKey={sortKey} sortDir={sortDir} onToggle={toggleSort}>{t("transactionCol")}</SortableTableHead>
              {showPortfolio && <SortableTableHead colKey="portfolio" sortKey={sortKey} sortDir={sortDir} onToggle={toggleSort}>{t("portfolio")}</SortableTableHead>}
              <SortableTableHead colKey="quantity" sortKey={sortKey} sortDir={sortDir} onToggle={toggleSort} align="right">{t("quantity")}</SortableTableHead>
              <SortableTableHead colKey="price" sortKey={sortKey} sortDir={sortDir} onToggle={toggleSort} align="right">{t("price")}</SortableTableHead>
              <SortableTableHead colKey="source" sortKey={sortKey} sortDir={sortDir} onToggle={toggleSort} className="hidden sm:table-cell">{t("source")}</SortableTableHead>
              <SortableTableHead colKey="netAmount" sortKey={sortKey} sortDir={sortDir} onToggle={toggleSort} align="right">{t("amount")}</SortableTableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {windowedRows.map((tx, i) => {
              const netAmount = txNetAmount(tx);
              const isSelected = selected.has(tx.id);
              const anomaly = anomalyByTxId.get(tx.id);
              const status = tx.status ?? "normal";
              // Emit a month-separator band whenever the month changes (reference `txMonths`).
              // The band uses role="presentation" so it stays out of row counts/queries.
              const monthKey = tx.executedAt.slice(0, 7);
              const showBand =
                groupByMonth && (i === 0 || windowedRows[i - 1].executedAt.slice(0, 7) !== monthKey);
              return (
                <Fragment key={tx.id}>
                  {showBand && (
                    <tr role="presentation">
                      <td
                        colSpan={colSpan}
                        className="bg-card-2 px-[22px] py-[9px] text-[11px] font-bold uppercase tracking-[0.05em] text-text-3"
                      >
                        {monthFmt.format(new Date(tx.executedAt))}
                      </td>
                    </tr>
                  )}
                <TableRow
                  data-state={isSelected ? "selected" : undefined}
                  className={`cursor-pointer select-none ${status === "archived" ? "opacity-50" : ""} ${
                    status === "draft" ? "bg-amber-50/40 dark:bg-amber-950/10" : ""
                  }`}
                  onClick={() => onRowActivate(tx)}
                  {...longPressHandlers(tx.id)}
                >
                  <TableCell className="w-16">
                    {selectionMode && (
                      <span onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          className="size-4 align-middle accent-primary"
                          aria-label={tb("selectRow")}
                          checked={isSelected}
                          onChange={() => toggle(tx.id)}
                        />
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="tabular whitespace-nowrap text-xs font-semibold text-text-2">
                    {rowDate(tx.executedAt)}
                  </TableCell>
                  {/* Reference "Transaction" column: 36px kind chip + "Buy · SYM"
                      700 14px title + instrument name 500 12px text-2; status badges
                      and anomaly tags ride inline next to the title. */}
                  <TableCell>
                    <div className="flex min-w-0 items-center gap-3">
                      <TypeIconChip type={tx.type} />
                      <div className="min-w-0">
                        <div className="flex min-w-0 items-center gap-[7px]">
                          <span className="truncate text-sm font-bold">
                            {tt(tx.type)}
                            {tx.instrument?.symbol ? ` · ${tx.instrument.symbol}` : ""}
                          </span>
                          {anomaly && (
                            <span
                              title={anomalyLabel(anomaly, ta as AnomalyTranslator, locale)}
                              aria-label={anomalyLabel(anomaly, ta as AnomalyTranslator, locale)}
                            >
                              {anomaly.severity === "error" ? (
                                <AlertCircle className="size-3.5 shrink-0 text-destructive" />
                              ) : (
                                <AlertTriangle className="size-3.5 shrink-0 text-amber-500" />
                              )}
                            </span>
                          )}
                          {status === "draft" && (
                            <Badge
                              variant="outline"
                              className="border-amber-400/50 text-amber-600 dark:text-amber-400"
                            >
                              {tm("status.badgeDraft")}
                            </Badge>
                          )}
                          {status === "draft" && tx.needsReview && (
                            <span
                              className="inline-flex items-center"
                              title={tm("status.needsReview")}
                              aria-label={tm("status.needsReview")}
                            >
                              <AlertTriangle className="size-3.5 text-amber-500" />
                            </span>
                          )}
                          {status === "archived" && (
                            <Badge variant="outline">{tm("status.badgeArchived")}</Badge>
                          )}
                          {status === "cash_neutral" && (
                            <Badge variant="outline">{tm("status.badgeCashNeutral")}</Badge>
                          )}
                        </div>
                        <div className="truncate text-xs font-medium text-text-2">
                          {tx.instrument?.displayName ?? tx.instrument?.name ?? t("cashLabel")}
                        </div>
                      </div>
                    </div>
                  </TableCell>
                  {showPortfolio && (
                    <TableCell className="text-xs font-medium text-text-2">
                      {tx.portfolioName ?? "—"}
                    </TableCell>
                  )}
                  <TableCell className="tabular text-right text-[13px] font-semibold text-text-2">{Number(tx.quantity) || "—"}</TableCell>
                  <TableCell className="tabular text-right text-[13px] font-semibold">
                    {Number(tx.quantity) > 0 ? m(Number(tx.price), tx.currency) : "—"}
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    <div className="flex flex-wrap items-center gap-1">
                      <SourceChips
                        tx={tx}
                        t={t}
                        chipClassName="inline-flex items-center whitespace-nowrap rounded-[7px] px-2 py-[3px] text-[9px] font-bold uppercase"
                      />
                    </div>
                  </TableCell>
                  <TableCell
                    className={`tabular text-right text-sm font-bold ${netAmount > 0 ? "text-success" : ""}`}
                  >
                    {m(netAmount, tx.currency)}
                  </TableCell>
                </TableRow>
                </Fragment>
              );
            })}
            {visibleRows.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={colSpan}
                  className="py-8 text-center text-sm text-muted-foreground"
                >
                  {hasActiveFilter ? t("noResults") : t("empty")}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* ── Mobile list (< md): a card per day, reference "Activity" ledger. No date
          column (the day is the group header), no qty/price/portfolio columns. ── */}
      <div className="space-y-4 md:hidden">
        {dayGroups.map((group) => (
          <div key={group.day}>
            <div className="mb-2 ml-1 text-[12px] font-bold uppercase tracking-[0.04em] text-text-3">
              {group.label}
            </div>
            <div className="overflow-hidden rounded-[20px] bg-card shadow-card">
              {group.rows.map((tx, i) => {
                const netAmount = txNetAmount(tx);
                const isSelected = selected.has(tx.id);
                const anomaly = anomalyByTxId.get(tx.id);
                const status = tx.status ?? "normal";
                const sub =
                  Number(tx.quantity) > 0
                    ? `${Number(tx.quantity)} @ ${m(Number(tx.price), tx.currency)}`
                    : (tx.instrument?.displayName ?? tx.instrument?.name ?? t("cashLabel"));
                return (
                  <div
                    key={tx.id}
                    data-state={isSelected ? "selected" : undefined}
                    onClick={() => onRowActivate(tx)}
                    {...longPressHandlers(tx.id)}
                    className={cn(
                      "flex cursor-pointer select-none items-center gap-3 px-[15px] py-[14px]",
                      i > 0 && "border-t border-line",
                      status === "archived" && "opacity-50",
                      status === "draft" && "bg-amber-50/40 dark:bg-amber-950/10",
                      isSelected && "bg-primary/10",
                    )}
                  >
                    {selectionMode && (
                      <input
                        type="checkbox"
                        readOnly
                        aria-label={tb("selectRow")}
                        checked={isSelected}
                        className="size-4 shrink-0 accent-primary"
                      />
                    )}
                    <TypeIconChip type={tx.type} className="size-10 rounded-[12px]" />
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-[7px]">
                        <span className="truncate text-sm font-bold">
                          {tt(tx.type)}
                          {tx.instrument?.symbol ? ` · ${tx.instrument.symbol}` : ""}
                        </span>
                        {anomaly && (
                          <span
                            title={anomalyLabel(anomaly, ta as AnomalyTranslator, locale)}
                            aria-label={anomalyLabel(anomaly, ta as AnomalyTranslator, locale)}
                          >
                            {anomaly.severity === "error" ? (
                              <AlertCircle className="size-3.5 shrink-0 text-destructive" />
                            ) : (
                              <AlertTriangle className="size-3.5 shrink-0 text-amber-500" />
                            )}
                          </span>
                        )}
                      </div>
                      <div className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-text-2">
                        <span className="truncate">{sub}</span>
                        <span className="flex shrink-0 flex-wrap items-center gap-1">
                          <SourceChips
                            tx={tx}
                            t={t}
                            chipClassName="inline-flex shrink-0 items-center whitespace-nowrap rounded-[6px] px-1.5 py-[2px] text-[9px] font-bold uppercase"
                          />
                        </span>
                      </div>
                    </div>
                    <div
                      className={cn(
                        "tabular shrink-0 text-sm font-bold",
                        netAmount > 0 && "text-success",
                      )}
                    >
                      {m(netAmount, tx.currency)}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
        {visibleRows.length === 0 && (
          <div className="rounded-[20px] bg-card px-4 py-8 text-center text-sm text-muted-foreground shadow-card">
            {hasActiveFilter ? t("noResults") : t("empty")}
          </div>
        )}
      </div>

      {/* Explicit "Load more" rather than scroll-triggered/infinite loading — an
          intersection-observer approach never bottoms out, which would make "Recent
          imports" (rendered below this table) permanently unreachable by scrolling. */}
      {visibleRows.length > 0 && hasMore && (
        <div className="flex flex-col items-center gap-2 py-2">
          <Button variant="outline" size="sm" onClick={() => setVisibleCount((n) => n + PAGE_SIZE)}>
            {tb("loadMore")}
          </Button>
          <span className="text-xs text-muted-foreground">
            {tb("showingCount", { shown: windowedRows.length, total: sortedRows.length })}
          </span>
        </div>
      )}

      <TransactionDetailSheet
        tx={detailTx}
        anomaly={detailTx ? anomalyByTxId.get(detailTx.id) ?? null : null}
        open={!!detailTx}
        onOpenChange={(o) => { if (!o) setDetailTx(null); }}
        onDeleted={() => { setDetailTx(null); router.refresh(); }}
        portfolios={portfolios}
        onEdit={(tx) => { setDetailTx(null); setEditTx(tx); }}
        onReassign={(tx) => { setDetailTx(null); setReassignRows([tx]); }}
        onResolve={(tx, action) => onResolveOne(tx, action)}
        resolving={resolvingId === detailTx?.id}
      />

      <EditTransactionSheet
        tx={editTx}
        open={!!editTx}
        onOpenChange={(o) => { if (!o) setEditTx(null); }}
      />
    </div>
  );
}
