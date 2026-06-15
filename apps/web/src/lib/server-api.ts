import "server-only";
import {
  createApiClient,
  type ApiClient,
  type Portfolio,
  type User,
  type NetWorth,
  type Instrument,
  type Candle,
  type CorporateAction,
} from "@portfolio/api-client";
import { auth } from "@/auth";

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
 * Resolve the user's active portfolio (the first for now) and run `fn` against
 * it, folding the three states every screen must handle into one result:
 * `unavailable` (not signed in / API down), `empty` (no portfolio yet), or `ok`.
 */
export async function loadPortfolio<T>(
  fn: (api: ApiClient, portfolio: Portfolio) => Promise<T>,
): Promise<PortfolioResult<T>> {
  const api = await getServerApi();
  if (!api) return { status: "unavailable" };
  try {
    const portfolios = await api.listPortfolios();
    const portfolio = portfolios[0];
    if (!portfolio) return { status: "empty" };
    const data = await fn(api, portfolio);
    return { status: "ok", portfolio, data };
  } catch {
    return { status: "unavailable" };
  }
}
