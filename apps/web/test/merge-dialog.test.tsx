import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";

const previewMergeTransactions = vi.fn();
const mergeTransactions = vi.fn(async () => ({ survivorId: "a" }));

// Stable object reference — MergeDialog's preview effect depends on `api`; a fresh object
// literal per call would re-fire the effect on every render (infinite loop).
const apiMock = { previewMergeTransactions, mergeTransactions };
vi.mock("@/lib/api", () => ({ useApiClient: () => apiMock }));

import { MergeDialog } from "../src/components/merge-dialog";
import type { TxRow } from "../src/components/transactions-table";

const rowA: TxRow = {
  id: "a",
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
};
const rowB: TxRow = {
  ...rowA,
  id: "b",
  source: "pdf",
  executedAt: "2026-02-02T00:00:00.000Z",
};

const t = messages.Transactions.merge;

function renderDialog(onMerged = vi.fn()) {
  const onOpenChange = vi.fn();
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <MergeDialog open rowA={rowA} rowB={rowB} onOpenChange={onOpenChange} onMerged={onMerged} />
    </NextIntlClientProvider>,
  );
  return { onOpenChange, onMerged };
}

describe("MergeDialog", () => {
  beforeEach(() => {
    previewMergeTransactions.mockReset();
    mergeTransactions.mockClear();
  });

  it("previews with rowA as the default survivor, then re-previews when the choice flips", async () => {
    previewMergeTransactions.mockResolvedValue({
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
        documentCount: 1,
      },
    });
    renderDialog();

    await waitFor(() => expect(previewMergeTransactions).toHaveBeenCalledWith("p1", "a", "b"));
    expect(await screen.findByText(t.previewTitle)).toBeInTheDocument();

    // Flip the survivor choice — the dialog re-previews with the ids swapped.
    fireEvent.click(screen.getByText(/pdf/));
    await waitFor(() => expect(previewMergeTransactions).toHaveBeenCalledWith("p1", "b", "a"));
  });

  it("disables confirm and shows the blocked reason when the preview refuses the merge", async () => {
    previewMergeTransactions.mockResolvedValue({
      ok: false,
      blockedReason: "different_instrument",
    });
    renderDialog();

    expect(await screen.findByText(t.blocked.different_instrument)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t.confirm })).toBeDisabled();
  });

  it("confirms the merge with the chosen survivor/absorbed ids and calls onMerged", async () => {
    previewMergeTransactions.mockResolvedValue({
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
    });
    const { onMerged, onOpenChange } = renderDialog();

    const confirmButton = await screen.findByRole("button", { name: t.confirm });
    await waitFor(() => expect(confirmButton).not.toBeDisabled());
    fireEvent.click(confirmButton);

    await waitFor(() => expect(mergeTransactions).toHaveBeenCalledWith("p1", "a", "b"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onMerged).toHaveBeenCalled();
  });
});
