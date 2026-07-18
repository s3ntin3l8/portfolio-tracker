"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "@/i18n/navigation";
import { useSearchParams } from "next/navigation";
import { formatMoneyCompact } from "@/lib/utils";
import { useApiClient } from "@/lib/api";
import {
  computeAllBanner,
  computeIncomeBanner,
  computeTradeBanner,
  barPct,
  BANNER_PALETTE,
} from "@/lib/transaction-banners";
import type { AllBannerData, IncomeBannerData, TradeBannerData } from "@/lib/transaction-banners";
import type { Anomaly } from "@portfolio/api-client";
import type { TxRow } from "./types";

const PAGE_SIZE = 25;

export function useAnomalyMap(anomalies: Anomaly[]) {
  return useMemo(() => {
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
}

export function useTransactionUrlNav() {
  const router = useRouter();
  const searchParams = useSearchParams();
  return useCallback(
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
}

export function useTransactionBanners(
  activeBannerMode: "all" | "income" | "buy" | "sell" | null,
  summary: {
    totalInvested: string | null;
    totalProceeds: string | null;
    totalIncome: string | null;
  } | null,
  rows: TxRow[],
  scopeCurrency: string,
  locale: string,
  tBanner: (key: string, values?: Record<string, string | number | Date> | undefined) => string,
): {
  allBanner: AllBannerData | null;
  incomeBanner: IncomeBannerData | null;
  tradeBanner: TradeBannerData | null;
} {
  const allBanner = useMemo(() => {
    if (activeBannerMode !== "all") return null;
    if (summary) {
      const money = (n: number) => formatMoneyCompact(n, scopeCurrency, locale);
      const investedTotal = Number(summary.totalInvested ?? 0);
      const proceedsTotal = Number(summary.totalProceeds ?? 0);
      const incomeTotal = Number(summary.totalIncome ?? 0);
      const max = Math.max(investedTotal, proceedsTotal, incomeTotal, 1);
      return {
        currency: scopeCurrency,
        tiles: [
          {
            label: tBanner("invested"),
            value: summary.totalInvested ? money(investedTotal) : "—",
            sub: "",
            tone: "neutral" as const,
          },
          {
            label: tBanner("proceeds"),
            value: summary.totalProceeds ? money(proceedsTotal) : "—",
            sub: "",
            tone: "neutral" as const,
          },
          {
            label: tBanner("incomeYtd"),
            value: summary.totalIncome ? money(incomeTotal) : "—",
            sub: "",
            tone: "neutral" as const,
          },
        ],
        mix: [
          {
            label: tBanner("buys"),
            value: summary.totalInvested ? money(investedTotal) : "—",
            pct: barPct(investedTotal, max),
            color: BANNER_PALETTE[0],
          },
          {
            label: tBanner("sells"),
            value: summary.totalProceeds ? money(proceedsTotal) : "—",
            pct: barPct(proceedsTotal, max),
            color: BANNER_PALETTE[1],
          },
          {
            label: tBanner("income"),
            value: summary.totalIncome ? money(incomeTotal) : "—",
            pct: barPct(incomeTotal, max),
            color: BANNER_PALETTE[3],
          },
        ],
      };
    }
    return computeAllBanner(rows, scopeCurrency, locale, {
      invested: tBanner("invested"),
      proceeds: tBanner("proceeds"),
      incomeYtd: tBanner("incomeYtd"),
      buysCount: (n: number) => tBanner("buysCount", { count: n }),
      sellsCount: (n: number) => tBanner("sellsCount", { count: n }),
      vsLastYear: (pct: string) => tBanner("vsLastYear", { pct }),
      buys: tBanner("buys"),
      sells: tBanner("sells"),
      income: tBanner("income"),
    });
  }, [activeBannerMode, summary, rows, scopeCurrency, locale, tBanner]);

  const incomeBanner = useMemo(() => {
    if (activeBannerMode !== "income") return null;
    return computeIncomeBanner(rows, scopeCurrency, locale, {
      vsLastYear: (pct: string) => tBanner("vsLastYear", { pct }),
      new: tBanner("newIncome"),
      perMonth: (amount: string) => tBanner("perMonth", { amount }),
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
      // avg and bySymbol reflect only the currently-loaded page, not the
      // full transaction set — the summary total above is cross-page accurate,
      // but the server doesn't provide per-symbol aggregation or avg to match.
      const fromRows = computeTradeBanner(rows, activeBannerMode, scopeCurrency, locale);
      if (fromRows) {
        return { ...fromRows, total: money(Number(total)) };
      }
      return {
        currency: scopeCurrency,
        total: money(Number(total)),
        count: 0,
        avg: "—",
        bySymbol: [],
      };
    }
    return computeTradeBanner(rows, activeBannerMode, scopeCurrency, locale);
  }, [activeBannerMode, summary, rows, scopeCurrency, locale]);

  return { allBanner, incomeBanner, tradeBanner };
}

export function useTransactionPagination(
  rows: TxRow[],
  total: number | undefined,
  typeFilter: string | undefined,
  yearFilterProp: string | undefined,
  searchQuery: string | undefined,
  portfolioId: string | undefined,
  showFlagged: boolean,
) {
  const [accumulatedRows, setAccumulatedRows] = useState<TxRow[]>(rows);
  const [currentPage, setCurrentPage] = useState(1);
  const [loadingMore, setLoadingMore] = useState(false);
  const [prevRows, setPrevRows] = useState(rows);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  if (prevRows !== rows) {
    setPrevRows(rows);
    setAccumulatedRows(rows);
    setCurrentPage(1);
  }

  const handleLoadMore = useCallback(
    async (sortedRowsLength: number) => {
      if (visibleCount < sortedRowsLength) {
        setVisibleCount((n) => n + PAGE_SIZE);
        return;
      }
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
    },
    [
      visibleCount,
      accumulatedRows.length,
      total,
      currentPage,
      typeFilter,
      yearFilterProp,
      searchQuery,
      portfolioId,
      showFlagged,
    ],
  );

  return { accumulatedRows, loadingMore, handleLoadMore, visibleCount, setVisibleCount };
}

export function useTransactionViewState(
  rows: TxRow[],
  anomalyByTxId: Map<string, Anomaly>,
  accumulatedRows: TxRow[],
  sortKey: string | null,
  setSelectionMode: (v: boolean) => void,
  setVisibleCount: React.Dispatch<React.SetStateAction<number>>,
  setSelected: React.Dispatch<React.SetStateAction<Set<string>>>,
) {
  const [draftFilter, setDraftFilter] = useState<"all" | "drafts">("all");
  const [showFlagged, setShowFlagged] = useState(false);
  const [detailTx, setDetailTx] = useState<TxRow | null>(null);

  const flaggedCount = anomalyByTxId.size;
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

  const clearSelection = useCallback(() => {
    setSelected(new Set());
    setSelectionMode(false);
  }, [setSelected, setSelectionMode]);

  const viewSignature = `${draftFilter}|${showFlagged}|${sortKey}`;

  const [prevViewSignature, setPrevViewSignature] = useState("");
  if (viewSignature !== prevViewSignature) {
    setPrevViewSignature(viewSignature);
    setVisibleCount(PAGE_SIZE);
  }

  return {
    draftFilter,
    setDraftFilter,
    showFlagged,
    setShowFlagged,
    detailTx,
    setDetailTx,
    clearSelection,
    flaggedCount,
    draftCount,
    viewSignature,
  };
}

export function useFlaggedRows(
  showFlagged: boolean,
  anomalyByTxId: Map<string, Anomaly>,
  portfolioId: string | undefined,
) {
  const api = useApiClient();
  const flaggedIds = useMemo(() => [...anomalyByTxId.keys()], [anomalyByTxId]);
  const flaggedIdsKey = `${portfolioId ?? ""}:${flaggedIds.join(",")}`;
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

  return { flaggedRows, flaggedLoading, flaggedIds };
}
