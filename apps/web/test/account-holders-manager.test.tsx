import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { AccountHolder } from "@portfolio/api-client";
import messages from "../messages/en.json";
import { AccountHoldersManager } from "../src/components/account-holders-manager";

const m = messages.AccountHolders;
const mf = messages.PortfolioForm;

function renderManager(holders: AccountHolder[] = []) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <AccountHoldersManager holders={holders} />
    </NextIntlClientProvider>,
  );
}

const emma: AccountHolder = {
  id: "h1",
  userId: "u1",
  name: "Emma",
  type: "child",
  birthYear: 2017,
  taxAllowanceAnnual: null,
  capitalGainsTaxRate: null,
  churchTax: null,
  taxResidence: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("AccountHoldersManager", () => {
  it("shows the empty state when there are no holders", () => {
    renderManager();
    expect(screen.getByText(m.empty)).toBeInTheDocument();
  });

  it("lists existing holders with their type and birth year", () => {
    renderManager([emma]);
    expect(screen.getByText("Emma")).toBeInTheDocument();
    expect(screen.getByText(`${mf.holderTypeChild} · 2017`)).toBeInTheDocument();
  });

  // Design (ProfileSettings.dc.html): each holder row is a `›`-chevron link to the inline
  // "Edit account holder" page — no `⋯` menu, no in-place dialog.
  it("links each holder row to its inline edit page", () => {
    renderManager([emma]);
    expect(screen.getByRole("link", { name: /Emma/ })).toHaveAttribute(
      "href",
      "/settings/portfolios/holder/h1",
    );
  });

  it('links "Add holder" to the inline create page', () => {
    renderManager();
    expect(screen.getByRole("link", { name: m.add })).toHaveAttribute(
      "href",
      "/settings/portfolios/holder/new",
    );
  });

  it("renders no overflow menu or dialog trigger on a holder row", () => {
    renderManager([emma]);
    expect(screen.queryByRole("button", { name: "More options" })).not.toBeInTheDocument();
  });
});
