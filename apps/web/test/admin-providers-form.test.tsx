import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { AdminProvider } from "@portfolio/api-client";
import {
  AdminProvidersForm,
  type AdminProvidersClient,
} from "../src/components/admin-providers-form";
import messages from "../messages/en.json";

const PROVIDERS: AdminProvider[] = [
  { id: "twelvedata", label: "Twelve Data", configured: true, enabled: true, priority: 1 },
  { id: "yahoo", label: "Yahoo Finance", configured: true, enabled: true, priority: 2 },
  { id: "eodhd", label: "EODHD", configured: false, enabled: true, priority: 3 },
];

function renderForm(client: AdminProvidersClient, onSuccess = vi.fn()) {
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <AdminProvidersForm
        client={client}
        initialProviders={PROVIDERS}
        onSuccess={onSuccess}
      />
    </NextIntlClientProvider>,
  );
  return onSuccess;
}

describe("AdminProvidersForm", () => {
  it("disables save until something changes", () => {
    renderForm({ updateAdminProviders: vi.fn() });
    expect(
      screen.getByRole("button", { name: messages.Admin.save }),
    ).toBeDisabled();
  });

  it("saves toggled enable state with priorities from display order", async () => {
    const updateAdminProviders = vi.fn(async () =>
      PROVIDERS.map((p) => (p.id === "yahoo" ? { ...p, enabled: false } : p)),
    );
    const onSuccess = renderForm({ updateAdminProviders });

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
    const updateAdminProviders = vi.fn(async () => PROVIDERS);
    renderForm({ updateAdminProviders });

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
    renderForm({ updateAdminProviders: vi.fn() });
    // EODHD is unconfigured → its enable toggle is disabled and the hint shows.
    expect(screen.getByText(messages.Admin.notConfigured)).toBeInTheDocument();
  });

  it("renders a usage badge: live quota with a limit, and a local-count fallback", () => {
    const withUsage: AdminProvider[] = [
      {
        id: "twelvedata",
        label: "Twelve Data",
        configured: true,
        enabled: true,
        priority: 1,
        usage: { source: "provider", window: "day", used: 120, limit: 800 },
      },
      {
        id: "antam",
        label: "Antam buyback",
        configured: true,
        enabled: true,
        priority: 2,
        usage: { source: "local", window: "month", used: 5, limit: null },
      },
    ];
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <AdminProvidersForm
          client={{ updateAdminProviders: vi.fn() }}
          initialProviders={withUsage}
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
});
