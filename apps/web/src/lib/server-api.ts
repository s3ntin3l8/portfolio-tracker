import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import {
  createApiClient,
  type ApiClient,
  type Portfolio,
  type AccountHolder,
  type User,
  type NetWorth,
  type PortfolioSummary,
  type PortfolioPerformance,
  type PerformancePoint,
  type HistoryPoint,
  type Instrument,
  type Candle,
  type CorporateAction,
  type Transaction,
  type HoldingValuation,
  type ImportRecord,
  type ImportDetail,
  type UnmappedEventType,
  type IncomeStats,
  type ContributionStats,
  type SparplanStats,
  type TradeLog,
  type TradeMethod,
  type TrConnection,
  type IbkrConnection,
  type AdminProvider,
  type AdminVisionProvider,
  type AdminStats,
  type AdminJobsResponse,
  type ImportStrategy,
  type AdminStorageResponse,
  type TaxSummaryHolder,
  type PortfolioTaxSummary,
  type AllowanceUsage,
  type TaxDistribution,
  type UserPreferences,
  type Anomaly,
  type ApiToken,
  type InboxDocument,
  type DocumentCategory,
} from "@portfolio/api-client";
import type { IdYearInput } from "@portfolio/core";
import {
  SELECTED_PORTFOLIO_COOKIE,
  HOLDER_SCOPE_PREFIX,
  qualifyingHolders,
} from "@/lib/portfolio-selection";
import { toApiRange, type InstrumentPriceRange } from "@/lib/instrument-price-range";
import { accessTokenFromCookieHeader } from "@/lib/session-token";

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

// Server-only — the API's internal address (e.g. http://api:3000 inside the Docker
// network in prod). Called directly, server-to-server; never exposed to the browser
// (the browser instead goes through the same-origin proxy, see lib/api.ts).
const apiBaseUrl = process.env.API_URL ?? "";

// Auth is only enforced once configured (mirrors the (app) layout). Without it
// there's no access token and the API can't be reached, so reads report
// "unavailable" rather than crashing the design-system preview.
const authConfigured = Boolean(
  process.env.AUTH_SECRET && process.env.AUTHENTIK_ISSUER,
);

/**
 * A server-bound api-client carrying the current session's access token, or null.
 *
 * Wrapped in React's `cache()` — request-scoped memoization that survives despite the
 * `(app)` layout being `force-dynamic` (it dedupes *within* one render, it doesn't add
 * cross-request caching). Without this, every one of the ~30 loaders below independently
 * re-read every cookie and re-ran `accessTokenFromCookieHeader`'s JWT decrypt; a single
 * page render calls this 4-5+ times. `cache()` only memoizes the *successful* result — a
 * rejected/null-returning call is retried on the next call, so failures never get stuck.
 */
const getServerApi = cache(async (): Promise<ApiClient | null> => {
  if (!authConfigured) return null;
  const cookieHeader = (await cookies())
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
  const token = await accessTokenFromCookieHeader(cookieHeader);
  if (!token) return null;
  // Snapshotting the token in the closure is safe here: this client is per-request and
  // short-lived (it doesn't outlive a single RSC render). The long-lived client-side hook
  // (`useApiClient` in lib/api.ts) doesn't hold a token at all anymore — it goes through
  // the same-origin proxy, which re-resolves the token on every request. Don't copy this
  // snapshot pattern into a long-lived context.
  return createApiClient({ baseUrl: apiBaseUrl, getToken: () => token });
});

/**
 * Cost basis is a single global preference; several loaders below accept it as an
 * optional param that the API defaults to `"purchase_price"` when omitted (see
 * `getSummary`'s `costBasis ? "...&costBasis=..." : "..."` branch in the api-client —
 * omitting the query param and passing `"purchase_price"` explicitly are the same
 * request server-side). Resolving to the explicit default *before* it reaches a
 * `cache()`-wrapped call below means two call sites that differ only in "omitted" vs
 * "purchase_price" — e.g. the `(app)` layout's `loadNetWorth()` and a page's
 * `loadNetWorth(costBasis)` — collapse onto the same cache entry instead of each
 * paying its own round trip.
 */
function normalizeCostBasis(
  costBasis?: "purchase_price" | "total_paid",
): "purchase_price" | "total_paid" {
  return costBasis ?? "purchase_price";
}

/**
 * Request-scoped dedup for the portfolio/account-holder/user catalog reads — each is
 * called from many independent loaders per page (e.g. `listPortfolios` from ~13 call
 * sites) with no shared cache today, so a single page render issued one round trip per
 * call site. `cache()` collapses repeats within one render into a single call.
 */
const listPortfoliosCached = cache(async (): Promise<Portfolio[]> => {
  const api = await getServerApi();
  if (!api) return [];
  return api.listPortfolios();
});

const listAccountHoldersCached = cache(async (): Promise<AccountHolder[]> => {
  const api = await getServerApi();
  if (!api) return [];
  return api.listAccountHolders();
});

const meCached = cache(async (): Promise<User | null> => {
  const api = await getServerApi();
  if (!api) return null;
  return api.me();
});

/**
 * Cached valuation reads, keyed by their resolved (normalized) arguments. Both the
 * `(app)` layout and several pages independently load net worth / a portfolio summary
 * for the same scope — these collapse those into one round trip per distinct scope.
 */
const getSummaryCached = cache(
  async (
    portfolioId: string,
    costBasis: "purchase_price" | "total_paid",
  ): Promise<PortfolioSummary> => {
    const api = await getServerApi();
    if (!api) throw new Error("api unavailable");
    return api.getSummary(portfolioId, costBasis);
  },
);

const getPerformanceCached = cache(
  async (portfolioId: string): Promise<PortfolioPerformance> => {
    const api = await getServerApi();
    if (!api) throw new Error("api unavailable");
    return api.getPerformance(portfolioId);
  },
);

const getNetWorthCached = cache(
  async (
    costBasis: "purchase_price" | "total_paid",
    holderId: string | undefined,
    period: string,
  ): Promise<NetWorth> => {
    const api = await getServerApi();
    if (!api) throw new Error("api unavailable");
    return api.getNetWorth(costBasis, holderId, period);
  },
);

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
  const resolvedCostBasis = normalizeCostBasis(costBasis);
  try {
    const portfolios = await listPortfoliosCached();
    if (portfolios.length === 0) return { status: "empty" };
    const wanted = await getSelectedPortfolioId();
    const selected = portfolios.find((p) => p.id === wanted);
    if (selected) {
      // Single-portfolio scope: period filter not yet supported via getSummary/getPerformance.
      // We pass period=max implicitly — PeriodSelector only renders in aggregate scope.
      const [summary, perf] = await Promise.all([
        getSummaryCached(selected.id, resolvedCostBasis),
        getPerformanceCached(selected.id),
      ]);
      return {
        status: "ok",
        data: { ...summary, xirr: perf.xirr, portfolioCount: 1, asOf: perf.asOf, period: "max" },
      };
    }
    const holderId = await resolveHolderScope(portfolios);
    const data = await getNetWorthCached(resolvedCostBasis, holderId, period);
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
): Promise<HistoryPoint[]> {
  const api = await getServerApi();
  if (!api) return [];
  try {
    const portfolios = await listPortfoliosCached();
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
    const [list, values] = await Promise.all([listPortfoliosCached(), api.listPortfolioValues()]);
    const valueMap = new Map(values.map((v) => [v.id, v.netWorth]));
    const portfolios = list.map((portfolio) => ({
      portfolio,
      netWorth: valueMap.get(portfolio.id) ?? "0",
    }));
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
      listPortfoliosCached(),
      listAccountHoldersCached(),
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
 *
 * "Scope currency" (#465): an aggregate/holder view has no single native currency, so
 * every row is fetched with `?convertTo=<users.displayCurrency>` — the same currency
 * `/networth` already converts into — giving each row a `displayRate` the Activity
 * banners can multiply by instead of dropping non-dominant-currency rows.
 */
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
    // When a holder scope is active (and still valid), narrow to that holder's portfolios.
    const holderId = await resolveHolderScope(allPortfolios);
    const portfolios = holderId
      ? allPortfolios.filter((p) => p.accountHolderId === holderId)
      : allPortfolios;
    if (portfolios.length === 0)
      return { status: "empty", transactions: [], scopeCurrency: "IDR" };
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
  /** Optional per-page portfolio override (e.g. from ?portfolio= query param).
   *  Validated against the live portfolio list; falls back to the global cookie
   *  when absent or stale. Does NOT write the selection cookie. */
  portfolioOverride?: string,
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
    const portfolios = await listPortfoliosCached();
    if (portfolios.length === 0) {
      return {
        status: "empty",
        holdings: [],
        displayCurrency: "IDR",
        cash: {},
        cashTracked: false,
      };
    }
    const overrideId =
      portfolioOverride && portfolios.some((p) => p.id === portfolioOverride)
        ? portfolioOverride
        : null;
    const wanted = overrideId ?? (await getSelectedPortfolioId());
    const selected = portfolios.find((p) => p.id === wanted);
    const holderId = selected ? undefined : await resolveHolderScope(portfolios);
    const resolvedCostBasis = normalizeCostBasis(costBasis);
    // period "max" is the same request as omitting it (see getNetWorthCached's doc
    // comment) — passed explicitly so this call collapses onto loadNetWorth's cache
    // entry for the same scope instead of paying its own round trip.
    const data = selected
      ? await getSummaryCached(selected.id, resolvedCostBasis)
      : await getNetWorthCached(resolvedCostBasis, holderId, "max");
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
 * Accepts an optional per-page portfolio override (same semantics as loadHoldings).
 */
export async function loadAnomalies(portfolioOverride?: string): Promise<Anomaly[] | null> {
  const api = await getServerApi();
  if (!api) return null;
  const portfolioId = portfolioOverride ?? (await getSelectedPortfolioId());
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
    const portfolios = await listPortfoliosCached();
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
      // range="all" always hits the day-grained daily-snapshot table (never the
      // timestamped intraday one), so this is always PerformancePoint[] in practice.
      valueHistory = (selected
        ? await api.getPortfolioHistory(selected.id, "all")
        : await api.getNetWorthHistory("all", holderId ? { holderId } : undefined)) as PerformancePoint[];
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
    const portfolios = await listPortfoliosCached();
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
    const portfolios = await listPortfoliosCached();
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

export async function loadIbkrConnection(): Promise<IbkrConnection | null> {
  const api = await getServerApi();
  if (!api) return null;
  try {
    return await api.getIbkrConnection();
  } catch {
    return null;
  }
}

/** The user's account holders, or an empty list when the API is unavailable. */
export async function loadAccountHolders(): Promise<AccountHolder[]> {
  const api = await getServerApi();
  if (!api) return [];
  try {
    return await listAccountHoldersCached();
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
  /** Price-history window for the detail chart's 1M/6M/1Y/All chips — defaults to 1Y
   *  (unchanged from before the chips existed). */
  range: InstrumentPriceRange = "1y",
): Promise<InstrumentDetail | null> {
  const api = await getServerApi();
  if (!api) return null;
  try {
    const [instrument, history, corporateActions] = await Promise.all([
      api.getInstrument(id),
      api.getInstrumentHistory(id, toApiRange(range)),
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
  /** Sum of every held position's market value (display currency) in the active scope —
   *  the denominator for the instrument page's "Portfolio weight" stat. Null when holdings
   *  couldn't be loaded (signed out / API down), distinct from a genuine 0. */
  totalMarketValueDisplay: number | null;
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
    // Single portfolio: `holdingsView.displayCurrency` is already the scope currency
    // (portfolio.baseCurrency, per #465) — reuse it as `convertTo` so a mixed-currency
    // portfolio's rows carry a displayRate too, not just aggregate ones.
    const result = await loadPortfolio((api, portfolio) =>
      api.listTransactions(portfolio.id, holdingsView.displayCurrency),
    );
    if (result.status === "ok") {
      transactions = result.data
        .filter((t) => t.instrumentId === instrumentId)
        .map((t) => ({ ...t, portfolioName: result.portfolio.name }));
    }
  }

  // Reuses the `holdings` list `loadHoldings()` already fetched above — no new API call.
  const totalMarketValueDisplay =
    holdingsView.status === "ok"
      ? holdingsView.holdings.reduce(
          (sum, h) => sum + (h.marketValueDisplay ? Number(h.marketValueDisplay) : 0),
          0,
        )
      : null;

  return {
    holding,
    transactions,
    aggregate,
    displayCurrency: holdingsView.displayCurrency,
    totalMarketValueDisplay,
  };
}

export interface HarvestPrefill {
  instrument: { symbol: string; name: string; assetClass: string; unit: string };
  currency: string;
  /** Sum of the instrument's standing open FIFO lots (from `HoldingValuation.lots`,
   *  PR #386) in the active scope — a starting-point quantity for a full-position
   *  harvest sell, not a precise partial-harvest amount. Empty string when the
   *  instrument isn't held in the active scope (the form is left for manual entry). */
  quantity: string;
}

/**
 * Prefill data for a harvest-suggestion "Sell" draft (`/tax`'s harvest rows →
 * `/transactions/new?harvestInstrument=<id>`). Pure lookup, no new backend: instrument
 * metadata from the catalog, quantity from the open lots already attached to the active
 * scope's holdings.
 */
export async function loadHarvestPrefill(instrumentId: string): Promise<HarvestPrefill | null> {
  const api = await getServerApi();
  if (!api) return null;
  try {
    const [instrument, scope] = await Promise.all([
      api.getInstrument(instrumentId),
      loadInstrumentScope(instrumentId),
    ]);
    const lots = scope.holding?.lots ?? [];
    // Estimate only (a prefilled, user-editable default) — summing decimal-string lot
    // quantities as numbers is fine here since nothing is submitted without review.
    const quantity = lots.length > 0
      ? lots.reduce((sum, l) => sum + Number(l.qty), 0).toString()
      : "";
    return {
      instrument: {
        symbol: instrument.symbol,
        name: instrument.name,
        assetClass: instrument.assetClass,
        unit: instrument.unit,
      },
      currency: instrument.currency,
      quantity,
    };
  } catch {
    return null;
  }
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
    const portfolios = await listPortfoliosCached();
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

/** The user's tax-reports inbox (newest first; empty when signed out / unreachable). */
export async function loadDocuments(category?: DocumentCategory): Promise<InboxDocument[]> {
  const api = await getServerApi();
  if (!api) return [];
  try {
    // Scope to the switcher-selected portfolio when one is active (mirrors
    // loadContributions()); undefined in the aggregate "all portfolios" / holder scope,
    // which lists every portfolio's documents.
    const portfolioId = await getSelectedPortfolioId();
    return await api.listDocuments(category, portfolioId ?? undefined);
  } catch {
    return [];
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

/**
 * Safety net: event types that reached the importer but have no mapping yet (TR emitted a
 * type we don't classify). A non-empty list is a self-announcing gap. User-scoped; empty on
 * error / signed out so it never blocks a page render.
 */
export async function loadUnmappedEventTypes(): Promise<UnmappedEventType[]> {
  const api = await getServerApi();
  if (!api) return [];
  try {
    return await api.getUnmappedEventTypes();
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
    return await listPortfoliosCached();
  } catch {
    return [];
  }
}

/** The authenticated user (or null when signed out / API unreachable). */
export async function loadMe(): Promise<User | null> {
  const api = await getServerApi();
  if (!api) return null;
  try {
    return await meCached();
  } catch {
    return null;
  }
}

export async function loadApiTokens(): Promise<ApiToken[]> {
  const api = await getServerApi();
  if (!api) return [];
  try {
    return await api.listApiTokens();
  } catch {
    return [];
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
    const portfolios = await listPortfoliosCached();
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
/**
 * Load tax data scoped to the active PortfolioSwitcher selection:
 * - single portfolio → `getPortfolioTax` (per-depot FSA, portfolio base currency)
 * - holder scope    → `getNetworthTax(year, holderId)`
 * - all             → `getNetworthTax(year)`
 *
 * Always returns a `TaxSummaryHolder[]` so the tax page component is uniform.
 * Single-portfolio results are normalized into a one-element array where the
 * holder stub is derived from the portfolio's own data.
 */
/**
 * Sentinel `holder.id` used for the Indonesian regime's "all portfolios" aggregate
 * bucket (no holder-scope cookie active). Indonesian final tax has no per-person
 * allowance to allocate, so — unlike German mode, which always groups the aggregate
 * view per account holder — there's no need to split it per holder; one bucket
 * covering every portfolio in scope is both simpler and correct. Recognized by
 * {@link loadTaxYearDetail}'s portfolio-resolution below.
 */
const ID_ALL_PORTFOLIOS_ID = "__id_all_portfolios__";

export async function loadNetworthTax(
  year?: number,
  taxRegime: "DE" | "ID" = "DE",
): Promise<TaxSummaryHolder[]> {
  const api = await getServerApi();
  if (!api) return [];
  try {
    const portfolios = await listPortfoliosCached();
    if (portfolios.length === 0) return [];

    const wanted = await getSelectedPortfolioId();
    const selected = portfolios.find((p) => p.id === wanted);
    const targetYear = year ?? new Date().getUTCFullYear();

    if (taxRegime === "ID") {
      // Indonesian final tax (0.1% on sale proceeds, 10% on dividends) has no
      // allowance/FSA concept, so — unlike the German path below — it must never be
      // gated behind a configured `taxAllowanceAnnual` (an ID user will almost never
      // have one; both `getPortfolioTax` and `getNetworthTax` 422/skip without it).
      // Build a normalized holder stub directly from the portfolio list instead of
      // calling those FSA-gated endpoints. The German-shaped `allowanceUsage`/
      // `distribution` fields below are inert placeholders never rendered in ID mode
      // (see tax/page.tsx's regime branch) — they exist only to satisfy the shared
      // `TaxSummaryHolder` shape that {@link loadTaxYearDetail} needs to run at all.
      const zeroAllowance: AllowanceUsage = {
        year: targetYear,
        allowanceAnnual: "0",
        realizedGainsAdjusted: "0",
        incomeYtd: "0",
        vorabpauschaleAccrued: "0",
        vorabpauschaleCredited: "0",
        stockPot: { netGainLoss: "0", carryForwardApplied: "0", used: "0" },
        generalPot: { netGainLoss: "0", carryForwardApplied: "0", used: "0" },
        usedYtd: "0",
        taxableExcess: "0",
        remaining: "0",
        taxRate: "0",
        taxSavingAvailable: "0",
        currency: selected?.baseCurrency ?? "IDR",
        forecastIncomeRestOfYear: "0",
        projectedUsedFullYear: "0",
        projectedRemaining: "0",
        projectedTaxSavingAvailable: "0",
      };
      const zeroDistribution: TaxDistribution = {
        holderAllowanceCap: "0",
        totalAllocated: "0",
        remainingToDistribute: "0",
        overAllocated: false,
      };

      if (selected) {
        return [
          {
            holder: {
              id: selected.accountHolderId ?? selected.id,
              name: selected.accountHolder ?? selected.name,
              taxAllowanceAnnual: selected.taxAllowanceAnnual,
              capitalGainsTaxRate: null,
              churchTax: null,
              taxResidence: null,
            },
            year: targetYear,
            currency: zeroAllowance.currency,
            allowanceUsage: zeroAllowance,
            harvestSuggestions: [],
            carryForwardApplied: false,
            distribution: zeroDistribution,
            tfRatesByInstrument: {},
          },
        ];
      }

      // Aggregate scope: one bucket for the active holder-scope (if any), else one
      // bucket for every portfolio the user has — see ID_ALL_PORTFOLIOS_ID above.
      const holderId = await resolveHolderScope(portfolios);
      let holderName = "";
      if (holderId) {
        const holders = await listAccountHoldersCached();
        holderName = holders.find((h) => h.id === holderId)?.name ?? "";
      }

      return [
        {
          holder: {
            id: holderId ?? ID_ALL_PORTFOLIOS_ID,
            name: holderName,
            taxAllowanceAnnual: null,
            capitalGainsTaxRate: null,
            churchTax: null,
            taxResidence: null,
          },
          year: targetYear,
          currency: zeroAllowance.currency,
          allowanceUsage: zeroAllowance,
          harvestSuggestions: [],
          carryForwardApplied: false,
          distribution: zeroDistribution,
          tfRatesByInstrument: {},
        },
      ];
    }

    if (selected) {
      // Single-portfolio scope: use the per-depot FSA endpoint.
      let result: PortfolioTaxSummary;
      try {
        result = await api.getPortfolioTax(selected.id, year);
      } catch (err: unknown) {
        // 422 = FSA not configured for this portfolio — show nothing (not an error).
        if (err && typeof err === "object" && "status" in err && (err as { status: number }).status === 422) {
          return [];
        }
        throw err;
      }
      // Normalize into TaxSummaryHolder shape for the shared page component.
      const holderEntry: TaxSummaryHolder = {
        holder: {
          id: selected.accountHolderId ?? selected.id,
          name: selected.accountHolder ?? selected.name,
          taxAllowanceAnnual: selected.taxAllowanceAnnual,
          capitalGainsTaxRate: null,
          churchTax: null,
          taxResidence: null,
        },
        year: result.year,
        currency: result.currency,
        allowanceUsage: result.allowanceUsage,
        harvestSuggestions: result.harvestSuggestions,
        carryForwardApplied: result.carryForwardApplied,
        distribution: result.holderDistribution,
        tfRatesByInstrument: result.tfRatesByInstrument,
      };
      return [holderEntry];
    }

    // Holder or all-portfolio scope.
    const holderId = await resolveHolderScope(portfolios);
    return await api.getNetworthTax(year, holderId);
  } catch {
    return [];
  }
}

/** One FIFO buy-lot consumed by an aggregate disposal — the expandable detail behind
 *  a `TaxDisposalRow` (see its doc comment). */
export interface TaxDisposalLot {
  acqDate: string; // YYYY-MM-DD
  quantity: string;
  buyPrice: string; // this lot's cost per share
  sellPrice: string; // this lot's proceeds per share
  proceeds: string;
  gain: string;
  holdingDays: number;
  longTerm: boolean;
}

/**
 * One aggregate disposal — all FIFO legs for the same instrument sold on the same
 * date, rolled into a single row (an ETF bought in several tranches then sold in one
 * order would otherwise emit one near-identical row per consumed lot). `avgBuyPrice`/
 * `sellPrice` are per-share, Σcost/Σqty and Σproceeds/Σqty respectively; `lots` carries
 * the individual consumed lots for an expandable detail view.
 */
export interface TaxDisposalRow {
  symbol: string;
  when: string; // YYYY-MM-DD (the shared sell date)
  proceeds: string;
  gain: string;
  /** Teilfreistellung rate applied to this row's instrument (0–1), from the backend's
   *  tfRatesByInstrument — the same rate allowanceUsage/harvestSuggestions use. */
  tfRate: string;
  /** Tf-adjusted gain = gain × (1 − tfRate) — what actually counts against the FSA,
   *  as opposed to `gain` (the gross economic gain shown by default). Equal to `gain`
   *  when tfRate is 0 (the common case: stocks, bonds, gold). */
  gainAdjusted: string;
  quantity: string;
  avgBuyPrice: string;
  sellPrice: string;
  lots: TaxDisposalLot[];
}

export interface TaxDividendRow {
  symbol: string;
  /** The transaction's own currency (dividend/coupon/interest amounts are NOT FX-converted
   *  here, unlike every other figure on this screen — see {@link loadTaxYearDetail}'s doc
   *  comment). Render each row in this currency, not the holder's display currency. */
  currency: string;
  gross: string;
  tax: string;
  net: string;
}

export interface TaxCurrencyTotal {
  currency: string;
  gross: string;
  tax: string;
  net: string;
}

export interface TaxYearRow {
  year: number;
  realized: string;
  dividends: string;
  tax: string;
  /** Sparerpauschbetrag (FSA) consumed that year. The selected year uses the backend's
   *  exact `allowanceUsage.usedYtd` (Teilfreistellung + Vorabpauschale + two-pot netting
   *  already applied); other years are estimated the same way the `tax` column already
   *  is — see this interface's doc comment on `loadTaxYearDetail` for the caveat. */
  fsaUsed: string;
}

export interface TaxYearDetail {
  currency: string;
  disposals: TaxDisposalRow[];
  totalProceeds: string;
  totalGain: string;
  dividendRows: TaxDividendRow[];
  /** Per-currency totals (see {@link TaxDividendRow.currency} — dividend rows aren't
   *  FX-converted, so a single cross-currency sum would be wrong whenever a holder's
   *  positions pay dividends in more than one currency; render these joined, one per
   *  currency, the way `CashOnHandCard` joins multi-currency balances). */
  dividendTotalsByCurrency: TaxCurrencyTotal[];
  byYear: TaxYearRow[];
  /**
   * Per-year totals (proceeds, gross dividends, realized gain) across EVERY year the
   * trade log covers — not just the selected year. Computed regardless of tax regime
   * (cheap), but only consumed by the Indonesian tax view: unlike the German
   * `byYear` above (which only tracks realized GAIN), Indonesian final tax is levied
   * on sale PROCEEDS and dividend GROSS, which this rollup carries per year so
   * `indonesianFinalTax`'s "By year" table is correct for prior years too.
   */
  idByYear: IdYearInput[];
}

/**
 * Per-holder assembly of the `/tax` screen's disposal table, dividends-withheld table, and
 * by-year breakdown — all derived from data the backend already computes (the FIFO trade
 * log that already backs `allowanceUsage`/harvest suggestions, plus raw transaction
 * fields), no new backend endpoint. Keyed by `TaxSummaryHolder.holder.id` (mirrors
 * {@link loadNetworthTax}'s branching so the single-portfolio fallback id lines up).
 *
 * Caveat (documented, not silently swallowed): the backend computes `allowanceUsage` with
 * Teilfreistellung (ETF partial tax exemption) rates from `tfRatesFor()`, which is
 * server-only and not exposed via the API client. So the by-year table's realized figures
 * for years OTHER than the selected one are plain (not TF-adjusted), and their tax applies
 * the CURRENT Sparerpauschbetrag uniformly across history (no historical allowance amounts
 * are stored) — a genuinely-new-backend gap if a filing-grade number were needed. The
 * selected year's own row is special-cased to the already-computed, precise
 * `allowanceUsage` figures so it ties out to the hero card. This matches the screen's own
 * "estimate only, not tax advice" footnote — a summary, not a filing document.
 */
export async function loadTaxYearDetail(
  holders: TaxSummaryHolder[],
  year?: number,
): Promise<Map<string, TaxYearDetail>> {
  const result = new Map<string, TaxYearDetail>();
  if (holders.length === 0) return result;
  const api = await getServerApi();
  if (!api) return result;
  const targetYear = year ?? new Date().getUTCFullYear();

  let portfolios: Portfolio[];
  let selected: Portfolio | undefined;
  try {
    portfolios = await listPortfoliosCached();
    const wanted = await getSelectedPortfolioId();
    selected = portfolios.find((p) => p.id === wanted);
  } catch {
    return result;
  }

  await Promise.all(
    holders.map(async (entry) => {
      const holderId = entry.holder.id;
      // ID_ALL_PORTFOLIOS_ID (see loadNetworthTax) means "every portfolio in scope,
      // not grouped by account holder" — the Indonesian aggregate bucket.
      const pfs =
        selected
          ? [selected]
          : holderId === ID_ALL_PORTFOLIOS_ID
            ? portfolios
            : portfolios.filter((p) => p.accountHolderId === holderId);
      if (pfs.length === 0) return;

      try {
        const [tradeLog, txLists] = await Promise.all([
          selected
            ? api.getTrades(selected.id, "fifo")
            : api.getNetWorthTrades("fifo", undefined, holderId),
          Promise.all(pfs.map((p) => api.listTransactions(p.id))),
        ]);

        // Disposals: FIFO legs closed in the target year, grouped into one aggregate
        // row per (instrument, sell date) — a multi-lot sale (e.g. an ETF bought in
        // several tranches, sold in one order) would otherwise emit one row per
        // consumed lot. Aggregate avg buy/sell price = Σcost/Σqty, Σproceeds/Σqty;
        // the individual lots are kept on `.lots` for an expandable detail view.
        const disposalGroups = new Map<
          string,
          {
            symbol: string;
            when: string;
            proceeds: number;
            gain: number;
            quantity: number;
            cost: number;
            /** Teilfreistellung rate for this row's instrument (0–1), from the SAME
             *  tfRatesByInstrument map the backend's allowanceUsage/harvestSuggestions
             *  were computed with — see TaxYearRow.fsaUsed's caveat for why this must
             *  come from the backend rather than a client-side asset-class guess. */
            tfRate: number;
            lots: TaxDisposalLot[];
          }
        >();
        for (const t of tradeLog.trades) {
          for (const l of t.legs) {
            if (l.taxYear !== targetYear) continue;
            const key = `${t.instrumentId}:${l.sellDate}`;
            const qty = Number(l.quantity);
            const cost = Number(l.cost);
            const proceeds = Number(l.proceeds);
            const group = disposalGroups.get(key) ?? {
              symbol: t.instrument?.symbol ?? t.instrumentId.slice(0, 8),
              when: l.sellDate,
              proceeds: 0,
              gain: 0,
              quantity: 0,
              cost: 0,
              tfRate: Number(entry.tfRatesByInstrument?.[t.instrumentId] ?? "0"),
              lots: [],
            };
            group.proceeds += proceeds;
            group.gain += Number(l.gain);
            group.quantity += qty;
            group.cost += cost;
            group.lots.push({
              acqDate: l.acqDate,
              quantity: l.quantity,
              buyPrice: qty > 0 ? (cost / qty).toString() : "0",
              sellPrice: qty > 0 ? (proceeds / qty).toString() : "0",
              proceeds: l.proceeds,
              gain: l.gain,
              holdingDays: l.holdingDays,
              longTerm: l.longTerm,
            });
            disposalGroups.set(key, group);
          }
        }
        const legs: TaxDisposalRow[] = [...disposalGroups.values()].map((g) => ({
          symbol: g.symbol,
          when: g.when,
          proceeds: g.proceeds.toFixed(2),
          gain: g.gain.toFixed(2),
          tfRate: g.tfRate.toString(),
          gainAdjusted: (g.gain * (1 - g.tfRate)).toFixed(2),
          quantity: g.quantity.toString(),
          avgBuyPrice: g.quantity > 0 ? (g.cost / g.quantity).toString() : "0",
          sellPrice: g.quantity > 0 ? (g.proceeds / g.quantity).toString() : "0",
          lots: g.lots.sort((a, b) => a.acqDate.localeCompare(b.acqDate)),
        }));
        const totalProceeds = legs.reduce((s, l) => s + Number(l.proceeds), 0);
        const totalGain = legs.reduce((s, l) => s + Number(l.gain), 0);

        // Dividends withheld, per instrument, for the target year — from raw transactions
        // (dividend/coupon/interest carry a `tax` field the trade log's yearly rollup
        // doesn't break out by instrument). `price` already follows the app's
        // net-of-withholding convention for income rows (see core's `cashFlow()`), so
        // gross = net + withheld tax, not qty × price.
        //
        // NOT FX-converted (unlike every other figure here, which comes straight from the
        // backend's already-display-currency trade log): a transaction's own `currency`
        // has no client-side FX path (no rate endpoint on the API client), so each row is
        // grouped and rendered in ITS OWN currency rather than mislabeled with the
        // holder's display currency — see `TaxDividendRow.currency` and
        // `dividendTotalsByCurrency`.
        const incomeTxns = txLists
          .flat()
          .filter(
            (t) =>
              (t.type === "dividend" || t.type === "coupon" || t.type === "interest") &&
              t.status !== "archived" &&
              t.status !== "draft" &&
              new Date(t.executedAt).getUTCFullYear() === targetYear,
          );
        const byInstrument = new Map<
          string,
          { symbol: string; currency: string; net: number; tax: number }
        >();
        for (const t of incomeTxns) {
          const qty = Number(t.quantity);
          const net = (qty > 0 ? qty * Number(t.price) : Number(t.price)) - Number(t.fees ?? 0);
          const key = `${t.instrumentId ?? t.description ?? t.type}:${t.currency}`;
          const symbol = t.instrument?.symbol ?? t.description ?? t.type;
          const bucket = byInstrument.get(key) ?? { symbol, currency: t.currency, net: 0, tax: 0 };
          bucket.net += net;
          bucket.tax += Number(t.tax ?? 0);
          byInstrument.set(key, bucket);
        }
        const dividendRows: TaxDividendRow[] = [...byInstrument.values()].map((b) => ({
          symbol: b.symbol,
          currency: b.currency,
          gross: (b.net + b.tax).toFixed(2),
          tax: b.tax.toFixed(2),
          net: b.net.toFixed(2),
        }));
        const totalsByCurrencyMap = new Map<string, { gross: number; tax: number; net: number }>();
        for (const r of dividendRows) {
          const t = totalsByCurrencyMap.get(r.currency) ?? { gross: 0, tax: 0, net: 0 };
          t.gross += Number(r.gross);
          t.tax += Number(r.tax);
          t.net += Number(r.net);
          totalsByCurrencyMap.set(r.currency, t);
        }
        const dividendTotalsByCurrency: TaxCurrencyTotal[] = [...totalsByCurrencyMap.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([currency, t]) => ({
            currency,
            gross: t.gross.toFixed(2),
            tax: t.tax.toFixed(2),
            net: t.net.toFixed(2),
          }));

        // By year: union of years with realized gains or dividend/interest income, newest
        // first. See the doc comment above for the estimate's known limits.
        const taxRate = Number(entry.allowanceUsage.taxRate);
        const allowanceAnnual = Number(entry.allowanceUsage.allowanceAnnual);
        const years = new Set<number>([
          ...tradeLog.realizedByYear.map((r) => r.year),
          ...tradeLog.dividendsByYear.map((d) => d.year),
        ]);
        const byYear: TaxYearRow[] = [...years].sort((a, b) => b - a).map((y) => {
          if (y === entry.year) {
            // Ties out to the hero card / allowanceUsage figures already on screen.
            // Backend-computed (u.taxableExcess) — see tax/page.tsx's identical comment.
            const u = entry.allowanceUsage;
            const taxable = Number(u.taxableExcess);
            return {
              year: y,
              realized: u.realizedGainsAdjusted,
              dividends: u.incomeYtd,
              tax: (taxable * taxRate).toFixed(2),
              fsaUsed: u.usedYtd,
            };
          }

          const realized = tradeLog.realizedByYear.find((r) => r.year === y)?.amount ?? "0";
          const divEntry = tradeLog.dividendsByYear.find((d) => d.year === y);
          const dividendsGross = divEntry ? Number(divEntry.amount) + Number(divEntry.tax) : 0;
          const taxable = Math.max(0, Number(realized) + dividendsGross - allowanceAnnual);
          // FSA-used estimate for a non-selected year: the allowance-consuming complement
          // of `taxable` above (same inputs, no Teilfreistellung/Vorabpauschale/loss-pot
          // precision — see this file's loadTaxYearDetail doc comment for the caveat this
          // inherits), clamped to the annual cap since usage can never exceed it.
          const fsaUsed = Math.min(allowanceAnnual, Math.max(0, Number(realized) + dividendsGross));
          return {
            year: y,
            realized,
            dividends: dividendsGross.toFixed(2),
            tax: (taxable * taxRate).toFixed(2),
            fsaUsed: fsaUsed.toFixed(2),
          };
        });

        // Indonesian "By year" rollup: per-year sale PROCEEDS (not gain) across every
        // year the trade log covers, plus per-year dividend GROSS — both needed by
        // `indonesianFinalTax`'s multi-year table (see TaxYearDetail.idByYear's doc
        // comment). Computed unconditionally (cheap); only consumed under ID.
        const proceedsByYearMap = new Map<number, number>();
        for (const t of tradeLog.trades) {
          for (const l of t.legs) {
            proceedsByYearMap.set(
              l.taxYear,
              (proceedsByYearMap.get(l.taxYear) ?? 0) + Number(l.proceeds),
            );
          }
        }
        const idYears = new Set<number>([
          ...proceedsByYearMap.keys(),
          ...tradeLog.dividendsByYear.map((d) => d.year),
          ...tradeLog.realizedByYear.map((r) => r.year),
        ]);
        const idByYear: IdYearInput[] = [...idYears].map((y) => {
          const divEntry = tradeLog.dividendsByYear.find((d) => d.year === y);
          const dividendGross = divEntry ? Number(divEntry.amount) + Number(divEntry.tax) : 0;
          const realized = tradeLog.realizedByYear.find((r) => r.year === y)?.amount ?? "0";
          return {
            year: y,
            proceeds: (proceedsByYearMap.get(y) ?? 0).toFixed(2),
            dividendGross: dividendGross.toFixed(2),
            realized,
          };
        });

        result.set(holderId, {
          currency: tradeLog.displayCurrency,
          disposals: legs,
          totalProceeds: totalProceeds.toFixed(2),
          totalGain: totalGain.toFixed(2),
          dividendRows,
          dividendTotalsByCurrency,
          byYear,
          idByYear,
        });
      } catch {
        // Best-effort per holder — omit the new sections for this holder on failure,
        // the rest of the tax page (allowanceUsage, harvest suggestions) is unaffected.
      }
    }),
  );

  return result;
}
