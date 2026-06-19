import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { Portfolio, TrConnection } from "@portfolio/api-client";
import messages from "../messages/en.json";

const refresh = vi.fn();
const createPortfolio = vi.fn(async () => ({
  id: "p-new",
  name: "Test",
  baseCurrency: "IDR",
  portfolioType: "standard",
  birthYear: null,
  brokerage: null,
  accountHolder: null, accountNumber: null,
  userId: "u1",
}) as unknown as Portfolio);
const updatePortfolio = vi.fn(async () => ({}) as never);
const deletePortfolio = vi.fn(async () => undefined);
const getTrConnection = vi.fn(
  async (): Promise<TrConnection> => ({
    status: "disconnected",
    portfolioId: null,
    lastSyncAt: null,
    lastError: null,
    importCategories: null,
    lastReconciliation: null,
  }),
);

vi.mock("@/i18n/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/lib/api", () => ({
  useApiClient: () => ({ createPortfolio, updatePortfolio, deletePortfolio, getTrConnection }),
}));

import { PortfolioFormDialog, type EditablePortfolio } from "../src/components/portfolio-form-dialog";
import { Button } from "../src/components/ui/button";

const m = messages.PortfolioForm;

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
    portfolioType: "standard",
    birthYear: null,
    brokerage: null,
    accountHolder: null, accountNumber: null,
    includeInAggregate: true,
    cashCounted: false,
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
    document.cookie = "pf=; max-age=0; path=/";
  });

  it("creates a standard portfolio with the entered name and currency", async () => {
    renderCreate();
    fireEvent.click(screen.getByRole("button", { name: m.new }));

    fireEvent.change(screen.getByLabelText(m.name), { target: { value: "Stockbit" } });
    fireEvent.click(screen.getByRole("button", { name: m.create }));

    await waitFor(() => expect(createPortfolio).toHaveBeenCalled());
    expect(createPortfolio).toHaveBeenCalledWith({
      name: "Stockbit",
      baseCurrency: "IDR",
      portfolioType: "standard",
      birthYear: null,
      brokerage: null,
      accountHolder: null, accountNumber: null,
      includeInAggregate: true,
      cashCounted: false,
    });
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
      baseCurrency: "IDR",
      portfolioType: "standard",
      birthYear: null,
      brokerage: "Interactive Brokers",
      accountHolder: null, accountNumber: null,
      includeInAggregate: true,
      cashCounted: false,
    });
  });

  it("captures the entered account holder name", async () => {
    renderCreate();
    fireEvent.click(screen.getByRole("button", { name: m.new }));

    fireEvent.change(screen.getByLabelText(m.name), { target: { value: "Kids Savings" } });
    fireEvent.change(screen.getByLabelText(m.accountHolder), { target: { value: "Emma" } });
    fireEvent.click(screen.getByRole("button", { name: m.create }));

    await waitFor(() => expect(createPortfolio).toHaveBeenCalled());
    expect(createPortfolio).toHaveBeenCalledWith({
      name: "Kids Savings",
      baseCurrency: "IDR",
      portfolioType: "standard",
      birthYear: null,
      brokerage: null,
      accountHolder: "Emma",
      accountNumber: null,
      includeInAggregate: true,
      cashCounted: false,
    });
  });

  it("hides the birth-year field until the type is set to child", async () => {
    renderCreate();
    fireEvent.click(screen.getByRole("button", { name: m.new }));

    expect(screen.queryByLabelText(m.birthYear)).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(m.type), { target: { value: "child" } });
    expect(screen.getByLabelText(m.birthYear)).toBeInTheDocument();
  });

  it("creates a child portfolio carrying its birth year", async () => {
    renderCreate();
    fireEvent.click(screen.getByRole("button", { name: m.new }));

    fireEvent.change(screen.getByLabelText(m.name), { target: { value: "Kid" } });
    fireEvent.change(screen.getByLabelText(m.type), { target: { value: "child" } });
    fireEvent.change(screen.getByLabelText(m.birthYear), { target: { value: "2017" } });
    fireEvent.click(screen.getByRole("button", { name: m.create }));

    await waitFor(() => expect(createPortfolio).toHaveBeenCalled());
    expect(createPortfolio).toHaveBeenCalledWith({
      name: "Kid",
      baseCurrency: "IDR",
      portfolioType: "child",
      birthYear: 2017,
      brokerage: null,
      accountHolder: null, accountNumber: null,
      includeInAggregate: true,
      cashCounted: false,
    });
  });

  it("edits an existing portfolio via PATCH", async () => {
    renderEdit();
    fireEvent.click(screen.getByRole("button", { name: m.edit }));

    fireEvent.change(screen.getByLabelText(m.name), { target: { value: "Growth" } });
    fireEvent.click(screen.getByRole("button", { name: m.save }));

    await waitFor(() => expect(updatePortfolio).toHaveBeenCalled());
    expect(updatePortfolio).toHaveBeenCalledWith("p1", {
      name: "Growth",
      baseCurrency: "IDR",
      portfolioType: "standard",
      birthYear: null,
      brokerage: null,
      accountHolder: null, accountNumber: null,
      includeInAggregate: true,
      cashCounted: false,
    });
    expect(refresh).toHaveBeenCalled();
  });

  it("deletes only after the two-step confirm", async () => {
    renderEdit();
    fireEvent.click(screen.getByRole("button", { name: m.edit }));

    fireEvent.click(screen.getByRole("button", { name: m.delete }));
    expect(deletePortfolio).not.toHaveBeenCalled();
    expect(screen.getByText(m.deleteWarning)).toBeInTheDocument();

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
      baseCurrency: "IDR",
      portfolioType: "standard",
      birthYear: null,
      brokerage: "Trade Republic",
      accountHolder: null, accountNumber: null,
      includeInAggregate: true,
      cashCounted: false,
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
      portfolioType: "standard",
      birthYear: null,
      brokerage: "Trade Republic",
      accountHolder: null, accountNumber: null,
      includeInAggregate: true,
      cashCounted: false,
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
      portfolioType: "child",
      birthYear: 2020,
      brokerage: "Trade Republic",
      accountHolder: null, accountNumber: null,
      includeInAggregate: true,
      cashCounted: false,
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
      portfolioType: "child",
      birthYear: 2020,
      brokerage: "Trade Republic",
      accountHolder: null, accountNumber: null,
      includeInAggregate: true,
      cashCounted: false,
    });
    fireEvent.click(screen.getByRole("button", { name: m.edit }));

    fireEvent.click(screen.getByRole("button", { name: m.save }));

    await waitFor(() => expect(updatePortfolio).toHaveBeenCalledWith("p-tr-kid", expect.anything()));
    // Dialog closed — the name field and Save button are gone.
    await waitFor(() => expect(screen.queryByLabelText(m.name)).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: m.save })).not.toBeInTheDocument();
  });

  it("keeps the dialog open after saving a standard TR account (connect section stays)", async () => {
    renderEdit({
      id: "p-tr",
      name: "TR Portfolio",
      baseCurrency: "EUR",
      portfolioType: "standard",
      brokerage: "Trade Republic",
      birthYear: null,
      accountHolder: null, accountNumber: null,
      includeInAggregate: true,
      cashCounted: false,
    });
    fireEvent.click(screen.getByRole("button", { name: m.edit }));

    fireEvent.click(screen.getByRole("button", { name: m.save }));

    await waitFor(() => expect(updatePortfolio).toHaveBeenCalledWith("p-tr", expect.anything()));
    // Dialog stays open so the user can pair — the TR section remains visible.
    expect(screen.getByText(m.trSectionTitle)).toBeInTheDocument();
    expect(screen.getByLabelText(m.name)).toBeInTheDocument();
  });

  it("does not show the TR section for a non-TR portfolio", async () => {
    renderEdit({
      id: "p1",
      name: "Stockbit",
      baseCurrency: "IDR",
      portfolioType: "standard",
      birthYear: null,
      brokerage: "Stockbit",
      accountHolder: null, accountNumber: null,
      includeInAggregate: true,
      cashCounted: false,
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
      portfolioType: "standard",
      birthYear: null,
      brokerage: "Trade Republic",
      accountHolder: null, accountNumber: null,
      includeInAggregate: true,
      cashCounted: false,
    });
    // Dialog is closed on mount — the fetch must be gated on `open`.
    expect(getTrConnection).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: m.edit }));
    await waitFor(() => expect(getTrConnection).toHaveBeenCalled());
  });

  it("shows the reconnect form for an expired connection (not a stuck loading spinner)", async () => {
    getTrConnection.mockResolvedValueOnce({
      status: "expired" as const,
      portfolioId: "p-tr",
      lastSyncAt: null,
      lastError: null,
      importCategories: null,
      lastReconciliation: null,
    });
    renderEdit({
      id: "p-tr",
      name: "TR Portfolio",
      baseCurrency: "EUR",
      portfolioType: "standard",
      birthYear: null,
      brokerage: "Trade Republic",
      accountHolder: null, accountNumber: null,
      includeInAggregate: true,
      cashCounted: false,
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
});
