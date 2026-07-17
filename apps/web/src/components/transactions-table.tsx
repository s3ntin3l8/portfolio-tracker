"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { useSearchParams } from "next/navigation";
import { useApiClient } from "@/lib/api";
import { Spinner } from "@/components/ui/spinner";
import { formatMoneyCompact, bannerAnomalies } from "@/lib/utils";
import { useTableSort } from "@/lib/table-sort";
import { useLongPressSelect } from "@/lib/use-long-press-select";
import {
  computeAllBanner,
  computeIncomeBanner,
  computeTradeBanner,
} from "@/lib/transaction-banners";
import { toast } from "sonner";
import { TransactionDetailSheet } from "@/components/transaction-detail-sheet";
import { EditTransactionSheet } from "@/components/edit-transaction-sheet";
import {
  AllFilterBanner,
  IncomeFilterBanner,
  TradeFilterBanner,
  ReconciliationBanner,
} from "@/components/transactions/activity-banners";
import type { Anomaly } from "@portfolio/api-client";
import type { PickablePortfolio } from "@/components/portfolio-picker";

import type { TxRow } from "./transactions-table/types";
import { TX_COLS } from "./transactions-table/utils";
import { AnomalyBanner } from "./transactions-table/banners";
import { FilterBar } from "./transactions-table/filter-bar";
import { SelectionBar } from "./transactions-table/selection-bar";
import { ReassignMergeDialogs } from "./transactions-table/reassign-merge";
import { DesktopTable } from "./transactions-table/desktop";
import { MobileView } from "./transactions-table/mobile";
import { LoadMoreSection } from "./transactions-table/load-more";
import { anomalyLabel, type AnomalyTranslator } from "@/lib/utils";

export type { TxRow } from "./transactions-table/types";
export { SOURCE_ICON } from "./transactions-table/types";
export {
  txAmount,
  txNetAmount,
  txAmountDisplay,
  txNetAmountDisplay,
} from "./transactions-table/utils";

const PAGE_SIZE = 25;

export function TransactionsTable({
  rows,
  showPortfolio = false,
  anomalies = [],
  portfolios = [],
  showFilterBanners = true,
  scopeCurrency = "IDR",
  summary = null,
  years = [],
  typeFilter,
  yearFilter: yearFilterProp,
  searchQuery,
  portfolioId,
  total,
}: {
  rows: TxRow[];
  showPortfolio?: boolean;
  anomalies?: Anomaly[];
  portfolios?: PickablePortfolio[];
  showFilterBanners?: boolean;
  scopeCurrency?: string;
  summary?: {
    totalInvested: string | null;
    totalProceeds: string | null;
    totalIncome: string | null;
  } | null;
  years?: string[];
  typeFilter?: string;
  yearFilter?: string;
  searchQuery?: string;
  portfolioId?: string;
  total?: number;
}) {
  const ta = useTranslations("Anomalies");
  const locale = useLocale();
  const api = useApiClient();
  const router = useRouter();
  const searchParams = useSearchParams();

  const { sortKey, sortDir, toggle: toggleSort, sort } = useTableSort<TxRow>(TX_COLS);

  // Build a lookup: transactionId → worst-severity anomaly for that row.
  const anomalyByTxId = useMemo(() => {
    const m = new Map<string, Anomaly>();
    for (const a of anomalies) {
      if (!a.transactionId) continue;
      const existing = m.get(a.transactionId);
      if (!existing || (existing.severity === "warning" && a.severity === "error")) {
        m.set(a.transactionId, a);
      }
    }
    return m;
  }, [anomalies]);

  const flaggedCount = anomalyByTxId.size;

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draftFilter, setDraftFilter] = useState<"all" | "drafts">("all");
  const [showFlagged, setShowFlagged] = useState(false);

  // "Show flagged only" / "Needs review" (#562): the count comes from a whole-scope
  // anomalies fetch (unpaginated, unfiltered), so a flagged transaction can sit well past
  // whatever page is currently loaded into `accumulatedRows`. Rather than filtering only
  // what's already loaded, fetch exactly the flagged transactions by id — the ids are
  // already known from `anomalyByTxId` — so the toggle surfaces every flagged row
  // regardless of pagination/type/year/search scope.
  const flaggedIds = useMemo(() => [...anomalyByTxId.keys()], [anomalyByTxId]);
  const flaggedIdsKey = flaggedIds.join(",");
  const [flaggedRows, setFlaggedRows] = useState<TxRow[] | null>(null);
  const [flaggedLoading, setFlaggedLoading] = useState(false);
  const [loadedFlaggedKey, setLoadedFlaggedKey] = useState<string | null>(null);

  useEffect(() => {
    if (!showFlagged || flaggedIds.length === 0 || loadedFlaggedKey === flaggedIdsKey) return;
    let cancelled = false;
    (async () => {
      setFlaggedLoading(true);
      try {
        const fetched = portfolioId
          ? await api.listTransactionsByIds(portfolioId, flaggedIds)
          : await api.listNetworthTransactionsByIds(flaggedIds);
        if (cancelled) return;
        setFlaggedRows(fetched);
        setLoadedFlaggedKey(flaggedIdsKey);
      } finally {
        if (!cancelled) setFlaggedLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [showFlagged, flaggedIds, flaggedIdsKey, loadedFlaggedKey, portfolioId, api]);

  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [detailTx, setDetailTx] = useState<TxRow | null>(null);
  const [editTx, setEditTx] = useState<TxRow | null>(null);

  // Server-side "Load more": accumulate pages from the API as the user clicks "Load more".
  const [accumulatedRows, setAccumulatedRows] = useState<TxRow[]>(rows);
  const [currentPage, setCurrentPage] = useState(1);
  const [loadingMore, setLoadingMore] = useState(false);
  const [prevRows, setPrevRows] = useState(rows);
  if (prevRows !== rows) {
    setPrevRows(rows);
    setAccumulatedRows(rows);
    setCurrentPage(1);
  }

  const [resolvingId, setResolvingId] = useState<string | null>(null);

  const [reassignRows, setReassignRows] = useState<TxRow[] | null>(null);
  const [mergeRows, setMergeRows] = useState<[TxRow, TxRow] | null>(null);

  const tr = useTranslations("Transactions.reassign");

  const clearSelection = () => {
    setSelected(new Set());
    setSelectionMode(false);
  };

  // Long-press selection using the shared hook.
  const { selectionMode, setSelectionMode, longPressHandlers, consumeLongPress } =
    useLongPressSelect((id) => {
      setSelected((prev) => new Set(prev).add(id));
    });

  const draftCount = useMemo(() => rows.filter((r) => r.status === "draft").length, [rows]);

  if (showFlagged && flaggedCount === 0) {
    setShowFlagged(false);
  }

  if (draftFilter === "drafts" && draftCount === 0) {
    setDraftFilter("all");
  }

  if (detailTx) {
    const freshDetailTx = accumulatedRows.find((r) => r.id === detailTx.id) ?? null;
    if (freshDetailTx !== detailTx) {
      setDetailTx(freshDetailTx);
    }
  }

  const viewSignature = `${draftFilter}|${showFlagged}|${sortKey}`;
  const [prevViewSignature, setPrevViewSignature] = useState(viewSignature);
  if (viewSignature !== prevViewSignature) {
    setPrevViewSignature(viewSignature);
    setVisibleCount(PAGE_SIZE);
  }

  const yearOptions = useMemo(
    () =>
      years.length > 0
        ? years
        : [...new Set(rows.map((r) => String(new Date(r.executedAt).getFullYear())))].sort(
            (a, b) => Number(b) - Number(a),
          ),
    [years, rows],
  );

  const visibleRows = useMemo(() => {
    const source = showFlagged ? (flaggedRows ?? []) : accumulatedRows;
    return source.filter(
      (r) =>
        (!showFlagged || anomalyByTxId.has(r.id)) &&
        (draftFilter === "all" || r.status === "draft"),
    );
  }, [accumulatedRows, showFlagged, anomalyByTxId, draftFilter, flaggedRows]);

  const hasActiveFilter =
    (searchQuery != null && searchQuery.length > 0) ||
    showFlagged ||
    typeFilter != null ||
    yearFilterProp != null ||
    draftFilter !== "all";

  const tBanner = useTranslations("Transactions.banners");
  const activeBannerMode: "all" | "income" | "buy" | "sell" | null =
    typeFilter == null ? "all" : (typeFilter as "all" | "income" | "buy" | "sell");

  const allBanner = useMemo(() => {
    if (activeBannerMode !== "all") return null;
    if (summary) {
      return {
        currency: scopeCurrency,
        tiles: [
          {
            label: tBanner("invested"),
            value: summary.totalInvested
              ? formatMoneyCompact(Number(summary.totalInvested), scopeCurrency, locale)
              : "—",
            sub: "",
            tone: "neutral" as const,
          },
          {
            label: tBanner("proceeds"),
            value: summary.totalProceeds
              ? formatMoneyCompact(Number(summary.totalProceeds), scopeCurrency, locale)
              : "—",
            sub: "",
            tone: "neutral" as const,
          },
          {
            label: tBanner("incomeYtd"),
            value: summary.totalIncome
              ? formatMoneyCompact(Number(summary.totalIncome), scopeCurrency, locale)
              : "—",
            sub: "",
            tone: "neutral" as const,
          },
        ],
        mix: [],
      };
    }
    return computeAllBanner(rows, scopeCurrency, locale, {
      invested: tBanner("invested"),
      proceeds: tBanner("proceeds"),
      incomeYtd: tBanner("incomeYtd"),
      buysCount: (n) => tBanner("buysCount", { count: n }),
      sellsCount: (n) => tBanner("sellsCount", { count: n }),
      vsLastYear: (pct) => tBanner("vsLastYear", { pct }),
      buys: tBanner("buys"),
      sells: tBanner("sells"),
      income: tBanner("income"),
    });
  }, [activeBannerMode, summary, rows, scopeCurrency, locale, tBanner]);
  const incomeBanner = useMemo(() => {
    if (activeBannerMode !== "income") return null;
    return computeIncomeBanner(rows, scopeCurrency, locale, {
      vsLastYear: (pct) => tBanner("vsLastYear", { pct }),
      new: tBanner("newIncome"),
      perMonth: (amount) => tBanner("perMonth", { amount }),
      dividends: tBanner("dividends"),
      couponsInterest: tBanner("couponsInterest"),
      other: tBanner("otherIncome"),
    });
  }, [activeBannerMode, rows, scopeCurrency, locale, tBanner]);
  const tradeBanner = useMemo(() => {
    if (activeBannerMode !== "buy" && activeBannerMode !== "sell") return null;
    if (summary) {
      const total = activeBannerMode === "buy" ? summary.totalInvested : summary.totalProceeds;
      if (!total) return null;
      const money = (n: number) => formatMoneyCompact(n, scopeCurrency, locale);
      return {
        currency: scopeCurrency,
        total: money(Number(total)),
        count: rows.filter((r) => r.type === activeBannerMode).length,
        avg: "—",
        bySymbol: [],
      };
    }
    return computeTradeBanner(rows, activeBannerMode, scopeCurrency, locale);
  }, [activeBannerMode, summary, rows, scopeCurrency, locale]);

  const navigateWithParam = useCallback(
    (key: string, value: string | undefined) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value) {
        params.set(key, value);
      } else {
        params.delete(key);
      }
      params.set("page", "1");
      router.push(`/transactions?${params.toString()}`);
    },
    [router, searchParams],
  );

  const portfolioAnomalies = useMemo(() => bannerAnomalies(anomalies), [anomalies]);

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
    if (next.size === 0) setSelectionMode(false);
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(visibleRows.map((r) => r.id)));
  }

  const onRowActivate = (tx: TxRow) => {
    if (consumeLongPress()) return;
    if (selectionMode) toggle(tx.id);
    else setDetailTx(tx);
  };

  async function onBatchDelete() {
    setBusy(true);
    try {
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

  const selectedDraftIds = useMemo(
    () => rows.filter((r) => selected.has(r.id) && r.status === "draft").map((r) => r.id),
    [rows, selected],
  );

  async function onBatchResolve(action: "confirm" | "discard") {
    setBusy(true);
    try {
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

  const canReassign = portfolios.length > 1;
  const selectedRows = useMemo(() => rows.filter((r) => selected.has(r.id)), [rows, selected]);
  const canMerge =
    selectedRows.length === 2 && selectedRows[0].portfolioId === selectedRows[1].portfolioId;

  async function doReassign(targetPortfolioId: string) {
    const queued = reassignRows ?? [];
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

  const colSpan = showPortfolio ? 9 : 8;

  const sortedRows = sort(visibleRows);
  const windowedRows = useMemo(() => sortedRows.slice(0, visibleCount), [sortedRows, visibleCount]);
  // In flagged mode every matching row is already fetched (see the effect above), so
  // "more" only ever means revealing more of that already-loaded set — never a further
  // server page (`total` here is the whole-scope pagination total, unrelated to the
  // flagged count, so it must not drive the flagged view's "Load more").
  const hasMore = showFlagged
    ? sortedRows.length > windowedRows.length
    : sortedRows.length > windowedRows.length || accumulatedRows.length < (total ?? 0);
  const groupByMonth = sortKey === null || sortKey === "date";

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

  const handleLoadMore = useCallback(async () => {
    if (visibleCount < sortedRows.length) {
      setVisibleCount((n) => n + PAGE_SIZE);
      return;
    }
    // Flagged mode has no further server page to fetch — every flagged row is already in
    // `flaggedRows` (see the fetch effect above); `hasMore` already reflects this, but
    // guard here too since this callback is also reachable directly.
    if (showFlagged) return;
    if (accumulatedRows.length < (total ?? 0)) {
      setLoadingMore(true);
      try {
        const params = new URLSearchParams({
          page: String(currentPage + 1),
          pageSize: "25",
        });
        if (typeFilter) params.set("type", typeFilter);
        if (yearFilterProp) params.set("year", yearFilterProp);
        if (searchQuery) params.set("q", searchQuery);
        const basePath = portfolioId
          ? `/api/backend/portfolios/${portfolioId}/transactions`
          : "/api/backend/networth/transactions";
        const res = await fetch(`${basePath}?${params}`);
        const data = await res.json();
        setAccumulatedRows((prev) => [...prev, ...data.rows]);
        setCurrentPage((p) => p + 1);
        setVisibleCount((n) => n + data.rows.length);
      } finally {
        setLoadingMore(false);
      }
    }
  }, [
    visibleCount,
    sortedRows.length,
    accumulatedRows.length,
    total,
    currentPage,
    typeFilter,
    yearFilterProp,
    searchQuery,
    portfolioId,
    showFlagged,
  ]);

  const showEmpty = visibleRows.length === 0;

  return (
    <div className="space-y-3">
      <AnomalyBanner
        anomalies={anomalies}
        flaggedCount={flaggedCount}
        showFlagged={showFlagged}
        onToggleFlagged={() => setShowFlagged((v) => !v)}
      />

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
      {showFilterBanners &&
        tradeBanner &&
        (activeBannerMode === "buy" || activeBannerMode === "sell") && (
          <TradeFilterBanner
            data={tradeBanner}
            totalLabel={tBanner(activeBannerMode === "buy" ? "investedAllTime" : "proceedsAllTime")}
            ordersNote={tBanner("ordersCount", { count: tradeBanner.count })}
            averageLabel={tBanner("averageOrder")}
            averageNote={tBanner(
              activeBannerMode === "buy" ? "capitalDeployed" : "capitalReturned",
            )}
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

      <FilterBar
        typeFilter={typeFilter}
        showFlagged={showFlagged}
        flaggedCount={flaggedCount}
        onToggleFlagged={() => setShowFlagged((v) => !v)}
        yearOptions={yearOptions}
        yearFilterProp={yearFilterProp}
        onNavigateWithParam={navigateWithParam}
        draftCount={draftCount}
        draftFilter={draftFilter}
        onDraftFilterChange={(v) => setDraftFilter(v)}
        searchQuery={searchQuery}
        onSearchChange={(v) => {
          const params = new URLSearchParams(searchParams.toString());
          if (v) {
            params.set("q", v);
          } else {
            params.delete("q");
          }
          params.set("page", "1");
          router.push(`/transactions?${params.toString()}`);
        }}
      />

      <SelectionBar
        selectionMode={selectionMode}
        selectedCount={selected.size}
        selectedDraftCount={selectedDraftIds.length}
        canReassign={canReassign}
        canMerge={canMerge}
        busy={busy}
        confirming={confirming}
        onClearSelection={clearSelection}
        onBatchConfirmDrafts={() => onBatchResolve("confirm")}
        onBatchDiscardDrafts={() => onBatchResolve("discard")}
        onReassign={() => setReassignRows(rows.filter((r) => selected.has(r.id)))}
        onMerge={() => setMergeRows([selectedRows[0], selectedRows[1]])}
        onRequestDelete={() => setConfirming(true)}
        onConfirmDelete={onBatchDelete}
        onCancelDelete={() => setConfirming(false)}
      />

      <ReassignMergeDialogs
        reassignRows={reassignRows}
        onCloseReassign={() => setReassignRows(null)}
        portfolios={portfolios}
        onConfirmReassign={doReassign}
        mergeRows={mergeRows}
        onCloseMerge={() => setMergeRows(null)}
        onMerged={() => {
          setMergeRows(null);
          clearSelection();
          router.refresh();
        }}
      />

      {showFlagged && flaggedLoading ? (
        <div className="flex justify-center py-10">
          <Spinner size="md" />
        </div>
      ) : (
        <>
          <DesktopTable
            rows={windowedRows}
            selectionMode={selectionMode}
            selected={selected}
            anomalyByTxId={anomalyByTxId}
            sortKey={sortKey}
            sortDir={sortDir}
            onToggleSort={toggleSort}
            showPortfolio={showPortfolio}
            groupByMonth={groupByMonth}
            colSpan={colSpan}
            monthFmt={monthFmt}
            longPressHandlers={longPressHandlers}
            onRowActivate={onRowActivate}
            onToggle={toggle}
            onToggleAll={toggleAll}
            allSelected={allSelected}
            onEnterSelectionMode={() => setSelectionMode(true)}
            hasActiveFilter={hasActiveFilter}
            showEmpty={showEmpty}
          />

          <MobileView
            dayGroups={dayGroups}
            selectionMode={selectionMode}
            selected={selected}
            anomalyByTxId={anomalyByTxId}
            longPressHandlers={longPressHandlers}
            onRowActivate={onRowActivate}
            hasActiveFilter={hasActiveFilter}
            showEmpty={showEmpty}
          />
        </>
      )}

      <LoadMoreSection
        hasVisibleRows={visibleRows.length > 0}
        hasMore={hasMore}
        loadingMore={loadingMore}
        windowedCount={windowedRows.length}
        sortedTotal={sortedRows.length}
        total={total}
        onLoadMore={handleLoadMore}
      />

      <TransactionDetailSheet
        tx={detailTx}
        anomaly={detailTx ? (anomalyByTxId.get(detailTx.id) ?? null) : null}
        open={!!detailTx}
        onOpenChange={(o) => {
          if (!o) setDetailTx(null);
        }}
        onDeleted={() => {
          setDetailTx(null);
          router.refresh();
        }}
        portfolios={portfolios}
        scopeCurrency={scopeCurrency}
        onEdit={(tx) => {
          setDetailTx(null);
          setEditTx(tx);
        }}
        onReassign={(tx) => {
          setDetailTx(null);
          setReassignRows([tx]);
        }}
        onResolve={(tx, action) => onResolveOne(tx, action)}
        resolving={resolvingId === detailTx?.id}
      />

      <EditTransactionSheet
        tx={editTx}
        open={!!editTx}
        onOpenChange={(o) => {
          if (!o) setEditTx(null);
        }}
      />
    </div>
  );
}
