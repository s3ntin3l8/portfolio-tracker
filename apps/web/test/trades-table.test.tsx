import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { vi } from "vitest";
import messages from "../messages/en.json";

vi.mock("@/i18n/navigation", () => ({
  Link: ({ children, onClick }: { children: React.ReactNode; onClick?: (e: unknown) => void }) => (
    <a onClick={onClick}>{children}</a>
  ),
}));

import { TradesTable } from "../src/components/trades-table";
import type { Trade } from "@portfolio/api-client";

const closed: Trade = {
  instrumentId: "i-tlkm",
  currency: "EUR",
  status: "closed",
  entryDate: "2021-01-01",
  exitDate: "2021-06-01",
  holdingDays: 151,
  longTerm: false,
  quantity: "10",
  avgEntryPrice: "100",
  avgExitPrice: "130",
  invested: "1000",
  realizedPnL: "300",
  unrealizedPnL: "0",
  dividends: "0",
  totalReturn: "300",
  totalReturnPct: 0.3,
  annualizedPct: 0.7,
  legs: [
    {
      acqDate: "2021-01-01",
      sellDate: "2021-06-01",
      quantity: "10",
      cost: "1000",
      proceeds: "1300",
      gain: "300",
      holdingDays: 151,
      longTerm: false,
      taxYear: 2021,
    },
  ],
  instrument: { symbol: "TLKM", name: "Telkom", assetClass: "equity", unit: "shares", market: "IDX", sector: null, sectorWeights: null },
};

const open: Trade = {
  instrumentId: "i-bbca",
  currency: "EUR",
  status: "open",
  entryDate: "2021-02-01",
  exitDate: null,
  holdingDays: 800,
  longTerm: true,
  quantity: "5",
  avgEntryPrice: "9000",
  avgExitPrice: null,
  invested: "45000",
  realizedPnL: "0",
  unrealizedPnL: "2500",
  dividends: "100",
  totalReturn: "2600",
  totalReturnPct: 0.0578,
  annualizedPct: null,
  legs: [],
  instrument: { symbol: "BBCA", name: "BCA", assetClass: "equity", unit: "shares", market: "IDX", sector: null, sectorWeights: null },
};

function renderTable(trades: Trade[]) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <TradesTable trades={trades} currency="EUR" />
    </NextIntlClientProvider>,
  );
}

describe("TradesTable", () => {
  it("renders open and closed trades with their total return", () => {
    renderTable([open, closed]);
    expect(screen.getAllByText("TLKM").length).toBeGreaterThan(0);
    expect(screen.getAllByText("BBCA").length).toBeGreaterThan(0);
    // The long-term (tax-free) flag surfaces on the open position held > 1 year.
    expect(screen.getAllByText(/Tax-free/).length).toBeGreaterThan(0);
  });

  it("filters to closed trades only", () => {
    renderTable([open, closed]);
    fireEvent.click(screen.getByRole("button", { name: "Closed" }));
    expect(screen.queryByText("BBCA")).toBeNull();
    expect(screen.getAllByText("TLKM").length).toBeGreaterThan(0);
  });

  it("expands a trade to reveal its matched legs", () => {
    renderTable([closed]);
    // Leg detail is hidden until the row is expanded.
    expect(screen.queryByText("2021-01-01 → 2021-06-01")).toBeNull();
    fireEvent.click(screen.getAllByText("Telkom")[0]);
    expect(screen.getByText("2021-01-01 → 2021-06-01")).toBeTruthy();
  });

  it("aligns leg detail cells with their corresponding header columns", () => {
    renderTable([closed]);
    fireEvent.click(screen.getAllByText("Telkom")[0]);

    const legRow = screen.getByText("2021-01-01 → 2021-06-01").closest("tr");
    expect(legRow).toBeTruthy();

    // 9 cells: dates(colSpan=2) + exitDate(1) + held(1) + quantity(1) + invested(1) + realized(1) + dividends(1) + totalReturn(1) + annualized(1) = 10 columns
    const legCells = legRow!.querySelectorAll("td");
    expect(legCells.length).toBe(9);

    // Verify key values are present in the leg row
    expect(legRow!.textContent).toContain("151d");
    expect(legRow!.textContent).toContain("€1,000");
    expect(legRow!.textContent).toContain("€1,300");
    expect(legRow!.textContent).toContain("€300");
  });
});
