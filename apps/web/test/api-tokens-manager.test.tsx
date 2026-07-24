import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ApiToken } from "@portfolio/api-client";
import { ApiTokensManager, type ApiTokensClient } from "../src/components/api-tokens-manager";
import messages from "../messages/en.json";

const m = messages.Settings;

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

/** Opens the create-token modal (design: "Create token" pill below the row list). */
function openCreateModal() {
  fireEvent.click(screen.getByRole("button", { name: m.tokensCreate }));
  return within(screen.getByRole("dialog"));
}

beforeEach(() => {
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn(async () => undefined) },
  });
});

describe("ApiTokensManager", () => {
  it("renders each token as a card row with a scope pill — no data table", () => {
    renderManager({ listApiTokens: vi.fn(), createApiToken: vi.fn(), deleteApiToken: vi.fn() }, [
      existing,
    ]);
    expect(screen.getByText("old-cli")).toBeInTheDocument();
    expect(screen.getByText(m.tokensScopeRead)).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("creates a token via the modal and shows the secret once", async () => {
    const created = { ...existing, id: "tok-2", name: "dev-cli", token: "pt_supersecret" };
    const client: ApiTokensClient = {
      listApiTokens: vi.fn(async () => [existing, { ...created, token: undefined } as never]),
      createApiToken: vi.fn(async () => created),
      deleteApiToken: vi.fn(),
    };
    renderManager(client, [existing]);

    const dialog = openCreateModal();
    expect(dialog.getByText(m.tokensCreateTitle)).toBeInTheDocument();
    fireEvent.change(dialog.getByLabelText(m.tokensName), { target: { value: "dev-cli" } });
    fireEvent.click(dialog.getByRole("button", { name: m.tokensCreate }));

    await waitFor(() => expect(screen.getByText("pt_supersecret")).toBeInTheDocument());
    expect(client.createApiToken).toHaveBeenCalledWith({ name: "dev-cli", scope: "read" });
    expect(screen.getByText(m.tokensCreatedWarning)).toBeInTheDocument();
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

    const dialog = openCreateModal();
    fireEvent.change(dialog.getByLabelText(m.tokensName), { target: { value: "c" } });
    fireEvent.click(dialog.getByRole("button", { name: m.tokensCreate }));
    await screen.findByText("pt_copyme");

    fireEvent.click(screen.getByRole("button", { name: m.tokensCopy }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("pt_copyme"));
    await screen.findByText(m.tokensCopied);
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

    const dialog = openCreateModal();
    fireEvent.change(dialog.getByLabelText(m.tokensName), { target: { value: "c" } });
    fireEvent.click(dialog.getByRole("button", { name: m.tokensCreate }));
    await screen.findByText("pt_fallback");

    fireEvent.click(screen.getByRole("button", { name: m.tokensCopy }));
    await waitFor(() => expect(exec).toHaveBeenCalledWith("copy"));
    await screen.findByText(m.tokensCopied);
  });

  it("passes an expiry when an Expires chip is selected", async () => {
    const client: ApiTokensClient = {
      listApiTokens: vi.fn(async () => []),
      createApiToken: vi.fn(async () => ({ ...existing, token: "pt_x" })),
      deleteApiToken: vi.fn(),
    };
    renderManager(client);

    const dialog = openCreateModal();
    fireEvent.change(dialog.getByLabelText(m.tokensName), { target: { value: "temp" } });
    fireEvent.click(dialog.getByRole("radio", { name: m.tokensExpiry30 }));
    fireEvent.click(dialog.getByRole("button", { name: m.tokensCreate }));

    await waitFor(() =>
      expect(client.createApiToken).toHaveBeenCalledWith({
        name: "temp",
        scope: "read",
        expiresInDays: 30,
      }),
    );
  });

  it("defaults to no-expiry note and switches on selecting a day chip", () => {
    renderManager({ listApiTokens: vi.fn(), createApiToken: vi.fn(), deleteApiToken: vi.fn() });
    const dialog = openCreateModal();
    expect(dialog.getByText(m.tokensExpiryNoteNever)).toBeInTheDocument();

    fireEvent.click(dialog.getByRole("radio", { name: m.tokensExpiry90 }));
    expect(dialog.getByText("Stops working automatically after 90 days.")).toBeInTheDocument();
  });

  it("selects a Read & write scope chip", async () => {
    const client: ApiTokensClient = {
      listApiTokens: vi.fn(async () => []),
      createApiToken: vi.fn(async () => ({ ...existing, token: "pt_w" })),
      deleteApiToken: vi.fn(),
    };
    renderManager(client);

    const dialog = openCreateModal();
    fireEvent.change(dialog.getByLabelText(m.tokensName), { target: { value: "writer" } });
    fireEvent.click(dialog.getByRole("radio", { name: m.tokensScopeWrite }));
    fireEvent.click(dialog.getByRole("button", { name: m.tokensCreate }));

    await waitFor(() =>
      expect(client.createApiToken).toHaveBeenCalledWith({ name: "writer", scope: "write" }),
    );
  });

  it("closes the modal via Cancel without creating a token", () => {
    const client: ApiTokensClient = {
      listApiTokens: vi.fn(),
      createApiToken: vi.fn(),
      deleteApiToken: vi.fn(),
    };
    renderManager(client);

    const dialog = openCreateModal();
    fireEvent.click(dialog.getByRole("button", { name: m.tokensCancel }));
    expect(screen.queryByText(m.tokensCreateTitle)).not.toBeInTheDocument();
    expect(client.createApiToken).not.toHaveBeenCalled();
  });

  it("revokes a token and removes it from the list", async () => {
    const client: ApiTokensClient = {
      listApiTokens: vi.fn(async () => []),
      createApiToken: vi.fn(),
      deleteApiToken: vi.fn(async () => undefined),
    };
    renderManager(client, [existing]);

    expect(screen.getByText("old-cli")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: m.tokensRevoke }));

    await waitFor(() => expect(client.deleteApiToken).toHaveBeenCalledWith("tok-1"));
    await waitFor(() => expect(screen.queryByText("old-cli")).not.toBeInTheDocument());
  });
});
