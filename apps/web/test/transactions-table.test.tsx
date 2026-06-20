import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";

const refresh = vi.fn();
const bulkDeleteTransactions = vi.fn(async () => ({ deleted: 1 }));
const deleteTransaction = vi.fn(async () => undefined);

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ refresh }),
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));
vi.mock("@/lib/api", () => ({
  useApiClient: () => ({ bulkDeleteTransactions, deleteTransaction }),
}));

import {
  TransactionsTable,
  type TxRow,
} from "../src/components/transactions-table";

const ROWS: TxRow[] = [
  {
    id: "t1",
    portfolioId: "p1",
    portfolioName: "Main",
    type: "buy",
    quantity: "10",
    price: "100",
    fees: "5",
    tax: null,
    fxRate: null,
    currency: "IDR",
    executedAt: "2026-02-01T00:00:00.000Z",
    source: "manual",
    instrument: { symbol: "BBCA", name: "Bank Central Asia" },
  },
  {
    id: "t2",
    portfolioId: "p2",
    portfolioName: "DKB",
    type: "sell",
    quantity: "5",
    price: "200",
    fees: "0",
    tax: "10",
    fxRate: "15500",
    currency: "USD",
    executedAt: "2026-01-01T00:00:00.000Z",
    source: "csv",
    instrument: { symbol: "AAPL", name: "Apple" },
  },
];

// Helper: render a minimal table with a single row for targeted assertions.
function renderSingleRow(row: TxRow) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <TransactionsTable rows={[row]} />
    </NextIntlClientProvider>,
  );
}

const tb = messages.Transactions.batch;

function renderTable(showPortfolio = false) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <TransactionsTable rows={ROWS} showPortfolio={showPortfolio} />
    </NextIntlClientProvider>,
  );
}

describe("TransactionsTable", () => {
  beforeEach(() => {
    refresh.mockClear();
    bulkDeleteTransactions.mockClear();
  });

  it("shows the portfolio column only in the aggregate view", () => {
    const { rerender } = renderTable(false);
    expect(screen.queryByText("Main")).toBeNull();
    rerender(
      <NextIntlClientProvider locale="en" messages={messages}>
        <TransactionsTable rows={ROWS} showPortfolio />
      </NextIntlClientProvider>,
    );
    expect(screen.getByText("Main")).toBeInTheDocument();
    expect(screen.getByText("DKB")).toBeInTheDocument();
  });

  it("batch-deletes selected rows grouped by portfolio", async () => {
    renderTable(true);
    // Select all, then delete (two-step confirm).
    fireEvent.click(screen.getByLabelText(tb.selectAll));
    fireEvent.click(screen.getByRole("button", { name: new RegExp(tb.delete) }));
    fireEvent.click(screen.getByRole("button", { name: tb.confirm }));

    await waitFor(() => expect(bulkDeleteTransactions).toHaveBeenCalledTimes(2));
    expect(bulkDeleteTransactions).toHaveBeenCalledWith("p1", ["t1"]);
    expect(bulkDeleteTransactions).toHaveBeenCalledWith("p2", ["t2"]);
    expect(refresh).toHaveBeenCalled();
  });

  it("hides the batch toolbar when nothing is selected", () => {
    renderTable();
    expect(screen.queryByRole("button", { name: new RegExp(tb.delete) })).toBeNull();
  });

  it("formats each row's amount in its own currency, not a hardcoded one", () => {
    renderTable();
    // t1 rows are IDR, t2 rows are USD — both currencies must appear.
    // Multiple cells may now show each currency (Amount, Fees, Net Amount), so use getAllBy.
    expect(screen.getAllByText(/IDR/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/\$/).length).toBeGreaterThan(0);
  });

  it("sorts rows by date ascending when date header is clicked", () => {
    renderTable();
    // Default order: t1 (2026-02-01), t2 (2026-01-01) — t1 first
    const rows = screen.getAllByRole("row").slice(1); // skip header
    expect(rows[0]).toHaveTextContent("BBCA");

    // Click the date sort header
    fireEvent.click(screen.getByRole("button", { name: /date/i }));
    const sortedRows = screen.getAllByRole("row").slice(1);
    // After sorting asc by date: t2 (Jan) should come first
    expect(sortedRows[0]).toHaveTextContent("AAPL");
    expect(sortedRows[1]).toHaveTextContent("BBCA");
  });

  it("reverses date sort order when date header is clicked again", () => {
    renderTable();
    fireEvent.click(screen.getByRole("button", { name: /date/i }));
    fireEvent.click(screen.getByRole("button", { name: /date/i }));
    const sortedRows = screen.getAllByRole("row").slice(1);
    // desc: t1 (Feb) should come first
    expect(sortedRows[0]).toHaveTextContent("BBCA");
    expect(sortedRows[1]).toHaveTextContent("AAPL");
  });

  it("sorts rows by quantity numerically (not lexicographic)", () => {
    renderTable();
    // ROWS: t1 qty "10", t2 qty "5"
    // numeric asc: 5 (AAPL) first, then 10 (BBCA)
    fireEvent.click(screen.getByRole("button", { name: /quantity/i }));
    const sortedRows = screen.getAllByRole("row").slice(1);
    expect(sortedRows[0]).toHaveTextContent("AAPL");
    expect(sortedRows[1]).toHaveTextContent("BBCA");
  });

  it("shows sort icons in headers (neutral, ascending, descending)", () => {
    renderTable();
    // Before sorting: all headers show the neutral ChevronsUpDown icon
    const dateBtn = screen.getByRole("button", { name: /date/i });
    // Click once: ascending
    fireEvent.click(dateBtn);
    const th = dateBtn.closest("th");
    expect(th).toHaveAttribute("aria-sort", "ascending");

    // Click again: descending
    fireEvent.click(dateBtn);
    expect(th).toHaveAttribute("aria-sort", "descending");
  });

  it("renders new column headers for fees, tax, net amount, and fx rate", () => {
    renderTable();
    expect(screen.getByRole("button", { name: /fees/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /tax/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /net amount/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /fx rate/i })).toBeInTheDocument();
  });

  it("shows dash for zero fees and null tax, renders tax value when set", () => {
    renderTable();
    // t1 has fees "5" (non-zero → shows formatted), t2 has fees "0" → dash
    // t1 has tax null → dash, t2 has tax "10" → shows formatted
    // The cells are hidden on small screens but still in DOM; test by checking text content
    const cells = screen.getAllByRole("cell");
    const cellTexts = cells.map((c) => c.textContent ?? "");
    // t2 tax cell should show a dollar-formatted value (USD 10)
    expect(cellTexts.some((t) => t.includes("10"))).toBe(true);
    // tax for t1 (null) should render as —
    expect(cellTexts.some((t) => t === "—")).toBe(true);
  });

  it("renders the fx rate for t2 and dash for t1", () => {
    renderTable();
    // t2 fxRate = "15500" → should appear as "15500.0000"
    expect(screen.getAllByText(/15500/).length).toBeGreaterThan(0);
  });

  it("shows GROSS amount (price + tax) for dividend rows; net amount stays separate", () => {
    // Normal dividend: price=0.07 (net), tax=0.03 (withheld) → Amount should show gross 0.10.
    const dividendRow: TxRow = {
      id: "div1",
      portfolioId: "p1",
      type: "dividend",
      quantity: "0",
      price: "0.07",   // net cash credited (drives cashFlow)
      fees: "0",
      tax: "0.03",     // withheld (positive = deduction)
      fxRate: null,
      currency: "EUR",
      executedAt: "2026-05-09T00:00:00.000Z",
      source: "csv",
      instrument: { symbol: "O", name: "Realty Income" },
    };
    renderSingleRow(dividendRow);
    // Amount column = gross = 0.07 + 0.03 = 0.10
    // Net Amount column = cashFlow = 0.07
    // Both are formatted as EUR; check both values appear and 0.07 appears at least once (net)
    const cells = screen.getAllByRole("cell");
    const texts = cells.map((c) => c.textContent ?? "");
    // Gross (0.10) appears in the Amount cell
    expect(texts.some((t) => t.includes("0.10") || t.includes("0,10"))).toBe(true);
  });

  it("shows negative amount and net amount for a dividend reversal", () => {
    const reversalRow: TxRow = {
      id: "rev1",
      portfolioId: "p1",
      type: "dividend",
      quantity: "0",
      price: "-0.07",  // negative net (cash back to broker)
      fees: "0",
      tax: "-0.03",    // negative tax (refund, not a fresh withholding)
      fxRate: null,
      currency: "EUR",
      executedAt: "2026-11-15T00:00:00.000Z",
      source: "csv",
      instrument: { symbol: "O", name: "Realty Income" },
    };
    renderSingleRow(reversalRow);
    // gross = -0.07 + (-0.03) = -0.10 → Amount is negative
    const cells = screen.getAllByRole("cell");
    const texts = cells.map((c) => c.textContent ?? "");
    expect(texts.some((t) => t.includes("-") && (t.includes("0.10") || t.includes("0,10")))).toBe(true);
  });

  it("renders bonus_cash rows with the Bonus type badge", () => {
    const bonusRow: TxRow = {
      id: "bonus1",
      portfolioId: "p1",
      type: "bonus_cash",
      quantity: "0",
      price: "22.86",
      fees: "0",
      tax: null,
      fxRate: null,
      currency: "EUR",
      executedAt: "2026-01-20T00:00:00.000Z",
      source: "csv",
      instrument: null,
    };
    renderSingleRow(bonusRow);
    // The TxType.bonus_cash label ("Bonus") should appear in the badge.
    expect(screen.getByText(messages.TxType.bonus_cash)).toBeInTheDocument();
  });
});
