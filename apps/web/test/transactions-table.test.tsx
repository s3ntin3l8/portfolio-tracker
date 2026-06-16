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
    currency: "USD",
    executedAt: "2026-01-01T00:00:00.000Z",
    source: "csv",
    instrument: { symbol: "AAPL", name: "Apple" },
  },
];

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
    // t1 amount is IDR, t2 amount is USD — pre-fix both rendered as IDR.
    expect(screen.getByText(/IDR/)).toBeInTheDocument();
    expect(screen.getByText(/\$/)).toBeInTheDocument();
  });
});
