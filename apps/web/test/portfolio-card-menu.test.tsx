import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ComponentProps, ReactNode } from "react";
import messages from "../messages/en.json";

const refresh = vi.fn();
const syncTr = vi.fn(async () => ({ queued: true as const }));
const getTrConnection = vi.fn(async () => ({
  status: "connected" as const,
  portfolioId: "p1",
  lastSyncAt: null,
  lastError: null,
  importCategories: null,
  lastReconciliation: null,
  syncing: false,
}));
const syncIbkr = vi.fn(async () => ({ queued: true as const }));
const getIbkrConnection = vi.fn(async () => ({
  status: "connected" as const,
  portfolioId: "p1",
  flexAccountId: null,
  lastSyncAt: null,
  lastError: null,
  lastReconciliation: null,
  syncing: false,
}));
const deletePortfolio = vi.fn(async () => undefined);

vi.mock("@/i18n/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/lib/api", () => ({
  useApiClient: () => ({
    syncTr,
    getTrConnection,
    syncIbkr,
    getIbkrConnection,
    deletePortfolio,
  }),
}));
vi.mock("@/lib/portfolio-selection", () => ({ SELECTED_PORTFOLIO_COOKIE: "pf" }));

// Stub PortfolioFormDialog so the edit trigger renders without the full form.
vi.mock("../src/components/portfolio-form-dialog", () => ({
  PortfolioFormDialog: ({ trigger }: { trigger: ReactNode }) => <>{trigger}</>,
}));

import { PortfolioCardMenu } from "../src/components/portfolio-card-menu";

const PORTFOLIO = {
  id: "p1",
  name: "Test Portfolio",
  baseCurrency: "EUR" as const,
  accountHolderId: null,
  portfolioType: "standard" as const,
  brokerage: "Trade Republic",
  accountNumber: null,
  includeInAggregate: true,
  cashCounted: false,
  documentRetention: false,
  taxAllowanceAnnual: null,
};

type MenuProps = ComponentProps<typeof PortfolioCardMenu>;

function renderMenu(props: Partial<MenuProps> = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <PortfolioCardMenu portfolio={PORTFOLIO} {...props} />
    </NextIntlClientProvider>,
  );
}

// Radix opens its dropdown on keyboard/pointer events, not a synthetic click;
// Enter on the focused trigger is the most reliable opener under jsdom.
function openMenu() {
  const trigger = screen.getByRole("button", { name: "More options" });
  fireEvent.keyDown(trigger, { key: "Enter" });
}

describe("PortfolioCardMenu", () => {
  beforeEach(() => {
    refresh.mockClear();
    syncTr.mockClear();
    getTrConnection.mockClear();
    syncIbkr.mockClear();
    getIbkrConnection.mockClear();
    deletePortfolio.mockClear();
  });

  describe("TR sync", () => {
    it("shows no sync item when trSync prop is omitted", () => {
      renderMenu();
      openMenu();
      expect(
        screen.queryByRole("menuitem", { name: messages.TradeRepublic.syncNow }),
      ).not.toBeInTheDocument();
    });

    it("shows a TR sync item when trSync prop is provided", () => {
      renderMenu({ trSync: { initialSyncing: false } });
      openMenu();
      expect(
        screen.getByRole("menuitem", { name: messages.TradeRepublic.syncNow }),
      ).toBeInTheDocument();
    });

    it("calls syncTr and refreshes the router once the poll sees syncing=false", async () => {
      getTrConnection.mockResolvedValue({
        status: "connected" as const,
        portfolioId: "p1",
        lastSyncAt: null,
        lastError: null,
        importCategories: null,
        lastReconciliation: null,
        syncing: false,
      });

      renderMenu({ trSync: { initialSyncing: false } });
      openMenu();
      fireEvent.click(
        screen.getByRole("menuitem", { name: messages.TradeRepublic.syncNow }),
      );

      await waitFor(() => expect(syncTr).toHaveBeenCalled());
      await waitFor(() => expect(refresh).toHaveBeenCalled(), { timeout: 8000 });
    });

    it("disables the sync item while syncing", async () => {
      let resolveSyncTr!: () => void;
      syncTr.mockImplementationOnce(
        () =>
          new Promise<{ queued: true }>(
            (res) => { resolveSyncTr = () => res({ queued: true }); },
          ),
      );

      renderMenu({ trSync: { initialSyncing: false } });
      openMenu();
      const item = screen.getByRole("menuitem", { name: messages.TradeRepublic.syncNow });
      fireEvent.click(item);

      // Radix DropdownMenuItem marks disabled with data-disabled (not the HTML disabled attr).
      await waitFor(() => expect(item).toHaveAttribute("data-disabled"));

      resolveSyncTr();
    });

    it("re-enables the sync item after a sync error", async () => {
      syncTr.mockRejectedValueOnce(new Error("sync failed"));

      renderMenu({ trSync: { initialSyncing: false } });
      openMenu();
      const item = screen.getByRole("menuitem", { name: messages.TradeRepublic.syncNow });
      fireEvent.click(item);

      await waitFor(() => expect(item).not.toHaveAttribute("data-disabled"));
      expect(refresh).not.toHaveBeenCalled();
    });

    it("starts polling on mount when initialSyncing=true and refreshes when done", async () => {
      getTrConnection.mockResolvedValue({
        status: "connected" as const,
        portfolioId: "p1",
        lastSyncAt: null,
        lastError: null,
        importCategories: null,
        lastReconciliation: null,
        syncing: false,
      });

      renderMenu({ trSync: { initialSyncing: true } });

      await waitFor(() => expect(refresh).toHaveBeenCalled(), { timeout: 8000 });
    });
  });

  describe("delete", () => {
    it("requires two clicks to confirm deletion", async () => {
      renderMenu();
      openMenu();

      // First click: shows the confirm label, does not yet delete.
      const deleteItem = screen.getByRole("menuitem", {
        name: messages.PortfolioForm.delete,
      });
      fireEvent.click(deleteItem);
      expect(deletePortfolio).not.toHaveBeenCalled();

      // Label changes to confirmDelete.
      const confirmItem = await screen.findByRole("menuitem", {
        name: messages.PortfolioForm.confirmDelete,
      });
      expect(confirmItem).toBeInTheDocument();

      // Second click: actually deletes.
      fireEvent.click(confirmItem);
      await waitFor(() =>
        expect(deletePortfolio).toHaveBeenCalledWith(PORTFOLIO.id),
      );
    });

    it("resets the confirm state when the menu closes and reopens", async () => {
      const { unmount } = renderMenu();
      openMenu();

      // First click: enters confirm state.
      fireEvent.click(screen.getByRole("menuitem", { name: messages.PortfolioForm.delete }));
      expect(
        await screen.findByRole("menuitem", { name: messages.PortfolioForm.confirmDelete }),
      ).toBeInTheDocument();

      // Close menu by pressing Escape.
      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });

      // Reopen menu — confirm state should be reset.
      openMenu();
      expect(
        screen.getByRole("menuitem", { name: messages.PortfolioForm.delete }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("menuitem", { name: messages.PortfolioForm.confirmDelete }),
      ).not.toBeInTheDocument();

      unmount();
    });

    it("calls refresh after successful deletion", async () => {
      renderMenu();
      openMenu();

      fireEvent.click(screen.getByRole("menuitem", { name: messages.PortfolioForm.delete }));
      const confirmItem = await screen.findByRole("menuitem", { name: messages.PortfolioForm.confirmDelete });
      fireEvent.click(confirmItem);

      await waitFor(() => expect(refresh).toHaveBeenCalled());
    });
  });
});
