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
    assetClass: "equity",
    unit: "shares",
  },
});

const ROWS: HoldingValuation[] = [
  makeHolding("ZZYX", "50", "200"),
  makeHolding("AAPL", "10", "1500"),
  makeHolding("BBCA", "100", "800"),
];

function renderTable() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <HoldingsTable rows={ROWS} currency="IDR" />
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
});
