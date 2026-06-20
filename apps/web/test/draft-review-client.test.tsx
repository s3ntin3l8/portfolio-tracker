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

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ push, refresh }),
}));
vi.mock("@/lib/api", () => ({
  useApiClient: () => ({ confirmImport, discardImport }),
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
      <DraftReviewClient importId="imp1" drafts={[DRAFT]} />
    </NextIntlClientProvider>,
  );
}

describe("DraftReviewClient", () => {
  beforeEach(() => {
    push.mockClear();
    refresh.mockClear();
    confirmImport.mockClear();
    discardImport.mockClear();
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
      name: messages.ImportHistory.duplicates.importAnyway,
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
});
