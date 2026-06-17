import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { ImportReview } from "../src/components/import-review";
import type { ReviewDraft } from "../src/components/import-flow";
import messages from "../messages/en.json";

const DRAFTS: ReviewDraft[] = [
  {
    uid: "a",
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

function renderReview(
  drafts: ReviewDraft[] = DRAFTS,
  h: ReturnType<typeof handlers> = handlers(),
) {
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
    fireEvent.click(
      within(confirmRegion).getByRole("button", { name: tr.batch.removeConfirm }),
    );
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
    expect(
      screen.getByRole("button", { name: messages.Import.discard }),
    ).toBeDisabled();
  });
});
