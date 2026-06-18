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
    keySource: null,
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

  it("renders a drag handle for each provider row (replacing up/down arrows)", () => {
    renderForm(STUB_CLIENT);
    const handles = screen.getAllByRole("button", { name: messages.Admin.dragHandle });
    expect(handles).toHaveLength(PROVIDERS.length);
    // no arrow buttons
    expect(screen.queryByRole("button", { name: messages.Admin.moveUp })).toBeNull();
    expect(screen.queryByRole("button", { name: messages.Admin.moveDown })).toBeNull();
  });

  it("renders an icon-only switch for each provider row", () => {
    renderForm(STUB_CLIENT);
    // Two configured (enabled) providers → two switches with aria-label "Enabled"
    const enabledSwitches = screen.getAllByRole("switch", { name: messages.Admin.enabled });
    expect(enabledSwitches.length).toBeGreaterThan(0);
    // EODHD is unconfigured → its switch is disabled
    const allSwitches = screen.getAllByRole("switch");
    const disabledSwitch = allSwitches.find((s) => (s as HTMLButtonElement).disabled);
    expect(disabledSwitch).toBeDefined();
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

    // Disable Yahoo — its switch has aria-label "Enabled" (second enabled row).
    const enabledSwitches = screen.getAllByRole("switch", { name: messages.Admin.enabled });
    fireEvent.click(enabledSwitches[1]);
    fireEvent.click(screen.getByRole("button", { name: messages.Admin.save }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(updateAdminProviders).toHaveBeenCalledWith([
      { id: "twelvedata", enabled: true, priority: 1 },
      { id: "yahoo", enabled: false, priority: 2 },
      { id: "eodhd", enabled: true, priority: 3 },
    ]);
  });

  it("disables the toggle for an unconfigured provider", () => {
    renderForm(STUB_CLIENT);
    // EODHD is unconfigured → not-configured hint shows and its switch is disabled.
    expect(screen.getByText(messages.Admin.notConfigured)).toBeInTheDocument();
    const allSwitches = screen.getAllByRole("switch");
    expect(allSwitches.some((s) => (s as HTMLButtonElement).disabled)).toBe(true);
  });

  it("renders a 'from .env' badge for an env-keyed provider with no DB key", () => {
    const providers: AdminProvider[] = [
      provider({ id: "twelvedata", label: "Twelve Data", priority: 1, keySource: "env" }),
      provider({ id: "yahoo", label: "Yahoo Finance", priority: 2, keySource: null }),
    ];
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <AdminProvidersForm
          client={STUB_CLIENT}
          initialProviders={providers}
          encryptionEnabled={false}
        />
      </NextIntlClientProvider>,
    );
    expect(screen.getAllByText(messages.Admin.keyFromEnv)).toHaveLength(1);
  });

  it("renders a usage badge: live quota with a limit, and a local-count fallback", () => {
    const withUsage: AdminProvider[] = [
      provider({
        id: "twelvedata",
        label: "Twelve Data",
        priority: 1,
        keySource: "env",
        usage: { source: "provider", window: "day", used: 120, limit: 800 },
      }),
      provider({
        id: "antam",
        label: "Antam buyback",
        priority: 2,
        keySource: null,
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
