import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
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

vi.mock("@/i18n/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/lib/api", () => ({ useApiClient: () => ({ syncTr, getTrConnection }) }));

import { TrSyncButton } from "../src/components/tr-sync-button";

function renderButton(props?: Parameters<typeof TrSyncButton>[0]) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <TrSyncButton {...props} />
    </NextIntlClientProvider>,
  );
}

describe("TrSyncButton", () => {
  beforeEach(() => {
    refresh.mockClear();
    syncTr.mockClear();
    getTrConnection.mockClear();
  });

  it("calls syncTr and refreshes the router once the poll sees syncing=false", async () => {
    // Simulate: sync is queued, poller sees syncing=false on first check.
    getTrConnection.mockResolvedValue({
      status: "connected" as const,
      portfolioId: "p1",
      lastSyncAt: null,
      lastError: null,
      importCategories: null,
      lastReconciliation: null,
      syncing: false,
    });

    renderButton();
    fireEvent.click(screen.getByRole("button", { name: messages.TradeRepublic.syncNow }));

    await waitFor(() => expect(syncTr).toHaveBeenCalled());
    await waitFor(() => expect(refresh).toHaveBeenCalled(), { timeout: 8000 });
  });

  it("disables the button while syncing", async () => {
    // Hold the syncTr open so we can observe the in-flight state before polling starts.
    let resolveSyncTr!: () => void;
    syncTr.mockImplementationOnce(
      () => new Promise<{ queued: true }>((res) => { resolveSyncTr = () => res({ queued: true }); }),
    );

    renderButton();
    const btn = screen.getByRole("button", { name: messages.TradeRepublic.syncNow });
    fireEvent.click(btn);

    await waitFor(() => expect(btn).toBeDisabled());

    resolveSyncTr();
  });

  it("re-enables the button after a sync error without throwing", async () => {
    syncTr.mockRejectedValueOnce(new Error("sync failed"));
    renderButton();
    const btn = screen.getByRole("button", { name: messages.TradeRepublic.syncNow });
    fireEvent.click(btn);

    await waitFor(() => expect(btn).not.toBeDisabled());
    expect(refresh).not.toHaveBeenCalled();
  });

  it("starts spinning immediately when initialSyncing=true and refreshes when done", async () => {
    getTrConnection.mockResolvedValue({
      status: "connected" as const,
      portfolioId: "p1",
      lastSyncAt: null,
      lastError: null,
      importCategories: null,
      lastReconciliation: null,
      syncing: false,
    });

    renderButton({ initialSyncing: true });
    const btn = screen.getByRole("button", { name: messages.TradeRepublic.syncNow });

    // Should be disabled immediately (already syncing).
    expect(btn).toBeDisabled();

    // Once the poll returns syncing=false the router refreshes and button re-enables.
    await waitFor(() => expect(refresh).toHaveBeenCalled(), { timeout: 8000 });
  });
});
