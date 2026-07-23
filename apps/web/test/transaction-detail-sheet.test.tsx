import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";

const refresh = vi.fn();
const getTransactionDocumentUrl = vi.fn(async () => ({ url: "https://example.com/doc" }));
const getSourceDocumentUrl = vi.fn(async () => ({ url: "https://example.com/src-doc" }));
const deleteTransaction = vi.fn(async () => undefined);
const dismissAnomaly = vi.fn(async () => undefined);

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ refresh }),
  Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock("@/lib/api", () => ({
  useApiClient: () => ({
    getTransactionDocumentUrl,
    getSourceDocumentUrl,
    deleteTransaction,
    dismissAnomaly,
  }),
}));

import { TransactionDetailSheet } from "../src/components/transaction-detail-sheet";
import type { TxRow } from "../src/components/transactions-table";

const TX: TxRow = {
  id: "tx-1",
  portfolioId: "p-1",
  portfolioName: "Main",
  type: "buy",
  quantity: "10",
  price: "100",
  fees: "5",
  tax: null,
  fxRate: null,
  currency: "IDR",
  executedAt: "2026-03-15T00:00:00.000Z",
  source: "manual",
  instrument: { symbol: "BBCA", name: "Bank Central Asia" },
  hasDocument: true,
};

function renderSheet(props: Partial<Parameters<typeof TransactionDetailSheet>[0]> = {}) {
  const onOpenChange = vi.fn();
  const onDeleted = vi.fn();
  return {
    onOpenChange,
    onDeleted,
    ...render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <TransactionDetailSheet
          tx={TX}
          open={true}
          onOpenChange={onOpenChange}
          onDeleted={onDeleted}
          {...props}
        />
      </NextIntlClientProvider>,
    ),
  };
}

describe("TransactionDetailSheet", () => {
  beforeEach(() => {
    refresh.mockClear();
    getTransactionDocumentUrl.mockClear();
    getSourceDocumentUrl.mockClear();
    deleteTransaction.mockClear();
    dismissAnomaly.mockClear();
  });

  it("shows a negative_cash anomaly with its balance and dismisses it", async () => {
    const { onOpenChange } = renderSheet({
      anomaly: {
        code: "negative_cash",
        severity: "error",
        scope: "transaction",
        transactionId: "tx-1",
        meta: { currency: "EUR", balance: "-0.98" },
      },
    });
    // The localized message folds in the formatted balance.
    expect(screen.getByText(/Negative cash balance/)).toHaveTextContent("-€0.98");

    fireEvent.click(screen.getByRole("button", { name: "Dismiss warning" }));
    await waitFor(() =>
      expect(dismissAnomaly).toHaveBeenCalledWith("p-1", "tx-1", "negative_cash"),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("renders no dismiss control when there is no anomaly", () => {
    renderSheet();
    expect(screen.queryByRole("button", { name: "Dismiss warning" })).toBeNull();
  });

  it("renders date, type, instrument symbol, quantity and currency when open", () => {
    renderSheet();
    // Date — formatted in medium style (header subtitle + Details row)
    expect(screen.getAllByText(/Mar 15, 2026|15 Mar 2026/).length).toBeGreaterThan(0);
    // Header title folds the type into "Buy · BBCA".
    expect(screen.getByText(/Buy · BBCA/)).toBeInTheDocument();
    // Instrument symbol appears on its own in the Details row.
    expect(screen.getAllByText("BBCA").length).toBeGreaterThan(0);
    // Quantity — breakdown row value
    expect(screen.getByText("10")).toBeInTheDocument();
    // Currency appears in the formatted amounts
    expect(screen.getAllByText(/IDR/).length).toBeGreaterThan(0);
  });

  it("#465: shows a secondary ≈ amount in the scope currency when it differs from the row's own currency", () => {
    renderSheet({
      tx: { ...TX, currency: "USD", displayCurrency: "EUR", displayRate: "0.9" },
    });
    // netAmount = -(10*100 + 5) = -1005 USD -> * 0.9 = -904.5 EUR.
    expect(screen.getByText(/≈.*904\.50/)).toBeInTheDocument();
  });

  it("hides the secondary amount when the row is already in the scope currency", () => {
    renderSheet({
      tx: { ...TX, currency: "EUR", displayCurrency: "EUR", displayRate: "1" },
    });
    expect(screen.queryByText(/≈/)).toBeNull();
  });

  it("hides the secondary amount when displayRate is the unconverted fallback (unknown FX pair)", () => {
    // currency !== displayCurrency but rate="1" here means "no rate found", not "already
    // converted" — must not mislabel the unconverted amount as EUR.
    renderSheet({
      tx: { ...TX, currency: "SGD", displayCurrency: "EUR", displayRate: "1" },
    });
    expect(screen.queryByText(/≈/)).toBeNull();
  });

  it("renders the Breakdown and Details section headings", () => {
    renderSheet();
    expect(screen.getByText(messages.Transactions.breakdown)).toBeInTheDocument();
    expect(screen.getByText(messages.Transactions.details)).toBeInTheDocument();
  });

  it("shows shares/per-share/gross-native rows for a foreign-currency dividend instead of hiding Quantity/Price", () => {
    renderSheet({
      tx: {
        ...TX,
        id: "div-gbp",
        type: "dividend",
        quantity: "0", // stays "0" by convention — net-EUR-credited
        price: "34.23",
        currency: "EUR",
        fxRate: "1.145199",
        shares: "27.526515",
        perShare: "1.08580023",
        nativeCurrency: "GBP",
        grossNative: "29.89",
        instrument: { symbol: "RIO1", name: "Rio Tinto" },
      },
    });
    // Quantity/Price would normally be hidden entirely when qty === 0; here they fall back
    // to the parsed shares/per-share pair instead of disappearing. (The shared quantity
    // formatter caps at 3 fraction digits, same as any other fractional-share quantity.)
    expect(screen.getByText("27.527")).toBeInTheDocument();
    expect(screen.getByText("£1.09")).toBeInTheDocument();
    // New "Gross (native currency)" row.
    expect(screen.getByText(messages.Transactions.grossNative)).toBeInTheDocument();
    expect(screen.getByText("£29.89")).toBeInTheDocument();
    // The FX rate is now populated (previously null for every synced dividend) and surfaces
    // in the existing Details row.
    expect(screen.getByText(messages.Transactions.fxRate)).toBeInTheDocument();
    expect(screen.getByText("1.1452")).toBeInTheDocument();
  });

  it("#508: flags derived shares/per-share with an approximate (≈) hint, but not a source-provided pair", () => {
    renderSheet({
      tx: {
        ...TX,
        id: "div-derived",
        type: "dividend",
        quantity: "0",
        price: "8",
        currency: "EUR",
        shares: "10",
        perShare: "1",
        sharesEstimated: true,
        instrument: { symbol: "MO", name: "Altria" },
      },
    });
    expect(screen.getByText("≈ 10")).toBeInTheDocument();
    expect(screen.getByText(/≈.*€1\.00/)).toBeInTheDocument();
  });

  it("does not show the approximate hint for a source-provided (parsed) shares/per-share pair", () => {
    renderSheet({
      tx: {
        ...TX,
        id: "div-authoritative",
        type: "dividend",
        quantity: "0",
        price: "0.65",
        currency: "EUR",
        shares: "1",
        perShare: "0.91",
        nativeCurrency: "USD",
        instrument: { symbol: "MSFT", name: "Microsoft" },
      },
    });
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.queryByText(/≈ 1\b/)).toBeNull();
    expect(screen.queryByText(/≈.*\$0\.91/)).toBeNull();
  });

  it("resolves the Account line from the portfolios prop when the row omits portfolioName", () => {
    // The reported bug: portfolioName is absent (single-portfolio scope) → the account line
    // vanished. It must now fall back to the portfolios lookup by portfolioId.
    renderSheet({
      tx: { ...TX, portfolioName: undefined },
      portfolios: [
        { id: "p-1", name: "Growth depot", brokerage: null, accountHolder: null },
        { id: "p-2", name: "Other", brokerage: null, accountHolder: null },
      ],
    });
    expect(screen.getByText("Growth depot")).toBeInTheDocument();
  });

  // Radix opens its dropdown on keyboard/pointer events, not a synthetic click.
  const openActions = () =>
    fireEvent.keyDown(screen.getByRole("button", { name: messages.Manage.actions }), {
      key: "Enter",
    });

  it("offers Download receipt in the overflow menu when the tx has a retained document", () => {
    renderSheet();
    openActions();
    expect(
      screen.getByRole("menuitem", { name: messages.Manage.downloadReceipt }),
    ).toBeInTheDocument();
  });

  it("omits Download receipt from the overflow menu when there is no document", () => {
    renderSheet({ tx: { ...TX, hasDocument: false } });
    openActions();
    expect(screen.queryByRole("menuitem", { name: messages.Manage.downloadReceipt })).toBeNull();
  });

  it("offers Reassign in the overflow menu only when 2+ portfolios exist", () => {
    const onReassign = vi.fn();
    renderSheet({
      onReassign,
      portfolios: [
        { id: "p-1", name: "A", brokerage: null, accountHolder: null },
        { id: "p-2", name: "B", brokerage: null, accountHolder: null },
      ],
    });
    openActions();
    fireEvent.click(screen.getByRole("menuitem", { name: messages.Manage.reassign }));
    expect(onReassign).toHaveBeenCalledWith(TX);
  });

  it("shows an Edit link pointing to /transactions/:id/edit (no onEdit handler)", () => {
    renderSheet();
    const editLink = screen.getByRole("link", { name: messages.Manage.edit });
    expect(editLink).toHaveAttribute("href", "/transactions/tx-1/edit");
  });

  it("calls onEdit in place (no navigation link) when an onEdit handler is provided", () => {
    const onEdit = vi.fn();
    renderSheet({ onEdit });
    // Edit is now an in-place button, not a navigation link.
    expect(screen.queryByRole("link", { name: messages.Manage.edit })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: messages.Manage.edit }));
    expect(onEdit).toHaveBeenCalledWith(TX);
  });

  it("shows a Delete control", () => {
    renderSheet();
    // The DeleteTransactionButton renders a button with the delete label
    expect(screen.getByRole("button", { name: messages.Manage.delete.label })).toBeInTheDocument();
  });

  it("does not render the sheet content when open=false", () => {
    // Radix Dialog unmounts hidden content, so type badge should not appear
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <TransactionDetailSheet tx={TX} open={false} onOpenChange={vi.fn()} onDeleted={vi.fn()} />
      </NextIntlClientProvider>,
    );
    // When closed, the dialog content is not mounted
    expect(screen.queryByText(messages.TxType.buy)).toBeNull();
  });

  it("calls download URL handler when the Download receipt menu item is clicked", async () => {
    renderSheet();
    openActions();
    fireEvent.click(screen.getByRole("menuitem", { name: messages.Manage.downloadReceipt }));
    await waitFor(() => {
      expect(getTransactionDocumentUrl).toHaveBeenCalledWith("p-1", "tx-1");
    });
  });

  it("returns null when tx is null", () => {
    const { container } = render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <TransactionDetailSheet tx={null} open={true} onOpenChange={vi.fn()} onDeleted={vi.fn()} />
      </NextIntlClientProvider>,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders the import provenance section with an Imported date + filename, not the raw fingerprint", () => {
    const txWithSources = {
      ...TX,
      hasDocument: true,
      sources: [
        {
          id: "src-1",
          sourceType: "pdf",
          externalId: "dkb:12345",
          orderRef: null,
          documentId: "doc-1",
          taxComponents: null,
          createdAt: "2026-03-15T00:00:00.000Z",
          filename: "settlement.pdf",
          hasDocument: true,
        },
      ],
    };
    renderSheet({ tx: txWithSources });
    // Section heading
    expect(screen.getByText(messages.Transactions.sourcesSection.title)).toBeInTheDocument();
    // Clean source-type label (localized, not the raw "pdf")
    expect(screen.getByText(messages.Transactions.sources.pdf)).toBeInTheDocument();
    // Imported date + filename, NOT the raw externalId fingerprint
    expect(screen.getByText(/Imported.*settlement\.pdf/)).toBeInTheDocument();
    expect(screen.queryByText("dkb:12345")).toBeNull();
  });

  it("promotes the per-source tax breakdown into Details rows, not the sources-section footnote", () => {
    const txWithTaxComponents = {
      ...TX,
      currency: "EUR",
      hasDocument: true,
      sources: [
        {
          id: "src-tax",
          sourceType: "pdf",
          externalId: "dkb:msft",
          orderRef: null,
          documentId: "doc-1",
          taxComponents: { quellensteuer: "0.12" },
          createdAt: "2026-03-15T00:00:00.000Z",
          filename: "settlement.pdf",
          hasDocument: true,
        },
      ],
    };
    renderSheet({ tx: txWithTaxComponents });
    // Promoted as a labelled Details row.
    const qstRow = screen.getByText("QSt").closest("div");
    expect(qstRow).toHaveTextContent("€0.12");
    // Not duplicated as the old footnote under the source row.
    expect(screen.queryByText(/QSt: 0.12/)).toBeNull();
  });

  it("hides the top-level Source field when source rows exist, shows it for manual (no sources)", () => {
    // Manual transaction (no source rows) → top-level Source field is shown.
    renderSheet();
    expect(screen.getByText(messages.Transactions.source)).toBeInTheDocument();

    // With source rows the Data sources section replaces it.
    renderSheet({
      tx: {
        ...TX,
        sources: [
          {
            id: "src-x",
            sourceType: "csv",
            externalId: null,
            orderRef: null,
            documentId: null,
            taxComponents: null,
            createdAt: "2026-03-15T00:00:00.000Z",
            filename: null,
            hasDocument: false,
          },
        ],
      },
    });
    expect(screen.getByText(messages.Transactions.sourcesSection.title)).toBeInTheDocument();
  });

  it("hides the global Download receipt button when a source row carries its own document", () => {
    const txWithDoc = {
      ...TX,
      hasDocument: true,
      sources: [
        {
          id: "src-d",
          sourceType: "csv",
          externalId: null,
          orderRef: null,
          documentId: null,
          taxComponents: null,
          createdAt: "2026-03-15T00:00:00.000Z",
          filename: "statement.csv",
          hasDocument: true,
        },
      ],
    };
    renderSheet({ tx: txWithDoc });
    // The inline per-source download is present (assert before opening the modal menu,
    // which is Radix-modal and aria-hides the rest of the sheet while open).
    expect(
      screen.getByRole("button", { name: messages.Transactions.sourcesSection.download }),
    ).toBeInTheDocument();
    // No global receipt action — the inline per-source download covers it.
    openActions();
    expect(screen.queryByRole("menuitem", { name: messages.Manage.downloadReceipt })).toBeNull();
  });

  it("calls getSourceDocumentUrl when per-source download button is clicked", async () => {
    const txWithSources = {
      ...TX,
      sources: [
        {
          id: "src-2",
          sourceType: "pdf",
          externalId: "dkb:99999",
          orderRef: null,
          documentId: "doc-abc",
          taxComponents: null,
          createdAt: "2026-03-15T00:00:00.000Z",
          filename: "settlement.pdf",
          hasDocument: true,
        },
      ],
    };
    renderSheet({ tx: txWithSources });
    const dlBtn = screen.getByRole("button", {
      name: messages.Transactions.sourcesSection.download,
    });
    fireEvent.click(dlBtn);
    await waitFor(() => {
      expect(getSourceDocumentUrl).toHaveBeenCalledWith("p-1", "tx-1", "src-2");
    });
  });

  it("shows the retention note when sources exist but no document was retained", () => {
    const txNoDoc = {
      ...TX,
      hasDocument: false,
      sources: [
        {
          id: "src-3",
          sourceType: "csv",
          externalId: null,
          orderRef: null,
          documentId: null,
          taxComponents: null,
          createdAt: "2026-03-15T00:00:00.000Z",
          filename: null,
          hasDocument: false,
        },
      ],
    };
    renderSheet({ tx: txNoDoc });
    expect(screen.getByText(messages.Transactions.sourcesSection.notRetained)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// v2 design: header subtitle "{date} · {portfolio}", desktop centered Dialog
// branch (#587), and type-aware breakdown labels (income vs. trade).
// ---------------------------------------------------------------------------

describe("TransactionDetailSheet — v2 design fidelity", () => {
  afterEach(() => {
    // Restore jsdom's default (matches: false) so later tests aren't affected.
    window.matchMedia = (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    });
  });

  it("shows '{date} · {portfolio}' as the header subtitle", () => {
    renderSheet();
    expect(screen.getByText("Mar 15, 2026 · Main")).toBeInTheDocument();
  });

  it("falls back to just the date when no portfolio name is known", () => {
    renderSheet({ tx: { ...TX, portfolioName: undefined } });
    // The header subtitle (a <p>) is distinct from the Details card's own Date row, which
    // also renders "Mar 15, 2026" — match on the subtitle's own element specifically.
    const subtitle = screen.getByText(
      (content, element) => element?.tagName === "P" && content === "Mar 15, 2026",
    );
    expect(subtitle).toBeInTheDocument();
  });

  it("renders as a centered Dialog on desktop (≥860px) instead of a bottom Sheet", () => {
    window.matchMedia = vi.fn().mockReturnValue({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    renderSheet();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    // The desktop close button has no drag handle — the mobile Sheet's shows one.
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });

  it("labels a dividend's breakdown rows Shares/Per share/Gross/Net income (not Quantity/Price/Amount/Net Amount)", () => {
    const dividend: TxRow = {
      ...TX,
      type: "dividend",
      quantity: "0",
      price: "150000",
      fees: "0",
      tax: "15000",
      shares: "100",
      perShare: "1500",
    };
    renderSheet({ tx: dividend });
    expect(screen.getByText(messages.Transactions.shares)).toBeInTheDocument();
    expect(screen.getByText(messages.Transactions.perShare)).toBeInTheDocument();
    expect(screen.getByText(messages.Transactions.gross)).toBeInTheDocument();
    expect(screen.getByText(messages.Transactions.netIncome)).toBeInTheDocument();
    expect(screen.getByText(messages.Transactions.taxWithheld)).toBeInTheDocument();
    expect(screen.queryByText(messages.Transactions.quantity)).toBeNull();
    expect(screen.queryByText(messages.Transactions.netAmount)).toBeNull();
  });

  it("keeps Quantity/Price · unit/Amount/Net Amount labels for a buy", () => {
    renderSheet();
    expect(screen.getByText(messages.Transactions.quantity)).toBeInTheDocument();
    expect(screen.getByText(messages.Transactions.priceUnit)).toBeInTheDocument();
    expect(screen.getByText(messages.Transactions.amount)).toBeInTheDocument();
    expect(screen.getByText(messages.Transactions.netAmount)).toBeInTheDocument();
  });
});
