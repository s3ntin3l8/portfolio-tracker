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
    createMerger: vi.fn(async () => []),
  }),
}));

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import { NewEntryTabs } from "../src/components/new-entry-tabs";

const tx = messages.Manage.tx;
const ca = messages.CorpAction;
const mg = messages.Merger;

type TestPortfolio = {
  id: string;
  name: string;
  brokerage: string | null;
  accountHolder: string | null;
};

function renderTabs(
  defaultTab?: "transaction" | "corporate-action" | "merger",
  portfolios: TestPortfolio[] = [
    { id: "p1", name: "Main", brokerage: null, accountHolder: null },
  ],
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

  it("starts on the merger tab when requested", () => {
    renderTabs("merger");
    // The merger form's two instrument pickers are present (their search inputs).
    expect(screen.getByLabelText(mg.from)).toBeInTheDocument();
    expect(screen.getByLabelText(mg.to)).toBeInTheDocument();
  });

  it("offers the rich portfolio picker only when more than one portfolio exists", () => {
    // Single portfolio: no picker (destination is unambiguous).
    const { unmount } = renderTabs();
    expect(
      screen.queryByRole("button", { name: tx.portfolioPicker }),
    ).not.toBeInTheDocument();
    unmount();

    // Two portfolios: the rich picker (a Radix dropdown trigger, not a native select) is
    // shown on the transaction tab; opening it lists both, with the brokerage appended.
    renderTabs("transaction", [
      { id: "p1", name: "Main", brokerage: null, accountHolder: null },
      { id: "p2", name: "DKB", brokerage: "DKB", accountHolder: null },
    ]);
    const trigger = screen.getByRole("button", { name: tx.portfolioPicker });
    expect(trigger).toBeInTheDocument();
    // Radix opens on pointer/keyboard events, not a synthetic click.
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(
      screen.getByRole("menuitem", { name: /DKB · DKB/ }),
    ).toBeInTheDocument();
  });

  it("shares the rich portfolio picker with the merger tab", () => {
    renderTabs("merger", [
      { id: "p1", name: "Main", brokerage: null, accountHolder: null },
      { id: "p2", name: "DKB", brokerage: null, accountHolder: null },
    ]);
    expect(
      screen.getByRole("button", { name: tx.portfolioPicker }),
    ).toBeInTheDocument();
  });

  // Regression test for #472: the tab bar used to shrink-wrap and hug the left edge
  // instead of spreading evenly across the sheet width.
  it("renders the tab bar as a full-width segmented control", () => {
    renderTabs();
    expect(screen.getByRole("tablist")).toHaveClass("flex", "w-full");
    screen.getAllByRole("tab").forEach((tab) => expect(tab).toHaveClass("flex-1"));
  });
});
