import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";

import { IncomeEventsTable, type IncomeEventRow } from "../src/components/income/income-events-table";

const HISTORICAL: IncomeEventRow = {
  instrumentId: "i1",
  symbol: "BBCA",
  name: "Bank Central Asia",
  type: "dividend",
  date: "2025-07-15",
  amount: "500000",
  currency: "IDR",
};

const UPCOMING: IncomeEventRow = {
  instrumentId: "i2",
  symbol: "TLKM",
  name: "Telkom Indonesia",
  type: "dividend",
  date: "2026-08-20",
  amount: "300000",
  currency: "IDR",
  status: "projected",
};

function wrap(ui: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      {ui}
    </NextIntlClientProvider>,
  );
}

describe("IncomeEventsTable", () => {
  it("renders type badge for historical events", () => {
    wrap(<IncomeEventsTable rows={[HISTORICAL]} />);
    expect(screen.getByText("BBCA")).toBeInTheDocument();
    expect(screen.getByText("Dividend")).toBeInTheDocument();
  });

  it("renders status badge for upcoming payments with gray styling", () => {
    const { container } = wrap(<IncomeEventsTable rows={[UPCOMING]} />);
    expect(screen.getByText("TLKM")).toBeInTheDocument();
    expect(screen.getByText("Projected")).toBeInTheDocument();
    // The row should have muted-foreground class for grayish text
    const rows = container.querySelectorAll("tr");
    const dataRow = rows[1]; // skip header
    expect(dataRow.className).toContain("text-muted-foreground");
  });

  it("renders mixed historical and upcoming rows", () => {
    wrap(<IncomeEventsTable rows={[HISTORICAL, UPCOMING]} />);
    expect(screen.getByText("BBCA")).toBeInTheDocument();
    expect(screen.getByText("TLKM")).toBeInTheDocument();
    expect(screen.getByText("Dividend")).toBeInTheDocument();
    expect(screen.getByText("Projected")).toBeInTheDocument();
  });

  it("historical rows do not have muted styling", () => {
    const { container } = wrap(<IncomeEventsTable rows={[HISTORICAL]} />);
    const rows = container.querySelectorAll("tr");
    const dataRow = rows[1];
    expect(dataRow.className).not.toContain("text-muted-foreground");
  });
});
