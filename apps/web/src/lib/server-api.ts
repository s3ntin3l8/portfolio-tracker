import "server-only";
import { cookies } from "next/headers";
import {
  createApiClient,
  type ApiClient,
  type Portfolio,
  type AccountHolder,
  type User,
  type NetWorth,
  type PerformancePoint,
  type Instrument,
  type Candle,
  type CorporateAction,
  type Transaction,
  type HoldingValuation,
  type ImportRecord,
  type ImportDetail,
  type IncomeStats,
  type ContributionStats,
  type SparplanStats,
  type TradeLog,
  type TradeMethod,
  type TrConnection,
  type AdminProvider,
  type AdminVisionProvider,
  type AdminStats,
  type AdminJobsResponse,
  type ImportStrategy,
  type AdminStorageResponse,
  type TaxSummaryHolder,
  type UserPreferences,
  type Anomaly,
} from "@portfolio/api-client";
import { auth } from "@/auth";
import {
  SELECTED_PORTFOLIO_COOKIE,
  HOLDER_SCOPE_PREFIX,
  qualifyingHolders,
} from "@/lib/portfolio-selection";

/**
 * The active scope derived from the `pf` cookie.
 * - `all`       — cross-portfolio aggregate (default)
 * - `portfolio` — single portfolio
 * - `holder`    — aggregate of a specific account holder's portfolios
 */
export type Scope =
  | { kind: "all" }
  | { kind: "portfolio"; portfolioId: string }
  | { kind: "holder"; holderId: string };

/**
 * Parse the raw `pf` cookie value into a typed Scope.
 * Does NOT validate against the live list — call `resolveSelection()` for that.
 */
async function getRawScope(): Promise<Scope> {
  const value = (await cookies()).get(SELECTED_PORTFOLIO_COOKIE)?.value;
  if (!value || value === "all") return { kind: "all" };
  if (value.startsWith(HOLDER_SCOPE_PREFIX)) {
    return { kind: "holder", holderId: value.slice(HOLDER_SCOPE_PREFIX.length) };
  }
  return { kind: "portfolio", portfolioId: value };
}

/** The selected portfolio id, or null when the aggregate ("All portfolios") is active. */
export async function getSelectedPortfolioId(): Promise<string | null> {
  const scope = await getRawScope();
  return scope.kind === "portfolio" ? scope.portfolioId : null;
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

/**
 * Net worth for the active scope: a single portfolio when one is selected, else the
 * cross-portfolio aggregate ("All portfolios"). Merges `getPerformance` into the
 * per-portfolio result so the returned shape always matches {@link NetWorth} (which
 * adds `xirr`, `portfolioCount`, and `asOf` to `PortfolioSummary`).
 */
export async function loadNetWorth(
  costBasis?: "purchase_price" | "total_paid",
  period = "max",
): Promise<NetWorthResult> {
  const api = await getServerApi();
  if (!api) return { status: "unavailable" };
  try {
    const portfolios = await api.listPortfolios();
    if (portfolios.length === 0) return { status: "empty" };
    const wanted = await getSelectedPortfolioId();
    const selected = portfolios.find((p) => p.id === wanted);
    if (selected) {
      // Single-portfolio scope: period filter not yet supported via getSummary/getPerformance.
      // We pass period=max implicitly — PeriodSelector only renders in aggregate scope.
      const [summary, perf] = await Promise.all([
        api.getSummary(selected.id, costBasis),
        api.getPerformance(selected.id),
      ]);
      return {
        status: "ok",
        data: { ...summary, xirr: perf.xirr, portfolioCount: 1, asOf: perf.asOf, period: "max" },
      };
    }
    const holderId = await resolveHolderScope(portfolios);
    const data = await api.getNetWorth(costBasis, holderId, period);
    if (data.portfolioCount === 0) return { status: "empty" };
    return { status: "ok", data };
  } catch {
    return { status: "unavailable" };
  }
}

export async function loadPreferences(): Promise<UserPreferences | null> {
  const api = await getServerApi();
  if (!api) return null;
  try {
    return await api.getPreferences();
  } catch {
    return null;
  }
}

/**
 * Net-worth-over-time for the active scope: a single portfolio's snapshot history
 * when one is selected, else the cross-portfolio aggregate series.
 */
export async function loadNetWorthHistory(
  range = "1y",
): Promise<PerformancePoint[]> {
  const api = await getServerApi();
  if (!api) return [];
  try {
    const portfolios = await api.listPortfolios();
    const wanted = await getSelectedPortfolioId();
    const selected = portfolios.find((p) => p.id === wanted);
    if (selected) return await api.getPortfolioHistory(selected.id, range);
    const holderId = await resolveHolderScope(portfolios);
    return await api.getNetWorthHistory(range, holderId ? { holderId } : undefined);
  } catch {
    return [];
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
  /** null = aggregate across all portfolios ("All portfolios"), or holder scope is active. */
  selectedId: string | null;
  /** Set when a holder-scoped aggregate is active; null otherwise. */
  selectedHolderId: string | null;
}

/**
 * Resolve the active scope (cookie) against the live portfolio + holder lists and return
 * the validated selection. Stale/unknown ids collapse to the aggregate. Drives the global
 * switcher and every aggregate loader.
 */
export async function resolveSelection(): Promise<Selection> {
  const api = await getServerApi();
  if (!api) return { status: "unavailable", portfolios: [], selectedId: null, selectedHolderId: null };
  try {
    const [portfolios, holders] = await Promise.all([
      api.listPortfolios(),
      api.listAccountHolders(),
    ]);
    const rawScope = await getRawScope();

    if (rawScope.kind === "portfolio") {
      const selectedId = portfolios.some((p) => p.id === rawScope.portfolioId)
        ? rawScope.portfolioId
        : null;
      return { status: "ok", portfolios, selectedId, selectedHolderId: null };
    }

    if (rawScope.kind === "holder") {
      // Validate that the holder still exists and still qualifies (≥2 portfolios).
      const qualifying = qualifyingHolders(portfolios, holders);
      const selectedHolderId = qualifying.some((h) => h.id === rawScope.holderId)
        ? rawScope.holderId
        : null;
      return { status: "ok", portfolios, selectedId: null, selectedHolderId };
    }

    return { status: "ok", portfolios, selectedId: null, selectedHolderId: null };
  } catch {
    return { status: "unavailable", portfolios: [], selectedId: null, selectedHolderId: null };
  }
}

/**
 * Returns the holderId when the cookie encodes a holder-scoped aggregate AND the
 * holder is still valid (owns ≥2 portfolios in the provided list), or `undefined`
 * otherwise. Validates with the portfolio list the caller already holds — no extra
 * API calls. This prevents the header (validated via `resolveSelection`) and the
 * page body (this loader) from disagreeing when a holder is deleted or demoted.
 */
async function resolveHolderScope(
  portfolios: { accountHolderId?: string | null }[],
): Promise<string | undefined> {
  const raw = await getRawScope();
  if (raw.kind !== "holder") return undefined;
  const { holderId } = raw;
  const count = portfolios.filter((p) => p.accountHolderId === holderId).length;
  return count >= 2 ? holderId : undefined;
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
    const allPortfolios = await api.listPortfolios();
    if (allPortfolios.length === 0) return { status: "empty", transactions: [] };
    // When a holder scope is active (and still valid), narrow to that holder's portfolios.
    const holderId = await resolveHolderScope(allPortfolios);
    const portfolios = holderId
      ? allPortfolios.filter((p) => p.accountHolderId === holderId)
      : allPortfolios;
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
  /** Native-currency cash balances, keyed by currency code. Non-empty only when
   *  the portfolio (or aggregate) has cashTracked = true. */
  cash: Record<string, string>;
  /** True when at least one portfolio in scope is cashCounted and has cash movement. */
  cashTracked: boolean;
}

/**
 * Holdings for the active scope: a single portfolio's `summary` when one is selected,
 * else the cross-portfolio `networth` aggregate ("All portfolios"). Both responses
 * expose the same `holdings` + `displayCurrency`, so the screen renders one way.
 */
export async function loadHoldings(
  costBasis?: "purchase_price" | "total_paid",
): Promise<HoldingsView> {
  const api = await getServerApi();
  if (!api)
    return {
      status: "unavailable",
      holdings: [],
      displayCurrency: "IDR",
      cash: {},
      cashTracked: false,
    };
  try {
    const portfolios = await api.listPortfolios();
    if (portfolios.length === 0) {
      return {
        status: "empty",
        holdings: [],
        displayCurrency: "IDR",
        cash: {},
        cashTracked: false,
      };
    }
    const wanted = await getSelectedPortfolioId();
    const selected = portfolios.find((p) => p.id === wanted);
    const holderId = selected ? undefined : await resolveHolderScope(portfolios);
    const data = selected
      ? await api.getSummary(selected.id, costBasis)
      : await api.getNetWorth(costBasis, holderId);
    return {
      status: "ok",
      holdings: data.holdings,
      displayCurrency: data.displayCurrency,
      cash: data.cash,
      cashTracked: data.cashTracked,
    };
  } catch {
    return {
      status: "unavailable",
      holdings: [],
      displayCurrency: "IDR",
      cash: {},
      cashTracked: false,
    };
  }
}

/**
 * Fetch data-integrity anomalies for the currently selected portfolio.
 * Only available in single-portfolio scope — returns null in aggregate mode.
 */
export async function loadAnomalies(): Promise<Anomaly[] | null> {
  const api = await getServerApi();
  if (!api) return null;
  const portfolioId = await getSelectedPortfolioId();
  if (!portfolioId) return null;
  try {
    const { anomalies } = await api.getHoldings(portfolioId);
    return anomalies;
  } catch {
    return null;
  }
}

export type ContributionsView =
  | { status: "ok"; data: ContributionStats; valueHistory: PerformancePoint[] }
  | { status: "empty" }
  | { status: "unavailable" };

/**
 * Contribution analytics for the active scope: a single portfolio when one is
 * selected, else the cross-portfolio aggregate narrowed by the holder scope (if any).
 * The single-portfolio cookie wins; the holder scope only applies in the "all" state.
 *
 * Also fetches the full portfolio-value history (inception→today) for the same scope,
 * so the /savings chart can overlay contributions vs. value. The history fetch is
 * independent — a failure returns an empty array and degrades the chart gracefully
 * without breaking the contributions stats.
 */
export async function loadContributions(): Promise<ContributionsView> {
  const api = await getServerApi();
  if (!api) return { status: "unavailable" };
  try {
    const portfolios = await api.listPortfolios();
    if (portfolios.length === 0) return { status: "empty" };
    const wanted = await getSelectedPortfolioId();
    const selected = portfolios.find((p) => p.id === wanted);
    const holderId = selected ? undefined : await resolveHolderScope(portfolios);
    const data = selected
      ? await api.getPortfolioContributions(selected.id)
      : await api.getContributions(holderId);
    // Fetch value history with the same scope. "all" range → rangeStart returns null
    // (no lower bound) → full inception→today series. Wrapped independently so a
    // history error doesn't cascade to the whole page.
    let valueHistory: PerformancePoint[] = [];
    try {
      valueHistory = selected
        ? await api.getPortfolioHistory(selected.id, "all")
        : await api.getNetWorthHistory("all", holderId ? { holderId } : undefined);
    } catch {
      // History unavailable — chart degrades gracefully.
    }
    return { status: "ok", data, valueHistory };
  } catch {
    return { status: "unavailable" };
  }
}

export type SparplanView =
  | { status: "ok"; data: SparplanStats; portfolioId: string | null }
  | { status: "empty" }
  | { status: "unavailable" };

/**
 * Sparplan (recurring investment) detection for the active scope: a single portfolio
 * when one is selected, else the cross-portfolio aggregate narrowed by the holder scope.
 * Returns `portfolioId` in the result so the savings page can gate the rebalance dialog
 * (drift + contribution split are only available in single-portfolio scope).
 */
export async function loadSparplan(): Promise<SparplanView> {
  const api = await getServerApi();
  if (!api) return { status: "unavailable" };
  try {
    const portfolios = await api.listPortfolios();
    if (portfolios.length === 0) return { status: "empty" };
    const wanted = await getSelectedPortfolioId();
    const selected = portfolios.find((p) => p.id === wanted);
    const holderId = selected ? undefined : await resolveHolderScope(portfolios);
    const data = selected
      ? await api.getPortfolioSparplan(selected.id)
      : await api.getSparplan(holderId);
    return { status: "ok", data, portfolioId: selected?.id ?? null };
  } catch {
    return { status: "unavailable" };
  }
}

export type TradeLogView =
  | { status: "ok"; data: TradeLog }
  | { status: "empty" }
  | { status: "unavailable" };

/**
 * Trade log for the active scope: a single portfolio when one is selected, else the
 * cross-portfolio aggregate. Mirrors {@link loadHoldings}.
 */
export async function loadTrades(
  method: TradeMethod = "average",
  costBasis?: "purchase_price" | "total_paid",
): Promise<TradeLogView> {
  const api = await getServerApi();
  if (!api) return { status: "unavailable" };
  try {
    const portfolios = await api.listPortfolios();
    if (portfolios.length === 0) return { status: "empty" };
    const wanted = await getSelectedPortfolioId();
    const selected = portfolios.find((p) => p.id === wanted);
    const holderId = selected ? undefined : await resolveHolderScope(portfolios);
    const data = selected
      ? await api.getTrades(selected.id, method, costBasis)
      : await api.getNetWorthTrades(method, costBasis, holderId);
    return { status: "ok", data };
  } catch {
    return { status: "unavailable" };
  }
}

/** The user's Trade Republic connection state (or null when API unreachable). */
export async function loadTrConnection(): Promise<TrConnection | null> {
  const api = await getServerApi();
  if (!api) return null;
  try {
    return await api.getTrConnection();
  } catch {
    return null;
  }
}

/** The user's account holders, or an empty list when the API is unavailable. */
export async function loadAccountHolders(): Promise<AccountHolder[]> {
  const api = await getServerApi();
  if (!api) return [];
  try {
    return await api.listAccountHolders();
  } catch {
    return [];
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

export interface InstrumentScope {
  /** The user's position in this instrument for the active scope (null = not held). */
  holding: HoldingValuation | null;
  /** The user's transactions for this instrument, each tagged with its portfolio name. */
  transactions: TransactionWithPortfolio[];
  /** True in the cross-portfolio ("All portfolios") scope (drives the portfolio column). */
  aggregate: boolean;
  displayCurrency: string;
}

/**
 * The user's own position and transactions for a single instrument, scoped to the active
 * portfolio selection (a single portfolio, or the cross-portfolio aggregate). Composes the
 * existing scope-aware loaders — there's no instrument-filtered endpoint — so it follows
 * the global switcher for free. Distinct from {@link loadInstrument}, which is the
 * instrument's market-data view (price + corporate actions).
 */
export async function loadInstrumentScope(
  instrumentId: string,
  costBasis?: "purchase_price" | "total_paid",
): Promise<InstrumentScope> {
  const holdingsView = await loadHoldings(costBasis);
  const holding =
    holdingsView.status === "ok"
      ? (holdingsView.holdings.find((h) => h.instrumentId === instrumentId) ?? null)
      : null;

  const aggregate = (await getSelectedPortfolioId()) === null;
  let transactions: TransactionWithPortfolio[] = [];
  if (aggregate) {
    const result = await loadTransactionsAcrossPortfolios();
    if (result.status === "ok") {
      transactions = result.transactions.filter(
        (t) => t.instrumentId === instrumentId,
      );
    }
  } else {
    const result = await loadPortfolio((api, portfolio) =>
      api.listTransactions(portfolio.id),
    );
    if (result.status === "ok") {
      transactions = result.data
        .filter((t) => t.instrumentId === instrumentId)
        .map((t) => ({ ...t, portfolioName: result.portfolio.name }));
    }
  }

  return {
    holding,
    transactions,
    aggregate,
    displayCurrency: holdingsView.displayCurrency,
  };
}

export type IncomeStatsView =
  | { status: "ok"; data: IncomeStats }
  | { status: "empty" }
  | { status: "unavailable" };

/**
 * Income analytics for the active scope: a single portfolio when one is selected,
 * else the cross-portfolio aggregate narrowed by the holder scope (if any).
 * The single-portfolio cookie wins; the holder scope only applies in the "all" state.
 */
export async function loadIncomeStats(): Promise<IncomeStatsView> {
  const api = await getServerApi();
  if (!api) return { status: "unavailable" };
  try {
    const portfolios = await api.listPortfolios();
    if (portfolios.length === 0) return { status: "empty" };
    const wanted = await getSelectedPortfolioId();
    const selected = portfolios.find((p) => p.id === wanted);
    const holderId = selected ? undefined : await resolveHolderScope(portfolios);
    const data = selected
      ? await api.getPortfolioIncome(selected.id)
      : await api.getIncome(holderId);
    return { status: "ok", data };
  } catch {
    return { status: "unavailable" };
  }
}

/** The user's import history (newest first; empty when signed out / unreachable). */
export async function loadImports(): Promise<ImportRecord[]> {
  const api = await getServerApi();
  if (!api) return [];
  try {
    return await api.listImports();
  } catch {
    return [];
  }
}

/** A single import with its parsed drafts (or null when missing / signed out / down). */
export async function loadImport(importId: string): Promise<ImportDetail | null> {
  const api = await getServerApi();
  if (!api) return null;
  try {
    return await api.getImport(importId);
  } catch {
    return null;
  }
}

/** Plain portfolio list (no net-worth) — used for portfolio pickers that don't need valuations. */
export async function loadPortfolioList(): Promise<Portfolio[]> {
  const api = await getServerApi();
  if (!api) return [];
  try {
    return await api.listPortfolios();
  } catch {
    return [];
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

/** Admin: the market-data provider config, or "unavailable" (signed out / non-admin / down). */
export async function loadAdminProviders(): Promise<
  | { status: "ok"; providers: AdminProvider[]; encryptionEnabled: boolean }
  | { status: "unavailable" }
> {
  const api = await getServerApi();
  if (!api) return { status: "unavailable" };
  try {
    const { providers, encryptionEnabled } = await api.getAdminProviders();
    return { status: "ok", providers, encryptionEnabled };
  } catch {
    return { status: "unavailable" };
  }
}

/** Admin: server statistics (#140), or "unavailable". */
export async function loadAdminStats(): Promise<
  { status: "ok"; stats: AdminStats } | { status: "unavailable" }
> {
  const api = await getServerApi();
  if (!api) return { status: "unavailable" };
  try {
    const stats = await api.getAdminStats();
    return { status: "ok", stats };
  } catch {
    return { status: "unavailable" };
  }
}

/** Admin: storage provider config, or "unavailable" (signed out / non-admin / down). */
export async function loadAdminStorageProviders(): Promise<
  { status: "ok"; storage: AdminStorageResponse } | { status: "unavailable" }
> {
  const api = await getServerApi();
  if (!api) return { status: "unavailable" };
  try {
    const storage = await api.getAdminStorageProviders();
    return { status: "ok", storage };
  } catch {
    return { status: "unavailable" };
  }
}

/** Admin: background job list, or "unavailable" (signed out / non-admin / down). */
export async function loadAdminJobs(): Promise<
  { status: "ok" } & AdminJobsResponse | { status: "unavailable" }
> {
  const api = await getServerApi();
  if (!api) return { status: "unavailable" };
  try {
    const data = await api.getAdminJobs();
    return { status: "ok", ...data };
  } catch {
    return { status: "unavailable" };
  }
}

/** Admin: the vision LLM provider config, or "unavailable" (signed out / non-admin / down). */
export async function loadAdminVisionProviders(): Promise<
  | { status: "ok"; providers: AdminVisionProvider[]; encryptionEnabled: boolean }
  | { status: "unavailable" }
> {
  const api = await getServerApi();
  if (!api) return { status: "unavailable" };
  try {
    const { providers, encryptionEnabled } = await api.getAdminVisionProviders();
    return { status: "ok", providers, encryptionEnabled };
  } catch {
    return { status: "unavailable" };
  }
}

/** Admin: the import strategy (parser vs vision-LLM), or "unavailable". */
export async function loadAdminImportSettings(): Promise<
  { status: "ok"; strategy: ImportStrategy } | { status: "unavailable" }
> {
  const api = await getServerApi();
  if (!api) return { status: "unavailable" };
  try {
    const { strategy } = await api.getAdminImportSettings();
    return { status: "ok", strategy };
  } catch {
    return { status: "unavailable" };
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

/**
 * Load German tax summary (Sparerpauschbetrag headroom + harvest suggestions)
 * across all holders with a configured allowance. Returns an empty array when
 * the API is unavailable or no holders are configured.
 */
export async function loadNetworthTax(year?: number): Promise<TaxSummaryHolder[]> {
  const api = await getServerApi();
  if (!api) return [];
  try {
    return await api.getNetworthTax(year);
  } catch {
    return [];
  }
}
