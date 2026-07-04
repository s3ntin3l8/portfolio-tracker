import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type * as React from "react";
import messages from "../messages/en.json";

// DataConnectionsSection embeds the real `ApiTokens` wrapper, which pulls a session-aware
// api-client via `useApiClient` — stub it so this test doesn't need a SessionProvider.
vi.mock("@/lib/api", () => ({
  useApiClient: () => ({}),
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
}));

// Identity translator: Settings/TradeRepublic/InteractiveBrokers messages aren't loaded,
// so a key-echoing stub is enough to assert structure without a full i18n provider.
vi.mock("next-intl/server", () => ({
  getTranslations: vi.fn(async (namespace?: string) => {
    const t = (key: string) => `${namespace ?? ""}.${key}`;
    return t;
  }),
}));

const { InvestingSection } = await import(
  "../src/components/settings-sections/investing-section"
);
const { DataConnectionsSection } = await import(
  "../src/components/settings-sections/data-connections-section"
);

describe("InvestingSection", () => {
  it("is informational only — no chips, no stored global preference implied", async () => {
    const element = await InvestingSection();
    render(element as React.ReactElement);
    expect(screen.getByText("Settings.investingCostBasisNote")).toBeInTheDocument();
    expect(screen.getByText("Settings.investingTaxNote")).toBeInTheDocument();
    // Links out to where the tax profile is actually configured (per-holder).
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "/settings/portfolios");
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
