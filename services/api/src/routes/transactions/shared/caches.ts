import { createStore, type CacheEntry } from "../../../lib/derivation-cache.js";
import type { Anomaly, ContributionStats, SparplanStats, TradeLog } from "@portfolio/core";

export type { CacheEntry };

export const anomaliesCache = createStore<{ filtered: Anomaly[] }>();
export const transactionsCache = createStore<{
  rows: unknown[];
  total: number;
  summary?: {
    totalInvested: string;
    totalProceeds: string;
    totalIncome: string;
  };
}>();
export const tradesCache = createStore<{
  trades: unknown[];
  realizedByYear: unknown[];
  dividendsByYear: unknown[];
}>();
export const performanceCache = createStore<{
  xirr: number | null;
  netWorth: string;
  asOf: string;
}>();
export const historyCache = createStore<unknown[]>();
export const insightsCache = createStore<unknown>();

export const sparplanCache = createStore<SparplanStats>();
export const networthSparplanCache = createStore<SparplanStats>();
export const networthTradesCache = createStore<TradeLog>();
export const networthContributionsCache = createStore<ContributionStats>();
export const networthTransactionsCache = createStore<{
  rows: unknown[];
  total: number;
  summary?: { totalInvested: string; totalProceeds: string; totalIncome: string };
}>();
