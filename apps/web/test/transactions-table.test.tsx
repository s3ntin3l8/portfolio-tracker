import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";

const refresh = vi.fn();
const bulkDeleteTransactions = vi.fn(async () => ({ deleted: 1 }));
const deleteTransaction = vi.fn(async () => undefined);
const setTransactionStatus = vi.fn(async () => ({}));
const resolveDraftTransactions = vi.fn(async () => ({ updated: 1 }));
const reassignTransactions = vi.fn(async () => ({
  moved: 1,
  skippedConflicts: 0,
  skippedLoans: 0,
}));

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ refresh }),
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));
vi.mock("@/lib/api", () => ({
  useApiClient: () => ({
    bulkDeleteTransactions,
    deleteTransaction,
    setTransactionStatus,
    resolveDraftTransactions,
    reassignTransactions,
  }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() } }));

const PORTFOLIOS = [
  { id: "p1", name: "Main", brokerage: null, accountHolder: null },
  { id: "p2", name: "DKB", brokerage: null, accountHolder: null },
];

import {
  TransactionsTable,
  txNetAmount,
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

// Extended fixture: 3 rows across 2 types, 2 instruments, 2 years for filter tests.
const FILTER_ROWS: TxRow[] = [
  {
    id: "f1",
    portfolioId: "p1",
    type: "buy",
    quantity: "10",
    price: "100",
    fees: "0",
    tax: null,
    fxRate: null,
    currency: "IDR",
    executedAt: "2025-06-01T00:00:00.000Z",
    source: "manual",
    instrument: { symbol: "BBCA", name: "Bank Central Asia" },
  },
  {
    id: "f2",
    portfolioId: "p1",
    type: "dividend",
    quantity: "0",
    price: "50",
    fees: "0",
    tax: null,
    fxRate: null,
    currency: "IDR",
    executedAt: "2026-03-01T00:00:00.000Z",
    source: "manual",
    instrument: { symbol: "BBCA", name: "Bank Central Asia" },
  },
  {
    id: "f3",
    portfolioId: "p1",
    type: "buy",
    quantity: "5",
    price: "200",
    fees: "0",
    tax: null,
    fxRate: null,
    currency: "IDR",
    executedAt: "2026-04-01T00:00:00.000Z",
    source: "manual",
    instrument: { symbol: "AAPL", name: "Apple" },
  },
];

function renderFilterTable() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <TransactionsTable rows={FILTER_ROWS} />
    </NextIntlClientProvider>,
  );
}

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
    reassignTransactions.mockClear();
  });

  it("reassigns a single row to another portfolio", async () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <TransactionsTable rows={ROWS} showPortfolio portfolios={PORTFOLIOS} />
      </NextIntlClientProvider>,
    );
    // Open the row's Reassign action (first row is portfolio p1).
    const reassignButtons = screen.getAllByRole("button", {
      name: messages.Manage.reassign,
    });
    fireEvent.click(reassignButtons[0]);

    // The dialog shows; p1 is excluded so the only target is DKB (p2) — confirm the move.
    fireEvent.click(
      screen.getByRole("button", { name: messages.Transactions.reassign.confirm }),
    );
    await waitFor(() =>
      expect(reassignTransactions).toHaveBeenCalledWith("p1", ["t1"], "p2"),
    );
  });

  it("hides the reassign action when only one portfolio exists", () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <TransactionsTable rows={ROWS} portfolios={[PORTFOLIOS[0]]} />
      </NextIntlClientProvider>,
    );
    expect(
      screen.queryByRole("button", { name: messages.Manage.reassign }),
    ).toBeNull();
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

  it("renders the reference column headers (Transaction, Price, Source, Amount)", () => {
    renderTable();
    expect(
      screen.getByRole("button", { name: messages.Transactions.transactionCol }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /price/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /source/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /amount/i })).toBeInTheDocument();
  });

  it("shows a dash in the price column for qty-less cash rows", () => {
    const cashRow: TxRow = {
      id: "cash1",
      portfolioId: "p1",
      type: "deposit",
      quantity: "0",
      price: "500",
      fees: "0",
      tax: null,
      fxRate: null,
      currency: "EUR",
      executedAt: "2026-03-01T00:00:00.000Z",
      source: "manual",
      instrument: null,
    };
    renderSingleRow(cashRow);
    const cells = screen.getAllByRole("cell");
    const cellTexts = cells.map((c) => c.textContent ?? "");
    expect(cellTexts.some((t) => t === "—")).toBe(true);
  });

  it("shows the net cash amount for dividend rows", () => {
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
    // Reference table shows one Amount column = the NET cash movement (0.07).
    const cells = screen.getAllByRole("cell");
    const texts = cells.map((c) => c.textContent ?? "");
    expect(texts.some((t) => t.includes("0.07") || t.includes("0,07"))).toBe(true);
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
    // net = -0.07 → Amount is negative
    const cells = screen.getAllByRole("cell");
    const texts = cells.map((c) => c.textContent ?? "");
    expect(texts.some((t) => t.includes("-") && (t.includes("0.07") || t.includes("0,07")))).toBe(true);
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

  describe("transaction status", () => {
    it("renders an Archived badge and dims the row for archived transactions", () => {
      renderSingleRow({ ...ROWS[0], status: "archived" });
      expect(screen.getByText(messages.Manage.status.badgeArchived)).toBeInTheDocument();
      // The row is visually de-emphasised.
      const row = screen.getAllByRole("row").slice(1)[0];
      expect(row.className).toContain("opacity-50");
    });

    it("renders a Cash-neutral badge for cash_neutral transactions", () => {
      renderSingleRow({ ...ROWS[0], status: "cash_neutral" });
      expect(screen.getByText(messages.Manage.status.badgeCashNeutral)).toBeInTheDocument();
    });

    it("exposes a per-row status control", () => {
      renderSingleRow({ ...ROWS[0], status: "normal" });
      expect(
        screen.getByRole("button", { name: messages.Manage.status.label }),
      ).toBeInTheDocument();
    });
  });

  describe("txNetAmount — display net (drafts preview their face value)", () => {
    // A Vorabpauschale-style income leg: net cash lives in `price`, no quantity.
    const incomeLeg: TxRow = {
      id: "vp",
      portfolioId: "p1",
      portfolioName: "Main",
      type: "interest",
      quantity: "0",
      price: "-0.06",
      fees: "0",
      tax: "0.06",
      fxRate: null,
      currency: "EUR",
      executedAt: "2026-01-28T00:00:00.000Z",
      source: "csv",
      instrument: null,
    };

    it("a DRAFT row shows its face-value net, not 0", () => {
      expect(txNetAmount({ ...incomeLeg, status: "draft" })).toBeCloseTo(-0.06);
    });

    it("a normal row shows the same net", () => {
      expect(txNetAmount({ ...incomeLeg, status: "normal" })).toBeCloseTo(-0.06);
    });

    it("archived (voided) and cash_neutral rows keep their real net of 0", () => {
      expect(txNetAmount({ ...incomeLeg, status: "archived" })).toBeCloseTo(0);
      expect(txNetAmount({ ...incomeLeg, status: "cash_neutral" })).toBeCloseTo(0); // fees only (0)
    });
  });

  describe("draft transactions", () => {
    const md = messages.Manage.status;

    it("renders a Draft badge for draft rows", () => {
      renderSingleRow({ ...ROWS[0], status: "draft" });
      expect(screen.getByText(md.badgeDraft)).toBeInTheDocument();
    });

    it("shows a needs-review marker on a low-confidence draft, and not otherwise", () => {
      renderSingleRow({ ...ROWS[0], status: "draft", needsReview: true });
      expect(screen.getByLabelText(md.needsReview)).toBeInTheDocument();
    });

    it("does not show the needs-review marker on a confident draft", () => {
      renderSingleRow({ ...ROWS[0], status: "draft", needsReview: false });
      expect(screen.queryByLabelText(md.needsReview)).toBeNull();
    });

    it("confirming a draft row calls resolveDraftTransactions with action=confirm", async () => {
      resolveDraftTransactions.mockClear();
      renderSingleRow({ ...ROWS[0], status: "draft" });
      fireEvent.click(screen.getByRole("button", { name: md.confirmDraft }));
      await waitFor(() =>
        expect(resolveDraftTransactions).toHaveBeenCalledWith("p1", ["t1"], "confirm"),
      );
    });

    it("discarding a draft row calls resolveDraftTransactions with action=discard", async () => {
      resolveDraftTransactions.mockClear();
      renderSingleRow({ ...ROWS[0], status: "draft" });
      fireEvent.click(screen.getByRole("button", { name: md.discardDraft }));
      await waitFor(() =>
        expect(resolveDraftTransactions).toHaveBeenCalledWith("p1", ["t1"], "discard"),
      );
    });

    it("filters to drafts only via the draft filter", () => {
      render(
        <NextIntlClientProvider locale="en" messages={messages}>
          <TransactionsTable rows={[ROWS[0], { ...ROWS[1], status: "draft" }]} />
        </NextIntlClientProvider>,
      );
      const draftSelect = screen.getByRole("combobox", {
        name: messages.Transactions.filterDraftLabel,
      });
      fireEvent.change(draftSelect, { target: { value: "drafts" } });
      const rows = screen.getAllByRole("row").slice(1);
      expect(rows.length).toBe(1);
      expect(rows[0]).toHaveTextContent("AAPL"); // t2 is the draft
    });

    it("auto-clears the draft filter when the last draft is confirmed", () => {
      const draftRow = { ...ROWS[1], status: "draft" as const };
      const { rerender } = render(
        <NextIntlClientProvider locale="en" messages={messages}>
          <TransactionsTable rows={[ROWS[0], draftRow]} />
        </NextIntlClientProvider>,
      );

      // Filter to drafts only: just the one draft row is visible.
      fireEvent.change(
        screen.getByRole("combobox", { name: messages.Transactions.filterDraftLabel }),
        { target: { value: "drafts" } },
      );
      expect(screen.getAllByRole("row").slice(1).length).toBe(1);

      // Confirming the last draft → router.refresh re-feeds rows with no drafts.
      rerender(
        <NextIntlClientProvider locale="en" messages={messages}>
          <TransactionsTable rows={[ROWS[0], ROWS[1]]} />
        </NextIntlClientProvider>,
      );

      // Filter auto-clears: all rows visible again instead of an empty "No results" list.
      expect(screen.getAllByRole("row").slice(1).length).toBe(2);
    });

    it("batch-confirms only the selected draft rows", async () => {
      resolveDraftTransactions.mockClear();
      render(
        <NextIntlClientProvider locale="en" messages={messages}>
          <TransactionsTable rows={[ROWS[0], { ...ROWS[1], status: "draft" }]} />
        </NextIntlClientProvider>,
      );
      // Select all (one normal, one draft), then confirm — only the draft is resolved.
      fireEvent.click(screen.getByLabelText(tb.selectAll));
      fireEvent.click(
        screen.getByRole("button", { name: new RegExp(tb.confirmDrafts) }),
      );
      await waitFor(() =>
        expect(resolveDraftTransactions).toHaveBeenCalledWith("p2", ["t2"], "confirm"),
      );
    });
  });

  describe("list filters", () => {
    it("renders the reference filter chips (All / Buys / Sells / Income)", () => {
      renderFilterTable();
      expect(
        screen.getByRole("button", { name: messages.Transactions.banners.chipBuys }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: messages.Transactions.banners.chipSells }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: messages.Transactions.banners.chipIncome }),
      ).toBeInTheDocument();
    });

    it("filtering by the Buys chip shows only matching rows", () => {
      renderFilterTable();
      fireEvent.click(screen.getByRole("button", { name: messages.Transactions.banners.chipBuys }));
      const rows = screen.getAllByRole("row").slice(1); // skip header
      expect(rows.length).toBe(2);
      expect(rows.some((r) => r.textContent?.includes("BBCA"))).toBe(true);
      expect(rows.some((r) => r.textContent?.includes("AAPL"))).toBe(true);
    });

    it("filtering by instrument shows only matching rows", () => {
      renderFilterTable();
      const instSelect = screen.getByRole("combobox", { name: messages.Transactions.filterInstrument });
      // Select "BBCA" — f1 and f2 match; f3 (AAPL) should be gone
      fireEvent.change(instSelect, { target: { value: "BBCA" } });
      const rows = screen.getAllByRole("row").slice(1);
      expect(rows.length).toBe(2);
      expect(rows.every((r) => r.textContent?.includes("BBCA"))).toBe(true);
    });

    it("filtering by year shows only matching rows", () => {
      renderFilterTable();
      const yearSelect = screen.getByRole("combobox", { name: messages.Transactions.filterYear });
      // Select "2025" — only f1 should remain
      fireEvent.change(yearSelect, { target: { value: "2025" } });
      const rows = screen.getAllByRole("row").slice(1);
      expect(rows.length).toBe(1);
      expect(rows[0]).toHaveTextContent("BBCA");
    });

    it("composes the Buys chip and year filters", () => {
      renderFilterTable();
      const yearSelect = screen.getByRole("combobox", { name: messages.Transactions.filterYear });
      // buy AND 2026: only f3 (AAPL, 2026-04)
      fireEvent.click(screen.getByRole("button", { name: messages.Transactions.banners.chipBuys }));
      fireEvent.change(yearSelect, { target: { value: "2026" } });
      const rows = screen.getAllByRole("row").slice(1);
      expect(rows.length).toBe(1);
      expect(rows[0]).toHaveTextContent("AAPL");
    });

    it("resetting to the All chip restores all rows", () => {
      renderFilterTable();
      fireEvent.click(screen.getByRole("button", { name: messages.Transactions.banners.chipBuys }));
      fireEvent.click(screen.getByRole("button", { name: messages.Transactions.filterAll }));
      const rows = screen.getAllByRole("row").slice(1);
      expect(rows.length).toBe(FILTER_ROWS.length);
    });
  });

  describe("anomaly banner and flagged-rows filter", () => {
    const ANOMALY_ROWS: TxRow[] = [
      {
        id: "a1",
        portfolioId: "p1",
        type: "sell",
        quantity: "100",
        price: "10",
        fees: "0",
        tax: null,
        fxRate: null,
        currency: "IDR",
        executedAt: "2026-05-01T00:00:00.000Z",
        source: "manual",
        instrument: { symbol: "BBCA", name: "Bank Central Asia" },
      },
      {
        id: "a2",
        portfolioId: "p1",
        type: "buy",
        quantity: "50",
        price: "10",
        fees: "0",
        tax: null,
        fxRate: null,
        currency: "IDR",
        executedAt: "2026-04-01T00:00:00.000Z",
        source: "manual",
        instrument: { symbol: "TLKM", name: "Telkom" },
      },
      {
        id: "a3",
        portfolioId: "p1",
        type: "buy",
        quantity: "10",
        price: "0",
        fees: "0",
        tax: null,
        fxRate: null,
        currency: "IDR",
        executedAt: "2026-03-01T00:00:00.000Z",
        source: "manual",
        instrument: { symbol: "AAPL", name: "Apple" },
      },
    ];

    // a1 has an error, a3 has a warning, a2 is clean.
    const MIXED_ANOMALIES = [
      { code: "oversell" as const, severity: "error" as const, scope: "transaction" as const, transactionId: "a1" },
      { code: "zero_price" as const, severity: "warning" as const, scope: "transaction" as const, transactionId: "a3" },
    ];

    it("renders the anomaly banner when transaction-scoped anomalies are present", () => {
      render(
        <NextIntlClientProvider locale="en" messages={messages}>
          <TransactionsTable rows={ANOMALY_ROWS} anomalies={MIXED_ANOMALIES} />
        </NextIntlClientProvider>,
      );
      // Banner text: 1 error + 1 warning → bannerBoth pattern
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    it("shows the 'Show flagged only' toggle when there are row-flagged anomalies", () => {
      render(
        <NextIntlClientProvider locale="en" messages={messages}>
          <TransactionsTable rows={ANOMALY_ROWS} anomalies={MIXED_ANOMALIES} />
        </NextIntlClientProvider>,
      );
      expect(screen.getByRole("button", { name: messages.Anomalies.showFlagged })).toBeInTheDocument();
    });

    it("clicking the toggle shows only flagged rows; clicking again restores all", () => {
      render(
        <NextIntlClientProvider locale="en" messages={messages}>
          <TransactionsTable rows={ANOMALY_ROWS} anomalies={MIXED_ANOMALIES} />
        </NextIntlClientProvider>,
      );
      const toggle = screen.getByRole("button", { name: messages.Anomalies.showFlagged });

      // Before: all 3 rows visible.
      expect(screen.getAllByRole("row").slice(1).length).toBe(3);

      fireEvent.click(toggle);
      // After toggling: only a1 (error) and a3 (warning) — a2 (clean) hidden.
      const filtered = screen.getAllByRole("row").slice(1);
      expect(filtered.length).toBe(2);
      expect(filtered.some((r) => r.textContent?.includes("BBCA"))).toBe(true);
      expect(filtered.some((r) => r.textContent?.includes("AAPL"))).toBe(true);
      expect(filtered.every((r) => !r.textContent?.includes("TLKM"))).toBe(true);

      // Toggle off: all restored.
      fireEvent.click(toggle);
      expect(screen.getAllByRole("row").slice(1).length).toBe(3);
    });

    it("auto-clears the flagged filter when the last flagged transaction is dismissed", () => {
      const { rerender } = render(
        <NextIntlClientProvider locale="en" messages={messages}>
          <TransactionsTable rows={ANOMALY_ROWS} anomalies={MIXED_ANOMALIES} />
        </NextIntlClientProvider>,
      );

      // Turn the filter on: only the 2 flagged rows are visible.
      fireEvent.click(screen.getByRole("button", { name: messages.Anomalies.showFlagged }));
      expect(screen.getAllByRole("row").slice(1).length).toBe(2);

      // Dismissing the last warning → router.refresh re-feeds an empty anomalies list.
      rerender(
        <NextIntlClientProvider locale="en" messages={messages}>
          <TransactionsTable rows={ANOMALY_ROWS} anomalies={[]} />
        </NextIntlClientProvider>,
      );

      // Filter auto-clears: all rows visible again instead of an empty "No results" list.
      const restored = screen.getAllByRole("row").slice(1);
      expect(restored.length).toBe(3);
      // The previously-hidden clean row (a2 / TLKM) is back.
      expect(restored.some((r) => r.textContent?.includes("TLKM"))).toBe(true);
    });

    it("does not show the toggle when only portfolio-scoped anomalies are present", () => {
      const portfolioOnlyAnomalies = [
        { code: "reconciliation_gap" as const, severity: "warning" as const, scope: "portfolio" as const },
      ];
      render(
        <NextIntlClientProvider locale="en" messages={messages}>
          <TransactionsTable rows={ANOMALY_ROWS} anomalies={portfolioOnlyAnomalies} />
        </NextIntlClientProvider>,
      );
      // Banner should appear (warning exists)...
      expect(screen.getByRole("alert")).toBeInTheDocument();
      // ...but no toggle (no transactionIds → flaggedCount === 0).
      expect(screen.queryByRole("button", { name: messages.Anomalies.showFlagged })).toBeNull();
    });

    it("shows no banner when anomalies array is empty (aggregate view)", () => {
      render(
        <NextIntlClientProvider locale="en" messages={messages}>
          <TransactionsTable rows={ANOMALY_ROWS} anomalies={[]} />
        </NextIntlClientProvider>,
      );
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByRole("button", { name: messages.Anomalies.showFlagged })).toBeNull();
    });
  });

  describe("text search", () => {
    function getSearchInput() {
      return screen.getByPlaceholderText(messages.Transactions.searchPlaceholder);
    }

    it("renders a search input", () => {
      renderFilterTable();
      expect(getSearchInput()).toBeInTheDocument();
    });

    it("filters rows by instrument symbol", () => {
      renderFilterTable();
      fireEvent.change(getSearchInput(), { target: { value: "BBCA" } });
      // FILTER_ROWS: f1 (BBCA buy) + f2 (BBCA dividend) match; f3 (AAPL buy) does not.
      const rows = screen.getAllByRole("row").slice(1);
      expect(rows.length).toBe(2);
      expect(rows.every((r) => r.textContent?.includes("BBCA"))).toBe(true);
    });

    it("filters rows by instrument name (case-insensitive)", () => {
      renderFilterTable();
      fireEvent.change(getSearchInput(), { target: { value: "apple" } });
      const rows = screen.getAllByRole("row").slice(1);
      expect(rows.length).toBe(1);
      expect(rows[0]).toHaveTextContent("AAPL");
    });

    it("filters rows by raw type string", () => {
      renderFilterTable();
      fireEvent.change(getSearchInput(), { target: { value: "dividend" } });
      const rows = screen.getAllByRole("row").slice(1);
      expect(rows.length).toBe(1);
      expect(rows[0]).toHaveTextContent("BBCA");
    });

    it("shows noResults message when search matches nothing", () => {
      renderFilterTable();
      fireEvent.change(getSearchInput(), { target: { value: "xyznonexistent" } });
      expect(screen.getByText(messages.Transactions.noResults)).toBeInTheDocument();
    });

    it("shows empty (not noResults) when the full row set is empty and there is no query", () => {
      render(
        <NextIntlClientProvider locale="en" messages={messages}>
          <TransactionsTable rows={[]} />
        </NextIntlClientProvider>,
      );
      expect(screen.getByText(messages.Transactions.empty)).toBeInTheDocument();
      expect(screen.queryByText(messages.Transactions.noResults)).toBeNull();
    });

    it("clearing the search via the X button restores all rows", () => {
      renderFilterTable();
      const input = getSearchInput();
      fireEvent.change(input, { target: { value: "BBCA" } });
      // The clear button should be visible.
      const clearBtn = screen.getByRole("button", { name: messages.Transactions.searchClear });
      fireEvent.click(clearBtn);
      // All rows restored.
      const rows = screen.getAllByRole("row").slice(1);
      expect(rows.length).toBe(FILTER_ROWS.length);
      expect((input as HTMLInputElement).value).toBe("");
    });

    it("composes text search with the Buys chip filter", () => {
      renderFilterTable();
      // Buys chip; then search for AAPL → only f3 matches
      fireEvent.click(screen.getByRole("button", { name: messages.Transactions.banners.chipBuys }));
      fireEvent.change(getSearchInput(), { target: { value: "AAPL" } });
      const rows = screen.getAllByRole("row").slice(1);
      expect(rows.length).toBe(1);
      expect(rows[0]).toHaveTextContent("AAPL");
    });
  });

  describe("anomaly tooltip", () => {
    it("localizes the negative_cash flag tooltip with the formatted balance", () => {
      render(
        <NextIntlClientProvider locale="en" messages={messages}>
          <TransactionsTable
            rows={ROWS}
            anomalies={[
              {
                code: "negative_cash",
                severity: "error",
                scope: "transaction",
                transactionId: "t1",
                meta: { currency: "EUR", balance: "-0.98" },
              },
            ]}
          />
        </NextIntlClientProvider>,
      );
      const flag = screen.getByLabelText(/Negative cash balance/);
      expect(flag).toHaveAttribute("title", expect.stringContaining("-€0.98"));
    });
  });

  describe("filter-scoped summary banners", () => {
    const b = messages.Transactions.banners;

    it("shows the All banner (Invested/Proceeds/Income tiles) by default", () => {
      renderFilterTable();
      expect(screen.getByText(b.invested)).toBeInTheDocument();
      expect(screen.getByText(b.proceeds)).toBeInTheDocument();
      expect(screen.getByText(b.cashFlowMix)).toBeInTheDocument();
    });

    it("does not render the All banner when there are no rows", () => {
      render(
        <NextIntlClientProvider locale="en" messages={messages}>
          <TransactionsTable rows={[]} />
        </NextIntlClientProvider>,
      );
      expect(screen.queryByText(b.invested)).toBeNull();
    });

    it("switches to the Income banner when the Income chip is selected", () => {
      renderFilterTable();
      fireEvent.click(screen.getByRole("button", { name: messages.Transactions.banners.chipIncome }));
      expect(screen.queryByText(b.invested)).toBeNull();
      expect(screen.getByText(b.receivedYtd)).toBeInTheDocument();
      expect(screen.getByText(b.bySource)).toBeInTheDocument();
    });

    it("switches to the Buys banner when the Buys chip is selected", () => {
      renderFilterTable();
      fireEvent.click(screen.getByRole("button", { name: messages.Transactions.banners.chipBuys }));
      expect(screen.queryByText(b.invested)).toBeNull();
      expect(screen.getByText(b.investedAllTime)).toBeInTheDocument();
      expect(screen.getByText(b.mostBought)).toBeInTheDocument();
    });

    it("shows the reconciliation banner for a portfolio-scoped anomaly, independent of Show flagged", () => {
      render(
        <NextIntlClientProvider locale="en" messages={messages}>
          <TransactionsTable
            rows={FILTER_ROWS}
            anomalies={[
              {
                code: "reconciliation_gap",
                severity: "warning",
                scope: "portfolio",
                meta: { currency: "EUR", reported: "100", derived: "98" },
              },
            ]}
          />
        </NextIntlClientProvider>,
      );
      expect(screen.getByText(messages.Anomalies.reconciliationTitle)).toBeInTheDocument();
      expect(screen.getByText(messages.Anomalies.portfolioTag)).toBeInTheDocument();
      // No transaction-scoped anomaly → no "Show flagged" toggle, yet the recon banner shows.
      expect(screen.queryByRole("button", { name: messages.Anomalies.showFlagged })).toBeNull();
    });
  });
});
