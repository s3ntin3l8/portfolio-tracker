/** Cookie holding the globally-selected portfolio id (or "all" / absent = aggregate). */
export const SELECTED_PORTFOLIO_COOKIE = "pf";

/**
 * Cookie value prefix for a holder-scoped aggregate.
 * Value format: `holder:<holderId>` — absent means "all" or a plain portfolio id.
 */
export const HOLDER_SCOPE_PREFIX = "holder:";

/**
 * Returns only the account holders that own ≥2 portfolios in the provided list.
 * A holder with a single portfolio is equivalent to selecting that portfolio
 * directly via the global switcher, so it doesn't qualify for the holder section.
 */
export function qualifyingHolders<
  P extends { accountHolderId?: string | null },
  H extends { id: string },
>(portfolios: P[], holders: H[]): H[] {
  const count = new Map<string, number>();
  for (const p of portfolios) {
    if (p.accountHolderId) {
      count.set(p.accountHolderId, (count.get(p.accountHolderId) ?? 0) + 1);
    }
  }
  return holders.filter((h) => (count.get(h.id) ?? 0) >= 2);
}
