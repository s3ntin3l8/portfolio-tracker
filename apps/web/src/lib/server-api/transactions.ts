import type { Transaction } from "@portfolio/api-client";
import {
  getServerApi,
  listPortfoliosCached,
  resolveHolderScope,
  type TransactionWithPortfolio,
} from "./_shared";
import { loadMe } from "./user";

export async function loadTransactionsAcrossPortfolios(): Promise<{
  status: "ok" | "empty" | "unavailable";
  transactions: TransactionWithPortfolio[];
  scopeCurrency: string;
}> {
  const api = await getServerApi();
  if (!api) return { status: "unavailable", transactions: [], scopeCurrency: "IDR" };
  try {
    const allPortfolios = await listPortfoliosCached();
    if (allPortfolios.length === 0)
      return { status: "empty", transactions: [], scopeCurrency: "IDR" };
    const holderId = await resolveHolderScope(allPortfolios);
    const portfolios = holderId
      ? allPortfolios.filter((p) => p.accountHolderId === holderId)
      : allPortfolios;
    if (portfolios.length === 0) return { status: "empty", transactions: [], scopeCurrency: "IDR" };
    const me = await loadMe();
    const scopeCurrency = me?.displayCurrency ?? "IDR";
    const nameById = new Map(portfolios.map((p) => [p.id, p.name]));
    const lists = await Promise.all(
      portfolios.map((p) => api.listTransactions(p.id, scopeCurrency)),
    );
    const transactions = lists.flat().map((t) => ({
      ...t,
      portfolioName: nameById.get(t.portfolioId) ?? "",
    }));
    return { status: "ok", transactions, scopeCurrency };
  } catch {
    return { status: "unavailable", transactions: [], scopeCurrency: "IDR" };
  }
}

export async function loadNetworthTransactionsPaginated(
  page: number,
  pageSize = 25,
  type?: string,
  year?: string,
  q?: string,
  instrumentId?: string,
): Promise<
  | {
      status: "ok";
      rows: Transaction[];
      total: number;
      summary?: { totalInvested: string; totalProceeds: string; totalIncome: string };
      years?: string[];
    }
  | { status: "unavailable"; rows: []; total: 0 }
> {
  const api = await getServerApi();
  if (!api) return { status: "unavailable", rows: [], total: 0 };
  try {
    const data = await api.listNetworthTransactionsPaginated(
      page,
      pageSize,
      type,
      year,
      q,
      instrumentId,
    );
    return {
      status: "ok",
      rows: data.rows,
      total: data.total,
      summary: data.summary,
      years: data.years,
    };
  } catch {
    return { status: "unavailable", rows: [], total: 0 };
  }
}

export async function loadTransactionsPaginated(
  portfolioId: string,
  page: number,
  pageSize = 25,
  convertTo?: string,
  type?: string,
  year?: string,
  q?: string,
  instrumentId?: string,
): Promise<
  | {
      status: "ok";
      rows: Transaction[];
      total: number;
      summary?: { totalInvested: string; totalProceeds: string; totalIncome: string };
      years?: string[];
    }
  | { status: "unavailable"; rows: []; total: 0 }
> {
  const api = await getServerApi();
  if (!api) return { status: "unavailable", rows: [], total: 0 };
  try {
    const data = await api.listTransactionsPaginated(
      portfolioId,
      page,
      pageSize,
      convertTo,
      type,
      year,
      q,
      instrumentId,
    );
    return {
      status: "ok",
      rows: data.rows,
      total: data.total,
      summary: data.summary,
      years: data.years,
    };
  } catch {
    return { status: "unavailable", rows: [], total: 0 };
  }
}
