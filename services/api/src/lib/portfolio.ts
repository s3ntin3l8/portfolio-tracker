import type { AccountHolder, Portfolio } from "@portfolio/db";

// The portfolio shape the API exposes. The stored row no longer carries
// portfolioType/birthYear/accountHolder — those derive from the linked account
// holder so they live in one place (see issue #207). We keep the same flat field
// names readers already use, sourced from the holder, plus accountHolderId.
export interface PortfolioWithHolder extends Portfolio {
  accountHolder: string | null;
  birthYear: number | null;
  portfolioType: "standard" | "child";
}

// Flatten a (portfolio, holder) join row into the public read shape. A portfolio
// with no holder reads as "standard" with no name/birth year.
export function flattenPortfolio(
  portfolio: Portfolio,
  holder: AccountHolder | null,
): PortfolioWithHolder {
  return {
    ...portfolio,
    accountHolder: holder?.name ?? null,
    birthYear: holder?.birthYear ?? null,
    portfolioType: holder?.type === "child" ? "child" : "standard",
  };
}

// drizzle keys a `.select()` join result by table name.
type JoinRow = { portfolios: Portfolio; account_holders: AccountHolder | null };

export const flattenJoinRow = (row: JoinRow): PortfolioWithHolder =>
  flattenPortfolio(row.portfolios, row.account_holders);
