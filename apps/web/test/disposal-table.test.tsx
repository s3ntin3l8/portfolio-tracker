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
  tfRate: "0",
  gainAdjusted: "430",
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
// IWDA is an equity ETF — 30% Teilfreistellung, so it exercises the Tf-adjusted
// sub-line (unlike singleLot's plain stock, tfRate 0).
const multiLot: TaxDisposalRow = {
  symbol: "IWDA",
  when: "2026-04-01",
  proceeds: "2892",
  gain: "546",
  tfRate: "0.30",
  gainAdjusted: "382.20",
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
    // tfRate=0 (a plain stock) — no Tf-adjusted sub-line.
    expect(screen.queryByText(/after.*% TF/)).toBeNull();
  });

  it("shows a Tf-adjusted sub-line under the gain for a partially-exempt instrument (ETF)", () => {
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
    expect(screen.getByText(/€382\.20 after 30% TF/)).toBeInTheDocument();
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

  it("keeps a multi-lot row expanded when a sort reorders the table", () => {
    // Two rows so the multi-lot row's index actually changes on sort; a
    // single-row case is a no-op for index-based keys and would not exercise
    // the regression. Sorting by Gain flips the multi-lot row between index
    // 0 and 1 — before the fix, the Fragment remounted and the lot rows
    // collapsed back into the aggregate row.
    const cheap = { ...singleLot, proceeds: "100", gain: "10" };
    wrap(
      <DisposalTable
        rows={[multiLot, cheap]}
        totalProceeds="2992"
        totalGain="556"
        currency="EUR"
        locale="en"
        year={2026}
      />,
    );
    fireEvent.click(screen.getByText("IWDA"));
    expect(screen.getByText(/2021-01-15/)).toBeInTheDocument();
    expect(screen.getByText(/2022-06-10/)).toBeInTheDocument();
    expect(screen.getByText(/2023-02-20/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Gain/i }));

    expect(screen.getByText(/2021-01-15/)).toBeInTheDocument();
    expect(screen.getByText(/2022-06-10/)).toBeInTheDocument();
    expect(screen.getByText(/2023-02-20/)).toBeInTheDocument();
  });

  it("sorts by Gain ascending when the Gain header is clicked", () => {
    // cheap (gain 10) must render BELOW rich (gain 546) by default — the table has
    // no inherent order, so we assert that clicking Gain flips the row order.
    const cheap = { ...singleLot, proceeds: "100", gain: "10" };
    const rich = { ...multiLot, proceeds: "2892", gain: "546" };
    wrap(
      <DisposalTable
        rows={[rich, cheap]}
        totalProceeds="2992"
        totalGain="556"
        currency="EUR"
        locale="en"
        year={2026}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Gain/i }));
    const dataRows = screen.getAllByRole("row").slice(1);
    // After asc: cheap (10) first, rich (546) second.
    expect(dataRows[0]).toHaveTextContent("NVDA");
    expect(dataRows[1]).toHaveTextContent("IWDA");
    // Active column gets aria-sort=ascending.
    expect(screen.getByRole("button", { name: /Gain/i }).closest("th")).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
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

  it("sorts by Tax ascending when the Tax header is clicked", () => {
    // idSingle (tax 1.24) and idMulti (tax 2.89) — single-lot row is the
    // tax-cheap one, multi-lot the tax-rich one. Same shape as the German
    // Gain test, just on a different column.
    wrap(
      <IdSalesTable
        rows={[idMulti, idSingle]}
        totalProceeds="4132"
        totalSalesTax="4.13"
        currency="EUR"
        locale="en"
        year={2026}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Tax/i }));
    const dataRows = screen.getAllByRole("row").slice(1);
    // After asc: idSingle (1.24) first, idMulti (2.89) second.
    expect(dataRows[0]).toHaveTextContent("NVDA");
    expect(dataRows[1]).toHaveTextContent("IWDA");
    expect(screen.getByRole("button", { name: /Tax/i }).closest("th")).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
  });

  // Regression guard for the row-key collision found in PR #496 review: two distinct
  // instruments that share a displayed `symbol` (dual-listed tickers, or the
  // `instrumentId.slice(0, 8)` fallback for unnamed instruments) and both have a
  // disposal on the same day must not collide on the same React key / expand state.
  // Two multi-lot rows that look identical (same symbol, same when, same day) but
  // belong to different instruments — clicking one to expand its lot detail must
  // not expand the other's.
  it("treats two rows with the same symbol+when as distinct when instrumentId differs", () => {
    const sharedSymbol = "DUP";
    const sharedWhen = "2026-05-15";
    const dupA: TaxDisposalRow = {
      instrumentId: "inst-A",
      symbol: sharedSymbol,
      when: sharedWhen,
      proceeds: "100",
      gain: "10",
      tfRate: "0",
      gainAdjusted: "10",
      quantity: "1",
      avgBuyPrice: "100",
      sellPrice: "100",
      lots: [
        {
          acqDate: "2025-01-10",
          quantity: "1",
          buyPrice: "100",
          sellPrice: "100",
          proceeds: "100",
          gain: "10",
          holdingDays: 400,
          longTerm: true,
        },
      ],
    };
    const dupB: TaxDisposalRow = {
      instrumentId: "inst-B",
      symbol: sharedSymbol,
      when: sharedWhen,
      proceeds: "200",
      gain: "20",
      tfRate: "0",
      gainAdjusted: "20",
      quantity: "1",
      avgBuyPrice: "200",
      sellPrice: "200",
      lots: [
        {
          acqDate: "2025-06-20",
          quantity: "1",
          buyPrice: "200",
          sellPrice: "200",
          proceeds: "200",
          gain: "20",
          holdingDays: 300,
          longTerm: false,
        },
      ],
    };
    // Both rows have a single lot — but for the click-to-expand chevron to appear
    // we need `lots.length > 1`. Push a second lot onto each so the multi-lot
    // affordance (and its click handler) is exercised.
    dupA.lots.push({
      acqDate: "2025-02-15",
      quantity: "1",
      buyPrice: "100",
      sellPrice: "100",
      proceeds: "100",
      gain: "10",
      holdingDays: 380,
      longTerm: true,
    });
    dupB.lots.push({
      acqDate: "2025-07-01",
      quantity: "1",
      buyPrice: "200",
      sellPrice: "200",
      proceeds: "200",
      gain: "20",
      holdingDays: 290,
      longTerm: false,
    });

    wrap(
      <DisposalTable
        rows={[dupA, dupB]}
        totalProceeds="300"
        totalGain="30"
        currency="EUR"
        locale="en"
        year={2026}
      />,
    );

    // Both aggregate rows render (each carries its own chevron for the >1 lots case).
    expect(screen.getAllByText("DUP")).toHaveLength(2);

    // Each row shows a distinct avg-buy line so we can tell them apart when expanded.
    // dupA's lots were both bought at €100, so its avg is €100; dupB's lots at €200,
    // avg €200. (avg = Σcost/Σqty, both at 1 share.)
    expect(screen.getByText(/avg €100\.00 → €100\.00 · 2 lots/)).toBeInTheDocument();
    expect(screen.getByText(/avg €200\.00 → €200\.00 · 2 lots/)).toBeInTheDocument();

    // Click the first row directly (header row is index 0; dupA is row 1). The
    // row's onClick handler is the click target — a `fireEvent.click` on the row
    // element itself is the most reliable way to exercise the toggle.
    const dataRows = screen.getAllByRole("row");
    fireEvent.click(dataRows[1]!);
    // Lot dates for dupA are 2025-01-10 and 2025-02-15; for dupB they're
    // 2025-06-20 and 2025-07-01. The lot row's cell concatenates
    // `${acqDate} · ${quantity} @ ${buyPrice} → ${sellPrice}` into a single text
    // node, so use a regex matcher (not a literal string, which would require
    // an exact text match).
    expect(screen.getByText(/2025-01-10/)).toBeInTheDocument();
    expect(screen.getByText(/2025-02-15/)).toBeInTheDocument();
    // dupB's lot dates must NOT be visible — the second row is still collapsed.
    expect(screen.queryByText(/2025-06-20/)).not.toBeInTheDocument();
    expect(screen.queryByText(/2025-07-01/)).not.toBeInTheDocument();
  });
});
