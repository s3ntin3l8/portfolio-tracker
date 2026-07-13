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

  it("copies the secret and confirms via the Clipboard API", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const client: ApiTokensClient = {
      listApiTokens: vi.fn(async () => []),
      createApiToken: vi.fn(async () => ({ ...existing, token: "pt_copyme" })),
      deleteApiToken: vi.fn(),
    };
    renderManager(client);

    fireEvent.change(screen.getByLabelText(messages.Settings.tokensName), {
      target: { value: "c" },
    });
    fireEvent.click(screen.getByRole("button", { name: messages.Settings.tokensCreate }));
    await screen.findByText("pt_copyme");

    fireEvent.click(screen.getByRole("button", { name: messages.Settings.tokensCopy }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("pt_copyme"));
    // Visual confirmation appears.
    await screen.findByText(messages.Settings.tokensCopied);
  });

  it("falls back to execCommand when the Clipboard API is unavailable (insecure context)", async () => {
    // Simulate http-on-LAN-IP: no navigator.clipboard.
    Object.assign(navigator, { clipboard: undefined });
    const exec = vi.fn(() => true);
    document.execCommand = exec as unknown as typeof document.execCommand;
    const client: ApiTokensClient = {
      listApiTokens: vi.fn(async () => []),
      createApiToken: vi.fn(async () => ({ ...existing, token: "pt_fallback" })),
      deleteApiToken: vi.fn(),
    };
    renderManager(client);

    fireEvent.change(screen.getByLabelText(messages.Settings.tokensName), {
      target: { value: "c" },
    });
    fireEvent.click(screen.getByRole("button", { name: messages.Settings.tokensCreate }));
    await screen.findByText("pt_fallback");

    fireEvent.click(screen.getByRole("button", { name: messages.Settings.tokensCopy }));
    await waitFor(() => expect(exec).toHaveBeenCalledWith("copy"));
    await screen.findByText(messages.Settings.tokensCopied);
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

  it("sorts tokens by Name on click", () => {
    const old: ApiToken = { ...existing, name: "old-cli" };
    const newer: ApiToken = { ...existing, id: "tok-2", name: "zeta-cli" };
    renderManager(
      {
        listApiTokens: vi.fn(async () => [old, newer]),
        createApiToken: vi.fn(),
        deleteApiToken: vi.fn(),
      },
      [old, newer],
    );
    const nameBtn = screen.getByRole("button", { name: /Name/i });
    fireEvent.click(nameBtn);
    const dataRows = screen.getAllByRole("row").slice(1);
    // Asc: old-cli first, zeta-cli second.
    expect(dataRows[0]).toHaveTextContent("old-cli");
    expect(dataRows[1]).toHaveTextContent("zeta-cli");
    expect(nameBtn.closest("th")).toHaveAttribute("aria-sort", "ascending");
    fireEvent.click(nameBtn);
    const dataRowsDesc = screen.getAllByRole("row").slice(1);
    // Desc: zeta-cli first, old-cli second.
    expect(dataRowsDesc[0]).toHaveTextContent("zeta-cli");
    expect(dataRowsDesc[1]).toHaveTextContent("old-cli");
    expect(nameBtn.closest("th")).toHaveAttribute("aria-sort", "descending");
  });
});
