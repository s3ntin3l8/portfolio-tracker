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
  Link: ({
    href,
    children,
    ...rest
  }: { href: string; children: ReactNode } & Record<string, unknown>) => (
    <a href={href} {...rest}>
      {children}
    </a>
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
    originalFilename: null,
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
    originalFilename: null,
  },
];

const threeItems: ImportRecord[] = [
  {
    id: "i1",
    portfolioId: "p1",
    // Deliberately not "pytr"/"ibkr" — those are the two sync parsers isDeadSyncAnchor
    // always hides once confirmed (see import-history.tsx), and this fixture exists purely
    // for generic parser-name/count sort-order testing below, not sync-anchor behavior.
    parser: "screenshot",
    status: "confirmed",
    confidence: null,
    count: 10,
    createdAt: "2026-06-12T10:00:00.000Z",
    batchId: null,
    document: null,
    originalFilename: null,
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
    originalFilename: null,
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
    originalFilename: null,
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
  originalFilename: null,
};

const itemsWithDiscarded: ImportRecord[] = [...items, discardedItem];

// A connection-sync (IBKR/pytr) "anchor" row: provenance-only, not a real import to review.
// Confirmed means the last sync was clean (no unresolved attention error); draft means it's
// still carrying one the user needs to see. Visibility is keyed on `status` alone — `count`
// reflects real materialized transactions and can be large even on a clean `confirmed`
// anchor (see the nonzero-count variant below), so it must NOT gate visibility.
const confirmedSyncAnchor: ImportRecord = {
  id: "ibkr-anchor",
  portfolioId: "p1",
  parser: "ibkr",
  status: "confirmed",
  confidence: null,
  count: 0,
  createdAt: "2026-07-06T12:00:00.000Z",
  batchId: null,
  document: null,
  originalFilename: null,
};

const draftSyncAnchor: ImportRecord = {
  ...confirmedSyncAnchor,
  id: "ibkr-anchor-draft",
  status: "draft",
};

// A healthy, actively-syncing connection: the anchor is `confirmed` (no attention errors)
// but `count` reflects hundreds of real materialized transactions, not 0.
const confirmedSyncAnchorWithTransactions: ImportRecord = {
  ...confirmedSyncAnchor,
  id: "ibkr-anchor-active",
  count: 883,
};

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
    fireEvent.click(screen.getByRole("button", { name: messages.Transactions.reassign.confirm }));
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

  describe("connection-sync anchor rows", () => {
    it("never shows a confirmed zero-item IBKR anchor, even with Show completed on", () => {
      render(
        <NextIntlClientProvider locale="en" messages={messages}>
          <ImportHistory items={[...items, confirmedSyncAnchor]} />
        </NextIntlClientProvider>,
      );
      fireEvent.click(screen.getByRole("button", { name: /Show completed/ }));
      expect(screen.queryByText("ibkr")).toBeNull();
    });

    it("excludes the dead anchor from the Show completed count", () => {
      render(
        <NextIntlClientProvider locale="en" messages={messages}>
          <ImportHistory items={[...items, confirmedSyncAnchor]} />
        </NextIntlClientProvider>,
      );
      // Only conf1 is a real confirmed import — the anchor doesn't add to the count.
      expect(
        screen.getByRole("button", { name: m.showCompleted.replace("{count}", "1") }),
      ).toBeInTheDocument();
    });

    it("still shows a draft IBKR anchor (an unresolved attention error) by default", () => {
      render(
        <NextIntlClientProvider locale="en" messages={messages}>
          <ImportHistory items={[...items, draftSyncAnchor]} />
        </NextIntlClientProvider>,
      );
      expect(screen.getByText("ibkr")).toBeInTheDocument();
    });

    it("hides a confirmed anchor even with a large real transaction count (regression: count is no longer 0 for an active sync)", () => {
      render(
        <NextIntlClientProvider locale="en" messages={messages}>
          <ImportHistory items={[...items, confirmedSyncAnchorWithTransactions]} />
        </NextIntlClientProvider>,
      );
      fireEvent.click(screen.getByRole("button", { name: /Show completed/ }));
      // Visibility is keyed on status alone — a clean (confirmed) anchor stays hidden no
      // matter how many transactions it materialized.
      expect(screen.queryByText("ibkr")).toBeNull();
    });

    it("labels a draft sync anchor 'Needs attention' instead of the generic 'Draft'", () => {
      render(
        <NextIntlClientProvider locale="en" messages={messages}>
          <ImportHistory items={[...items, draftSyncAnchor]} />
        </NextIntlClientProvider>,
      );
      // A visible sync anchor is always draft (a clean confirmed one is filtered out), and
      // its draft doesn't mean "unreviewed" — it means the last sync left an attention
      // error. Reusing "Draft" would misleadingly suggest the real, already-live
      // transactions it materialized haven't been looked at. (Desktop table + mobile card
      // both render — scope to the table like the rest of this file's dual-render tests.
      // `items` also has its own genuine draft CSV row, so "Draft" legitimately still
      // appears elsewhere — only the anchor's own label is under test here.)
      expect(desktop().getByText(m.status.syncNeedsAttention)).toBeInTheDocument();
    });

    it("still labels a genuine CSV/PDF draft import 'Draft' (not affected by the sync-anchor relabel)", () => {
      renderHistory();
      expect(desktop().getByText(m.status.draft)).toBeInTheDocument();
    });
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
    // Default: screenshot(10), csv(1), dkb(5)
    fireEvent.click(screen.getByRole("button", { name: /items/i }));
    const rows = screen.getAllByRole("row").slice(1);
    // asc: 1 (csv), 5 (dkb), 10 (screenshot)
    expect(rows[0]).toHaveTextContent("csv");
    expect(rows[1]).toHaveTextContent("dkb");
    expect(rows[2]).toHaveTextContent("screenshot");
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
    // asc: csv, dkb, screenshot
    expect(rows[0]).toHaveTextContent("csv");
    expect(rows[1]).toHaveTextContent("dkb");
    expect(rows[2]).toHaveTextContent("screenshot");
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
    expect(screen.queryByText("screenshot")).not.toBeInTheDocument();
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
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(m.actionError));
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
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(m.actionError));
  });

  it("shows an error banner when clear fails", async () => {
    clearImport.mockRejectedValueOnce(new Error("network error"));
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ImportHistory items={itemsWithDiscarded} />
      </NextIntlClientProvider>,
    );
    fireEvent.click(desktop().getByRole("button", { name: m.clear }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(m.actionError));
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
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(m.actionError));
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
      document: {
        id: "doc1",
        originalFilename: "export.pdf",
        mimeType: "application/pdf",
        sizeBytes: 12345,
        storedAt: "2026-06-09T10:00:00.000Z",
      },
      originalFilename: "export.pdf",
    };
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ImportHistory items={[confirmedWithDoc]} showTitle />
      </NextIntlClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Show completed/ }));
    fireEvent.click(desktop().getByRole("button", { name: m.downloadReceipt }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(m.downloadError));
  });

  it("bulk-deletes a multi-select of drafts in one request (no confirm step)", async () => {
    const drafts: ImportRecord[] = [
      {
        id: "d1",
        portfolioId: "p1",
        parser: "csv",
        status: "draft",
        confidence: null,
        count: 2,
        createdAt: "2026-06-10T10:00:00.000Z",
        batchId: null,
        document: null,
        originalFilename: null,
      },
      {
        id: "d2",
        portfolioId: "p1",
        parser: "dkb",
        status: "draft",
        confidence: null,
        count: 3,
        createdAt: "2026-06-09T10:00:00.000Z",
        batchId: null,
        document: null,
        originalFilename: null,
      },
    ];
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ImportHistory items={drafts} />
      </NextIntlClientProvider>,
    );
    // Checkboxes stay hidden until selection mode is entered via the header toggle.
    fireEvent.click(desktop().getByRole("button", { name: m.selectRows }));
    fireEvent.click(screen.getByLabelText(m.selectAll));
    fireEvent.click(screen.getByRole("button", { name: m.deleteSelected }));
    await waitFor(() => expect(bulkDeleteImports).toHaveBeenCalledTimes(1));
    expect(new Set(bulkDeleteImports.mock.calls[0][0])).toEqual(new Set(["d1", "d2"]));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("requires a confirmation click before bulk-deleting a selection with confirmed imports", async () => {
    const confirmed: ImportRecord = {
      id: "c1",
      portfolioId: "p1",
      parser: "dkb",
      status: "confirmed",
      confidence: null,
      count: 7,
      createdAt: "2026-06-09T10:00:00.000Z",
      batchId: null,
      document: null,
      originalFilename: null,
    };
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ImportHistory items={[confirmed]} />
      </NextIntlClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Show completed/ }));
    fireEvent.click(desktop().getByRole("button", { name: m.selectRows }));
    fireEvent.click(desktop().getByLabelText(m.selectRow));
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
      {
        id: "b-a",
        portfolioId: "p1",
        parser: "dkb-pdf",
        status: "draft",
        confidence: null,
        count: 1,
        createdAt: "2026-06-10T10:00:01.000Z",
        batchId: "batch-1",
        document: null,
        originalFilename: "statement.pdf",
      },
      {
        id: "b-b",
        portfolioId: "p1",
        parser: "dkb-pdf",
        status: "draft",
        confidence: null,
        count: 1,
        createdAt: "2026-06-10T10:00:02.000Z",
        batchId: "batch-1",
        document: null,
        originalFilename: "statement.pdf",
      },
    ];
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ImportHistory items={batched} />
      </NextIntlClientProvider>,
    );
    // Shown once per layout — desktop's batch-header row and the mobile group caption.
    expect(screen.getAllByText(/Upload · 2 files/).length).toBeGreaterThan(0);
    fireEvent.click(desktop().getByRole("button", { name: m.selectRows }));
    fireEvent.click(desktop().getByLabelText(m.selectBatch));
    fireEvent.click(screen.getByRole("button", { name: m.deleteSelected }));
    await waitFor(() => expect(bulkDeleteImports).toHaveBeenCalledTimes(1));
    expect(new Set(bulkDeleteImports.mock.calls[0][0])).toEqual(new Set(["b-a", "b-b"]));
  });

  // -------------------------------------------------------------------------
  // Reference-fidelity redesign: icon+filename column, mobile compact cards,
  // long-press-to-select.
  // -------------------------------------------------------------------------
  it("hides desktop checkboxes by default and reveals them via the select-rows toggle", () => {
    renderHistory();
    expect(desktop().queryByLabelText(m.selectAll)).toBeNull();
    expect(desktop().queryByLabelText(m.selectRow)).toBeNull();
    expect(screen.queryByText(/selected/)).not.toBeInTheDocument();

    fireEvent.click(desktop().getByRole("button", { name: m.selectRows }));

    expect(desktop().getByLabelText(m.selectAll)).toBeInTheDocument();
    expect(desktop().getByLabelText(m.selectRow)).toBeInTheDocument();
    // Entering selection mode with nothing picked yet shows the prompt, not "0 selected".
    expect(screen.getByText(m.selectPrompt)).toBeInTheDocument();
  });

  it("cancel (X) exits selection mode and clears the selection", () => {
    renderHistory();
    fireEvent.click(desktop().getByRole("button", { name: m.selectRows }));
    fireEvent.click(desktop().getByLabelText(m.selectRow));
    expect(screen.getByText(/1 selected/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: m.cancelSelection }));

    expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
    expect(desktop().queryByLabelText(m.selectRow)).toBeNull();
    // Back to the toggle, ready to start a fresh selection.
    expect(desktop().getByRole("button", { name: m.selectRows })).toBeInTheDocument();
  });

  it("renders the File column header and a friendly fallback label when no document exists", () => {
    renderHistory();
    expect(desktop().getByText(m.file)).toBeInTheDocument();
    // draft1 (parser "csv") has no stored document — falls back to the friendly source label.
    expect(desktop().getByText("CSV")).toBeInTheDocument();
  });

  it("shows the real imported filename instead of the generic source label when available", () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ImportHistory
          items={[
            {
              id: "draft-named",
              portfolioId: "p1",
              parser: "csv",
              status: "draft",
              confidence: null,
              count: 3,
              createdAt: "2026-06-10T10:00:00.000Z",
              batchId: null,
              document: null,
              originalFilename: "dkb-umsaetze-juni.csv",
            },
          ]}
        />
      </NextIntlClientProvider>,
    );
    expect(desktop().getByText("dkb-umsaetze-juni.csv")).toBeInTheDocument();
    expect(desktop().queryByText("CSV")).not.toBeInTheDocument();
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
