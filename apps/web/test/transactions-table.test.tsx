import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act, within } from "@testing-library/react";
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
const previewMergeTransactions = vi.fn(async () => ({
  ok: true,
  merged: {
    quantity: "10",
    price: "100",
    executedAt: "2026-02-01T00:00:00.000Z",
    type: "buy",
    currency: "IDR",
    tax: null,
    fees: "5",
    executedPrice: null,
    fxRate: null,
    venue: null,
    documentCount: 0,
  },
}));
const mergeTransactions = vi.fn(async () => ({ survivorId: "m1" }));

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ refresh }),
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));
// A stable object — some components (e.g. MergeDialog) depend on `api` in a useEffect,
// and a fresh object literal on every call would re-trigger that effect on every render.
const apiMock = {
  bulkDeleteTransactions,
  deleteTransaction,
  setTransactionStatus,
  resolveDraftTransactions,
  reassignTransactions,
  previewMergeTransactions,
  mergeTransactions,
  // Needed once the in-place EditTransactionSheet mounts its AddTransactionForm.
  getGoldSources: vi.fn(async () => []),
  searchInstruments: vi.fn(async () => []),
  lookupInstruments: vi.fn(async () => []),
};
vi.mock("@/lib/api", () => ({
  useApiClient: () => apiMock,
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

/** Batch-select checkboxes are hidden until a long-press enters selection mode. Simulate
 *  the press-and-hold (450ms) on a row to reveal them. */
function enterSelectionMode(rowLabel = "Bank Central Asia") {
  const row = screen.getByText(rowLabel).closest("tr")!;
  vi.useFakeTimers();
  fireEvent.pointerDown(row);
  act(() => {
    vi.advanceTimersByTime(500);
  });
  fireEvent.pointerUp(row);
  vi.useRealTimers();
}

// Two rows in the SAME portfolio — the Merge action only appears when exactly two selected
// rows share a portfolio (a cross-portfolio merge doesn't correspond to a real event).
const MERGE_ROWS: TxRow[] = [
  {
    id: "m1",
    portfolioId: "p1",
    type: "buy",
    quantity: "10",
    price: "100",
    fees: "5",
    tax: null,
    fxRate: null,
    currency: "IDR",
    executedAt: "2026-02-01T00:00:00.000Z",
    source: "csv",
    instrument: { symbol: "BBCA", name: "Bank Central Asia" },
  },
  {
    id: "m2",
    portfolioId: "p1",
    type: "buy",
    quantity: "10",
    price: "100",
    fees: "5",
    tax: null,
    fxRate: null,
    currency: "IDR",
    executedAt: "2026-02-02T00:00:00.000Z",
    source: "pdf",
    instrument: { symbol: "TLKM", name: "Telkom" },
  },
];

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
    // Single-row actions live in the detail sheet (opened by clicking the row), not inline.
    fireEvent.click(screen.getByText("Bank Central Asia")); // t1 (portfolio p1)
    // Secondary actions live in the header "⋯" overflow menu now.
    fireEvent.keyDown(screen.getByRole("button", { name: messages.Manage.actions }), {
      key: "Enter",
    });
    fireEvent.click(screen.getByRole("menuitem", { name: messages.Manage.reassign }));

    // The dialog shows; p1 is excluded so the only target is DKB (p2) — confirm the move.
    fireEvent.click(
      screen.getByRole("button", { name: messages.Transactions.reassign.confirm }),
    );
    await waitFor(() =>
      expect(reassignTransactions).toHaveBeenCalledWith("p1", ["t1"], "p2"),
    );
  });

  // Scope to a row's own "select transaction" checkbox in the desktop table (both the
  // desktop and mobile renderings share the checkbox's aria-label, so an unscoped query
  // would match both).
  function selectRowCheckbox(label: string) {
    const table = screen.getByRole("table");
    const row = within(table).getByText(label).closest("tr")!;
    return within(row as HTMLElement).getByLabelText(tb.selectRow);
  }

  it("offers Merge only when exactly two selected rows share a portfolio", async () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <TransactionsTable rows={MERGE_ROWS} />
      </NextIntlClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: tb.selectRows }));
    fireEvent.click(selectRowCheckbox("Bank Central Asia"));
    // Only one row selected so far — Merge isn't offered yet.
    expect(screen.queryByRole("button", { name: new RegExp(tb.merge) })).toBeNull();

    fireEvent.click(selectRowCheckbox("Telkom")); // both rows now selected, both in p1
    fireEvent.click(screen.getByRole("button", { name: new RegExp(tb.merge) }));

    // The merge dialog opens and previews the merged result; the confirm button stays
    // disabled until the (async, mocked) preview resolves.
    await waitFor(() => expect(previewMergeTransactions).toHaveBeenCalledWith("p1", "m1", "m2"));
    const confirmButton = await screen.findByRole("button", {
      name: messages.Transactions.merge.confirm,
    });
    await waitFor(() => expect(confirmButton).not.toBeDisabled());
    fireEvent.click(confirmButton);
    await waitFor(() => expect(mergeTransactions).toHaveBeenCalledWith("p1", "m1", "m2"));
    expect(refresh).toHaveBeenCalled();
  });

  it("hides Merge when the two selected rows belong to different portfolios", () => {
    renderTable(true); // t1 in p1, t2 in p2
    fireEvent.click(screen.getByRole("button", { name: tb.selectRows }));
    fireEvent.click(selectRowCheckbox("Bank Central Asia"));
    fireEvent.click(selectRowCheckbox("Apple"));
    expect(screen.queryByRole("button", { name: new RegExp(tb.merge) })).toBeNull();
  });

  it("opens the edit sheet in place when Edit is clicked in the detail sheet", () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <TransactionsTable rows={ROWS} showPortfolio portfolios={PORTFOLIOS} />
      </NextIntlClientProvider>,
    );
    fireEvent.click(screen.getByText("Bank Central Asia")); // open the detail sheet
    fireEvent.click(screen.getByRole("button", { name: messages.Manage.edit }));
    // The edit sheet opens in place (no navigation) with its "Edit transaction" title.
    expect(screen.getByText(messages.Manage.tx.editTitle)).toBeInTheDocument();
  });

  it("hides the reassign action when only one portfolio exists", () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <TransactionsTable rows={ROWS} portfolios={[PORTFOLIOS[0]]} />
      </NextIntlClientProvider>,
    );
    // Open the detail sheet — with a single portfolio there's nowhere to reassign to.
    fireEvent.click(screen.getByText("Bank Central Asia"));
    // The overflow menu still opens (status control), but Reassign isn't offered.
    fireEvent.keyDown(screen.getByRole("button", { name: messages.Manage.actions }), {
      key: "Enter",
    });
    expect(
      screen.queryByRole("menuitem", { name: messages.Manage.reassign }),
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
    // Long-press to enter selection mode, then select all and delete (two-step confirm).
    enterSelectionMode();
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

  it("hides desktop checkboxes by default and reveals them via the select-rows toggle", () => {
    renderTable();
    expect(screen.queryByLabelText(tb.selectAll)).toBeNull();
    expect(screen.queryByLabelText(tb.selectRow)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: tb.selectRows }));

    expect(screen.getByLabelText(tb.selectAll)).toBeInTheDocument();
    // Entering selection mode with nothing picked yet shows the prompt, not "0 selected".
    expect(screen.getByText(tb.selectPrompt)).toBeInTheDocument();
  });

  it("cancel (X) exits selection mode and clears the selection", () => {
    renderTable();
    fireEvent.click(screen.getByRole("button", { name: tb.selectRows }));
    fireEvent.click(screen.getByLabelText(tb.selectAll));
    // Selection mode is active: the toggle is replaced by the select-all checkbox.
    expect(screen.queryByRole("button", { name: tb.selectRows })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: tb.cancel }));

    expect(screen.queryByLabelText(tb.selectAll)).toBeNull();
    expect(screen.getByRole("button", { name: tb.selectRows })).toBeInTheDocument();
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

  it("shows a desktop-only Tax column with the withheld amount, dash when none", () => {
    renderTable();
    expect(screen.getByRole("button", { name: messages.Transactions.tax })).toBeInTheDocument();
    const table = screen.getByRole("table");
    // t2 (Apple): tax "10", currency USD → formatted "$10.00" in its own cell.
    const taxedRow = within(table).getByText("Apple").closest("tr")!;
    expect(within(taxedRow as HTMLElement).getByText("$10.00")).toBeInTheDocument();
    // t1 (Bank Central Asia): tax null → dash, not blank or "0".
    const untaxedRow = within(table).getByText("Bank Central Asia").closest("tr")!;
    const cells = within(untaxedRow as HTMLElement).getAllByRole("cell");
    expect(cells.some((c) => c.textContent === "—")).toBe(true);
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

  it("shows shares/per-share (in native currency) instead of a dash, for a dividend that carries them", () => {
    // Rio Tinto GBP dividend: quantity stays "0" (net-EUR-credited convention), but
    // shares/perShare/nativeCurrency were parsed from the settlement PDF.
    const gbpDividendRow: TxRow = {
      id: "div-gbp",
      portfolioId: "p1",
      type: "dividend",
      quantity: "0",
      price: "34.23",
      fees: "0",
      tax: null,
      fxRate: "1.145199",
      shares: "27.526515",
      perShare: "1.08580023",
      nativeCurrency: "GBP",
      grossNative: "29.89",
      currency: "EUR",
      executedAt: "2025-09-25T00:00:00.000Z",
      source: "pytr",
      instrument: { symbol: "RIO1", name: "Rio Tinto" },
    };
    renderSingleRow(gbpDividendRow);
    const cells = screen.getAllByRole("cell");
    const texts = cells.map((c) => c.textContent ?? "");
    // Quantity cell shows the parsed share count, not "0" or "—".
    expect(texts.some((t) => t === "27.526515")).toBe(true);
    // Price cell shows the per-share rate formatted in GBP (native currency), not EUR.
    expect(texts.some((t) => t === "£1.09")).toBe(true);
  });

  it("falls back to a dash for a dividend with no shares/perShare captured (older/unparsed row)", () => {
    const plainDividendRow: TxRow = {
      id: "div-plain",
      portfolioId: "p1",
      type: "dividend",
      quantity: "0",
      price: "5.00",
      fees: "0",
      tax: null,
      fxRate: null,
      currency: "EUR",
      executedAt: "2025-01-01T00:00:00.000Z",
      source: "manual",
      instrument: { symbol: "BBCA", name: "Bank Central Asia" },
    };
    renderSingleRow(plainDividendRow);
    const cells = screen.getAllByRole("cell");
    const texts = cells.map((c) => c.textContent ?? "");
    expect(texts.some((t) => t === "—")).toBe(true);
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
    // Title appears in both the desktop table and the mobile card list.
    expect(screen.getAllByText(messages.TxType.bonus_cash).length).toBeGreaterThan(0);
  });

  // Matches a row title node whose text STARTS with `label` (it also carries a trailing
  // " · SYMBOL" from the instrument, e.g. "Saveback · BBCA"). Anchored + word-boundary so
  // "Buy" doesn't false-positive-match unrelated page chrome like the "Buys" filter chip.
  function titleStartsWith(label: string) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^${escaped}(\\s|$)`);
  }

  describe("kind-aware sub-type label (saveback/roundup/crypto bonus)", () => {
    // Saveback, round-up and crypto-bonus all collapse to a generic `buy`/`savings_plan`
    // `type` — the list must prefer `kind` so they don't all read as plain "Buy".
    it("shows 'Saveback', not 'Savings plan', for a savings_plan row with kind=saveback", () => {
      renderSingleRow({ ...ROWS[0], type: "savings_plan", kind: "saveback" });
      expect(
        screen.getAllByText(titleStartsWith(messages.TxType.saveback)).length,
      ).toBeGreaterThan(0);
      expect(
        screen.queryByText(titleStartsWith(messages.TxType.savings_plan)),
      ).not.toBeInTheDocument();
    });

    it("shows 'Round-up', not 'Buy', for a buy row with kind=roundup", () => {
      renderSingleRow({ ...ROWS[0], type: "buy", kind: "roundup" });
      expect(
        screen.getAllByText(titleStartsWith(messages.TxType.roundup)).length,
      ).toBeGreaterThan(0);
      expect(screen.queryByText(titleStartsWith(messages.TxType.buy))).not.toBeInTheDocument();
    });

    it("shows 'Crypto bonus', not 'Buy', for a buy row with kind=crypto_bonus", () => {
      renderSingleRow({ ...ROWS[0], type: "buy", kind: "crypto_bonus" });
      expect(
        screen.getAllByText(titleStartsWith(messages.TxType.crypto_bonus)).length,
      ).toBeGreaterThan(0);
      expect(screen.queryByText(titleStartsWith(messages.TxType.buy))).not.toBeInTheDocument();
    });

    it("still shows the generic 'Buy' label for a plain buy row (no kind)", () => {
      renderSingleRow({ ...ROWS[0], type: "buy", kind: null });
      expect(screen.getAllByText(titleStartsWith(messages.TxType.buy)).length).toBeGreaterThan(0);
    });
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

    it("exposes a per-row status control in the detail sheet", () => {
      renderSingleRow({ ...ROWS[0], status: "normal" });
      fireEvent.click(screen.getByText("Bank Central Asia"));
      // Status options live in the header "⋯" overflow menu.
      fireEvent.keyDown(screen.getByRole("button", { name: messages.Manage.actions }), {
        key: "Enter",
      });
      expect(
        screen.getByRole("menuitem", { name: messages.Manage.status.archived }),
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
      fireEvent.click(screen.getByText("Bank Central Asia")); // open the detail sheet
      fireEvent.click(screen.getByRole("button", { name: md.confirmDraft }));
      await waitFor(() =>
        expect(resolveDraftTransactions).toHaveBeenCalledWith("p1", ["t1"], "confirm"),
      );
    });

    it("discarding a draft row calls resolveDraftTransactions with action=discard", async () => {
      resolveDraftTransactions.mockClear();
      renderSingleRow({ ...ROWS[0], status: "draft" });
      fireEvent.click(screen.getByText("Bank Central Asia")); // open the detail sheet
      fireEvent.click(screen.getByRole("button", { name: md.discardDraft }));
      await waitFor(() =>
        expect(resolveDraftTransactions).toHaveBeenCalledWith("p1", ["t1"], "discard"),
      );
    });

    it("keeps the detail sheet open and reflects the fresh status after router.refresh() re-feeds a confirmed row", () => {
      const draftRow = { ...ROWS[0], status: "draft" as const };
      const { rerender } = render(
        <NextIntlClientProvider locale="en" messages={messages}>
          <TransactionsTable rows={[draftRow]} />
        </NextIntlClientProvider>,
      );

      fireEvent.click(screen.getByText("Bank Central Asia")); // open the detail sheet
      expect(screen.getByRole("button", { name: md.confirmDraft })).toBeInTheDocument();

      // Confirming calls the API and triggers router.refresh(), which re-feeds `rows` with
      // the same transaction now status='normal' — simulate that prop update directly rather
      // than relying on the (mocked, no-op) refresh() to do anything.
      rerender(
        <NextIntlClientProvider locale="en" messages={messages}>
          <TransactionsTable rows={[{ ...draftRow, status: "normal" }]} />
        </NextIntlClientProvider>,
      );

      // The sheet stays open (not closed/reset) but no longer offers Confirm/Discard, since
      // it's now re-pointed at the fresh (non-draft) row instead of the stale draft snapshot.
      // (Instrument name now renders in both the sheet and the row, hence getAllByText.)
      expect(screen.getAllByText("Bank Central Asia").length).toBeGreaterThan(0);
      expect(screen.queryByRole("button", { name: md.confirmDraft })).toBeNull();
      expect(screen.queryByRole("button", { name: md.discardDraft })).toBeNull();
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
      enterSelectionMode();
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

    // The year filter is a Radix dropdown (opens on keyboard/pointer, not a change event).
    function selectYear(year: string) {
      fireEvent.keyDown(
        screen.getByRole("button", { name: messages.Transactions.filterYear }),
        { key: "Enter" },
      );
      fireEvent.click(screen.getByRole("menuitem", { name: year }));
    }

    it("filtering by year shows only matching rows", () => {
      renderFilterTable();
      // Select "2025" — only f1 should remain
      selectYear("2025");
      const rows = screen.getAllByRole("row").slice(1);
      expect(rows.length).toBe(1);
      expect(rows[0]).toHaveTextContent("BBCA");
    });

    it("composes the Buys chip and year filters", () => {
      renderFilterTable();
      // buy AND 2026: only f3 (AAPL, 2026-04)
      fireEvent.click(screen.getByRole("button", { name: messages.Transactions.banners.chipBuys }));
      selectYear("2026");
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

  describe("load more pagination", () => {
    // No column sort is applied by default (useTableSort's `sort()` is a no-op until a
    // header is clicked), so the render order is simply array/insertion order — the same
    // order page.tsx already sorts rows into (newest-first) before handing them to this
    // component. "Instrument 0" (index 0) falls inside the first PAGE_SIZE-row window;
    // "Instrument 29" (the last index, for n=30) falls past it until Load more is clicked.
    function manyRows(n: number): TxRow[] {
      return Array.from({ length: n }, (_, i) => {
        const day = String((i % 28) + 1).padStart(2, "0");
        return {
          id: `m${i}`,
          portfolioId: "p1",
          type: "buy",
          quantity: "1",
          price: "100",
          fees: "0",
          tax: null,
          fxRate: null,
          currency: "IDR",
          executedAt: `2026-01-${day}T00:00:00.000Z`,
          source: "manual",
          instrument: { symbol: `SYM${i}`, name: `Instrument ${i}` },
        } satisfies TxRow;
      });
    }

    function renderMany(n: number) {
      return render(
        <NextIntlClientProvider locale="en" messages={messages}>
          <TransactionsTable rows={manyRows(n)} />
        </NextIntlClientProvider>,
      );
    }

    it("caps the ledger at 25 rows and shows a Load more control with a count", () => {
      renderMany(30);
      expect(screen.getAllByRole("row").length - 1).toBe(25); // -1 for the header row
      // The 30th (last-index) row falls past the initial 25-row window.
      expect(screen.queryByText("Instrument 29")).toBeNull();
      expect(screen.getByRole("button", { name: tb.loadMore })).toBeInTheDocument();
      expect(
        screen.getByText(tb.showingCount.replace("{shown}", "25").replace("{total}", "30")),
      ).toBeInTheDocument();
    });

    it("clicking Load more reveals the rest and then hides the control", () => {
      renderMany(30);
      fireEvent.click(screen.getByRole("button", { name: tb.loadMore }));
      expect(screen.getAllByRole("row").length - 1).toBe(30);
      expect(screen.getByText("Instrument 29")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: tb.loadMore })).toBeNull();
    });

    it("hides Load more when the full set already fits on one page", () => {
      renderMany(10);
      expect(screen.queryByRole("button", { name: tb.loadMore })).toBeNull();
    });

    it("re-caps the window when a filter narrows the view", () => {
      renderFilterTable(); // 3 rows, well under the page size — nothing to load initially
      expect(screen.queryByRole("button", { name: tb.loadMore })).toBeNull();
      // Narrowing further must not somehow surface a stale "loaded more" state.
      fireEvent.click(screen.getByRole("button", { name: messages.Transactions.banners.chipBuys }));
      expect(screen.queryByRole("button", { name: tb.loadMore })).toBeNull();
    });

    it("select-all covers the full filtered set, not just the rendered window", () => {
      renderMany(30);
      enterSelectionMode("Instrument 0"); // present in the initial window
      fireEvent.click(screen.getByLabelText(tb.selectAll));
      // 30 rows total, only 25 rendered — the count must reflect all 30, not the window.
      expect(screen.getByText("30 selected")).toBeInTheDocument();
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

    it("does not show the headline banner or toggle when only portfolio-scoped anomalies are present", () => {
      const portfolioOnlyAnomalies = [
        { code: "reconciliation_gap" as const, severity: "warning" as const, scope: "portfolio" as const },
      ];
      render(
        <NextIntlClientProvider locale="en" messages={messages}>
          <TransactionsTable rows={ANOMALY_ROWS} anomalies={portfolioOnlyAnomalies} />
        </NextIntlClientProvider>,
      );
      // Headline count only includes row-flaggable anomalies; a portfolio-scoped one (no
      // transactionId) contributes nothing to it — so with only one of those, the "N found"
      // banner doesn't render at all (it's surfaced separately as its own ReconciliationBanner,
      // see the dedicated "renders every portfolio-scoped anomaly" test below).
      expect(screen.queryByRole("alert")).toBeNull();
      // ...and no toggle either (no transactionIds → flaggedCount === 0).
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

    it("renders every portfolio-scoped anomaly, not just the first (regression: reconciliation_gap + 2x position_gap all showed as only 1 banner)", () => {
      const portfolioAnomalies = [
        {
          code: "reconciliation_gap" as const,
          severity: "warning" as const,
          scope: "portfolio" as const,
          meta: { currency: "EUR", reported: "3552.4", derived: "3579.92", diff: "27.52" },
        },
        {
          code: "position_gap" as const,
          severity: "warning" as const,
          scope: "portfolio" as const,
          meta: { isin: "XF000BTC0017", reported: "0.026504", derived: "0.000262", diff: "0.026242" },
        },
        {
          code: "position_gap" as const,
          severity: "warning" as const,
          scope: "portfolio" as const,
          meta: { isin: "XF000ETH0019", reported: "0.850477", derived: "0.008420", diff: "0.842057" },
        },
      ];
      render(
        <NextIntlClientProvider locale="en" messages={messages}>
          <TransactionsTable rows={ANOMALY_ROWS} anomalies={portfolioAnomalies} />
        </NextIntlClientProvider>,
      );
      // All 3 render as distinct ReconciliationBanners (interpolated meta makes each unique),
      // not just the first one found — previously .find() only ever surfaced one.
      expect(screen.getAllByText("Cash doesn't reconcile").length).toBe(3);
      expect(screen.getByText(/XF000BTC0017/)).toBeInTheDocument();
      expect(screen.getByText(/XF000ETH0019/)).toBeInTheDocument();
      expect(screen.getByText(/EUR: reported 3552.4/)).toBeInTheDocument();
      // None of these 3 are row-flaggable (no transactionId) → the headline "N found" count
      // excludes them entirely instead of promising rows "Show flagged only" can't produce —
      // they're already visible above as their own banners. No headline banner, no toggle.
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByRole("button", { name: messages.Anomalies.showFlagged })).toBeNull();
    });

    it("headline counts only row-flaggable anomalies, excluding portfolio-scoped ones which render as their own banners instead (regression: banner said 7 warnings, 'Show flagged only' showed only 4)", () => {
      const mixedWithPortfolio = [
        ...MIXED_ANOMALIES, // a1: 1 error, a3: 1 warning — both row-flaggable
        {
          code: "reconciliation_gap" as const,
          severity: "warning" as const,
          scope: "portfolio" as const,
          meta: { currency: "EUR", reported: "1", derived: "2", diff: "1" },
        },
        {
          code: "position_gap" as const,
          severity: "warning" as const,
          scope: "portfolio" as const,
          meta: { isin: "ISIN1", reported: "1", derived: "2", diff: "1" },
        },
        {
          code: "position_gap" as const,
          severity: "warning" as const,
          scope: "portfolio" as const,
          meta: { isin: "ISIN2", reported: "1", derived: "2", diff: "1" },
        },
      ];
      render(
        <NextIntlClientProvider locale="en" messages={messages}>
          <TransactionsTable rows={ANOMALY_ROWS} anomalies={mixedWithPortfolio} />
        </NextIntlClientProvider>,
      );
      // Headline = 1 error (a1) + 1 warning (a3) ONLY — exactly what "Show flagged only" can
      // show. The 3 portfolio-scoped anomalies render as their own ReconciliationBanners
      // instead of inflating this count to a number nothing on the page can match.
      expect(screen.getByText("1 error and 1 warning found in your data")).toBeInTheDocument();
      expect(screen.getAllByText("Cash doesn't reconcile").length).toBe(3);
      fireEvent.click(screen.getByRole("button", { name: messages.Anomalies.showFlagged }));
      expect(screen.getAllByRole("row").slice(1).length).toBe(2);
    });

    it("collapses two anomalies on the same transaction to one worst-severity row instead of double-counting", () => {
      const sameTxAnomalies = [
        { code: "oversell" as const, severity: "error" as const, scope: "transaction" as const, transactionId: "a1" },
        { code: "zero_price" as const, severity: "warning" as const, scope: "transaction" as const, transactionId: "a1" },
      ];
      render(
        <NextIntlClientProvider locale="en" messages={messages}>
          <TransactionsTable rows={ANOMALY_ROWS} anomalies={sameTxAnomalies} />
        </NextIntlClientProvider>,
      );
      // a1 carries both — dedup keeps only the worse (error), so this is 1 error / 0 warnings,
      // not "1 error and 1 warning" (which would double-count the same row).
      expect(screen.getByText("1 data error found")).toBeInTheDocument();
    });

    it("surfaces a negative_cash anomaly with no transactionId as its own banner instead of dropping it (edge case: not row-flaggable, not a hardcoded portfolio-scope code)", () => {
      const orphanedNegativeCash = [
        {
          code: "negative_cash" as const,
          severity: "error" as const,
          scope: "transaction" as const,
          // No transactionId — no cash-flow row matched that day. Under the old hardcoded
          // 3-code partition this fell into neither bucket: excluded from the row map (no
          // transactionId) AND excluded from portfolioAnomalies (scope isn't "portfolio"),
          // so it was counted nowhere and shown nowhere.
          meta: { currency: "EUR", balance: -8e-11 },
        },
      ];
      render(
        <NextIntlClientProvider locale="en" messages={messages}>
          <TransactionsTable rows={ANOMALY_ROWS} anomalies={orphanedNegativeCash} />
        </NextIntlClientProvider>,
      );
      // Partitioned by `isRowAnomaly` (transactionId presence), not by code or scope — so it
      // renders as its own ReconciliationBanner rather than vanishing.
      expect(screen.getByText(messages.Anomalies.reconciliationTitle)).toBeInTheDocument();
      // Not row-flaggable → no headline banner (0/0 row-attached) and no toggle.
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
      // Empty message renders in both the desktop table and the mobile list.
      expect(screen.getAllByText(messages.Transactions.noResults).length).toBeGreaterThan(0);
    });

    it("shows empty (not noResults) when the full row set is empty and there is no query", () => {
      render(
        <NextIntlClientProvider locale="en" messages={messages}>
          <TransactionsTable rows={[]} />
        </NextIntlClientProvider>,
      );
      expect(screen.getAllByText(messages.Transactions.empty).length).toBeGreaterThan(0);
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
      // The flag renders in both the desktop table and the mobile list.
      const flag = screen.getAllByLabelText(/Negative cash balance/)[0];
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
      // meta fields must interpolate into the detail string (regression: previously
      // `codes.reconciliation_gap` was rendered with no values, throwing next-intl's
      // FORMATTING_ERROR).
      expect(
        screen.getByText("Cash reconciliation gap vs. broker (EUR: reported 100, derived 98)"),
      ).toBeInTheDocument();
      // No transaction-scoped anomaly → no "Show flagged" toggle, yet the recon banner shows.
      expect(screen.queryByRole("button", { name: messages.Anomalies.showFlagged })).toBeNull();
    });
  });
});
