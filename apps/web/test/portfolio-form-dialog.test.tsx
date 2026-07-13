import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { AccountHolder, IbkrConnection, Portfolio, TrConnection } from "@portfolio/api-client";
import messages from "../messages/en.json";

const refresh = vi.fn();
const createPortfolio = vi.fn(async () => ({
  id: "p-new",
  name: "Test",
  baseCurrency: "IDR",
  accountHolderId: null,
  portfolioType: "standard",
  birthYear: null,
  brokerage: null,
  accountHolder: null,
  accountNumber: null,
  userId: "u1",
}) as unknown as Portfolio);
const updatePortfolio = vi.fn(async () => ({}) as never);
const deletePortfolio = vi.fn(async () => undefined);
// Holders the picker offers, and the holder created when the user adds one inline.
const listAccountHolders = vi.fn(async (): Promise<AccountHolder[]> => []);
const listPortfolios = vi.fn(async (): Promise<Portfolio[]> => []);
const createAccountHolder = vi.fn(
  async (input: { name: string; type: string; birthYear: number | null }): Promise<AccountHolder> => ({
    id: "h-new",
    userId: "u1",
    name: input.name,
    type: input.type as AccountHolder["type"],
    birthYear: input.birthYear,
    taxAllowanceAnnual: null,
    capitalGainsTaxRate: null,
    churchTax: null,
    taxResidence: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  }),
);
const getTrConnection = vi.fn(
  async (): Promise<TrConnection> => ({
    status: "disconnected",
    portfolioId: null,
    lastSyncAt: null,
    lastError: null,
    lastReconciliation: null,
    syncing: false,
  }),
);
const getIbkrConnection = vi.fn(
  async (): Promise<IbkrConnection> => ({
    status: "disconnected",
    portfolioId: null,
    flexAccountId: null,
    lastSyncAt: null,
    lastError: null,
    lastReconciliation: null,
    syncing: false,
  }),
);

vi.mock("@/i18n/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/lib/api", () => ({
  useApiClient: () => ({
    createPortfolio,
    updatePortfolio,
    deletePortfolio,
    getTrConnection,
    getIbkrConnection,
    listAccountHolders,
    listPortfolios,
    createAccountHolder,
  }),
}));

import { PortfolioFormDialog, type EditablePortfolio } from "../src/components/portfolio-form-dialog";
import { Button } from "../src/components/ui/button";

const m = messages.PortfolioForm;

// The standard create payload the form sends (no holder picked).
const baseInput = {
  baseCurrency: "IDR",
  accountHolderId: null,
  brokerage: null,
  accountNumber: null,
  iban: null,
  includeInAggregate: true,
  cashCounted: false,
  allowNegativeCash: false,
  documentRetention: false,
  taxAllowanceAnnual: null,
};

function renderCreate() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <PortfolioFormDialog mode="create" trigger={<Button>{m.new}</Button>} />
    </NextIntlClientProvider>,
  );
}

function renderEdit(
  portfolio: EditablePortfolio = {
    id: "p1",
    name: "Main",
    baseCurrency: "IDR",
    accountHolderId: null,
    portfolioType: "standard",
    brokerage: null,
    accountNumber: null,
    iban: null,
    includeInAggregate: true,
    cashCounted: false,
    allowNegativeCash: false,
    documentRetention: false,
    taxAllowanceAnnual: null,
  },
) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <PortfolioFormDialog
        mode="edit"
        portfolio={portfolio}
        trigger={<Button>{m.edit}</Button>}
      />
    </NextIntlClientProvider>,
  );
}

describe("PortfolioFormDialog", () => {
  beforeEach(() => {
    refresh.mockClear();
    createPortfolio.mockClear();
    updatePortfolio.mockClear();
    deletePortfolio.mockClear();
    getTrConnection.mockClear();
    getIbkrConnection.mockClear();
    listAccountHolders.mockClear();
    listAccountHolders.mockResolvedValue([]);
    listPortfolios.mockClear();
    listPortfolios.mockResolvedValue([]);
    createAccountHolder.mockClear();
    document.cookie = "pf=; max-age=0; path=/";
  });

  it("creates a standard portfolio with the entered name and currency", async () => {
    renderCreate();
    fireEvent.click(screen.getByRole("button", { name: m.new }));

    fireEvent.change(screen.getByLabelText(m.name), { target: { value: "Stockbit" } });
    fireEvent.click(screen.getByRole("button", { name: m.create }));

    await waitFor(() => expect(createPortfolio).toHaveBeenCalled());
    expect(createPortfolio).toHaveBeenCalledWith({ name: "Stockbit", ...baseInput });
    expect(refresh).toHaveBeenCalled();
  });

  it("captures the entered brokerage", async () => {
    renderCreate();
    fireEvent.click(screen.getByRole("button", { name: m.new }));

    fireEvent.change(screen.getByLabelText(m.name), { target: { value: "Euro" } });
    fireEvent.change(screen.getByLabelText(m.brokerage), {
      target: { value: "Interactive Brokers" },
    });
    fireEvent.click(screen.getByRole("button", { name: m.create }));

    await waitFor(() => expect(createPortfolio).toHaveBeenCalled());
    expect(createPortfolio).toHaveBeenCalledWith({
      name: "Euro",
      ...baseInput,
      brokerage: "Interactive Brokers",
    });
  });

  it("links an existing account holder when one is picked", async () => {
    listAccountHolders.mockResolvedValue([
      { id: "h1", userId: "u1", name: "Emma", type: "child", birthYear: 2017, taxAllowanceAnnual: null, capitalGainsTaxRate: null, churchTax: null, taxResidence: null, createdAt: "x" },
    ]);
    renderCreate();
    fireEvent.click(screen.getByRole("button", { name: m.new }));
    // Wait for the picker to be populated from listAccountHolders.
    await screen.findByRole("option", { name: /Emma/ });

    fireEvent.change(screen.getByLabelText(m.name), { target: { value: "Kids Savings" } });
    fireEvent.change(screen.getByLabelText(m.accountHolder), { target: { value: "h1" } });
    fireEvent.click(screen.getByRole("button", { name: m.create }));

    await waitFor(() => expect(createPortfolio).toHaveBeenCalled());
    expect(createPortfolio).toHaveBeenCalledWith({
      name: "Kids Savings",
      ...baseInput,
      accountHolderId: "h1",
    });
    expect(createAccountHolder).not.toHaveBeenCalled();
  });

  it("reveals the birth-year field only when a new child holder is being added", async () => {
    renderCreate();
    fireEvent.click(screen.getByRole("button", { name: m.new }));

    expect(screen.queryByLabelText(m.holderName)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(m.birthYear)).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(m.accountHolder), { target: { value: "__new__" } });
    expect(screen.getByLabelText(m.holderName)).toBeInTheDocument();
    // Default type is "self" → no birth year yet.
    expect(screen.queryByLabelText(m.birthYear)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: m.holderTypeChild }));
    expect(screen.getByLabelText(m.birthYear)).toBeInTheDocument();
  });

  it("creates a new child holder inline and links it to the portfolio", async () => {
    renderCreate();
    fireEvent.click(screen.getByRole("button", { name: m.new }));

    fireEvent.change(screen.getByLabelText(m.name), { target: { value: "Kid" } });
    fireEvent.change(screen.getByLabelText(m.accountHolder), { target: { value: "__new__" } });
    fireEvent.change(screen.getByLabelText(m.holderName), { target: { value: "Luca" } });
    fireEvent.click(screen.getByRole("radio", { name: m.holderTypeChild }));
    fireEvent.change(screen.getByLabelText(m.birthYear), { target: { value: "2017" } });
    fireEvent.click(screen.getByRole("button", { name: m.create }));

    await waitFor(() => expect(createAccountHolder).toHaveBeenCalledWith({
      name: "Luca",
      type: "child",
      birthYear: 2017,
    }));
    await waitFor(() => expect(createPortfolio).toHaveBeenCalledWith({
      name: "Kid",
      ...baseInput,
      accountHolderId: "h-new",
    }));
  });

  it("edits an existing portfolio via PATCH", async () => {
    renderEdit();
    fireEvent.click(screen.getByRole("button", { name: m.edit }));

    fireEvent.change(screen.getByLabelText(m.name), { target: { value: "Growth" } });
    fireEvent.click(screen.getByRole("button", { name: m.save }));

    await waitFor(() => expect(updatePortfolio).toHaveBeenCalled());
    expect(updatePortfolio).toHaveBeenCalledWith("p1", { name: "Growth", ...baseInput });
    expect(refresh).toHaveBeenCalled();
  });

  it("deletes only after the two-step confirm", async () => {
    renderEdit();
    fireEvent.click(screen.getByRole("button", { name: m.edit }));

    fireEvent.click(screen.getByRole("button", { name: m.delete }));
    expect(deletePortfolio).not.toHaveBeenCalled();
    expect(screen.getByText(new RegExp(m.deleteRelatedNote))).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: m.confirmDelete }));
    await waitFor(() => expect(deletePortfolio).toHaveBeenCalledWith("p1"));
    expect(refresh).toHaveBeenCalled();
  });

  it("shows a hint in create mode when brokerage is Trade Republic (save first)", async () => {
    renderCreate();
    fireEvent.click(screen.getByRole("button", { name: m.new }));

    fireEvent.change(screen.getByLabelText(m.brokerage), {
      target: { value: "Trade Republic" },
    });

    expect(screen.getByText(m.trConnectAfterSave)).toBeInTheDocument();
  });

  it("stays open and shows TR section after creating a Trade Republic portfolio", async () => {
    renderCreate();
    fireEvent.click(screen.getByRole("button", { name: m.new }));

    fireEvent.change(screen.getByLabelText(m.name), { target: { value: "TR Portfolio" } });
    fireEvent.change(screen.getByLabelText(m.brokerage), {
      target: { value: "Trade Republic" },
    });
    fireEvent.click(screen.getByRole("button", { name: m.create }));

    await waitFor(() => expect(createPortfolio).toHaveBeenCalledWith({
      name: "TR Portfolio",
      ...baseInput,
      brokerage: "Trade Republic",
    }));
    // Dialog stays open — TR section appears with Done button (no create button anymore)
    await waitFor(() =>
      expect(screen.getByRole("button", { name: m.done })).toBeInTheDocument(),
    );
    // TR section title is visible
    expect(screen.getByText(m.trSectionTitle)).toBeInTheDocument();
    // The TR connect form is fetching the connection
    expect(getTrConnection).toHaveBeenCalled();
  });

  it("shows the TR connect section immediately in edit mode for a TR portfolio", async () => {
    renderEdit({
      id: "p-tr",
      name: "TR Portfolio",
      baseCurrency: "EUR",
      accountHolderId: null,
      portfolioType: "standard",
      brokerage: "Trade Republic",
      accountNumber: null,
      iban: null,
      includeInAggregate: true,
      cashCounted: false,
      allowNegativeCash: false,
      documentRetention: false,
      taxAllowanceAnnual: null,
    });
    fireEvent.click(screen.getByRole("button", { name: m.edit }));

    // TR section is fetched and rendered
    await waitFor(() => expect(getTrConnection).toHaveBeenCalled());
    expect(screen.getByText(m.trSectionTitle)).toBeInTheDocument();
    // The connect form's phone field should appear (disconnected initial state)
    await waitFor(() =>
      expect(screen.getByLabelText(messages.TradeRepublic.phone)).toBeInTheDocument(),
    );
  });

  it("does not offer the TR connection for a TR child account (Kinderdepot)", async () => {
    renderEdit({
      id: "p-tr-kid",
      name: "TR Kinderdepot",
      baseCurrency: "EUR",
      accountHolderId: "h-kid",
      portfolioType: "child",
      brokerage: "Trade Republic",
      accountNumber: null,
      iban: null,
      includeInAggregate: true,
      cashCounted: false,
      allowNegativeCash: false,
      documentRetention: false,
      taxAllowanceAnnual: null,
    });
    fireEvent.click(screen.getByRole("button", { name: m.edit }));

    // The connect section is suppressed and an explanatory note is shown instead.
    expect(screen.getByText(m.trChildUnsupported)).toBeInTheDocument();
    expect(screen.queryByText(m.trSectionTitle)).not.toBeInTheDocument();
    expect(getTrConnection).not.toHaveBeenCalled();
  });

  it("closes the dialog after saving a TR child account (no TR section to keep open)", async () => {
    renderEdit({
      id: "p-tr-kid",
      name: "TR Kinderdepot",
      baseCurrency: "EUR",
      accountHolderId: "h-kid",
      portfolioType: "child",
      brokerage: "Trade Republic",
      accountNumber: null,
      iban: null,
      includeInAggregate: true,
      cashCounted: false,
      allowNegativeCash: false,
      documentRetention: false,
      taxAllowanceAnnual: null,
    });
    fireEvent.click(screen.getByRole("button", { name: m.edit }));

    fireEvent.click(screen.getByRole("button", { name: m.save }));

    await waitFor(() => expect(updatePortfolio).toHaveBeenCalledWith("p-tr-kid", expect.anything()));
    // Dialog closed — the name field and Save button are gone.
    await waitFor(() => expect(screen.queryByLabelText(m.name)).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: m.save })).not.toBeInTheDocument();
  });

  it("closes the dialog after saving a standard TR account in edit mode", async () => {
    renderEdit({
      id: "p-tr",
      name: "TR Portfolio",
      baseCurrency: "EUR",
      accountHolderId: null,
      portfolioType: "standard",
      brokerage: "Trade Republic",
      accountNumber: null,
      iban: null,
      includeInAggregate: true,
      cashCounted: false,
      allowNegativeCash: false,
      documentRetention: false,
      taxAllowanceAnnual: null,
    });
    fireEvent.click(screen.getByRole("button", { name: m.edit }));

    fireEvent.click(screen.getByRole("button", { name: m.save }));

    await waitFor(() => expect(updatePortfolio).toHaveBeenCalledWith("p-tr", expect.anything()));
    // Dialog closes after saving in edit mode (TR section only stays for create-then-connect).
    await waitFor(() => expect(screen.queryByLabelText(m.name)).not.toBeInTheDocument());
    expect(screen.queryByText(m.trSectionTitle)).not.toBeInTheDocument();
  });

  it("does not show the TR section for a non-TR portfolio", async () => {
    renderEdit({
      id: "p1",
      name: "Stockbit",
      baseCurrency: "IDR",
      accountHolderId: null,
      portfolioType: "standard",
      brokerage: "Stockbit",
      accountNumber: null,
      iban: null,
      includeInAggregate: true,
      cashCounted: false,
      allowNegativeCash: false,
      documentRetention: false,
      taxAllowanceAnnual: null,
    });
    fireEvent.click(screen.getByRole("button", { name: m.edit }));

    expect(screen.queryByText(m.trSectionTitle)).not.toBeInTheDocument();
    expect(getTrConnection).not.toHaveBeenCalled();
  });

  it("does not fetch the TR connection until the dialog is opened", async () => {
    renderEdit({
      id: "p-tr",
      name: "TR Portfolio",
      baseCurrency: "EUR",
      accountHolderId: null,
      portfolioType: "standard",
      brokerage: "Trade Republic",
      accountNumber: null,
      iban: null,
      includeInAggregate: true,
      cashCounted: false,
      allowNegativeCash: false,
      documentRetention: false,
      taxAllowanceAnnual: null,
    });
    // Dialog is closed on mount — the fetch must be gated on `open`.
    expect(getTrConnection).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: m.edit }));
    await waitFor(() => expect(getTrConnection).toHaveBeenCalled());
  });

  // ---------------------------------------------------------------------------
  // FSA allocation helper tests
  // ---------------------------------------------------------------------------

  it("shows the FSA allocation helper when a holder with sibling portfolios is selected", async () => {
    // Holder "FSA Holder" has a €1,000 cap; one sibling portfolio has €600 FSA allocated.
    listAccountHolders.mockResolvedValue([
      {
        id: "h-fsa",
        userId: "u1",
        name: "FSA Holder",
        type: "self",
        birthYear: null,
        taxAllowanceAnnual: "1000",
        capitalGainsTaxRate: null,
        churchTax: null,
        taxResidence: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    listPortfolios.mockResolvedValue([
      {
        id: "p-sibling",
        name: "Depot A",
        baseCurrency: "EUR",
        accountHolderId: "h-fsa",
        portfolioType: "standard",
        brokerage: null,
        accountNumber: null,
        includeInAggregate: true,
        cashCounted: false,
        allowNegativeCash: false,
        documentRetention: false,
        taxAllowanceAnnual: "600",
        userId: "u1",
      } as unknown as Portfolio,
    ]);

    renderCreate();
    fireEvent.click(screen.getByRole("button", { name: m.new }));

    // Wait for holders to load (from open), then select the holder.
    await screen.findByRole("option", { name: /FSA Holder/ });
    fireEvent.change(screen.getByLabelText(m.accountHolder), { target: { value: "h-fsa" } });

    // Helper text should show the sibling allocation vs. cap.
    await waitFor(() =>
      expect(screen.getByText(/€600 of €1000 cap allocated/)).toBeInTheDocument(),
    );
    // Remaining should be €400 (1000 - 600 = 400).
    expect(screen.getByText(/€400 left/)).toBeInTheDocument();
  });

  it("shows the over-allocation warning when entered FSA would exceed the holder cap", async () => {
    listAccountHolders.mockResolvedValue([
      {
        id: "h-fsa2",
        userId: "u1",
        name: "Over Holder",
        type: "self",
        birthYear: null,
        taxAllowanceAnnual: "1000",
        capitalGainsTaxRate: null,
        churchTax: null,
        taxResidence: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    // Sibling already has €600 allocated; typing €500 more pushes total to €1,100.
    listPortfolios.mockResolvedValue([
      {
        id: "p-sib2",
        name: "Depot B",
        baseCurrency: "EUR",
        accountHolderId: "h-fsa2",
        portfolioType: "standard",
        brokerage: null,
        accountNumber: null,
        includeInAggregate: true,
        cashCounted: false,
        allowNegativeCash: false,
        documentRetention: false,
        taxAllowanceAnnual: "600",
        userId: "u1",
      } as unknown as Portfolio,
    ]);

    renderCreate();
    fireEvent.click(screen.getByRole("button", { name: m.new }));

    await screen.findByRole("option", { name: /Over Holder/ });
    fireEvent.change(screen.getByLabelText(m.accountHolder), { target: { value: "h-fsa2" } });

    // Wait for sibling portfolios to resolve (the helper appears first).
    await waitFor(() =>
      expect(screen.getByText(/€600 of €1000 cap allocated/)).toBeInTheDocument(),
    );

    // Enter a value that pushes the total over €1,000.
    fireEvent.change(screen.getByLabelText(m.taxAllowanceAnnual), { target: { value: "500" } });

    // The over-allocation warning should replace the helper.
    await waitFor(() =>
      expect(
        screen.getByText(/Total allocation exceeds the €1000 cap/),
      ).toBeInTheDocument(),
    );
    // Normal helper text should be gone.
    expect(screen.queryByText(/€400 left/)).not.toBeInTheDocument();
  });

  it("shows the reconnect form for an expired connection (not a stuck loading spinner)", async () => {
    getTrConnection.mockResolvedValueOnce({
      status: "expired" as const,
      portfolioId: "p-tr",
      lastSyncAt: null,
      lastError: null,
      lastReconciliation: null,
      syncing: false,
    });
    renderEdit({
      id: "p-tr",
      name: "TR Portfolio",
      baseCurrency: "EUR",
      accountHolderId: null,
      portfolioType: "standard",
      brokerage: "Trade Republic",
      accountNumber: null,
      iban: null,
      includeInAggregate: true,
      cashCounted: false,
      allowNegativeCash: false,
      documentRetention: false,
      taxAllowanceAnnual: null,
    });
    fireEvent.click(screen.getByRole("button", { name: m.edit }));

    // The expired status resolves into the reconnect form with the expired hint…
    await waitFor(() =>
      expect(screen.getByLabelText(messages.TradeRepublic.phone)).toBeInTheDocument(),
    );
    expect(screen.getByText(messages.TradeRepublic.expiredHint)).toBeInTheDocument();
    // …and the loading placeholder is gone (not stuck).
    expect(screen.queryByText(m.trLoading)).not.toBeInTheDocument();
  });

  // Regression test for #472: the submit button is sticky-pinned in the sheet context
  it("wraps the submit button in a sticky footer", () => {
    renderCreate();
    fireEvent.click(screen.getByRole("button", { name: m.new }));
    const submitBtn = screen.getByRole("button", { name: m.create });
    expect(submitBtn.closest(".sticky")).not.toBeNull();
  });

  // Regression test for #472: FSA helper is not rendered on mount when no holder is selected
  it("does not render the FSA helper on mount when no holder is selected", async () => {
    renderCreate();
    fireEvent.click(screen.getByRole("button", { name: m.new }));
    // Wait for async calls (holders/sibling portfolios) to resolve
    await waitFor(() => expect(listAccountHolders).toHaveBeenCalled());
    expect(screen.queryByText(/across/)).toBeNull();
  });
});
