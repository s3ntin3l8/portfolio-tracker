import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { TrConnection, IbkrConnection } from "@portfolio/api-client";
import messages from "../messages/en.json";

const refresh = vi.fn();
const getTrConnection = vi.fn<() => Promise<TrConnection>>(async () => ({
  status: "connected",
  portfolioId: "p1",
  lastSyncAt: null,
  lastError: null,
  lastReconciliation: null,
  syncing: false,
}));
const getIbkrConnection = vi.fn<() => Promise<IbkrConnection>>(async () => ({
  status: "connected",
  portfolioId: "p1",
  flexAccountId: null,
  lastSyncAt: null,
  lastError: null,
  lastReconciliation: null,
  syncing: false,
}));

vi.mock("@/i18n/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/lib/api", () => ({
  useApiClient: () => ({ getTrConnection, getIbkrConnection }),
}));

import { PortfolioSyncWatcher } from "../src/components/portfolio-sync-watcher";

function renderWatcher(props: Partial<React.ComponentProps<typeof PortfolioSyncWatcher>> = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <PortfolioSyncWatcher {...props} />
    </NextIntlClientProvider>,
  );
}

describe("PortfolioSyncWatcher", () => {
  beforeEach(() => {
    refresh.mockClear();
    getTrConnection.mockClear();
    getIbkrConnection.mockClear();
  });

  it("renders nothing", () => {
    const { container } = renderWatcher();
    expect(container).toBeEmptyDOMElement();
  });

  it("does not poll when neither sync prop is provided", async () => {
    renderWatcher();
    await new Promise((r) => setTimeout(r, 50));
    expect(getTrConnection).not.toHaveBeenCalled();
    expect(getIbkrConnection).not.toHaveBeenCalled();
  });

  it("polls TR status and refreshes the router once syncing flips false (#588 list auto-update)", async () => {
    renderWatcher({ trSync: { initialSyncing: true } });
    await waitFor(() => expect(getTrConnection).toHaveBeenCalled(), { timeout: 8000 });
    await waitFor(() => expect(refresh).toHaveBeenCalled(), { timeout: 8000 });
  });

  it("polls IBKR status and refreshes the router once syncing flips false", async () => {
    renderWatcher({ ibkrSync: { initialSyncing: true } });
    await waitFor(() => expect(getIbkrConnection).toHaveBeenCalled(), { timeout: 8000 });
    await waitFor(() => expect(refresh).toHaveBeenCalled(), { timeout: 8000 });
  });

  it("surfaces a connection error via toast instead of refreshing", async () => {
    getTrConnection.mockResolvedValueOnce({
      status: "connected" as const,
      portfolioId: "p1",
      lastSyncAt: null,
      lastError: "boom",
      lastReconciliation: null,
      syncing: false,
    });
    renderWatcher({ trSync: { initialSyncing: true } });
    await waitFor(() => expect(getTrConnection).toHaveBeenCalled(), { timeout: 8000 });
    // The error path never calls refresh — it toasts instead.
    await new Promise((r) => setTimeout(r, 200));
    expect(refresh).not.toHaveBeenCalled();
  });
});
