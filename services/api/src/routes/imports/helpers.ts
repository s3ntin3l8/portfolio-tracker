import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { portfolios } from "@portfolio/db";

// Helpers shared by the import upload routes (imports.ts) and the confirm route
// (confirm.ts) — account-number matching and the owned-portfolio lookup — extracted so both
// can reuse them without one route module importing the other.

/** Fetch a portfolio by id, scoped to its owner; null when not found or not owned. */
export async function ownedPortfolio(
  app: FastifyInstance,
  userId: string,
  portfolioId: string,
) {
  const [p] = await app.db
    .select()
    .from(portfolios)
    .where(and(eq(portfolios.id, portfolioId), eq(portfolios.userId, userId)))
    .limit(1);
  return p ?? null;
}

/**
 * Normalize an account number for comparison: strip non-alphanumerics, lowercase.
 * Returns null when the input is empty/null so two blank values never match.
 */
export function normalizeAccountNumber(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const n = raw.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return n || null;
}

/**
 * Do two account identifiers refer to the same account? Exact normalized match, or a
 * suffix match (one is the tail of the other, ≥6 chars) so a full IBAN in one document
 * matches a short depot/Kontonummer in another (e.g. DKB IBAN `DE78…1066505387` vs the
 * stored Kontonummer `1066505387`). Blank on either side never matches.
 */
export function accountsMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeAccountNumber(a);
  const nb = normalizeAccountNumber(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const [short, long] = na.length <= nb.length ? [na, nb] : [nb, na];
  return short.length >= 6 && long.endsWith(short);
}

/**
 * Verdict on whether a file's detected account number conflicts with the *selected*
 * target portfolio (#197). Returns null when there's nothing to warn about (no detected
 * number, it matches the selected portfolio, or there's nothing comparable on either
 * side). Otherwise names the likely-owner portfolio (`other_portfolio`) or flags a soft
 * mismatch when the selected portfolio's own account number differs (`no_match`).
 */
export async function accountMismatchVerdict(
  app: FastifyInstance,
  userId: string,
  detected: string | null | undefined,
  selectedPortfolioId: string,
): Promise<
  | { kind: "other_portfolio"; matchedPortfolioId: string; matchedName: string; detected: string }
  | { kind: "no_match"; detected: string }
  | null
> {
  if (!normalizeAccountNumber(detected)) return null;
  const rows = await app.db
    .select({ id: portfolios.id, name: portfolios.name, accountNumber: portfolios.accountNumber })
    .from(portfolios)
    .where(eq(portfolios.userId, userId));
  const selected = rows.find((p) => p.id === selectedPortfolioId);
  if (selected && accountsMatch(selected.accountNumber, detected)) return null;
  const other = rows.find(
    (p) => p.id !== selectedPortfolioId && accountsMatch(p.accountNumber, detected),
  );
  if (other) {
    return {
      kind: "other_portfolio",
      matchedPortfolioId: other.id,
      matchedName: other.name,
      detected: detected as string,
    };
  }
  // No portfolio matches: warn only when the selected portfolio has its own (differing)
  // account number — otherwise there's nothing to compare against.
  if (selected?.accountNumber) return { kind: "no_match", detected: detected as string };
  return null;
}
