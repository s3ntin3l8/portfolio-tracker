import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import type { LotView } from "@portfolio/api-client";
import { InstrumentLotsTable } from "../src/components/instrument-lots-table";

function renderTable(lots: LotView[], currency = "IDR") {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <InstrumentLotsTable lots={lots} currency={currency} />
    </NextIntlClientProvider>,
  );
}

describe("InstrumentLotsTable", () => {
  it("renders each open lot in acquisition order", () => {
    const lots: LotView[] = [
      { acqDate: "2024-01-15", qty: "50", unitCost: "9500", cost: "475000" },
      { acqDate: "2024-03-01", qty: "20", unitCost: "9700", cost: "194000" },
    ];
    renderTable(lots);
    const rows = screen.getAllByRole("row").slice(1); // drop header row
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("50");
    expect(rows[1]).toHaveTextContent("20");
  });

  it("formats qty/price/cost using the given currency", () => {
    const lots: LotView[] = [
      { acqDate: "2024-01-15", qty: "50", unitCost: "9500", cost: "475000" },
    ];
    renderTable(lots, "IDR");
    expect(screen.getByText(/475,000/)).toBeInTheDocument();
    expect(screen.getByText(/9,500/)).toBeInTheDocument();
  });

  it("renders nothing when there are no open lots", () => {
    const { container } = renderTable([]);
    expect(container).toBeEmptyDOMElement();
  });

  it("sorts by Cost ascending on click", () => {
    const lots: LotView[] = [
      { acqDate: "2024-01-15", qty: "50", unitCost: "9500", cost: "475000" },
      { acqDate: "2024-03-01", qty: "20", unitCost: "9700", cost: "194000" },
    ];
    renderTable(lots);
    fireEvent.click(screen.getByRole("button", { name: /Cost/i }));
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows[0]).toHaveTextContent("194,000");
    expect(rows[1]).toHaveTextContent("475,000");
    expect(screen.getByRole("button", { name: /Cost/i }).closest("th")).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
  });
});
