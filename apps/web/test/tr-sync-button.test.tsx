import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";

const refresh = vi.fn();
const syncTr = vi.fn(async () => ({ status: "connected" as const, drafts: 5 }));

vi.mock("@/i18n/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/lib/api", () => ({ useApiClient: () => ({ syncTr }) }));

import { TrSyncButton } from "../src/components/tr-sync-button";

function renderButton() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <TrSyncButton />
    </NextIntlClientProvider>,
  );
}

describe("TrSyncButton", () => {
  beforeEach(() => {
    refresh.mockClear();
    syncTr.mockClear();
  });

  it("calls syncTr and refreshes the router on click", async () => {
    renderButton();
    fireEvent.click(screen.getByRole("button", { name: messages.TradeRepublic.syncNow }));

    await waitFor(() => expect(syncTr).toHaveBeenCalled());
    expect(refresh).toHaveBeenCalled();
  });

  it("disables the button while syncing", async () => {
    // Hold the sync open so we can observe the in-flight state.
    let resolve!: () => void;
    syncTr.mockImplementationOnce(
      () => new Promise<never>((res) => { resolve = res as () => void; }),
    );

    renderButton();
    const btn = screen.getByRole("button", { name: messages.TradeRepublic.syncNow });
    fireEvent.click(btn);

    await waitFor(() => expect(btn).toBeDisabled());

    // Clean up the dangling promise so the component unmounts cleanly.
    resolve();
  });

  it("re-enables the button after a sync error without throwing", async () => {
    syncTr.mockRejectedValueOnce(new Error("sync failed"));
    renderButton();
    const btn = screen.getByRole("button", { name: messages.TradeRepublic.syncNow });
    fireEvent.click(btn);

    await waitFor(() => expect(btn).not.toBeDisabled());
    expect(refresh).not.toHaveBeenCalled();
  });
});
