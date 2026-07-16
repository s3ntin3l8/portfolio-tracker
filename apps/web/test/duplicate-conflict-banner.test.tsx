import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { DuplicateConflictBanner } from "../src/components/duplicate-conflict-banner";
import type { DuplicateConflict, DuplicateMatch } from "@portfolio/api-client";

function makeDuplicate(overrides?: Partial<DuplicateMatch>): DuplicateMatch {
  return {
    name: "Apple Inc",
    action: "buy",
    quantity: "3",
    executedAt: "2026-03-01",
    matchedSource: "csv",
    matchedExecutedAt: "2026-03-01",
    draftIndex: 0,
    matchedTransactionId: "tx-001",
    ...overrides,
  };
}

function renderBanner(conflict: DuplicateConflict, onEnrich = vi.fn(), onImportAnyway = vi.fn()) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <DuplicateConflictBanner
        conflict={conflict}
        onEnrich={onEnrich}
        onImportAnyway={onImportAnyway}
      />
    </NextIntlClientProvider>,
  );
}

describe("DuplicateConflictBanner", () => {
  it("renders the warning header with the duplicate count", () => {
    renderBanner({ count: 2, duplicates: [makeDuplicate(), makeDuplicate({ draftIndex: 1 })] });
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText(/2 selected transactions were/i)).toBeInTheDocument();
  });

  it("shows the matched source in each row", () => {
    renderBanner({ count: 1, duplicates: [makeDuplicate({ matchedSource: "csv" })] });
    expect(screen.getByText(/already imported from csv/i)).toBeInTheDocument();
  });

  it("fires onEnrich when the 'Enrich existing' button is clicked", () => {
    const onEnrich = vi.fn();
    const duplicate = makeDuplicate();
    renderBanner({ count: 1, duplicates: [duplicate] }, onEnrich);

    fireEvent.click(screen.getByRole("button", { name: messages.Duplicates.enrichExisting }));
    expect(onEnrich).toHaveBeenCalledWith(duplicate);
  });

  it("does not render 'Enrich existing' when matchedTransactionId is absent", () => {
    const duplicate = makeDuplicate({ matchedTransactionId: undefined as unknown as string });
    renderBanner({ count: 1, duplicates: [duplicate] });
    expect(screen.queryByRole("button", { name: messages.Duplicates.enrichExisting })).toBeNull();
  });

  it("fires onImportAnyway when the 'Import anyway' button is clicked", () => {
    const onImportAnyway = vi.fn();
    renderBanner({ count: 1, duplicates: [makeDuplicate()] }, vi.fn(), onImportAnyway);

    fireEvent.click(screen.getByRole("button", { name: messages.Duplicates.importAnyway }));
    expect(onImportAnyway).toHaveBeenCalledTimes(1);
  });

  it("caps the list at 5 rows and shows the overflow count", () => {
    const duplicates = Array.from({ length: 8 }, (_, i) => makeDuplicate({ draftIndex: i }));
    renderBanner({ count: 8, duplicates });

    const enrichBtns = screen.getAllByRole("button", { name: messages.Duplicates.enrichExisting });
    expect(enrichBtns).toHaveLength(5);
    expect(screen.getByText("+3 more")).toBeInTheDocument();
  });

  it("does not show the overflow line when there are 5 or fewer duplicates", () => {
    const duplicates = Array.from({ length: 5 }, (_, i) => makeDuplicate({ draftIndex: i }));
    renderBanner({ count: 5, duplicates });
    expect(screen.queryByText(/more/i)).toBeNull();
  });
});
