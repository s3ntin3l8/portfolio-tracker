"use client";

import { useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { useSearchParams } from "next/navigation";
import { useApiClient } from "@/lib/api";
import { bannerAnomalies, anomalyLabel, type AnomalyTranslator } from "@/lib/utils";
import { useTableSort } from "@/lib/table-sort";
import { useLongPressSelect } from "@/lib/use-long-press-select";
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
import {
  useAnomalyMap,
  useTransactionUrlNav,
  useTransactionBanners,
  useTransactionPagination,
  useTransactionViewState,
} from "./transactions-table/hooks";
import { groupByDay } from "./transactions-table/grouping";

export type { TxRow } from "./transactions-table/types";
export { SOURCE_ICON } from "./transactions-table/types";
export {
  txAmount,
  txNetAmount,
  txAmountDisplay,
  txNetAmountDisplay,
} from "./transactions-table/utils";

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

  const anomalyByTxId = useAnomalyMap(anomalies);
  const navigateWithParam = useTransactionUrlNav();

  const { accumulatedRows, loadingMore, handleLoadMore, visibleCount, setVisibleCount } =
    useTransactionPagination(rows, total, typeFilter, yearFilterProp, searchQuery, portfolioId);

  const [selected, setSelected] = useState<Set<string>>(new Set());

  const { selectionMode, setSelectionMode, longPressHandlers, consumeLongPress } =
    useLongPressSelect((id) => {
      setSelected((prev) => new Set(prev).add(id));
    });

  const {
    draftFilter,
    setDraftFilter,
    showFlagged,
    setShowFlagged,
    detailTx,
    setDetailTx,
    clearSelection,
    flaggedCount,
    draftCount,
  } = useTransactionViewState(
    rows,
    anomalyByTxId,
    accumulatedRows,
    sortKey,
    setSelectionMode,
    setVisibleCount,
    setSelected,
  );

  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editTx, setEditTx] = useState<TxRow | null>(null);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [reassignRows, setReassignRows] = useState<TxRow[] | null>(null);
  const [mergeRows, setMergeRows] = useState<[TxRow, TxRow] | null>(null);

  const tr = useTranslations("Transactions.reassign");

  const tBanner = useTranslations("Transactions.banners");
  const activeBannerMode: "all" | "income" | "buy" | "sell" | null =
    typeFilter == null ? "all" : (typeFilter as "all" | "income" | "buy" | "sell");

  const { allBanner, incomeBanner, tradeBanner } = useTransactionBanners(
    activeBannerMode,
    summary,
    rows,
    scopeCurrency,
    locale,
    tBanner,
  );

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
    return accumulatedRows.filter(
      (r) =>
        (!showFlagged || anomalyByTxId.has(r.id)) &&
        (draftFilter === "all" || r.status === "draft"),
    );
  }, [accumulatedRows, showFlagged, anomalyByTxId, draftFilter]);

  const hasActiveFilter =
    (searchQuery != null && searchQuery.length > 0) ||
    showFlagged ||
    typeFilter != null ||
    yearFilterProp != null ||
    draftFilter !== "all";

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
  const hasMore = sortedRows.length > windowedRows.length || accumulatedRows.length < (total ?? 0);
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
  const dayGroups = useMemo(() => groupByDay(windowedRows, dayFmt), [windowedRows, dayFmt]);

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

      <LoadMoreSection
        hasVisibleRows={visibleRows.length > 0}
        hasMore={hasMore}
        loadingMore={loadingMore}
        windowedCount={windowedRows.length}
        sortedTotal={sortedRows.length}
        total={total}
        onLoadMore={() => handleLoadMore(sortedRows.length)}
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
