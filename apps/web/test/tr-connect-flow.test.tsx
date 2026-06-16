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
    ...over,
  };
}

const PORTFOLIOS = [{ id: "p1", name: "Main" }];
const DISCONNECTED: TrConnection = {
  status: "disconnected",
  portfolioId: null,
  lastSyncAt: null,
  lastError: null,
};

function renderFlow(client: TrConnectClient, initial: TrConnection = DISCONNECTED) {
  const onChanged = vi.fn();
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <TrConnectFlow
        client={client}
        portfolios={PORTFOLIOS}
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

    // The awaiting step long-polls verify automatically — no confirmation code is entered.
    await waitFor(() => expect(client.verifyTr).toHaveBeenCalledWith());
    expect(await screen.findByRole("button", { name: /Sync now/ })).toBeTruthy();
    expect(onChanged).toHaveBeenCalled();
  });

  it("returns to the form with an error when the approval is not granted", async () => {
    const client = makeClient({
      verifyTr: vi.fn(async () => {
        throw new Error("not approved");
      }),
    });
    renderFlow(client);
    fireEvent.change(screen.getByLabelText("Phone number"), {
      target: { value: "+49150" },
    });
    fireEvent.change(screen.getByLabelText("PIN"), { target: { value: "1234" } });
    fireEvent.click(screen.getByRole("button", { name: /Connect/ }));

    expect(await screen.findByRole("alert")).toBeTruthy();
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

  it("syncs from the connected state and shows the draft count", async () => {
    const client = makeClient();
    renderFlow(client, {
      status: "connected",
      portfolioId: "p1",
      lastSyncAt: null,
      lastError: null,
    });
    fireEvent.click(screen.getByRole("button", { name: /Sync now/ }));
    await waitFor(() => expect(client.syncTr).toHaveBeenCalled());
    expect(await screen.findByText(/3 draft transactions staged/)).toBeTruthy();
  });

  it("shows the reconnect hint when the session expired", () => {
    renderFlow(makeClient(), {
      status: "expired",
      portfolioId: "p1",
      lastSyncAt: null,
      lastError: "session expired",
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
});
