import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";

const search = { value: "" };

// next/navigation's useSearchParams drives the auto-open effect.
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(search.value),
}));

const replace = vi.fn();
vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ replace }),
  usePathname: () => "/transactions",
}));

const listPortfolios = vi.fn(
  async () =>
    [] as { id: string; name: string; brokerage: string | null; accountHolder: string | null }[],
);
const listAccountHolders = vi.fn(async () => [] as { id: string; name: string }[]);
const getInstrument = vi.fn();
const getSummary = vi.fn();
vi.mock("@/lib/api", () => ({
  useApiClient: () => ({ listPortfolios, listAccountHolders, getInstrument, getSummary }),
}));

// Stub the heavy flows — we only assert the right step/sheet renders.
vi.mock("@/components/import-flow-client", () => ({
  ImportFlowClient: () => <div data-testid="import-flow" />,
}));
// Captures the props NewEntryTabs was last rendered with, so deep-link tests can assert
// the tab/prefill actually threaded through rather than just that the sheet opened.
const lastEntryTabsProps = { current: null as Record<string, unknown> | null };
vi.mock("@/components/new-entry-tabs", () => ({
  NewEntryTabs: (props: Record<string, unknown>) => {
    lastEntryTabsProps.current = props;
    return <div data-testid="entry-tabs" />;
  },
}));

import { AddTransactionMenu } from "../src/components/add-transaction-menu";

function renderMenu(props: { autoOpenFromParams?: boolean } = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <AddTransactionMenu {...props} />
    </NextIntlClientProvider>,
  );
}

function openMenu() {
  fireEvent.click(screen.getByRole("button", { name: messages.Manage.addTransaction }));
}

describe("AddTransactionMenu", () => {
  beforeEach(() => {
    search.value = "";
    replace.mockClear();
    listPortfolios.mockClear();
    listPortfolios.mockResolvedValue([]);
    listAccountHolders.mockClear();
    listAccountHolders.mockResolvedValue([]);
    getInstrument.mockReset();
    getSummary.mockReset();
    lastEntryTabsProps.current = null;
  });

  it("opens the add sheet with the three reference method cards", () => {
    renderMenu();
    openMenu();

    expect(screen.getByRole("dialog", { name: messages.Manage.addMenu.title })).toBeInTheDocument();
    expect(screen.getByText(messages.Manage.addMenu.screenshot)).toBeInTheDocument();
    expect(screen.getByText(messages.Manage.addMenu.recommended)).toBeInTheDocument();
    expect(screen.getByText(messages.Manage.addMenu.csv)).toBeInTheDocument();
    expect(screen.getByText(messages.Manage.addMenu.manual)).toBeInTheDocument();
  });

  it("swaps to the in-sheet manual entry tabs from the manual card", async () => {
    renderMenu();
    openMenu();
    fireEvent.click(screen.getByText(messages.Manage.addMenu.manual));
    await waitFor(() => expect(screen.getByTestId("entry-tabs")).toBeInTheDocument());
    // ...and a back button returns to the method cards.
    fireEvent.click(screen.getByRole("button", { name: messages.Manage.back }));
    expect(screen.getByText(messages.Manage.addMenu.screenshot)).toBeInTheDocument();
  });

  it("opens the import sheet from the screenshot card and closes the add sheet", async () => {
    renderMenu();
    openMenu();
    fireEvent.click(screen.getByText(messages.Manage.addMenu.screenshot));

    await waitFor(() =>
      expect(screen.getByRole("dialog", { name: messages.Import.title })).toBeInTheDocument(),
    );
    expect(
      screen.queryByRole("dialog", { name: messages.Manage.addMenu.title }),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("import-flow")).toBeInTheDocument();
  });

  // Regression test for #471: the CSV card called the same `openImport()` path as
  // screenshot but closing one Drawer.Root and opening a second in the same tick raced
  // vaul's body-scroll-lock cleanup, so the import sheet never became interactive.
  it("opens the import sheet from the CSV card too", async () => {
    renderMenu();
    openMenu();
    fireEvent.click(screen.getByText(messages.Manage.addMenu.csv));

    await waitFor(() =>
      expect(screen.getByRole("dialog", { name: messages.Import.title })).toBeInTheDocument(),
    );
    expect(screen.getByTestId("import-flow")).toBeInTheDocument();
  });

  it("returns from the import step to the method cards via back, without closing the sheet", async () => {
    renderMenu();
    openMenu();
    fireEvent.click(screen.getByText(messages.Manage.addMenu.screenshot));
    await waitFor(() =>
      expect(screen.getByRole("dialog", { name: messages.Import.title })).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: messages.Manage.back }));

    expect(screen.getByRole("dialog", { name: messages.Manage.addMenu.title })).toBeInTheDocument();
    expect(screen.getByText(messages.Manage.addMenu.csv)).toBeInTheDocument();
  });

  it("keeps the import sheet closed without a share/import param", () => {
    renderMenu();
    expect(screen.queryByRole("dialog", { name: messages.Import.title })).not.toBeInTheDocument();
  });

  it("auto-opens the import sheet on ?import=1 and clears the flag", async () => {
    search.value = "import=1";
    renderMenu({ autoOpenFromParams: true });
    await waitFor(() =>
      expect(screen.getByRole("dialog", { name: messages.Import.title })).toBeInTheDocument(),
    );
    expect(replace).toHaveBeenCalledWith("/transactions");
  });

  it("auto-opens on ?shared=1 but leaves the param for ImportFlowClient", async () => {
    search.value = "shared=1";
    renderMenu({ autoOpenFromParams: true });
    await waitFor(() =>
      expect(screen.getByRole("dialog", { name: messages.Import.title })).toBeInTheDocument(),
    );
    expect(replace).not.toHaveBeenCalled();
  });

  it("ignores share/import params without autoOpenFromParams (only one instance owns it)", async () => {
    search.value = "import=1";
    renderMenu();
    await Promise.resolve();
    expect(screen.queryByRole("dialog", { name: messages.Import.title })).not.toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  describe("portfolio and account-holder shortcuts", () => {
    it("shows the Add portfolio card (always visible)", () => {
      renderMenu();
      openMenu();
      expect(screen.getByText(messages.Manage.addMenu.createPortfolio)).toBeInTheDocument();
    });

    it("shows the Add account holder card when no holders exist", async () => {
      listAccountHolders.mockResolvedValue([]);
      renderMenu();
      openMenu();

      // Initially hidden (hasHolders starts true), then appears after fetch.
      await waitFor(() =>
        expect(screen.getByText(messages.Manage.addMenu.createAccountHolder)).toBeInTheDocument(),
      );
    });

    it("hides the Add account holder card when holders already exist", async () => {
      listAccountHolders.mockResolvedValue([{ id: "h1", name: "Me" }]);
      renderMenu();
      openMenu();

      await waitFor(() => {
        expect(
          screen.queryByText(messages.Manage.addMenu.createAccountHolder),
        ).not.toBeInTheDocument();
      });
    });
  });

  // Deep-link params from the retired `/transactions/new` page's redirect + the tax
  // page's harvest CTA (#505 consolidation).
  describe("manual-entry deep links", () => {
    it("auto-opens the manual entry tabs on ?entry=corporate-action and clears the param", async () => {
      search.value = "entry=corporate-action";
      renderMenu({ autoOpenFromParams: true });

      await waitFor(() => expect(screen.getByTestId("entry-tabs")).toBeInTheDocument());
      expect(lastEntryTabsProps.current).toMatchObject({
        defaultTab: "corporate-action",
        initialTransaction: undefined,
      });
      expect(replace).toHaveBeenCalledWith("/transactions");
    });

    it("auto-opens the manual entry tabs on ?entry=merger", async () => {
      search.value = "entry=merger";
      renderMenu({ autoOpenFromParams: true });

      await waitFor(() => expect(screen.getByTestId("entry-tabs")).toBeInTheDocument());
      expect(lastEntryTabsProps.current).toMatchObject({ defaultTab: "merger" });
    });

    it("ignores an unrecognized ?entry value, falling back to the transaction tab", async () => {
      search.value = "entry=bogus";
      renderMenu({ autoOpenFromParams: true });

      await waitFor(() => expect(screen.getByTestId("entry-tabs")).toBeInTheDocument());
      expect(lastEntryTabsProps.current).toMatchObject({ defaultTab: "transaction" });
    });

    it("ignores ?entry without autoOpenFromParams (only the shell instance owns it)", async () => {
      search.value = "entry=merger";
      renderMenu();
      await Promise.resolve();
      expect(screen.queryByTestId("entry-tabs")).not.toBeInTheDocument();
      expect(replace).not.toHaveBeenCalled();
    });

    it("prefills a Sell draft from ?harvestInstrument=<id>, summing open lots in the first portfolio", async () => {
      listPortfolios.mockResolvedValue([
        { id: "p1", name: "Main", brokerage: null, accountHolder: null },
      ]);
      getInstrument.mockResolvedValue({
        id: "i1",
        symbol: "NVDA",
        name: "NVIDIA Corp",
        assetClass: "equity",
        unit: "shares",
        currency: "USD",
      });
      getSummary.mockResolvedValue({
        displayCurrency: "IDR",
        holdings: [
          {
            instrumentId: "i1",
            lots: [
              { acqDate: "2024-01-01", qty: "2", unitCost: "10", cost: "20" },
              { acqDate: "2024-06-01", qty: "3", unitCost: "12", cost: "36" },
            ],
          },
        ],
      });
      search.value = "harvestInstrument=i1";
      renderMenu({ autoOpenFromParams: true });

      await waitFor(() => expect(screen.getByTestId("entry-tabs")).toBeInTheDocument());
      expect(getSummary).toHaveBeenCalledWith("p1");
      expect(lastEntryTabsProps.current).toMatchObject({
        defaultTab: "transaction",
        initialTransaction: {
          type: "sell",
          instrumentId: "i1",
          instrument: { symbol: "NVDA", name: "NVIDIA Corp", assetClass: "equity", unit: "shares" },
          currency: "USD",
          quantity: "5",
        },
      });
      expect(replace).toHaveBeenCalledWith("/transactions");
    });

    it("leaves quantity blank when the harvested instrument isn't held", async () => {
      listPortfolios.mockResolvedValue([
        { id: "p1", name: "Main", brokerage: null, accountHolder: null },
      ]);
      getInstrument.mockResolvedValue({
        id: "i2",
        symbol: "ASML",
        name: "ASML Holding",
        assetClass: "equity",
        unit: "shares",
        currency: "EUR",
      });
      getSummary.mockResolvedValue({ displayCurrency: "IDR", holdings: [] });
      search.value = "harvestInstrument=i2";
      renderMenu({ autoOpenFromParams: true });

      await waitFor(() => expect(screen.getByTestId("entry-tabs")).toBeInTheDocument());
      expect(lastEntryTabsProps.current).toMatchObject({
        initialTransaction: { quantity: "" },
      });
    });

    it("still opens the manual tabs with no prefill when the harvest lookup fails", async () => {
      listPortfolios.mockResolvedValue([
        { id: "p1", name: "Main", brokerage: null, accountHolder: null },
      ]);
      getInstrument.mockRejectedValue(new Error("not found"));
      getSummary.mockResolvedValue({ displayCurrency: "IDR", holdings: [] });
      search.value = "harvestInstrument=ghost";
      renderMenu({ autoOpenFromParams: true });

      await waitFor(() => expect(screen.getByTestId("entry-tabs")).toBeInTheDocument());
      expect(lastEntryTabsProps.current).toMatchObject({ initialTransaction: undefined });
    });
  });
});
