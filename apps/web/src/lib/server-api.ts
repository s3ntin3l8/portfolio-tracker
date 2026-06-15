import "server-only";
import { cookies } from "next/headers";
import {
  createApiClient,
  type ApiClient,
  type Portfolio,
  type User,
  type NetWorth,
  type NetWorthPoint,
  type Instrument,
  type Candle,
  type CorporateAction,
  type Transaction,
  type HoldingValuation,
} from "@portfolio/api-client";
import { auth } from "@/auth";
import { SELECTED_PORTFOLIO_COOKIE } from "@/lib/portfolio-selection";

/** The selected portfolio id, or null when the aggregate ("All portfolios") is active. */
export async function getSelectedPortfolioId(): Promise<string | null> {
  const value = (await cookies()).get(SELECTED_PORTFOLIO_COOKIE)?.value;
  return value && value !== "all" ? value : null;
}

/** API base URL — config-driven so the web app can move to Vercel without a rewrite. */
const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL ?? "";

// Auth is only enforced once configured (mirrors the (app) layout). Without it
// there's no access token and the API can't be reached, so reads report
// "unavailable" rather than crashing the design-system preview.
const authConfigured = Boolean(
  process.env.AUTH_SECRET && process.env.AUTHENTIK_ISSUER,
);

/** A server-bound api-client carrying the current session's access token, or null. */
async function getServerApi(): Promise<ApiClient | null> {
  if (!authConfigured) return null;
  const session = await auth();
  const token = session?.accessToken;
  if (!token) return null;
  return createApiClient({ baseUrl: apiBaseUrl, getToken: () => token });
}

export type NetWorthResult =
  | { status: "ok"; data: NetWorth }
  | { status: "empty" }
  | { status: "unavailable" };

/** Aggregate net worth across every portfolio, folding empty/unavailable states. */
export async function loadNetWorth(): Promise<NetWorthResult> {
  const api = await getServerApi();
  if (!api) return { status: "unavailable" };
  try {
    const data = await api.getNetWorth();
    if (data.portfolioCount === 0) return { status: "empty" };
    return { status: "ok", data };
  } catch {
    return { status: "unavailable" };
  }
}

/** Net-worth-over-time across all portfolios (empty when not signed in / no data). */
export async function loadNetWorthHistory(
  range = "1y",
): Promise<NetWorthPoint[]> {
  const api = await getServerApi();
  if (!api) return [];
  try {
    return await api.getNetWorthHistory(range);
  } catch {
    return [];
  }
}

export interface IncomeEvent {
  id: string;
  date: string;
  type: string; // "dividend" | "coupon"
  symbol: string | null;
  name: string | null;
  amount: string;
  currency: string;
}

/**
 * Every dividend/coupon cash event across all of the user's portfolios (newest
 * first), derived from transactions — no dedicated API needed. `empty` = no
 * portfolio yet; `ok` may still carry zero events (no income recorded).
 */
export async function loadIncome(): Promise<{
  status: "ok" | "empty" | "unavailable";
  events: IncomeEvent[];
}> {
  const api = await getServerApi();
  if (!api) return { status: "unavailable", events: [] };
  try {
    const portfolios = await api.listPortfolios();
    if (portfolios.length === 0) return { status: "empty", events: [] };
    const lists = await Promise.all(
      portfolios.map((p) => api.listTransactions(p.id)),
    );
    const events = lists
      .flat()
      .filter((t) => t.type === "dividend" || t.type === "coupon")
      .map((t) => ({
        id: t.id,
        date: t.executedAt,
        type: t.type,
        symbol: t.instrument?.symbol ?? null,
        name: t.instrument?.name ?? null,
        amount: t.price,
        currency: t.currency,
      }))
      .sort((a, b) => b.date.localeCompare(a.date));
    return { status: "ok", events };
  } catch {
    return { status: "unavailable", events: [] };
  }
}

export interface PortfolioWithValue {
  portfolio: Portfolio;
  netWorth: string;
}

/** Every portfolio with its valued net worth (for the management screen). */
export async function loadPortfolios(): Promise<{
  status: "ok" | "unavailable";
  portfolios: PortfolioWithValue[];
}> {
  const api = await getServerApi();
  if (!api) return { status: "unavailable", portfolios: [] };
  try {
    const list = await api.listPortfolios();
    const portfolios = await Promise.all(
      list.map(async (portfolio) => ({
        portfolio,
        netWorth: (await api.getSummary(portfolio.id)).netWorth,
      })),
    );
    return { status: "ok", portfolios };
  } catch {
    return { status: "unavailable", portfolios: [] };
  }
}

export interface Selection {
  status: "ok" | "unavailable";
  portfolios: Portfolio[];
  /** null = aggregate across all portfolios ("All portfolios"). */
  selectedId: string | null;
}

/**
 * The user's portfolio list plus the active selection from the `pf` cookie, validated
 * against the live list (an unknown/stale id collapses to the aggregate). Drives the
 * global switcher and every per-portfolio screen.
 */
export async function resolveSelection(): Promise<Selection> {
  const api = await getServerApi();
  if (!api) return { status: "unavailable", portfolios: [], selectedId: null };
  try {
    const portfolios = await api.listPortfolios();
    const wanted = await getSelectedPortfolioId();
    const selectedId =
      wanted && portfolios.some((p) => p.id === wanted) ? wanted : null;
    return { status: "ok", portfolios, selectedId };
  } catch {
    return { status: "unavailable", portfolios: [], selectedId: null };
  }
}

export interface TransactionWithPortfolio extends Transaction {
  portfolioName: string;
}

/**
 * Every transaction across all of the user's portfolios, each tagged with its
 * portfolio name (for the aggregate Transactions view). `empty` = no portfolio yet.
 */
export async function loadTransactionsAcrossPortfolios(): Promise<{
  status: "ok" | "empty" | "unavailable";
  transactions: TransactionWithPortfolio[];
}> {
  const api = await getServerApi();
  if (!api) return { status: "unavailable", transactions: [] };
  try {
    const portfolios = await api.listPortfolios();
    if (portfolios.length === 0) return { status: "empty", transactions: [] };
    const nameById = new Map(portfolios.map((p) => [p.id, p.name]));
    const lists = await Promise.all(
      portfolios.map((p) => api.listTransactions(p.id)),
    );
    const transactions = lists.flat().map((t) => ({
      ...t,
      portfolioName: nameById.get(t.portfolioId) ?? "",
    }));
    return { status: "ok", transactions };
  } catch {
    return { status: "unavailable", transactions: [] };
  }
}

export interface HoldingsView {
  status: "ok" | "empty" | "unavailable";
  holdings: HoldingValuation[];
  displayCurrency: string;
}

/**
 * Holdings for the active scope: a single portfolio's `summary` when one is selected,
 * else the cross-portfolio `networth` aggregate ("All portfolios"). Both responses
 * expose the same `holdings` + `displayCurrency`, so the screen renders one way.
 */
export async function loadHoldings(): Promise<HoldingsView> {
  const api = await getServerApi();
  if (!api) return { status: "unavailable", holdings: [], displayCurrency: "IDR" };
  try {
    const portfolios = await api.listPortfolios();
    if (portfolios.length === 0) {
      return { status: "empty", holdings: [], displayCurrency: "IDR" };
    }
    const wanted = await getSelectedPortfolioId();
    const selected = portfolios.find((p) => p.id === wanted);
    const data = selected
      ? await api.getSummary(selected.id)
      : await api.getNetWorth();
    return {
      status: "ok",
      holdings: data.holdings,
      displayCurrency: data.displayCurrency,
    };
  } catch {
    return { status: "unavailable", holdings: [], displayCurrency: "IDR" };
  }
}

export interface InstrumentDetail {
  instrument: Instrument;
  history: Candle[];
  corporateActions: CorporateAction[];
}

/** An instrument with its price history and corporate actions (or null). */
export async function loadInstrument(
  id: string,
): Promise<InstrumentDetail | null> {
  const api = await getServerApi();
  if (!api) return null;
  try {
    const [instrument, history, corporateActions] = await Promise.all([
      api.getInstrument(id),
      api.getInstrumentHistory(id),
      api.listCorporateActions(id),
    ]);
    return { instrument, history, corporateActions };
  } catch {
    return null;
  }
}

/** The authenticated user (or null when signed out / API unreachable). */
export async function loadMe(): Promise<User | null> {
  const api = await getServerApi();
  if (!api) return null;
  try {
    return await api.me();
  } catch {
    return null;
  }
}

export type PortfolioResult<T> =
  | { status: "ok"; portfolio: Portfolio; data: T }
  | { status: "empty" }
  | { status: "unavailable" };

/**
 * Resolve the user's active portfolio (the one chosen in the global switcher, or the
 * first as a fallback) and run `fn` against it, folding the three states every screen
 * must handle into one result: `unavailable` (not signed in / API down), `empty` (no
 * portfolio yet), or `ok`.
 */
export async function loadPortfolio<T>(
  fn: (api: ApiClient, portfolio: Portfolio) => Promise<T>,
): Promise<PortfolioResult<T>> {
  const api = await getServerApi();
  if (!api) return { status: "unavailable" };
  try {
    const portfolios = await api.listPortfolios();
    if (portfolios.length === 0) return { status: "empty" };
    const wanted = await getSelectedPortfolioId();
    const portfolio = portfolios.find((p) => p.id === wanted) ?? portfolios[0];
    const data = await fn(api, portfolio);
    return { status: "ok", portfolio, data };
  } catch {
    return { status: "unavailable" };
  }
}
