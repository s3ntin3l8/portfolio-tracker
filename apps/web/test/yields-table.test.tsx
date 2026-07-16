import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import type { InstrumentYield } from "@portfolio/api-client";
import { YieldsTable } from "../src/components/income/yields-table";

vi.mock("@/i18n/navigation", () => ({
  Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const ROWS: InstrumentYield[] = [
  {
    instrumentId: "i-msft",
    symbol: "MSFT",
    name: "MICROSOFT DL- 00000625",
    displayName: "Microsoft",
    assetClass: "equity",
    market: "US",
    trailingIncome: "13.03",
    marketValue: "1683.16",
    costBasis: "1842.50",
    yield: "0.0077",
    yieldOnCost: "0.0071",
    currency: "USD",
  },
  {
    instrumentId: "i-bbca",
    symbol: "BBCA",
    name: "BANK CENTRAL ASIA TBK",
    displayName: "Bank Central Asia",
    assetClass: "equity",
    market: "IDX",
    trailingIncome: "90.28",
    marketValue: "1333.79",
    costBasis: "1180.00",
    yield: "0.0677",
    yieldOnCost: "0.0765",
    currency: "USD",
  },
];

function wrap(ui: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      {ui}
    </NextIntlClientProvider>,
  );
}

describe("YieldsTable", () => {
  it("prefers displayName over name on the desktop sublabel (#480)", () => {
    wrap(<YieldsTable rows={ROWS} />);
    // The clean name appears (not the raw broker string).
    expect(screen.getAllByText("Microsoft").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Bank Central Asia").length).toBeGreaterThan(0);
    // The raw broker-style names must not leak through.
    expect(screen.queryByText("MICROSOFT DL- 00000625")).not.toBeInTheDocument();
    expect(screen.queryByText("BANK CENTRAL ASIA TBK")).not.toBeInTheDocument();
  });

  it("renders the desktop table headers on all viewports", () => {
    wrap(<YieldsTable rows={ROWS} />);
    expect(screen.getByRole("columnheader", { name: /instrument/i })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /income.*12m/i })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /value/i })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /current yield/i })).toBeInTheDocument();
  });

  it("links each instrument's card to its detail page", () => {
    wrap(<YieldsTable rows={ROWS} />);
    const links = screen.getAllByRole("link", { name: /msft/i });
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link).toHaveAttribute("href", "/instruments/i-msft");
    }
    const bbca = screen.getAllByRole("link", { name: /bbca/i });
    expect(bbca.length).toBeGreaterThan(0);
    for (const link of bbca) {
      expect(link).toHaveAttribute("href", "/instruments/i-bbca");
    }
  });

  it("falls back to name when displayName is null", () => {
    const rows: InstrumentYield[] = [
      {
        ...ROWS[0]!,
        displayName: null,
        name: "Raw Broker Style Name",
      },
    ];
    wrap(<YieldsTable rows={rows} />);
    // Name is used as the fallback sublabel.
    expect(screen.getAllByText("Raw Broker Style Name").length).toBeGreaterThan(0);
  });

  it("hides the table element on mobile and renders a compact card list", () => {
    const { container } = wrap(<YieldsTable rows={ROWS} />);
    // Both the desktop table and the mobile card list are in the DOM (CSS toggles them).
    // The mobile layout must be present as a stack of cards, not a <table>.
    const mobileCards = container.querySelectorAll('[data-testid="yield-card"]');
    expect(mobileCards.length).toBe(ROWS.length);
    // Each card shows the symbol (no badge in the compact layout).
    for (const card of Array.from(mobileCards)) {
      expect(within(card as HTMLElement).getByText(/^MSFT$|^BBCA$/)).toBeInTheDocument();
    }
  });
});
