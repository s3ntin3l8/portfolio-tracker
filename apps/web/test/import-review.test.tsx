import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { ImportReview } from "../src/components/import-review";
import type { ReviewDraft } from "../src/components/import-flow/types";
import messages from "../messages/en.json";

const DRAFTS: ReviewDraft[] = [
  {
    uid: "a",
    importId: "imp1",
    _serverIdx: 0,
    assetClass: "gold",
    action: "buy",
    name: "Antam Gold",
    quantity: "5",
    unit: "grams",
    price: "1150000",
    fees: "0",
    currency: "IDR",
    executedAt: "2026-02-08",
    confidence: 0.94,
  },
  {
    uid: "b",
    importId: "imp1",
    _serverIdx: 1,
    assetClass: "stock",
    action: "buy",
    name: "Apple Inc",
    quantity: "3",
    unit: "shares",
    price: "150",
    fees: "0",
    currency: "USD",
    executedAt: "2026-02-07",
    confidence: 0.72,
  },
  {
    uid: "c",
    importId: "imp1",
    _serverIdx: 2,
    assetClass: "bond",
    action: "sell",
    name: "FR Bond",
    quantity: "1",
    unit: "units",
    price: "980",
    fees: "0",
    currency: "EUR",
    executedAt: "2026-02-05",
    confidence: 0.88,
  },
];

function handlers() {
  return {
    onUpdate: vi.fn(),
    onRemove: vi.fn(),
    onRemoveMany: vi.fn(),
    onConfirm: vi.fn(),
    onDiscard: vi.fn(),
  };
}

function renderReview(drafts: ReviewDraft[] = DRAFTS, h: ReturnType<typeof handlers> = handlers()) {
  const utils = render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ImportReview drafts={drafts} {...h} />
    </NextIntlClientProvider>,
  );
  // Re-render helper that preserves component state across drafts changes.
  const rerender = (next: ReviewDraft[]) =>
    utils.rerender(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ImportReview drafts={next} {...h} />
      </NextIntlClientProvider>,
    );
  return { ...utils, rerender, ...h };
}

const tr = messages.Import.review;

describe("ImportReview", () => {
  it("renders one table row per draft", () => {
    renderReview();
    const table = screen.getByRole("table");
    expect(within(table).getByText("Antam Gold")).toBeInTheDocument();
    expect(within(table).getByText("Apple Inc")).toBeInTheDocument();
    expect(within(table).getByText("FR Bond")).toBeInTheDocument();
  });

  it("select-all then remove-selected (two-step) removes every draft", () => {
    const { onRemoveMany } = renderReview();
    fireEvent.click(screen.getByLabelText(tr.selectAll));
    fireEvent.click(screen.getByRole("button", { name: tr.batch.remove }));
    // "Remove" confirm collides with per-row remove buttons — scope to the prompt region.
    const confirmRegion = screen.getByText(tr.batch.removePrompt).parentElement!;
    fireEvent.click(within(confirmRegion).getByRole("button", { name: tr.batch.removeConfirm }));
    expect(onRemoveMany).toHaveBeenCalledWith(["a", "b", "c"]);
  });

  it("keeps a selection on the right draft after the array reindexes", () => {
    const { rerender } = renderReview();
    const table = screen.getByRole("table");
    // [select-all, a, b, c] — select draft b.
    fireEvent.click(within(table).getAllByRole("checkbox")[2]);

    // Drop draft "a"; b shifts from index 1 to 0 in the underlying array.
    rerender([DRAFTS[1], DRAFTS[2]]);

    const table2 = screen.getByRole("table");
    // [select-all, b, c] — b must still be checked.
    expect(within(table2).getAllByRole("checkbox")[1]).toBeChecked();
  });

  it("filters to low-confidence drafts with the needs-review toggle", () => {
    renderReview();
    fireEvent.click(screen.getByLabelText(tr.filters.needsReview));
    const table = screen.getByRole("table");
    expect(within(table).queryByText("Antam Gold")).not.toBeInTheDocument(); // 0.94
    expect(within(table).getByText("Apple Inc")).toBeInTheDocument(); // 0.72
    expect(within(table).getByText("FR Bond")).toBeInTheDocument(); // 0.88
  });

  it("narrows rows with the name search", () => {
    renderReview();
    fireEvent.change(screen.getByLabelText(tr.filters.search), {
      target: { value: "apple" },
    });
    const table = screen.getByRole("table");
    expect(within(table).getByText("Apple Inc")).toBeInTheDocument();
    expect(within(table).queryByText("Antam Gold")).not.toBeInTheDocument();
  });

  it("confirm-selected passes the right uid even while a filter hides other rows", () => {
    const { onConfirm } = renderReview();
    const table = screen.getByRole("table");
    // Select draft c (index 3 of [select-all, a, b, c]).
    fireEvent.click(within(table).getAllByRole("checkbox")[3]);
    // Filter to bonds via the multi-select chip — only c stays visible, but selection
    // still targets c by uid.
    fireEvent.click(screen.getByRole("button", { name: "bond" }));
    fireEvent.click(screen.getByRole("button", { name: tr.batch.confirmSelected }));
    expect(onConfirm).toHaveBeenCalledWith(["c"]);
  });

  it("OR-filters within a dimension (buy OR sell shows both)", () => {
    renderReview();
    const table = screen.getByRole("table");
    // Sells only → just the bond sell.
    fireEvent.click(screen.getByRole("button", { name: "sell" }));
    expect(within(table).queryByText("Apple Inc")).not.toBeInTheDocument();
    expect(within(table).getByText("FR Bond")).toBeInTheDocument();
    // Add buy → OR within the action dimension brings the buys back too.
    fireEvent.click(screen.getByRole("button", { name: "buy" }));
    expect(within(table).getByText("Antam Gold")).toBeInTheDocument();
    expect(within(table).getByText("Apple Inc")).toBeInTheDocument();
    expect(within(table).getByText("FR Bond")).toBeInTheDocument();
  });

  it("renders attention issues as a banner + table rows, and maps them via the row Map button", () => {
    const onMapIssue = vi.fn();
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ImportReview
          drafts={DRAFTS}
          {...handlers()}
          onMapIssue={onMapIssue}
          issues={[
            {
              eventId: "ev-9",
              eventType: "SSP_CORPORATE_ACTION_INSTRUMENT",
              severity: "attention",
              message:
                "SSP_CORPORATE_ACTION_INSTRUMENT without a share count — check the event details",
              raw: {
                name: "Acme Corp",
                isin: "US123",
                currency: "EUR",
                executedAt: "2026-02-01",
                amount: 0,
                shares: 2,
              },
            },
            {
              eventId: "ev-10",
              eventType: "CARD_VERIFICATION",
              severity: "info",
              message: "card verification",
            },
          ]}
        />
      </NextIntlClientProvider>,
    );
    // Ignorable info events are still in the <details> disclosure.
    expect(screen.getByText("1 ignored event")).toBeInTheDocument();
    // Attention count is now a banner (not a detailed list).
    expect(screen.getByText("1 event needs attention")).toBeInTheDocument();
    // The issue's message text is NOT expanded in the banner (it's a table row now).
    // The issue appears as a table row; "Acme Corp" is rendered there.
    expect(screen.getByText("Acme Corp")).toBeInTheDocument();
    // Open the map dialog via the row-level Map button and save.
    fireEvent.click(screen.getByRole("button", { name: tr.issues.map }));
    fireEvent.click(screen.getByRole("button", { name: tr.issues.mapSave }));
    expect(onMapIssue).toHaveBeenCalledTimes(1);
    const [eventId, draft] = onMapIssue.mock.calls[0];
    expect(eventId).toBe("ev-9");
    // SSP_CORPORATE_ACTION_INSTRUMENT prefills as bonus with the raw share count.
    expect(draft).toMatchObject({
      externalId: "ev-9",
      name: "Acme Corp",
      isin: "US123",
      action: "bonus",
      quantity: "2",
      price: "0",
    });
  });

  it("edits a draft via the dialog and reports the right uid", () => {
    const { onUpdate } = renderReview();
    // Edit buttons are desktop-only and in row order [a, b, c].
    fireEvent.click(screen.getAllByRole("button", { name: tr.edit.open })[1]);
    fireEvent.change(screen.getByDisplayValue("Apple Inc"), {
      target: { value: "Apple 2" },
    });
    expect(onUpdate).toHaveBeenCalledWith("b", { name: "Apple 2" });
  });

  it("confirm-all calls onConfirm with no subset", () => {
    const { onConfirm } = renderReview();
    fireEvent.click(screen.getByRole("button", { name: messages.Import.confirm }));
    expect(onConfirm).toHaveBeenCalledWith(undefined);
  });

  it("disables and spins the Confirm button while the write is in flight", () => {
    const h = handlers();
    // A never-resolving promise keeps the write "in flight" for the assertion.
    h.onConfirm.mockReturnValue(new Promise(() => {}));
    renderReview(DRAFTS, h);
    const confirm = screen.getByRole("button", { name: messages.Import.confirm });
    fireEvent.click(confirm);
    expect(confirm).toBeDisabled();
    expect(confirm.querySelector(".animate-spin")).toBeInTheDocument();
    // Other write buttons are blocked too, so a second submit can't fire.
    expect(screen.getByRole("button", { name: messages.Import.discard })).toBeDisabled();
  });

  it("sorts draft rows by name ascending when name header is clicked", () => {
    renderReview();
    const table = screen.getByRole("table");
    // DRAFTS: Antam Gold (a), Apple Inc (b), FR Bond (c) — already asc by name
    // Click the name header button
    const nameBtn = within(table).getByRole("button", {
      name: new RegExp(messages.Import.fields.name, "i"),
    });
    fireEvent.click(nameBtn);
    const rows = within(table).getAllByRole("row").slice(1);
    // Antam, Apple, FR Bond alphabetically
    expect(rows[0]).toHaveTextContent("Antam Gold");
    expect(rows[1]).toHaveTextContent("Apple Inc");
    expect(rows[2]).toHaveTextContent("FR Bond");
    // Second click: descending
    fireEvent.click(nameBtn);
    const rowsDesc = within(table).getAllByRole("row").slice(1);
    expect(rowsDesc[0]).toHaveTextContent("FR Bond");
    expect(rowsDesc[2]).toHaveTextContent("Antam Gold");
  });

  it("sorts draft rows by date (executedAt) ascending", () => {
    renderReview();
    const table = screen.getByRole("table");
    const dateBtn = within(table).getByRole("button", {
      name: new RegExp(messages.Import.fields.executedAt, "i"),
    });
    fireEvent.click(dateBtn);
    const rows = within(table).getAllByRole("row").slice(1);
    // DRAFTS dates: a=2026-02-08, b=2026-02-07, c=2026-02-05
    // asc: c (05), b (07), a (08)
    expect(rows[0]).toHaveTextContent("FR Bond");
    expect(rows[1]).toHaveTextContent("Apple Inc");
    expect(rows[2]).toHaveTextContent("Antam Gold");
  });

  // ── Enrichment vs duplicate badge behavior (#259) ──────────────────────────

  it("shows amber warning badge for a duplicate draft", () => {
    const draftWithDup: ReviewDraft = {
      ...DRAFTS[0]!,
      likelyDuplicate: { kind: "duplicate", source: "csv", executedAt: "2026-02-08" },
    };
    renderReview([draftWithDup]);
    // Badge appears in both the desktop table and the mobile card view.
    expect(screen.getAllByText(/Already imported/i).length).toBeGreaterThan(0);
  });

  it("shows default badge for an enrichment draft", () => {
    const draftWithEnrich: ReviewDraft = {
      ...DRAFTS[0]!,
      likelyDuplicate: { kind: "enrichment", source: "csv", executedAt: "2026-02-08" },
    };
    renderReview([draftWithEnrich]);
    expect(screen.getAllByText(/Enriches existing/i).length).toBeGreaterThan(0);
  });

  it("shows enrichment notice banner when enrichment drafts are present", () => {
    const draftsWithEnrich: ReviewDraft[] = [
      {
        ...DRAFTS[0]!,
        likelyDuplicate: { kind: "enrichment", source: "csv", executedAt: "2026-02-08" },
      },
      DRAFTS[1]!,
    ];
    renderReview(draftsWithEnrich);
    expect(screen.getByText(/1 draft will enrich/i)).toBeInTheDocument();
  });

  it("shows duplicate notice banner when duplicate drafts are present", () => {
    const draftsWithDup: ReviewDraft[] = [
      {
        ...DRAFTS[0]!,
        likelyDuplicate: { kind: "duplicate", source: "csv", executedAt: "2026-02-08" },
      },
      DRAFTS[1]!,
    ];
    renderReview(draftsWithDup);
    expect(screen.getByText(/1 draft looks like it was already imported/i)).toBeInTheDocument();
  });

  it("enrichment draft is included in confirm-all (no subset passed)", () => {
    const { onConfirm } = renderReview([
      {
        ...DRAFTS[0]!,
        likelyDuplicate: { kind: "enrichment", source: "csv", executedAt: "2026-02-08" },
      },
    ]);
    fireEvent.click(screen.getByRole("button", { name: messages.Import.confirm }));
    // confirm-all passes undefined so the hook applies its own filter
    expect(onConfirm).toHaveBeenCalledWith(undefined);
  });

  it("isSubmitting=true disables buttons without unmounting the component", () => {
    const h = handlers();
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ImportReview drafts={DRAFTS} {...h} isSubmitting={true} />
      </NextIntlClientProvider>,
    );
    expect(screen.getByRole("button", { name: messages.Import.confirm })).toBeDisabled();
    expect(screen.getByRole("button", { name: messages.Import.discard })).toBeDisabled();
    // Component is still mounted — drafts are still rendered (appears in table + mobile card)
    expect(screen.getAllByText("Antam Gold").length).toBeGreaterThan(0);
  });
});
