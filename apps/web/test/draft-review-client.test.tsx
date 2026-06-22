import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { ApiError } from "@portfolio/api-client";
import messages from "../messages/en.json";
import type { ImportDraft } from "../src/components/import-flow";

const push = vi.fn();
const refresh = vi.fn();
const confirmImport = vi.fn(async () => ({ confirmed: 1, transactions: [] }));
const discardImport = vi.fn(async () => undefined);
const enrichImport = vi.fn(async () => ({ enriched: 1, skipped: [] }));

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ push, refresh }),
}));
vi.mock("@/lib/api", () => ({
  useApiClient: () => ({ confirmImport, discardImport, enrichImport }),
}));

import { DraftReviewClient } from "../src/components/draft-review-client";

const DRAFT: ImportDraft = {
  assetClass: "equity",
  action: "buy",
  name: "Apple Inc",
  quantity: "3",
  unit: "shares",
  price: "180",
  fees: "0",
  currency: "EUR",
  executedAt: "2026-03-01",
  confidence: 1,
};

function renderClient() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <DraftReviewClient importId="imp1" initialPortfolioId={null} drafts={[DRAFT]} />
    </NextIntlClientProvider>,
  );
}

describe("DraftReviewClient", () => {
  beforeEach(() => {
    push.mockClear();
    refresh.mockClear();
    confirmImport.mockClear();
    discardImport.mockClear();
    enrichImport.mockClear();
  });

  it("renders the staged drafts", () => {
    renderClient();
    expect(screen.getAllByText("Apple Inc").length).toBeGreaterThan(0);
  });

  it("confirms the (uid-stripped) drafts and returns to the import page", async () => {
    renderClient();
    fireEvent.click(screen.getByRole("button", { name: messages.Import.confirm }));
    await waitFor(() =>
      expect(confirmImport).toHaveBeenCalledWith("imp1", [DRAFT], [], undefined, false, false),
    );
    expect(push).toHaveBeenCalledWith("/transactions");
  });

  it("excludes likely-duplicate drafts from the default Confirm (#196)", async () => {
    // A clean draft plus a flagged one. Default Confirm should only submit the clean one.
    const flaggedDraft: ImportDraft = {
      ...DRAFT,
      name: "Flagged Stock",
      likelyDuplicate: { kind: "duplicate", source: "csv", executedAt: "2026-03-01" },
    };
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <DraftReviewClient
          importId="imp1"
          initialPortfolioId={null}
          drafts={[DRAFT, flaggedDraft]}
        />
      </NextIntlClientProvider>,
    );

    // Click the global Confirm button (no rows selected).
    fireEvent.click(screen.getByRole("button", { name: messages.Import.confirm }));
    await waitFor(() =>
      // Only the clean DRAFT reaches the API; the likelyDuplicate is excluded.
      expect(confirmImport).toHaveBeenCalledWith("imp1", [DRAFT], [], undefined, false, false),
    );
  });

  it("surfaces a cross-source duplicate 409 and re-confirms with acknowledgement (#217)", async () => {
    confirmImport
      .mockRejectedValueOnce(
        new ApiError(409, JSON.stringify({ error: "duplicate_transactions", count: 1, duplicates: [] })),
      )
      .mockResolvedValueOnce({ confirmed: 1, transactions: [] });
    renderClient();

    fireEvent.click(screen.getByRole("button", { name: messages.Import.confirm }));

    // The duplicate banner renders instead of the generic review error.
    const importAnyway = await screen.findByRole("button", {
      name: messages.Duplicates.importAnyway,
    });
    fireEvent.click(importAnyway);

    await waitFor(() => expect(push).toHaveBeenCalledWith("/transactions"));
    // First attempt did not acknowledge; the retry does.
    expect(confirmImport).toHaveBeenNthCalledWith(1, "imp1", [DRAFT], [], undefined, false, false);
    expect(confirmImport).toHaveBeenNthCalledWith(2, "imp1", [DRAFT], [], undefined, false, true);
  });

  it("discards the import and returns to the import page", async () => {
    renderClient();
    fireEvent.click(screen.getByRole("button", { name: messages.Import.discard }));
    await waitFor(() => expect(discardImport).toHaveBeenCalledWith("imp1"));
    expect(push).toHaveBeenCalledWith("/transactions");
  });

  it("Enrich existing calls enrichImport with the draft payload and drops the draft (#230)", async () => {
    const MATCHED_TX_ID = "tx-existing-001";
    confirmImport.mockRejectedValueOnce(
      new ApiError(
        409,
        JSON.stringify({
          error: "duplicate_transactions",
          count: 1,
          duplicates: [
            {
              name: "Apple Inc",
              action: "buy",
              quantity: "3",
              executedAt: "2026-03-01",
              matchedSource: "csv",
              matchedExecutedAt: "2026-03-01",
              draftIndex: 0,
              matchedTransactionId: MATCHED_TX_ID,
            },
          ],
        }),
      ),
    );
    renderClient();

    fireEvent.click(screen.getByRole("button", { name: messages.Import.confirm }));

    // Duplicate banner lists the match with "Enrich existing" button.
    const enrichBtn = await screen.findByRole("button", {
      name: messages.Duplicates.enrichExisting,
    });
    fireEvent.click(enrichBtn);

    await waitFor(() =>
      expect(enrichImport).toHaveBeenCalledWith(
        "imp1",
        [expect.objectContaining({ targetTransactionId: MATCHED_TX_ID })],
        undefined,
      ),
    );
    // The enriched draft is the only one; no re-confirm, but the draft is removed.
    expect(confirmImport).toHaveBeenCalledTimes(1); // only the original (failed) call
    // After enriching the sole draft the duplicate banner is cleared.
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: messages.Duplicates.enrichExisting }),
      ).toBeNull(),
    );
  });
});
