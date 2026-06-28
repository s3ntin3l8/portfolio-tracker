import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";

const refresh = vi.fn();
const deletePortfolio = vi.fn(async () => undefined);

vi.mock("@/i18n/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/lib/api", () => ({ useApiClient: () => ({ deletePortfolio }) }));
vi.mock("@/lib/portfolio-selection", () => ({ SELECTED_PORTFOLIO_COOKIE: "pf" }));

import { DeletePortfolioDialog } from "../src/components/delete-portfolio-dialog";

const BASE = {
  id: "p1",
  name: "Trade Republic",
  baseCurrency: "EUR" as const,
  accountHolderId: null,
  portfolioType: "standard" as const,
  brokerage: null,
  accountNumber: null,
  iban: null,
  includeInAggregate: true,
  cashCounted: false,
  documentRetention: false,
  taxAllowanceAnnual: null,
};

function renderDialog(transactionCount?: number) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <DeletePortfolioDialog
        portfolio={{ ...BASE, transactionCount }}
        trigger={<button type="button">open</button>}
      />
    </NextIntlClientProvider>,
  );
}

async function open() {
  fireEvent.click(screen.getByRole("button", { name: "open" }));
  return screen.findByRole("dialog");
}

describe("DeletePortfolioDialog", () => {
  beforeEach(() => {
    refresh.mockClear();
    deletePortfolio.mockClear();
  });

  it("pluralises the transaction count (many / one / zero)", async () => {
    const { unmount } = renderDialog(142);
    expect(await open()).toHaveTextContent("142 transactions");
    unmount();

    const one = renderDialog(1);
    expect(await open()).toHaveTextContent("1 transaction");
    expect(screen.getByRole("dialog")).not.toHaveTextContent("1 transactions");
    one.unmount();

    renderDialog(0);
    const zero = await open();
    expect(zero).toHaveTextContent(messages.PortfolioForm.deleteRelatedNote);
    expect(zero).not.toHaveTextContent("0 transaction");
  });

  it("deletes and refreshes on confirm, clearing a stale switcher cookie", async () => {
    // Cookie points at the portfolio being deleted → cleanup should reset it.
    document.cookie = "pf=p1";
    const dialog = await (renderDialog(3), open());
    expect(dialog).toHaveTextContent(messages.PortfolioForm.deleteRelatedNote);

    fireEvent.click(within(dialog).getByRole("button", { name: messages.PortfolioForm.confirmDelete }));
    await waitFor(() => expect(deletePortfolio).toHaveBeenCalledWith("p1"));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(document.cookie).not.toContain("pf=p1");
  });

  it("does not delete when cancelled", async () => {
    const dialog = await (renderDialog(3), open());
    fireEvent.click(within(dialog).getByRole("button", { name: messages.PortfolioForm.cancel }));
    expect(deletePortfolio).not.toHaveBeenCalled();
  });
});
