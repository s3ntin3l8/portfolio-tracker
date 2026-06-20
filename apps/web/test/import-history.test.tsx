import type { ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import type { ImportRecord } from "@portfolio/api-client";

const refresh = vi.fn();
const discardImport = vi.fn(async () => undefined);
const deleteImport = vi.fn(async () => ({ removed: 1 }));
const clearImport = vi.fn(async () => undefined);
const bulkClearImports = vi.fn(async () => ({ cleared: 2 }));

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ refresh }),
  Link: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock("@/lib/api", () => ({
  useApiClient: () => ({ discardImport, deleteImport, clearImport, bulkClearImports }),
}));

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
  },
  {
    id: "conf1",
    portfolioId: "p1",
    parser: "dkb",
    status: "confirmed",
    confidence: null,
    count: 4,
    createdAt: "2026-06-09T10:00:00.000Z",
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
  },
  {
    id: "i2",
    portfolioId: "p1",
    parser: "csv",
    status: "confirmed",
    confidence: null,
    count: 1,
    createdAt: "2026-06-11T10:00:00.000Z",
  },
  {
    id: "i3",
    portfolioId: "p1",
    parser: "dkb",
    status: "confirmed",
    confidence: null,
    count: 5,
    createdAt: "2026-06-10T10:00:00.000Z",
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
};

const itemsWithDiscarded: ImportRecord[] = [...items, discardedItem];

describe("ImportHistory", () => {
  beforeEach(() => {
    refresh.mockClear();
    discardImport.mockClear();
    deleteImport.mockClear();
    clearImport.mockClear();
    bulkClearImports.mockClear();
  });

  it("discards a draft import", async () => {
    renderHistory();
    fireEvent.click(screen.getByRole("button", { name: m.discard }));
    await waitFor(() => expect(discardImport).toHaveBeenCalledWith("draft1"));
    expect(refresh).toHaveBeenCalled();
  });

  it("links a draft import to its review page", () => {
    renderHistory();
    const link = screen.getByRole("link", { name: m.review });
    expect(link).toHaveAttribute("href", "/transactions/import/draft1");
  });

  it("undoes a confirmed import only after the two-step confirm", async () => {
    renderHistory();
    // First click reveals the warning + destructive confirm; nothing removed yet.
    fireEvent.click(screen.getByRole("button", { name: m.undo }));
    expect(deleteImport).not.toHaveBeenCalled();
    expect(screen.getByText(/Removes 4 transactions/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: m.undo }));
    await waitFor(() => expect(deleteImport).toHaveBeenCalledWith("conf1"));
    expect(refresh).toHaveBeenCalled();
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
    fireEvent.click(screen.getByRole("button", { name: m.clear }));
    await waitFor(() => expect(clearImport).toHaveBeenCalledWith("disc1"));
    expect(refresh).toHaveBeenCalled();
  });

  it("does not render Clear button for draft or confirmed rows", () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ImportHistory items={itemsWithDiscarded} />
      </NextIntlClientProvider>,
    );
    // Only one Clear button — for the single discarded row.
    expect(screen.getAllByRole("button", { name: m.clear })).toHaveLength(1);
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
});
