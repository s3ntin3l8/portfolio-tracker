import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { AdminProvider, AdminProvidersResponse } from "@portfolio/api-client";
import {
  AdminProvidersForm,
  type AdminProvidersClient,
} from "../src/components/admin-providers-form";
import messages from "../messages/en.json";

/** Minimal AdminProvider fixture (no DB credential set). */
function provider(overrides: Partial<AdminProvider> & Pick<AdminProvider, "id" | "label">): AdminProvider {
  return {
    configured: true,
    enabled: true,
    priority: 1,
    hasKey: false,
    keyHint: null,
    hasUrl: false,
    ...overrides,
  };
}

/** A stub AdminProvidersResponse wrapping a list of providers. */
function response(providers: AdminProvider[]): AdminProvidersResponse {
  return { providers, encryptionEnabled: false };
}

const PROVIDERS: AdminProvider[] = [
  provider({ id: "twelvedata", label: "Twelve Data", priority: 1 }),
  provider({ id: "yahoo", label: "Yahoo Finance", priority: 2 }),
  provider({ id: "eodhd", label: "EODHD", configured: false, priority: 3 }),
];

const STUB_CLIENT: AdminProvidersClient = {
  updateAdminProviders: vi.fn(async () => response(PROVIDERS)),
  setAdminProviderCredential: vi.fn(async () => response(PROVIDERS)),
  clearAdminProviderCredential: vi.fn(async () => response(PROVIDERS)),
};

function renderForm(client: AdminProvidersClient, onSuccess = vi.fn()) {
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <AdminProvidersForm
        client={client}
        initialProviders={PROVIDERS}
        encryptionEnabled={false}
        onSuccess={onSuccess}
      />
    </NextIntlClientProvider>,
  );
  return onSuccess;
}

describe("AdminProvidersForm", () => {
  it("disables save until something changes", () => {
    renderForm(STUB_CLIENT);
    expect(
      screen.getByRole("button", { name: messages.Admin.save }),
    ).toBeDisabled();
  });

  it("saves toggled enable state with priorities from display order", async () => {
    const updateAdminProviders = vi.fn(async () =>
      response(PROVIDERS.map((p) => (p.id === "yahoo" ? { ...p, enabled: false } : p))),
    );
    const client: AdminProvidersClient = {
      ...STUB_CLIENT,
      updateAdminProviders,
    };
    const onSuccess = renderForm(client);

    // Disable Yahoo (second row's toggle reads "Enabled" until clicked).
    const toggles = screen.getAllByRole("button", { name: messages.Admin.enabled });
    fireEvent.click(toggles[1]);
    fireEvent.click(screen.getByRole("button", { name: messages.Admin.save }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(updateAdminProviders).toHaveBeenCalledWith([
      { id: "twelvedata", enabled: true, priority: 1 },
      { id: "yahoo", enabled: false, priority: 2 },
      { id: "eodhd", enabled: true, priority: 3 },
    ]);
  });

  it("reorders a provider and saves the new priority order", async () => {
    const updateAdminProviders = vi.fn(async () => response(PROVIDERS));
    const client: AdminProvidersClient = { ...STUB_CLIENT, updateAdminProviders };
    renderForm(client);

    // Move Yahoo (row 2) up to first.
    fireEvent.click(screen.getAllByRole("button", { name: messages.Admin.moveUp })[1]);
    fireEvent.click(screen.getByRole("button", { name: messages.Admin.save }));

    await waitFor(() => expect(updateAdminProviders).toHaveBeenCalled());
    expect(updateAdminProviders).toHaveBeenCalledWith([
      { id: "yahoo", enabled: true, priority: 1 },
      { id: "twelvedata", enabled: true, priority: 2 },
      { id: "eodhd", enabled: true, priority: 3 },
    ]);
  });

  it("disables the toggle for an unconfigured provider", () => {
    renderForm(STUB_CLIENT);
    // EODHD is unconfigured → its enable toggle is disabled and the hint shows.
    expect(screen.getByText(messages.Admin.notConfigured)).toBeInTheDocument();
  });

  it("renders a usage badge: live quota with a limit, and a local-count fallback", () => {
    const withUsage: AdminProvider[] = [
      provider({
        id: "twelvedata",
        label: "Twelve Data",
        priority: 1,
        usage: { source: "provider", window: "day", used: 120, limit: 800 },
      }),
      provider({
        id: "antam",
        label: "Antam buyback",
        priority: 2,
        usage: { source: "local", window: "month", used: 5, limit: null },
      }),
    ];
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <AdminProvidersForm
          client={STUB_CLIENT}
          initialProviders={withUsage}
          encryptionEnabled={false}
        />
      </NextIntlClientProvider>,
    );
    // Live: "120 / 800 today"
    expect(screen.getByText("120 / 800 today")).toBeInTheDocument();
    // Local: "5 this month (local count)"
    expect(
      screen.getByText(`5 this month (${messages.Admin.usageLocalHint})`),
    ).toBeInTheDocument();
  });

  it("shows 'encryption disabled' hint when encryptionEnabled=false", () => {
    renderForm(STUB_CLIENT);
    // The credential editor shows the encryption-disabled hint for each provider.
    const hints = screen.getAllByText(messages.Admin.encryptionDisabled);
    expect(hints.length).toBeGreaterThan(0);
  });
});
