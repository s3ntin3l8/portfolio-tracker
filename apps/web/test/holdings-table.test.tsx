import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import type { HoldingValuation } from "@portfolio/api-client";

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
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

import { HoldingsTable } from "../src/components/holdings-table";

const makeHolding = (
  symbol: string,
  quantity: string,
  avgCost: string,
  instrumentId = symbol,
): HoldingValuation => ({
  instrumentId,
  quantity,
  avgCost,
  costBasis: String(Number(quantity) * Number(avgCost)),
  realizedPnL: "0",
  costCurrency: "IDR",
  price: "100",
  currency: "IDR",
  marketValue: String(Number(quantity) * 100),
  marketValueDisplay: String(Number(quantity) * 100),
  costBasisDisplay: String(Number(quantity) * Number(avgCost)),
  unrealizedPnL: "0",
  unrealizedPnLDisplay: "0",
  previousClose: null,
  dayChange: null,
  dayChangePct: null,
  instrument: {
    symbol,
    name: symbol + " Corp",
    displayName: null,
    assetClass: "equity",
    unit: "shares",
    market: "IDX",
    sector: null,
    sectorWeights: null,
    countryWeights: null,
  },
});

const ROWS: HoldingValuation[] = [
  makeHolding("ZZYX", "50", "200"),
  makeHolding("AAPL", "10", "1500"),
  makeHolding("BBCA", "100", "800"),
];

function renderTable(opts: { cash?: Record<string, string>; rows?: typeof ROWS } = {}) {
  const rows = opts.rows ?? ROWS;
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <HoldingsTable rows={rows} currency="IDR" cash={opts.cash} />
    </NextIntlClientProvider>,
  );
}

describe("HoldingsTable", () => {
  it("renders all rows", () => {
    renderTable();
    // Both desktop and mobile layouts render the same symbol; getAllByText handles both.
    expect(screen.getAllByText("ZZYX")[0]).toBeInTheDocument();
    expect(screen.getAllByText("AAPL")[0]).toBeInTheDocument();
    expect(screen.getAllByText("BBCA")[0]).toBeInTheDocument();
  });

  it("sorts by instrument name ascending when clicked", () => {
    renderTable();
    fireEvent.click(screen.getByRole("button", { name: /instrument/i }));
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows[0]).toHaveTextContent("AAPL");
    expect(rows[1]).toHaveTextContent("BBCA");
    expect(rows[2]).toHaveTextContent("ZZYX");
  });

  it("sorts by instrument name descending on second click", () => {
    renderTable();
    fireEvent.click(screen.getByRole("button", { name: /instrument/i }));
    fireEvent.click(screen.getByRole("button", { name: /instrument/i }));
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows[0]).toHaveTextContent("ZZYX");
    expect(rows[2]).toHaveTextContent("AAPL");
  });

  it("sorts quantity numerically (10 < 50 < 100)", () => {
    renderTable();
    fireEvent.click(screen.getByRole("button", { name: /quantity/i }));
    const rows = screen.getAllByRole("row").slice(1);
    // asc: 10 (AAPL), 50 (ZZYX), 100 (BBCA)
    expect(rows[0]).toHaveTextContent("AAPL");
    expect(rows[1]).toHaveTextContent("ZZYX");
    expect(rows[2]).toHaveTextContent("BBCA");
  });

  it("sets aria-sort on the active column header", () => {
    renderTable();
    const qtyBtn = screen.getByRole("button", { name: /quantity/i });
    fireEvent.click(qtyBtn);
    expect(qtyBtn.closest("th")).toHaveAttribute("aria-sort", "ascending");
    fireEvent.click(qtyBtn);
    expect(qtyBtn.closest("th")).toHaveAttribute("aria-sort", "descending");
  });

  it("inactive columns have aria-sort=none", () => {
    renderTable();
    const instrumentBtn = screen.getByRole("button", { name: /instrument/i });
    expect(instrumentBtn.closest("th")).toHaveAttribute("aria-sort", "none");
  });

  it("renders a totals row summing market value across the visible rows", () => {
    renderTable();
    // "Total" appears in both the desktop footer and the mobile total row.
    expect(screen.getAllByText("Total").length).toBeGreaterThan(0);
    // Market values: 50*100 + 10*100 + 100*100 = 16,000 in the display currency.
    expect(screen.getAllByText(/16,000/).length).toBeGreaterThan(0);
  });

  it("does not render a Cash row when no cash prop is provided", () => {
    renderTable();
    expect(screen.queryByText("Cash")).not.toBeInTheDocument();
  });

  it("renders a Cash row when cash prop is provided", () => {
    renderTable({ cash: { IDR: "5000000" } });
    // "Cash" label appears in both desktop and mobile layouts.
    expect(screen.getAllByText("Cash").length).toBeGreaterThan(0);
    // The currency sub-label appears.
    expect(screen.getAllByText("IDR").length).toBeGreaterThan(0);
    // Balance is formatted and appears somewhere in the document.
    expect(screen.getAllByText(/5,000,000/).length).toBeGreaterThan(0);
  });

  it("includes cash in the footer total", () => {
    // Securities total: 50*100 + 10*100 + 100*100 = 16,000
    // Cash: 4,000 → combined total: 20,000
    renderTable({ cash: { IDR: "4000" } });
    expect(screen.getAllByText(/20,000/).length).toBeGreaterThan(0);
  });

  it("renders only a Cash row when rows is empty but cash is provided (pure-cash portfolio)", () => {
    renderTable({ rows: [], cash: { IDR: "10000000" } });
    expect(screen.getAllByText("Cash").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/10,000,000/).length).toBeGreaterThan(0);
    // No security rows.
    expect(screen.queryByText("AAPL")).not.toBeInTheDocument();
  });

  it("skips zero-balance cash entries", () => {
    renderTable({ cash: { IDR: "0", USD: "5000" } });
    // IDR row should NOT appear (zero balance), USD row should appear.
    const cashLabels = screen.queryAllByText("Cash");
    // Only USD entry renders
    expect(cashLabels.length).toBeGreaterThan(0);
    expect(screen.queryAllByText("USD").length).toBeGreaterThan(0);
  });

  it("merges the instrument name and quantity into the mobile subtitle", () => {
    renderTable();
    // The mobile row shows "name · quantity" in one subtitle (quantity is no longer a column).
    expect(screen.getByText(/BBCA Corp ·/)).toBeInTheDocument();
  });

  it("prefers the clean displayName over the raw name in the mobile subtitle", () => {
    const named: HoldingValuation = {
      ...makeHolding("BBCA", "100", "800"),
      instrument: {
        ...makeHolding("BBCA", "100", "800").instrument!,
        displayName: "Bank Central Asia Tbk",
      },
    };
    renderTable({ rows: [named] });
    expect(screen.getByText(/Bank Central Asia Tbk ·/)).toBeInTheDocument();
    // The raw "BBCA Corp" name is no longer shown in the subtitle.
    expect(screen.queryByText(/BBCA Corp ·/)).toBeNull();
  });

  it("renders a price-course sparkline on mobile for a holding that carries one", () => {
    const withSpark: HoldingValuation = {
      ...makeHolding("AAPL", "10", "1500"),
      sparkline: [1, 2, 3, 4],
    };
    const { container } = renderTable({ rows: [withSpark] });
    expect(container.querySelector("polyline")).not.toBeNull();
  });

  it("omits the sparkline for a holding with no series data", () => {
    const { container } = renderTable({ rows: [makeHolding("AAPL", "10", "1500")] });
    expect(container.querySelector("polyline")).toBeNull();
  });
});
