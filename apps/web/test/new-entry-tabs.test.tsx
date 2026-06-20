import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";

// Both inner form wrappers wire the real client + router via these hooks.
vi.mock("@/lib/api", () => ({
  useApiClient: () => ({
    searchInstruments: vi.fn(async () => []),
    lookupInstruments: vi.fn(async () => []),
    createInstrument: vi.fn(async () => ({})),
    createTransaction: vi.fn(async () => ({})),
    updateTransaction: vi.fn(async () => ({})),
    getGoldSources: vi.fn(async () => [{ market: "ANTAM", label: "Antam buyback" }]),
    createCorporateAction: vi.fn(async () => ({})),
  }),
}));

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import { NewEntryTabs } from "../src/components/new-entry-tabs";

const tx = messages.Manage.tx;
const ca = messages.CorpAction;

function renderTabs(
  defaultTab?: "transaction" | "corporate-action",
  portfolios: { id: string; name: string }[] = [{ id: "p1", name: "Main" }],
) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <NewEntryTabs
        portfolios={portfolios}
        initialPortfolioId={portfolios[0]?.id ?? ""}
        defaultTab={defaultTab}
      />
    </NextIntlClientProvider>,
  );
}

describe("NewEntryTabs", () => {
  it("shows the transaction form by default and switches to the corporate-action form", () => {
    renderTabs();

    // Transaction tab active: the manual form's submit button is shown; the corp form
    // (inactive tab) is unmounted, so its Ratio field is absent.
    expect(
      screen.getByRole("button", { name: tx.submit }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(ca.ratio)).not.toBeInTheDocument();

    // Radix tab triggers activate on mouseDown (primary button), not a synthetic click.
    fireEvent.mouseDown(screen.getByRole("tab", { name: ca.link }));

    expect(screen.getByLabelText(ca.ratio)).toBeInTheDocument();
  });

  it("starts on the corporate-action tab when requested", () => {
    renderTabs("corporate-action");
    expect(screen.getByLabelText(ca.ratio)).toBeInTheDocument();
  });

  it("offers a portfolio picker only when more than one portfolio exists", () => {
    // Single portfolio: no picker (destination is unambiguous).
    const { unmount } = renderTabs();
    expect(screen.queryByLabelText(tx.portfolioPicker)).not.toBeInTheDocument();
    unmount();

    // Two portfolios: the picker is shown on the transaction tab, listing both.
    renderTabs("transaction", [
      { id: "p1", name: "Main" },
      { id: "p2", name: "DKB" },
    ]);
    const picker = screen.getByLabelText(tx.portfolioPicker);
    expect(picker).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "DKB" }),
    ).toBeInTheDocument();
  });
});
