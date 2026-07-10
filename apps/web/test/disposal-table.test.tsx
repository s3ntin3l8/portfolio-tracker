import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { DisposalTable, IdSalesTable } from "../src/components/tax/disposal-table";
import type { TaxDisposalRow } from "../src/lib/server-api";

// These are client components (useTranslations + local money formatting from
// currency/locale props — a function prop like `money`/`t` can't cross the
// server→client boundary, see disposal-table.tsx's comment) — wrap in the real
// provider so the ICU plural in `disposals.lotsLine` is genuinely parsed, not stubbed.
function wrap(ui: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      {ui}
    </NextIntlClientProvider>,
  );
}

// A single-lot disposal — should render exactly like the old flat row (no chevron).
const singleLot: TaxDisposalRow = {
  symbol: "NVDA",
  when: "2026-03-12",
  proceeds: "1240",
  gain: "430",
  quantity: "10",
  avgBuyPrice: "81",
  sellPrice: "124",
  lots: [
    {
      acqDate: "2025-01-10",
      quantity: "10",
      buyPrice: "81",
      sellPrice: "124",
      proceeds: "1240",
      gain: "430",
      holdingDays: 400,
      longTerm: true,
    },
  ],
};

// A multi-lot disposal — an ETF bought in three tranches, sold together.
const multiLot: TaxDisposalRow = {
  symbol: "IWDA",
  when: "2026-04-01",
  proceeds: "2892",
  gain: "546",
  quantity: "25",
  avgBuyPrice: "78.2",
  sellPrice: "96.4",
  lots: [
    {
      acqDate: "2021-01-15",
      quantity: "12",
      buyPrice: "71.1",
      sellPrice: "96.4",
      proceeds: "1156.8",
      gain: "303.6",
      holdingDays: 1900,
      longTerm: true,
    },
    {
      acqDate: "2022-06-10",
      quantity: "8",
      buyPrice: "80.5",
      sellPrice: "96.4",
      proceeds: "771.2",
      gain: "127.2",
      holdingDays: 1400,
      longTerm: true,
    },
    {
      acqDate: "2023-02-20",
      quantity: "5",
      buyPrice: "88.0",
      sellPrice: "96.4",
      proceeds: "482.0",
      gain: "42.0",
      holdingDays: 1000,
      longTerm: true,
    },
  ],
};

describe("DisposalTable (German)", () => {
  it("renders a single-lot disposal without an aggregate summary line", () => {
    wrap(
      <DisposalTable
        rows={[singleLot]}
        totalProceeds="1240"
        totalGain="430"
        currency="EUR"
        locale="en"
        year={2026}
      />,
    );
    expect(screen.getByText("NVDA")).toBeInTheDocument();
    expect(screen.getByText("2026-03-12")).toBeInTheDocument();
    expect(screen.getAllByText("€1,240.00").length).toBeGreaterThan(0);
    expect(screen.getAllByText("€430.00").length).toBeGreaterThan(0);
    expect(screen.queryByText(/lot/)).toBeNull();
  });

  it("collapses a multi-lot disposal into one aggregate row with an avg buy → sell summary", () => {
    wrap(
      <DisposalTable
        rows={[multiLot]}
        totalProceeds="2892"
        totalGain="546"
        currency="EUR"
        locale="en"
        year={2026}
      />,
    );
    expect(screen.getByText("IWDA")).toBeInTheDocument();
    // Exactly one aggregate row, not three lot rows, until expanded — real ICU plural
    // resolution via next-intl (not a hand-rolled stub).
    expect(screen.getByText(/avg €78\.20 → €96\.40 · 3 lots/)).toBeInTheDocument();
    expect(screen.queryByText("2021-01-15")).toBeNull();
  });

  it("expands the aggregate row to reveal every consumed FIFO lot", () => {
    wrap(
      <DisposalTable
        rows={[multiLot]}
        totalProceeds="2892"
        totalGain="546"
        currency="EUR"
        locale="en"
        year={2026}
      />,
    );
    fireEvent.click(screen.getByText("IWDA"));
    expect(screen.getByText(/2021-01-15/)).toBeInTheDocument();
    expect(screen.getByText(/2022-06-10/)).toBeInTheDocument();
    expect(screen.getByText(/2023-02-20/)).toBeInTheDocument();
    // Per-lot gain values are shown once expanded.
    expect(screen.getByText("€303.60")).toBeInTheDocument();
  });
});

describe("IdSalesTable (Indonesian)", () => {
  const idSingle = { ...singleLot, tax: "1.24" };
  const idMulti = { ...multiLot, tax: "2.89" };

  it("renders one row per disposal (proceeds + 0.1% tax) plus a total row", () => {
    wrap(
      <IdSalesTable
        rows={[idSingle]}
        totalProceeds="1240"
        totalSalesTax="1.24"
        currency="EUR"
        locale="en"
        year={2026}
      />,
    );
    expect(screen.getByText("NVDA")).toBeInTheDocument();
    expect(screen.getAllByText("€1,240.00").length).toBeGreaterThan(0);
    expect(screen.getByText("Total")).toBeInTheDocument();
    expect(screen.getByText("Share sales · 0.1% final")).toBeInTheDocument();
  });

  it("shows the same aggregate + collapsible-lot treatment as the German table", () => {
    wrap(
      <IdSalesTable
        rows={[idMulti]}
        totalProceeds="2892"
        totalSalesTax="2.89"
        currency="EUR"
        locale="en"
        year={2026}
      />,
    );
    expect(screen.getByText(/avg €78\.20 → €96\.40 · 3 lots/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("IWDA"));
    expect(screen.getByText(/2021-01-15/)).toBeInTheDocument();
  });

  it("renders the empty state when there are no disposals", () => {
    wrap(
      <IdSalesTable
        rows={[]}
        totalProceeds="0"
        totalSalesTax="0"
        currency="EUR"
        locale="en"
        year={2026}
      />,
    );
    expect(screen.getByText(/No disposals/)).toBeInTheDocument();
    expect(screen.queryByText("Total")).not.toBeInTheDocument();
  });
});
