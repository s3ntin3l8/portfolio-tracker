import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";

const push = vi.fn();
const globalSearch = vi.fn();

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ push }),
  usePathname: () => "/",
  Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("@/lib/api", () => ({
  useApiClient: () => ({ globalSearch }),
}));

import { GlobalSearch } from "../src/components/global-search";

const INSTRUMENT_RESULT = {
  id: "instr-1",
  symbol: "BBCA",
  name: "Bank Central Asia",
  market: "IDX",
  assetClass: "equity",
  currency: "IDR",
  isin: null,
  wkn: null,
  unit: "shares",
  sector: null,
  owned: true,
};

const CATALOG_RESULT = {
  id: "instr-2",
  symbol: "TLKM",
  name: "Telkom Indonesia",
  market: "IDX",
  assetClass: "equity",
  currency: "IDR",
  isin: null,
  wkn: null,
  unit: "shares",
  sector: null,
  owned: false,
};

const TX_RESULT = {
  id: "tx-1",
  portfolioId: "p-1",
  portfolioName: "Main",
  type: "buy",
  currency: "IDR",
  executedAt: "2026-01-15T00:00:00.000Z",
  description: "BBCA purchase",
  tags: null,
  instrument: { symbol: "BBCA", name: "Bank Central Asia" },
};

const s = messages.Search;

function renderSearch(holderId?: string | null) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <GlobalSearch holderId={holderId} />
    </NextIntlClientProvider>,
  );
}

/** Open the palette and type a query, then advance all pending timers (debounce)
 *  AND flush the resulting promise. Returns after the component has re-rendered
 *  with search results (or empty state). */
async function openAndSearch(query: string) {
  fireEvent.click(screen.getByRole("button", { name: s.triggerLabel }));
  const input = screen.getByPlaceholderText(s.placeholder);
  fireEvent.change(input, { target: { value: query } });
  // runAllTimersAsync: fires the debounce setTimeout + drains the resulting promise.
  await act(async () => {
    await vi.runAllTimersAsync();
  });
}

describe("GlobalSearch", () => {
  beforeEach(() => {
    push.mockClear();
    globalSearch.mockClear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens when the trigger button is clicked", () => {
    renderSearch();
    fireEvent.click(screen.getByRole("button", { name: s.triggerLabel }));
    expect(screen.getByPlaceholderText(s.placeholder)).toBeInTheDocument();
  });

  it("shows the hint text before any query is typed", () => {
    renderSearch();
    fireEvent.click(screen.getByRole("button", { name: s.triggerLabel }));
    expect(screen.getByText(s.hint)).toBeInTheDocument();
  });

  it("calls globalSearch after debounce and renders instrument results", async () => {
    globalSearch.mockResolvedValue({
      instruments: [INSTRUMENT_RESULT],
      transactions: [],
    });

    renderSearch();
    await openAndSearch("BBCA");

    expect(globalSearch).toHaveBeenCalledWith({ q: "BBCA", holderId: undefined, limit: 10 });
    expect(screen.getByText("BBCA")).toBeInTheDocument();
    expect(screen.getByText("Bank Central Asia")).toBeInTheDocument();
  });

  it("renders transaction results with type and description", async () => {
    globalSearch.mockResolvedValue({
      instruments: [],
      transactions: [TX_RESULT],
    });

    renderSearch();
    await openAndSearch("purchase");

    expect(screen.getByText("BBCA purchase")).toBeInTheDocument();
  });

  it("shows 'no results' when the search returns empty", async () => {
    globalSearch.mockResolvedValue({ instruments: [], transactions: [] });

    renderSearch();
    await openAndSearch("zzz-nomatch");

    expect(screen.getByText(s.noResults)).toBeInTheDocument();
  });

  it("navigates to instrument page on instrument select", async () => {
    globalSearch.mockResolvedValue({
      instruments: [INSTRUMENT_RESULT],
      transactions: [],
    });

    renderSearch();
    await openAndSearch("BBCA");

    expect(screen.getByText("BBCA")).toBeInTheDocument();

    // Click the instrument result item. The symbol text is inside the item.
    fireEvent.click(screen.getByText("BBCA"));
    expect(push).toHaveBeenCalledWith("/instruments/instr-1");

    // Dialog closes after navigation (use real timers for waitFor).
    vi.useRealTimers();
    await waitFor(() => {
      expect(screen.queryByPlaceholderText(s.placeholder)).not.toBeInTheDocument();
    });
  });

  it("navigates to transaction edit page on transaction select", async () => {
    globalSearch.mockResolvedValue({
      instruments: [],
      transactions: [TX_RESULT],
    });

    renderSearch();
    await openAndSearch("purchase");

    expect(screen.getByText("BBCA purchase")).toBeInTheDocument();

    fireEvent.click(screen.getByText("BBCA purchase"));
    expect(push).toHaveBeenCalledWith("/transactions/tx-1/edit");
  });

  it("shows a catalog badge for un-owned instruments", async () => {
    globalSearch.mockResolvedValue({
      instruments: [CATALOG_RESULT],
      transactions: [],
    });

    renderSearch();
    await openAndSearch("TLKM");

    expect(screen.getByText(s.catalogBadge)).toBeInTheDocument();
  });

  it("passes holderId to the search when provided", async () => {
    globalSearch.mockResolvedValue({ instruments: [], transactions: [] });

    renderSearch("holder-123");
    await openAndSearch("test");

    expect(globalSearch).toHaveBeenCalledWith({
      q: "test",
      holderId: "holder-123",
      limit: 10,
    });
  });

  it("does not call globalSearch when query is cleared to empty", async () => {
    globalSearch.mockResolvedValue({ instruments: [], transactions: [] });

    renderSearch();
    // Type a query and advance the debounce.
    await openAndSearch("BBCA");
    expect(globalSearch).toHaveBeenCalledTimes(1);

    // Clear the query.
    const input = screen.getByPlaceholderText(s.placeholder);
    fireEvent.change(input, { target: { value: "" } });
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    // globalSearch should NOT have been called again for an empty query.
    expect(globalSearch).toHaveBeenCalledTimes(1);
    // The hint should reappear.
    expect(screen.getByText(s.hint)).toBeInTheDocument();
  });

  it("does not open on '/' when an input is focused", () => {
    renderSearch();

    // Simulate a focused input field.
    const externalInput = document.createElement("input");
    document.body.appendChild(externalInput);
    externalInput.focus();

    fireEvent.keyDown(document, { key: "/" });

    // Dialog should NOT open.
    expect(screen.queryByPlaceholderText(s.placeholder)).not.toBeInTheDocument();

    document.body.removeChild(externalInput);
  });

  it("opens on Cmd-K regardless of focus", () => {
    renderSearch();
    fireEvent.keyDown(document, { key: "k", metaKey: true });
    expect(screen.getByPlaceholderText(s.placeholder)).toBeInTheDocument();
  });
});
