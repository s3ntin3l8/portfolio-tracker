import type { ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, act } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import type { ImportRecord } from "@portfolio/api-client";

// `rowActions()` renders identically in both the desktop table and the mobile card list —
// both coexist in jsdom (no CSS applied, so `hidden md:block` / `md:hidden` don't actually
// hide anything). Scope action queries to the desktop `<table>` to disambiguate, the same
// idiom `transactions-table.test.tsx` uses for its own dual desktop/mobile render.
function desktop() {
  return within(screen.getByRole("table"));
}

const refresh = vi.fn();
const pushMock = vi.fn();
const discardImport = vi.fn(async () => undefined);
const deleteImport = vi.fn(async () => ({ removed: 1 }));
const clearImport = vi.fn(async () => undefined);
const bulkClearImports = vi.fn(async () => ({ cleared: 2 }));
const bulkDeleteImports = vi.fn(async (_ids: string[]) => ({
  discarded: 0,
  undone: 0,
  cleared: 0,
  removedTransactions: 0,
}));
const getImportDocumentUrl = vi.fn(async () => ({ url: "https://example.com/doc.pdf" }));
const reassignImport = vi.fn(async () => ({ moved: 4, skippedConflicts: 0, skippedLoans: 0 }));

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ refresh, push: pushMock }),
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode } & Record<string, unknown>) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));
vi.mock("@/lib/api", () => ({
  useApiClient: () => ({
    discardImport,
    deleteImport,
    clearImport,
    bulkClearImports,
    bulkDeleteImports,
    getImportDocumentUrl,
    reassignImport,
  }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() } }));

const PORTFOLIOS = [
  { id: "p1", name: "Main", brokerage: null, accountHolder: null },
  { id: "p2", name: "DKB", brokerage: null, accountHolder: null },
];

import { ImportHistory } from "../src/components/import-history";

const m = messages.ImportHistory;

const items: ImportRecord[] = [
  {
    id: "draft1",
    portfolioId: "p1",
    parser: "csv",
    status: "draft",
    confidence: null,
    count: 2,
    createdAt: "2026-06-10T10:00:00.000Z",
    batchId: null,
    document: null,
  },
  {
    id: "conf1",
    portfolioId: "p1",
    parser: "dkb",
    status: "confirmed",
    confidence: null,
    count: 4,
    createdAt: "2026-06-09T10:00:00.000Z",
    batchId: null,
    document: null,
  },
];

const threeItems: ImportRecord[] = [
  {
    id: "i1",
    portfolioId: "p1",
    parser: "pytr",
    status: "confirmed",
    confidence: null,
    count: 10,
    createdAt: "2026-06-12T10:00:00.000Z",
    batchId: null,
    document: null,
  },
  {
    id: "i2",
    portfolioId: "p1",
    parser: "csv",
    status: "confirmed",
    confidence: null,
    count: 1,
    createdAt: "2026-06-11T10:00:00.000Z",
    batchId: null,
    document: null,
  },
  {
    id: "i3",
    portfolioId: "p1",
    parser: "dkb",
    status: "confirmed",
    confidence: null,
    count: 5,
    createdAt: "2026-06-10T10:00:00.000Z",
    batchId: null,
    document: null,
  },
];

function renderHistory() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ImportHistory items={items} />
    </NextIntlClientProvider>,
  );
}

const discardedItem: ImportRecord = {
  id: "disc1",
  portfolioId: "p1",
  parser: "csv",
  status: "discarded",
  confidence: null,
  count: 1,
  createdAt: "2026-06-08T10:00:00.000Z",
  batchId: null,
  document: null,
};

const itemsWithDiscarded: ImportRecord[] = [...items, discardedItem];

describe("ImportHistory", () => {
  beforeEach(() => {
    refresh.mockClear();
    pushMock.mockClear();
    discardImport.mockClear();
    deleteImport.mockClear();
    clearImport.mockClear();
    bulkClearImports.mockClear();
    bulkDeleteImports.mockClear();
    getImportDocumentUrl.mockClear();
  });

  it("discards a draft import", async () => {
    renderHistory();
    fireEvent.click(desktop().getByRole("button", { name: m.discard }));
    await waitFor(() => expect(discardImport).toHaveBeenCalledWith("draft1"));
    expect(refresh).toHaveBeenCalled();
  });

  it("links a draft import to its review page", () => {
    renderHistory();
    const link = desktop().getByRole("link", { name: m.review });
    expect(link).toHaveAttribute("href", "/transactions/import/draft1");
  });

  it("undoes a confirmed import only after the two-step confirm", async () => {
    renderHistory();
    // Confirmed imports are hidden by default — reveal them first.
    fireEvent.click(screen.getByRole("button", { name: /Show completed/ }));
    // First click reveals the warning + destructive confirm; nothing removed yet.
    fireEvent.click(desktop().getByRole("button", { name: m.undo }));
    expect(deleteImport).not.toHaveBeenCalled();
    expect(desktop().getByText(/Removes 4 transactions/)).toBeInTheDocument();

    fireEvent.click(desktop().getByRole("button", { name: m.undo }));
    await waitFor(() => expect(deleteImport).toHaveBeenCalledWith("conf1"));
    expect(refresh).toHaveBeenCalled();
  });

  it("reassigns a whole confirmed import to another portfolio", async () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ImportHistory items={items} portfolios={PORTFOLIOS} />
      </NextIntlClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Show completed/ }));
    fireEvent.click(desktop().getByRole("button", { name: m.reassign }));
    // The dialog confirms the move to the chosen portfolio.
    fireEvent.click(
      screen.getByRole("button", { name: messages.Transactions.reassign.confirm }),
    );
    await waitFor(() => expect(reassignImport).toHaveBeenCalledWith("conf1", "p1"));
    expect(refresh).toHaveBeenCalled();
  });

  it("hides the import reassign action when only one portfolio exists", () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ImportHistory items={items} portfolios={[PORTFOLIOS[0]]} />
      </NextIntlClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Show completed/ }));
    expect(screen.queryByRole("button", { name: m.reassign })).toBeNull();
  });

  it("renders sortable column headers", () => {
    renderHistory();
    expect(screen.getByRole("button", { name: /parser/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /status/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /items/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /timestamp/i })).toBeInTheDocument();
  });

  it("sorts by item count numerically ascending", () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ImportHistory items={threeItems} />
      </NextIntlClientProvider>,
    );
    // All three are confirmed (hidden by default) — reveal them first.
    fireEvent.click(screen.getByRole("button", { name: /Show completed/ }));
    // Default: pytr(10), csv(1), dkb(5)
    fireEvent.click(screen.getByRole("button", { name: /items/i }));
    const rows = screen.getAllByRole("row").slice(1);
    // asc: 1 (csv), 5 (dkb), 10 (pytr)
    expect(rows[0]).toHaveTextContent("csv");
    expect(rows[1]).toHaveTextContent("dkb");
    expect(rows[2]).toHaveTextContent("pytr");
  });

  it("sorts by parser name alphabetically", () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ImportHistory items={threeItems} />
      </NextIntlClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Show completed/ }));
    fireEvent.click(screen.getByRole("button", { name: /parser/i }));
    const rows = screen.getAllByRole("row").slice(1);
    // asc: csv, dkb, pytr
    expect(rows[0]).toHaveTextContent("csv");
    expect(rows[1]).toHaveTextContent("dkb");
    expect(rows[2]).toHaveTextContent("pytr");
  });

  it("sets aria-sort ascending then descending on repeated clicks", () => {
    renderHistory();
    const parserBtn = screen.getByRole("button", { name: /parser/i });
    fireEvent.click(parserBtn);
    expect(parserBtn.closest("th")).toHaveAttribute("aria-sort", "ascending");
    fireEvent.click(parserBtn);
    expect(parserBtn.closest("th")).toHaveAttribute("aria-sort", "descending");
  });

  it("clears a discarded import via the per-row Clear button", async () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ImportHistory items={itemsWithDiscarded} />
      </NextIntlClientProvider>,
    );
    fireEvent.click(desktop().getByRole("button", { name: m.clear }));
    await waitFor(() => expect(clearImport).toHaveBeenCalledWith("disc1"));
    expect(refresh).toHaveBeenCalled();
  });

  it("does not render Clear button for draft or confirmed rows", () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ImportHistory items={itemsWithDiscarded} />
      </NextIntlClientProvider>,
    );
    // Only one Clear button in the desktop table — for the single discarded row.
    expect(desktop().getAllByRole("button", { name: m.clear })).toHaveLength(1);
  });

  it("shows Clear all discarded header button when discarded rows exist", () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ImportHistory items={itemsWithDiscarded} />
      </NextIntlClientProvider>,
    );
    expect(screen.getByRole("button", { name: m.clearAll })).toBeInTheDocument();
  });

  it("hides Clear all discarded when no discarded rows exist", () => {
    renderHistory();
    expect(screen.queryByRole("button", { name: m.clearAll })).not.toBeInTheDocument();
  });

  it("hides confirmed imports by default and reveals them via the toggle", () => {
    renderHistory();
    // The confirmed row (dkb) is hidden; the draft (csv) is visible.
    expect(screen.queryByText("dkb")).not.toBeInTheDocument();
    expect(screen.getByText("csv")).toBeInTheDocument();
    // Toggle reveals it.
    fireEvent.click(screen.getByRole("button", { name: /Show completed/ }));
    expect(screen.getByText("dkb")).toBeInTheDocument();
    // And hides it again.
    fireEvent.click(screen.getByRole("button", { name: m.hideCompleted }));
    expect(screen.queryByText("dkb")).not.toBeInTheDocument();
  });

  it("shows an 'all completed hidden' hint when only confirmed imports exist", () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ImportHistory items={threeItems} />
      </NextIntlClientProvider>,
    );
    // No rows visible by default; a hint explains the hidden completed imports (shown once
    // per layout — desktop's empty table row and the mobile empty-state card).
    expect(screen.getAllByText(/3 completed imports hidden/).length).toBeGreaterThan(0);
    expect(screen.queryByText("pytr")).not.toBeInTheDocument();
  });

  it("does not render the completed toggle when no confirmed imports exist", () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ImportHistory items={[discardedItem]} />
      </NextIntlClientProvider>,
    );
    expect(screen.queryByRole("button", { name: /Show completed/ })).not.toBeInTheDocument();
  });

  it("clears all discarded imports via the header button", async () => {
    const twoDiscarded: ImportRecord[] = [
      { ...discardedItem, id: "disc1" },
      { ...discardedItem, id: "disc2" },
    ];
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ImportHistory items={twoDiscarded} />
      </NextIntlClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: m.clearAll }));
    // One batched request, not one DELETE per row (which tripped the rate limiter).
    await waitFor(() => {
      expect(bulkClearImports).toHaveBeenCalledWith(["disc1", "disc2"]);
    });
    expect(clearImport).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Error handling — fix 1.2: action failures must show an inline error banner
  // -------------------------------------------------------------------------
  it("shows an error banner when discard fails", async () => {
    discardImport.mockRejectedValueOnce(new Error("network error"));
    renderHistory();
    fireEvent.click(desktop().getByRole("button", { name: m.discard }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(m.actionError),
    );
    // The spinner resolves — the button is no longer spinning.
    expect(discardImport).toHaveBeenCalled();
  });

  it("shows an error banner when undo fails", async () => {
    deleteImport.mockRejectedValueOnce(new Error("network error"));
    renderHistory();
    fireEvent.click(screen.getByRole("button", { name: /Show completed/ }));
    fireEvent.click(desktop().getByRole("button", { name: m.undo }));
    // Two-step: first click shows warning; second triggers the delete.
    fireEvent.click(desktop().getByRole("button", { name: m.undo }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(m.actionError),
    );
  });

  it("shows an error banner when clear fails", async () => {
    clearImport.mockRejectedValueOnce(new Error("network error"));
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ImportHistory items={itemsWithDiscarded} />
      </NextIntlClientProvider>,
    );
    fireEvent.click(desktop().getByRole("button", { name: m.clear }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(m.actionError),
    );
  });

  it("shows an error banner when clearAllDiscarded fails", async () => {
    bulkClearImports.mockRejectedValueOnce(new Error("rate limited"));
    const twoDiscarded: ImportRecord[] = [
      { ...discardedItem, id: "disc1" },
      { ...discardedItem, id: "disc2" },
    ];
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ImportHistory items={twoDiscarded} />
      </NextIntlClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: m.clearAll }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(m.actionError),
    );
  });

  it("shows a download error banner when receipt fetch fails", async () => {
    getImportDocumentUrl.mockRejectedValueOnce(new Error("storage unavailable"));
    const confirmedWithDoc: ImportRecord = {
      id: "conf-doc",
      portfolioId: "p1",
      parser: "dkb",
      status: "confirmed",
      confidence: null,
      count: 2,
      createdAt: "2026-06-09T10:00:00.000Z",
      batchId: null,
      document: { id: "doc1", originalFilename: "export.pdf", mimeType: "application/pdf", sizeBytes: 12345, storedAt: "2026-06-09T10:00:00.000Z" },
    };
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ImportHistory items={[confirmedWithDoc]} showTitle />
      </NextIntlClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Show completed/ }));
    fireEvent.click(desktop().getByRole("button", { name: m.downloadReceipt }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(m.downloadError),
    );
  });

  it("bulk-deletes a multi-select of drafts in one request (no confirm step)", async () => {
    const drafts: ImportRecord[] = [
      { id: "d1", portfolioId: "p1", parser: "csv", status: "draft", confidence: null, count: 2, createdAt: "2026-06-10T10:00:00.000Z", batchId: null, document: null },
      { id: "d2", portfolioId: "p1", parser: "dkb", status: "draft", confidence: null, count: 3, createdAt: "2026-06-09T10:00:00.000Z", batchId: null, document: null },
    ];
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ImportHistory items={drafts} />
      </NextIntlClientProvider>,
    );
    fireEvent.click(screen.getByLabelText(m.selectAll));
    fireEvent.click(screen.getByRole("button", { name: m.deleteSelected }));
    await waitFor(() => expect(bulkDeleteImports).toHaveBeenCalledTimes(1));
    expect(new Set(bulkDeleteImports.mock.calls[0][0])).toEqual(new Set(["d1", "d2"]));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("requires a confirmation click before bulk-deleting a selection with confirmed imports", async () => {
    const confirmed: ImportRecord = { id: "c1", portfolioId: "p1", parser: "dkb", status: "confirmed", confidence: null, count: 7, createdAt: "2026-06-09T10:00:00.000Z", batchId: null, document: null };
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ImportHistory items={[confirmed]} />
      </NextIntlClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Show completed/ }));
    fireEvent.click(screen.getByLabelText(m.selectRow));
    // First click → warning, no request yet.
    fireEvent.click(screen.getByRole("button", { name: m.deleteSelected }));
    expect(bulkDeleteImports).not.toHaveBeenCalled();
    expect(screen.getByText(/Removes 7 transactions/)).toBeInTheDocument();
    // Second click → fires.
    fireEvent.click(screen.getByRole("button", { name: m.deleteSelected }));
    await waitFor(() => expect(bulkDeleteImports).toHaveBeenCalledWith(["c1"]));
  });

  it("groups same-batch uploads and selects the whole batch in one click", async () => {
    const batched: ImportRecord[] = [
      { id: "b-a", portfolioId: "p1", parser: "dkb-pdf", status: "draft", confidence: null, count: 1, createdAt: "2026-06-10T10:00:01.000Z", batchId: "batch-1", document: null },
      { id: "b-b", portfolioId: "p1", parser: "dkb-pdf", status: "draft", confidence: null, count: 1, createdAt: "2026-06-10T10:00:02.000Z", batchId: "batch-1", document: null },
    ];
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ImportHistory items={batched} />
      </NextIntlClientProvider>,
    );
    // Shown once per layout — desktop's batch-header row and the mobile group caption.
    expect(screen.getAllByText(/Upload · 2 files/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByLabelText(m.selectBatch));
    fireEvent.click(screen.getByRole("button", { name: m.deleteSelected }));
    await waitFor(() => expect(bulkDeleteImports).toHaveBeenCalledTimes(1));
    expect(new Set(bulkDeleteImports.mock.calls[0][0])).toEqual(new Set(["b-a", "b-b"]));
  });

  // -------------------------------------------------------------------------
  // Reference-fidelity redesign: icon+filename column, mobile compact cards,
  // long-press-to-select.
  // -------------------------------------------------------------------------
  it("renders the File column header and a friendly fallback label when no document exists", () => {
    renderHistory();
    expect(desktop().getByText(m.file)).toBeInTheDocument();
    // draft1 (parser "csv") has no stored document — falls back to the friendly source label.
    expect(desktop().getByText("CSV")).toBeInTheDocument();
  });

  it("renders a compact mobile card with a composed source/date/count subline", () => {
    renderHistory();
    const mobileRow = screen.getByTestId("import-mobile-draft1");
    expect(within(mobileRow).getByText(/CSV · .* · 2 items/)).toBeInTheDocument();
  });

  it("long-press enters selection mode and reveals a checkbox on the mobile card", () => {
    vi.useFakeTimers();
    try {
      renderHistory();
      const mobileRow = screen.getByTestId("import-mobile-draft1");
      // Checkboxes stay hidden on mobile until a long-press.
      expect(within(mobileRow).queryByRole("checkbox")).toBeNull();
      fireEvent.pointerDown(mobileRow, { clientX: 10, clientY: 10 });
      act(() => {
        vi.advanceTimersByTime(500);
      });
      const checkbox = within(mobileRow).getByRole("checkbox");
      expect(checkbox).toBeChecked();
      // Shared selection state — the bulk bar reacts the same as a desktop checkbox click.
      expect(screen.getByText(/1 selected/)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("tapping a draft's mobile card (no long-press) navigates to its review page", () => {
    renderHistory();
    const mobileRow = screen.getByTestId("import-mobile-draft1");
    fireEvent.click(mobileRow);
    // A plain tap on a draft mirrors the explicit Review action.
    expect(pushMock).toHaveBeenCalledWith("/transactions/import/draft1");
  });
});
