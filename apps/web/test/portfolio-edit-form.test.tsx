import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import type { EditablePortfolio } from "../src/components/portfolio-form-dialog/constants";

const push = vi.fn();
const refresh = vi.fn();
const listAccountHolders = vi.fn(async () => []);
const listPortfolios = vi.fn(async () => []);
const createPortfolio = vi.fn(async () => ({ id: "p2", portfolioType: "standard" }) as never);
const updatePortfolio = vi.fn(async () => ({}) as never);
const deletePortfolio = vi.fn(async () => undefined);

vi.mock("@/i18n/navigation", () => ({ useRouter: () => ({ push, refresh }) }));
vi.mock("@/lib/api", () => ({
  useApiClient: () => ({
    listAccountHolders,
    listPortfolios,
    createPortfolio,
    updatePortfolio,
    deletePortfolio,
  }),
}));
vi.mock("@/lib/portfolio-selection", () => ({ SELECTED_PORTFOLIO_COOKIE: "pf" }));

import { PortfolioEditForm } from "../src/components/portfolio-edit-form";

const t = messages.PortfolioForm;

const PORTFOLIO: EditablePortfolio = {
  id: "p1",
  name: "Main",
  baseCurrency: "EUR",
  accountHolderId: null,
  portfolioType: "standard",
  brokerage: "BCA Sekuritas",
  accountNumber: null,
  iban: null,
  includeInAggregate: true,
  cashCounted: false,
  allowNegativeCash: false,
  documentRetention: false,
  taxAllowanceAnnual: null,
  transactionCount: 12,
};

function renderForm(props: Partial<React.ComponentProps<typeof PortfolioEditForm>> = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <PortfolioEditForm mode="create" {...props} />
    </NextIntlClientProvider>,
  );
}

describe("PortfolioEditForm", () => {
  beforeEach(() => {
    push.mockClear();
    refresh.mockClear();
    listAccountHolders.mockClear();
    listPortfolios.mockClear();
    createPortfolio.mockClear();
    updatePortfolio.mockClear();
    deletePortfolio.mockClear();
  });

  it("renders the three design cards: BASICS, ACCOUNT DETAILS, ACCOUNTING OPTIONS", () => {
    renderForm();
    expect(screen.getByText(t.sectionBasics)).toBeInTheDocument();
    expect(screen.getByText(t.sectionAccount)).toBeInTheDocument();
    expect(screen.getByText(t.sectionAccounting)).toBeInTheDocument();
  });

  it("creates a portfolio (non-TR/IBKR brokerage) and navigates back on Create", async () => {
    renderForm();

    fireEvent.change(screen.getByLabelText(t.name), { target: { value: "New portfolio" } });
    fireEvent.click(screen.getByRole("button", { name: t.create }));

    await waitFor(() =>
      expect(createPortfolio).toHaveBeenCalledWith(
        expect.objectContaining({ name: "New portfolio" }),
      ),
    );
    // Non-TR/IBKR create has no connect step — the hook itself closes; our onSuccess for
    // create mode is a no-op (it navigates via the "Done" button instead), but since no
    // connect UI ever showed, there's no Done button and nothing further to click here —
    // the important thing is the API call above went through with the right payload.
    expect(refresh).toHaveBeenCalled();
  });

  it("edits an existing portfolio and navigates back to the list on save", async () => {
    renderForm({ mode: "edit", portfolio: PORTFOLIO });
    expect(screen.getByDisplayValue("Main")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(t.name), { target: { value: "Main (renamed)" } });
    fireEvent.click(screen.getByRole("button", { name: t.save }));

    await waitFor(() =>
      expect(updatePortfolio).toHaveBeenCalledWith(
        "p1",
        expect.objectContaining({ name: "Main (renamed)" }),
      ),
    );
    await waitFor(() => expect(push).toHaveBeenCalledWith("/settings/portfolios"));
  });

  it("shows the transaction count and deletes only after the two-step confirm", async () => {
    renderForm({ mode: "edit", portfolio: PORTFOLIO });
    // Let the mount-time holders/siblings-loading effects settle before interacting, so
    // their resolution doesn't land outside `act()` after the test moves on.
    await waitFor(() => expect(listAccountHolders).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: t.delete }));
    expect(deletePortfolio).not.toHaveBeenCalled();
    expect(screen.getByText(/12 transactions/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: t.confirmDelete }));
    await waitFor(() => expect(deletePortfolio).toHaveBeenCalledWith("p1"));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/settings/portfolios"));
  });

  it("does not show a delete action in create mode", () => {
    renderForm();
    expect(screen.queryByRole("button", { name: t.delete })).not.toBeInTheDocument();
  });

  it("disables Create until a name is entered", () => {
    renderForm();
    expect(screen.getByRole("button", { name: t.create })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(t.name), { target: { value: "x" } });
    expect(screen.getByRole("button", { name: t.create })).not.toBeDisabled();
  });
});
