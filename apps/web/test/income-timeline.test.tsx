import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));
vi.mock("@/lib/api", () => ({
  useApiClient: () => ({ listTransactions: vi.fn(async () => []) }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import { IncomeTimeline } from "../src/components/income/income-timeline";
import type { IncomeEventRow } from "../src/components/income/income-events-table";

const bbca2026: IncomeEventRow = {
  instrumentId: "i-bbca",
  symbol: "BBCA",
  name: "Bank Central Asia",
  displayName: null,
  type: "dividend",
  date: "2026-07-15",
  amount: "500000",
  currency: "IDR",
};

const tlkm2026Forecast: IncomeEventRow = {
  instrumentId: "i-tlkm",
  symbol: "TLKM",
  name: "Telkom Indonesia",
  displayName: null,
  type: "dividend",
  date: "2026-08-20",
  amount: "300000",
  currency: "IDR",
  status: "projected",
};

const sap2025: IncomeEventRow = {
  instrumentId: "i-sap",
  symbol: "SAP",
  name: "SAP SE",
  displayName: null,
  type: "dividend",
  date: "2025-03-01",
  amount: "168",
  currency: "EUR",
};

function wrap(rows: IncomeEventRow[]) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <IncomeTimeline rows={rows} locale="en" />
    </NextIntlClientProvider>,
  );
}

describe("IncomeTimeline", () => {
  it("groups rows by year, newest first, under the 'All' chip by default", () => {
    wrap([bbca2026, tlkm2026Forecast, sap2025]);
    expect(screen.getAllByText("BBCA").length).toBeGreaterThan(0);
    expect(screen.getAllByText("TLKM").length).toBeGreaterThan(0);
    expect(screen.getAllByText("SAP").length).toBeGreaterThan(0);
    expect(screen.getByText("2026")).toBeInTheDocument();
    expect(screen.getByText("2025")).toBeInTheDocument();
  });

  it("filters to received rows only", () => {
    wrap([bbca2026, tlkm2026Forecast]);
    fireEvent.click(screen.getByRole("button", { name: "Received" }));
    expect(screen.getAllByText("BBCA").length).toBeGreaterThan(0);
    expect(screen.queryByText("TLKM")).toBeNull();
  });

  it("filters to forecast rows only", () => {
    wrap([bbca2026, tlkm2026Forecast]);
    fireEvent.click(screen.getByRole("button", { name: "Forecast" }));
    expect(screen.getAllByText("TLKM").length).toBeGreaterThan(0);
    expect(screen.queryByText("BBCA")).toBeNull();
  });

  it("narrows rows by search text (symbol match)", () => {
    wrap([bbca2026, sap2025]);
    fireEvent.change(screen.getByPlaceholderText("Search income…"), {
      target: { value: "sap" },
    });
    expect(screen.getAllByText("SAP").length).toBeGreaterThan(0);
    expect(screen.queryByText("BBCA")).toBeNull();
  });

  it("narrows rows by search text matching the clean displayName (#480)", () => {
    // MSFT-shaped fixture: raw broker name is unsearchable ("MICROSOFT DL-…"),
    // but the displayName "Microsoft" should make the row findable by plain search.
    const msft: IncomeEventRow = {
      instrumentId: "i-msft",
      symbol: "MSFT",
      name: "MICROSOFT DL- 00000625",
      displayName: "Microsoft",
      type: "dividend",
      date: "2026-05-01",
      amount: "13",
      currency: "USD",
    };
    wrap([bbca2026, msft]);
    fireEvent.change(screen.getByPlaceholderText("Search income…"), {
      target: { value: "microsoft" },
    });
    expect(screen.getAllByText("MSFT").length).toBeGreaterThan(0);
    expect(screen.queryByText("BBCA")).toBeNull();
  });

  it("filters to a single year via the year dropdown", () => {
    wrap([bbca2026, sap2025]);
    // Radix dropdown — opens on keyboard/pointer, not a plain click+query.
    fireEvent.keyDown(screen.getByRole("button", { name: "Year" }), { key: "Enter" });
    fireEvent.click(screen.getByRole("menuitem", { name: "2025" }));
    expect(screen.getAllByText("SAP").length).toBeGreaterThan(0);
    expect(screen.queryByText("BBCA")).toBeNull();
    expect(screen.queryByText("2026")).toBeNull();
  });

  it("does not show a year dropdown when every row falls in the same year", () => {
    wrap([bbca2026, tlkm2026Forecast]);
    expect(screen.queryByRole("button", { name: "Year" })).toBeNull();
  });

  it("shows an empty-filters message when nothing matches", () => {
    wrap([bbca2026]);
    fireEvent.change(screen.getByPlaceholderText("Search income…"), {
      target: { value: "nonexistent" },
    });
    expect(screen.getByText("No payments match your filters.")).toBeInTheDocument();
  });

  it("clears the search query via the clear button", () => {
    wrap([bbca2026, sap2025]);
    fireEvent.change(screen.getByPlaceholderText("Search income…"), {
      target: { value: "sap" },
    });
    expect(screen.queryByText("BBCA")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(screen.getAllByText("BBCA").length).toBeGreaterThan(0);
  });
});
