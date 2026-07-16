import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type * as React from "react";
import messages from "../messages/en.json";

const refresh = vi.fn();
const putPreferences = vi.fn(async (body: unknown) => body);

// DataConnectionsSection embeds the real `ApiTokens` wrapper, which pulls a session-aware
// api-client via `useApiClient` — stub it so this test doesn't need a SessionProvider.
// InvestingSection's chip rows use the same hook to persist preferences.
vi.mock("@/lib/api", () => ({
  useApiClient: () => ({ putPreferences }),
}));

vi.mock("@/i18n/navigation", () => ({
  Link: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
  useRouter: () => ({ refresh }),
}));

// Identity translator: Settings/TradeRepublic/InteractiveBrokers messages aren't loaded,
// so a key-echoing stub is enough to assert structure without a full i18n provider.
vi.mock("next-intl/server", () => ({
  getTranslations: vi.fn(async (namespace?: string) => {
    const t = (key: string) => `${namespace ?? ""}.${key}`;
    return t;
  }),
}));

const { InvestingSection } = await import("../src/components/settings-sections/investing-section");
const { DataConnectionsSection } =
  await import("../src/components/settings-sections/data-connections-section");

describe("InvestingSection", () => {
  it("defaults to German / purchase_price chips active when no prefs row exists", async () => {
    const element = await InvestingSection({ prefs: null });
    renderWithIntl(element as React.ReactElement);
    expect(screen.getByRole("button", { name: "Settings.taxCodeGermany" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Settings.costBasisPurchasePrice" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByText("Settings.investingTaxNoteDe")).toBeInTheDocument();
    expect(screen.getByText("Settings.investingCostBasisNote")).toBeInTheDocument();
  });

  it("reflects a stored ID/total_paid preference and persists a chip change", async () => {
    const element = await InvestingSection({
      prefs: {
        dashboardPeriod: "max",
        dashboardKpis: null,
        taxRegime: "ID",
        costBasisMode: "total_paid",
        benchmarkSymbol: null,
        riskFreeRate: null,
      },
    });
    renderWithIntl(element as React.ReactElement);
    expect(screen.getByRole("button", { name: "Settings.taxCodeIndonesia" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByText("Settings.investingTaxNoteId")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Settings.costBasisPurchasePrice" }));
    await waitFor(() =>
      expect(putPreferences).toHaveBeenCalledWith({ costBasisMode: "purchase_price" }),
    );
    expect(refresh).toHaveBeenCalled();
  });
});

// DataConnectionsSection nests the real (client) ApiTokensManager, which needs a genuine
// next-intl client context — the mocked next-intl/server identity translator above only
// covers this section's own server-rendered strings.
function renderWithIntl(element: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      {element}
    </NextIntlClientProvider>,
  );
}

describe("DataConnectionsSection", () => {
  it("always shows the screenshot/CSV import source", async () => {
    const element = await DataConnectionsSection({
      apiTokens: [],
      trConnection: null,
      ibkrConnection: null,
    });
    renderWithIntl(element as React.ReactElement);
    expect(screen.getByText("Settings.dataSourceImport")).toBeInTheDocument();
  });

  it("surfaces a connected Trade Republic source when bound, but not IBKR", async () => {
    const element = await DataConnectionsSection({
      apiTokens: [],
      trConnection: {
        status: "connected",
        portfolioId: "p1",
        lastSyncAt: null,
        lastError: null,
        lastReconciliation: null,
        syncing: false,
      },
      ibkrConnection: null,
    });
    renderWithIntl(element as React.ReactElement);
    expect(screen.getByText("Settings.dataSourceTr")).toBeInTheDocument();
    expect(screen.queryByText("Settings.dataSourceIbkr")).not.toBeInTheDocument();
  });
});
