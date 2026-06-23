import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import {
  TrConnectFlow,
  type TrConnectClient,
} from "../src/components/tr-connect-flow";
import { ApiError } from "@portfolio/api-client";
import type { TrConnection } from "@portfolio/api-client";
import messages from "../messages/en.json";

function makeClient(over: Partial<TrConnectClient> = {}): TrConnectClient {
  return {
    connectTr: vi.fn(async () => ({ status: "awaiting_2fa" as const })),
    verifyTr: vi.fn(async () => ({ status: "connected" as const })),
    syncTr: vi.fn(async () => ({ status: "connected" as const, drafts: 3 })),
    disconnectTr: vi.fn(async () => undefined),
    reimportTr: vi.fn(async () => ({ removed: 0 })),
    updateTrCategories: vi.fn(async (importCategories) => ({
      status: "connected" as const,
      portfolioId: "p1",
      lastSyncAt: null,
      lastError: null,
      importCategories,
      lastReconciliation: null,
      syncing: false,
    })),
    // The awaiting phase polls this for the authoritative status; default = approved.
    getTrConnection: vi.fn(async () => ({
      status: "connected" as const,
      portfolioId: "p1",
      lastSyncAt: null,
      lastError: null,
      importCategories: null,
      lastReconciliation: null,
      syncing: false,
    })),
    ...over,
  };
}

const DISCONNECTED: TrConnection = {
  status: "disconnected",
  portfolioId: null,
  lastSyncAt: null,
  lastError: null,
  importCategories: null,
  lastReconciliation: null,
  syncing: false,
};

function renderFlow(client: TrConnectClient, initial: TrConnection = DISCONNECTED) {
  const onChanged = vi.fn();
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <TrConnectFlow
        client={client}
        portfolioId="p1"
        initial={initial}
        onChanged={onChanged}
      />
    </NextIntlClientProvider>,
  );
  return onChanged;
}

describe("TrConnectFlow", () => {
  it("walks connect → awaiting approval → connected (auto-polls, no code)", async () => {
    const client = makeClient();
    const onChanged = renderFlow(client);

    fireEvent.change(screen.getByLabelText("Phone number"), {
      target: { value: "+4915112345678" },
    });
    fireEvent.change(screen.getByLabelText("PIN"), { target: { value: "1234" } });
    fireEvent.click(screen.getByRole("button", { name: /Connect/ }));

    await waitFor(() =>
      expect(client.connectTr).toHaveBeenCalledWith({
        phone: "+4915112345678",
        pin: "1234",
        portfolioId: "p1",
      }),
    );

    // The awaiting step fires verify once (no confirmation code), then the status poll
    // observes the authoritative connection state.
    await waitFor(() => expect(client.verifyTr).toHaveBeenCalledWith());
    expect(
      await screen.findByRole("button", { name: /Sync now/ }, { timeout: 4000 }),
    ).toBeTruthy();
    expect(onChanged).toHaveBeenCalled();
  });

  it("reflects a connected status even when the verify request fails on the client", async () => {
    // The regression: the client-side verify can reject (StrictMode remount, token
    // rotation, HMR, a transient drop) while Fastify still completes the pairing. The
    // status poll is the source of truth, so the UI must still land on connected.
    const client = makeClient({
      verifyTr: vi.fn(async () => {
        throw new Error("client request aborted");
      }),
    });
    renderFlow(client);
    fireEvent.change(screen.getByLabelText("Phone number"), {
      target: { value: "+49150" },
    });
    fireEvent.change(screen.getByLabelText("PIN"), { target: { value: "1234" } });
    fireEvent.click(screen.getByRole("button", { name: /Connect/ }));

    expect(
      await screen.findByRole("button", { name: /Sync now/ }, { timeout: 4000 }),
    ).toBeTruthy();
  });

  it("returns to the form with an error when the status poll reports a failed pairing", async () => {
    const client = makeClient({
      getTrConnection: vi.fn(async () => ({
        status: "error" as const,
        portfolioId: "p1",
        lastSyncAt: null,
        lastError: "login was not approved",
        importCategories: null,
        lastReconciliation: null,
        syncing: false,
      })),
    });
    renderFlow(client);
    fireEvent.change(screen.getByLabelText("Phone number"), {
      target: { value: "+49150" },
    });
    fireEvent.change(screen.getByLabelText("PIN"), { target: { value: "1234" } });
    fireEvent.click(screen.getByRole("button", { name: /Connect/ }));

    expect(await screen.findByRole("alert", {}, { timeout: 4000 })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Connect/ })).toBeTruthy();
  });

  it("passes a pasted waf token from the advanced field", async () => {
    const client = makeClient();
    renderFlow(client);
    fireEvent.change(screen.getByLabelText("Phone number"), {
      target: { value: "+49150" },
    });
    fireEvent.change(screen.getByLabelText("PIN"), { target: { value: "1234" } });
    fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
    fireEvent.change(screen.getByLabelText(/aws-waf-token/), {
      target: { value: "tok-123" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Connect/ }));

    await waitFor(() =>
      expect(client.connectTr).toHaveBeenCalledWith(
        expect.objectContaining({ wafToken: "tok-123" }),
      ),
    );
  });

  it("syncs from the connected state and calls syncTr", async () => {
    const client = makeClient();
    const onChanged = renderFlow(client, {
      status: "connected",
      portfolioId: "p1",
      lastSyncAt: null,
      lastError: null,
      importCategories: null,
      lastReconciliation: null,
      syncing: false,
    });
    fireEvent.click(screen.getByRole("button", { name: /Sync now/ }));
    await waitFor(() => expect(client.syncTr).toHaveBeenCalled());
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("shows the reconnect hint when the session expired", () => {
    renderFlow(makeClient(), {
      status: "expired",
      portfolioId: "p1",
      lastSyncAt: null,
      lastError: "session expired",
      importCategories: null,
      lastReconciliation: null,
      syncing: false,
    });
    expect(screen.getByText(/Your session expired/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Connect/ })).toBeTruthy();
  });

  it("surfaces an error when connect fails", async () => {
    const client = makeClient({
      connectTr: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    renderFlow(client);
    fireEvent.change(screen.getByLabelText("Phone number"), {
      target: { value: "+49150" },
    });
    fireEvent.change(screen.getByLabelText("PIN"), { target: { value: "1234" } });
    fireEvent.click(screen.getByRole("button", { name: /Connect/ }));
    expect(await screen.findByRole("alert")).toBeTruthy();
  });

  it("shows a specific message for a known API error code", async () => {
    const client = makeClient({
      connectTr: vi.fn(async () => {
        throw new ApiError(503, JSON.stringify({ error: "pytr_not_available" }));
      }),
    });
    renderFlow(client);
    fireEvent.change(screen.getByLabelText("Phone number"), {
      target: { value: "+49150" },
    });
    fireEvent.change(screen.getByLabelText("PIN"), { target: { value: "1234" } });
    fireEvent.click(screen.getByRole("button", { name: /Connect/ }));
    expect(
      await screen.findByText(/Trade Republic sync isn't set up on the server/),
    ).toBeTruthy();
  });

  it("binds to the portfolio it was given, with no in-form picker", async () => {
    // TrConnectFlow is launched from a single portfolio's edit dialog, so the binding is
    // implicit (the prop) — there's no portfolio selector in the form.
    const client = makeClient();
    renderFlow(client);
    expect(screen.queryByLabelText("Import into")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Phone number"), {
      target: { value: "+49150" },
    });
    fireEvent.change(screen.getByLabelText("PIN"), { target: { value: "1234" } });
    fireEvent.click(screen.getByRole("button", { name: /Connect/ }));
    await waitFor(() =>
      expect(client.connectTr).toHaveBeenCalledWith(
        expect.objectContaining({ portfolioId: "p1" }),
      ),
    );
  });
});
