import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ApiToken } from "@portfolio/api-client";
import {
  ApiTokensManager,
  type ApiTokensClient,
} from "../src/components/api-tokens-manager";
import messages from "../messages/en.json";

const existing: ApiToken = {
  id: "tok-1",
  name: "old-cli",
  tokenPrefix: "pt_abcdefg",
  scope: "read",
  lastUsedAt: "2026-06-01T10:00:00.000Z",
  expiresAt: null,
  createdAt: "2026-05-01T10:00:00.000Z",
};

function renderManager(client: ApiTokensClient, initialTokens: ApiToken[] = []) {
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ApiTokensManager client={client} initialTokens={initialTokens} />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn(async () => undefined) },
  });
});

describe("ApiTokensManager", () => {
  it("creates a token and shows the secret once", async () => {
    const created = { ...existing, id: "tok-2", name: "dev-cli", token: "pt_supersecret" };
    const client: ApiTokensClient = {
      listApiTokens: vi.fn(async () => [existing, { ...created, token: undefined } as never]),
      createApiToken: vi.fn(async () => created),
      deleteApiToken: vi.fn(),
    };
    renderManager(client, [existing]);

    fireEvent.change(screen.getByLabelText(messages.Settings.tokensName), {
      target: { value: "dev-cli" },
    });
    fireEvent.click(screen.getByRole("button", { name: messages.Settings.tokensCreate }));

    await waitFor(() => expect(screen.getByText("pt_supersecret")).toBeInTheDocument());
    expect(client.createApiToken).toHaveBeenCalledWith({ name: "dev-cli", scope: "read" });
    // The one-time warning is shown.
    expect(screen.getByText(messages.Settings.tokensCreatedWarning)).toBeInTheDocument();
  });

  it("passes an expiry when provided", async () => {
    const client: ApiTokensClient = {
      listApiTokens: vi.fn(async () => []),
      createApiToken: vi.fn(async () => ({ ...existing, token: "pt_x" })),
      deleteApiToken: vi.fn(),
    };
    renderManager(client);

    fireEvent.change(screen.getByLabelText(messages.Settings.tokensName), {
      target: { value: "temp" },
    });
    fireEvent.change(screen.getByLabelText(messages.Settings.tokensExpiry), {
      target: { value: "30" },
    });
    fireEvent.click(screen.getByRole("button", { name: messages.Settings.tokensCreate }));

    await waitFor(() =>
      expect(client.createApiToken).toHaveBeenCalledWith({
        name: "temp",
        scope: "read",
        expiresInDays: 30,
      }),
    );
  });

  it("revokes a token and removes it from the list", async () => {
    const client: ApiTokensClient = {
      listApiTokens: vi.fn(async () => []),
      createApiToken: vi.fn(),
      deleteApiToken: vi.fn(async () => undefined),
    };
    renderManager(client, [existing]);

    expect(screen.getByText("old-cli")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: messages.Settings.tokensRevoke }));

    await waitFor(() => expect(client.deleteApiToken).toHaveBeenCalledWith("tok-1"));
    await waitFor(() => expect(screen.queryByText("old-cli")).not.toBeInTheDocument());
  });
});
