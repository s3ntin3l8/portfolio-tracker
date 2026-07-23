import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import {
  AddTransactionForm,
  type AddTransactionClient,
} from "../src/components/add-transaction-form";
import type { Instrument, SourceSummary } from "@portfolio/api-client";
import messages from "../messages/en.json";

const getSourceDocumentUrl = vi.fn(async () => ({
  url: "https://storage.example/settlement.pdf?sig=test",
  filename: "settlement.pdf",
  mimeType: "application/pdf",
}));

vi.mock("@/lib/api", () => ({
  useApiClient: () => ({ getSourceDocumentUrl }),
}));

const m = messages.Manage.tx;

const INSTRUMENT: Instrument = {
  id: "i1",
  isin: null,
  wkn: null,
  symbol: "BBCA",
  market: "IDX",
  assetClass: "equity",
  unit: "shares",
  currency: "IDR",
  name: "Bank Central Asia",
};

function makeClient(over: Partial<AddTransactionClient> = {}): AddTransactionClient {
  return {
    searchInstruments: vi.fn(async () => []),
    lookupInstruments: vi.fn(async () => []),
    createInstrument: vi.fn(async () => INSTRUMENT),
    createTransaction: vi.fn(async () => ({}) as never),
    updateTransaction: vi.fn(async () => ({}) as never),
    getGoldSources: vi.fn(async () => [{ market: "ANTAM", label: "Antam buyback" }]),
    ...over,
  };
}

function renderForm(client: AddTransactionClient, onSuccess = vi.fn()) {
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <AddTransactionForm client={client} portfolioId="p1" onSuccess={onSuccess} />
    </NextIntlClientProvider>,
  );
  return onSuccess;
}

const EDIT_INITIAL = {
  type: "buy",
  instrumentId: "i1",
  instrument: {
    symbol: "BBCA",
    name: "Bank Central Asia",
    assetClass: "equity",
    unit: "shares",
  },
  quantity: "100",
  price: "9500",
  fees: "0",
  currency: "IDR",
  executedAt: "2026-02-03T00:00:00.000Z",
};

// ---------------------------------------------------------------------------
// UX helpers for the v2 bucket-switcher form: pick a bucket (Trade/Income/
// Transfer/Cash), then (if not the bucket's default) the sub-type chip; open
// the "Can't find it? Add a custom instrument" / "Add fees / tax" / "Advanced"
// collapsibles on demand.
// ---------------------------------------------------------------------------

function selectBucket(label: string) {
  fireEvent.click(screen.getByRole("button", { name: label }));
}

function selectSubType(label: string) {
  fireEvent.click(screen.getByRole("button", { name: label }));
}

function openCustomInstrument() {
  fireEvent.click(screen.getByRole("button", { name: m.customInstrumentToggle }));
}

function openExtras() {
  const btn =
    screen.queryByRole("button", { name: m.extrasFeesTax }) ??
    screen.getByRole("button", { name: m.extrasFees });
  fireEvent.click(btn);
}

function openAdvanced() {
  fireEvent.click(screen.getByRole("button", { name: m.advanced }));
}

describe("AddTransactionForm", () => {
  it("creates a new instrument and records a buy", async () => {
    const client = makeClient();
    const onSuccess = renderForm(client);

    // Trade/Buy is the default bucket+type — just reveal the custom-instrument fields.
    openCustomInstrument();
    fireEvent.change(screen.getByLabelText(m.symbol), {
      target: { value: "bbca" },
    });
    fireEvent.change(screen.getByLabelText(m.name), {
      target: { value: "Bank Central Asia" },
    });
    fireEvent.change(screen.getByLabelText(m.quantity), {
      target: { value: "100" },
    });
    fireEvent.change(screen.getByLabelText(m.price), {
      target: { value: "9500" },
    });
    fireEvent.change(screen.getByLabelText(m.date, { selector: "input" }), {
      target: { value: "2026-02-03" },
    });
    fireEvent.click(screen.getByRole("button", { name: m.submit }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(client.createInstrument).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: "BBCA", // upper-cased
        market: "IDX",
        assetClass: "equity",
        unit: "shares",
        currency: "IDR",
        name: "Bank Central Asia",
      }),
    );
    expect(client.createTransaction).toHaveBeenCalledWith(
      "p1",
      expect.objectContaining({
        type: "buy",
        instrumentId: "i1",
        quantity: "100",
        price: "9500",
        source: "manual",
      }),
    );
  });

  it("records a gold buy via the dedicated gold flow (source + label, no symbol)", async () => {
    const gold: Instrument = {
      ...INSTRUMENT,
      id: "g1",
      symbol: "ANTAM-5G-BAR",
      market: "ANTAM",
      assetClass: "gold",
      unit: "grams",
      name: "Antam 5g bar",
    };
    const client = makeClient({ createInstrument: vi.fn(async () => gold) });
    renderForm(client);

    openCustomInstrument();
    fireEvent.change(screen.getByLabelText(m.kind), { target: { value: "gold" } });

    // The symbol/search fields are replaced by the gold source + label.
    expect(screen.queryByLabelText(m.symbol)).toBeNull();
    await screen.findByRole("option", { name: "Antam buyback" });

    fireEvent.change(screen.getByLabelText(m.goldLabel), {
      target: { value: "Antam 5g bar" },
    });
    fireEvent.change(screen.getByLabelText(m.grams), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText(m.pricePerGram), {
      target: { value: "1150000" },
    });
    fireEvent.change(screen.getByLabelText(m.date, { selector: "input" }), {
      target: { value: "2026-02-03" },
    });
    fireEvent.click(screen.getByRole("button", { name: m.submit }));

    await waitFor(() => expect(client.createInstrument).toHaveBeenCalled());
    expect(client.createInstrument).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: "ANTAM-5G-BAR", // derived from the label
        market: "ANTAM", // the chosen source's market
        assetClass: "gold",
        unit: "grams",
        name: "Antam 5g bar",
      }),
    );
    expect(client.createTransaction).toHaveBeenCalledWith(
      "p1",
      expect.objectContaining({
        type: "buy",
        instrumentId: "g1",
        quantity: "5", // grams
        price: "1150000",
      }),
    );
  });

  it("defaults the gold symbol to GOLD when no label is given", async () => {
    const client = makeClient();
    renderForm(client);

    openCustomInstrument();
    fireEvent.change(screen.getByLabelText(m.kind), { target: { value: "gold" } });
    await screen.findByRole("option", { name: "Antam buyback" });
    fireEvent.change(screen.getByLabelText(m.grams), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText(m.pricePerGram), {
      target: { value: "1150000" },
    });
    fireEvent.change(screen.getByLabelText(m.date, { selector: "input" }), {
      target: { value: "2026-02-03" },
    });
    fireEvent.click(screen.getByRole("button", { name: m.submit }));

    await waitFor(() => expect(client.createInstrument).toHaveBeenCalled());
    expect(client.createInstrument).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: "GOLD",
        market: "ANTAM",
        assetClass: "gold",
        unit: "grams",
        name: "Antam buyback", // falls back to the source label
      }),
    );
  });

  it("blocks a non-gold instrument submitted without a symbol", async () => {
    const client = makeClient();
    renderForm(client);

    // Equity is the default kind; leave the symbol empty (never even opening the
    // custom-instrument collapsible — the guard doesn't depend on it being open).
    fireEvent.change(screen.getByLabelText(m.quantity), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText(m.price), { target: { value: "100" } });
    fireEvent.change(screen.getByLabelText(m.date, { selector: "input" }), {
      target: { value: "2026-02-03" },
    });
    fireEvent.click(screen.getByRole("button", { name: m.submit }));

    expect(await screen.findByText(m.symbolRequired)).toBeInTheDocument();
    expect(client.createInstrument).not.toHaveBeenCalled();
    expect(client.createTransaction).not.toHaveBeenCalled();
  });

  it("records a cash deposit without an instrument", async () => {
    const client = makeClient();
    renderForm(client);

    selectBucket(messages.Manage.tx.bucketCash);
    // Instrument section is hidden for cash types; Deposit is the Cash bucket's default.
    expect(screen.queryByLabelText(m.symbol)).toBeNull();

    fireEvent.change(screen.getByLabelText(m.amount), {
      target: { value: "5000000" },
    });
    fireEvent.change(screen.getByLabelText(m.date, { selector: "input" }), {
      target: { value: "2026-01-15" },
    });
    fireEvent.click(screen.getByRole("button", { name: m.submit }));

    await waitFor(() => expect(client.createTransaction).toHaveBeenCalled());
    expect(client.createInstrument).not.toHaveBeenCalled();
    expect(client.createTransaction).toHaveBeenCalledWith(
      "p1",
      expect.objectContaining({
        type: "deposit",
        instrumentId: null,
        price: "5000000",
      }),
    );
  });

  it("records a manual adjustment with a negative (signed) amount, hint shown", async () => {
    // 3b remediation: the adjustment's amount IS the signed cash delta the user enters —
    // unlike every other cash type, the sign is not derived from `type`. Confirm the form
    // treats it as a cash type (no instrument) and passes the negative sign straight through.
    const client = makeClient();
    renderForm(client);

    selectBucket(messages.Manage.tx.bucketCash);
    selectSubType(messages.TxType.adjustment);
    expect(screen.queryByLabelText(m.symbol)).toBeNull();
    expect(screen.getByText(m.adjustmentHint)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(m.amount), {
      target: { value: "-26.70" },
    });
    fireEvent.change(screen.getByLabelText(m.date, { selector: "input" }), {
      target: { value: "2026-07-08" },
    });
    fireEvent.click(screen.getByRole("button", { name: m.submit }));

    await waitFor(() => expect(client.createTransaction).toHaveBeenCalled());
    expect(client.createTransaction).toHaveBeenCalledWith(
      "p1",
      expect.objectContaining({
        type: "adjustment",
        instrumentId: null,
        price: "-26.70",
      }),
    );
  });

  it("selects an existing instrument from search results", async () => {
    const client = makeClient({
      searchInstruments: vi.fn(async () => [INSTRUMENT]),
    });
    renderForm(client);

    fireEvent.change(screen.getByLabelText(m.search), {
      target: { value: "bbca" },
    });
    await waitFor(() => expect(screen.getByRole("button", { name: /BBCA/ })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /BBCA/ }));

    fireEvent.change(screen.getByLabelText(m.quantity), {
      target: { value: "50" },
    });
    fireEvent.change(screen.getByLabelText(m.price), {
      target: { value: "9000" },
    });
    fireEvent.change(screen.getByLabelText(m.date, { selector: "input" }), {
      target: { value: "2026-02-03" },
    });
    fireEvent.click(screen.getByRole("button", { name: m.submit }));

    await waitFor(() => expect(client.createTransaction).toHaveBeenCalled());
    expect(client.createInstrument).not.toHaveBeenCalled();
    expect(client.createTransaction).toHaveBeenCalledWith(
      "p1",
      expect.objectContaining({ instrumentId: "i1" }),
    );
  });

  it("auto-fills the new-instrument fields from a market-data match (and opens the custom-instrument fields to show them)", async () => {
    const client = makeClient({
      lookupInstruments: vi.fn(async () => [
        {
          symbol: "AAPL",
          name: "Apple Inc",
          market: "US",
          assetClass: "equity",
          currency: "USD",
          isin: "US0378331005",
          source: "openfigi",
        },
      ]),
    });
    renderForm(client);

    fireEvent.change(screen.getByLabelText(m.search), {
      target: { value: "apple" },
    });
    // Debounced market-data lookup surfaces a discovered match.
    const match = await screen.findByRole("button", { name: /Apple Inc/ });
    fireEvent.click(match);

    // Fields are prefilled (and editable) from the discovery result — the custom-instrument
    // collapsible opens automatically so the prefill is actually visible, a deliberate
    // deviation from the design's own demo state machine (which leaves it closed — see the
    // PR description).
    expect(screen.getByLabelText(m.symbol)).toHaveValue("AAPL");
    expect(screen.getByLabelText(m.name)).toHaveValue("Apple Inc");
    expect(screen.getByLabelText(m.currency)).toHaveValue("USD");

    fireEvent.change(screen.getByLabelText(m.quantity), {
      target: { value: "10" },
    });
    fireEvent.change(screen.getByLabelText(m.price), {
      target: { value: "190" },
    });
    fireEvent.change(screen.getByLabelText(m.date, { selector: "input" }), {
      target: { value: "2026-04-01" },
    });
    fireEvent.click(screen.getByRole("button", { name: m.submit }));

    await waitFor(() => expect(client.createInstrument).toHaveBeenCalled());
    expect(client.createInstrument).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: "AAPL",
        market: "US", // the discovered market, not the IDX default
        assetClass: "equity",
        currency: "USD",
        name: "Apple Inc",
        isin: "US0378331005",
      }),
    );
  });

  it("records a crypto buy, stamping the CRYPTO market and units", async () => {
    const client = makeClient();
    renderForm(client);

    openCustomInstrument();
    fireEvent.change(screen.getByLabelText(m.kind), { target: { value: "crypto" } });
    fireEvent.change(screen.getByLabelText(m.symbol), { target: { value: "btc" } });
    fireEvent.change(screen.getByLabelText(m.name), { target: { value: "Bitcoin" } });
    fireEvent.change(screen.getByLabelText(m.currency), { target: { value: "USD" } });
    fireEvent.change(screen.getByLabelText(m.quantity), { target: { value: "0.5" } });
    fireEvent.change(screen.getByLabelText(m.price), { target: { value: "65000" } });
    fireEvent.change(screen.getByLabelText(m.date, { selector: "input" }), {
      target: { value: "2026-02-03" },
    });
    fireEvent.click(screen.getByRole("button", { name: m.submit }));

    await waitFor(() => expect(client.createInstrument).toHaveBeenCalled());
    expect(client.createInstrument).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: "BTC", // upper-cased
        market: "CRYPTO",
        assetClass: "crypto",
        unit: "units",
        currency: "USD",
        name: "Bitcoin",
      }),
    );
    expect(client.createTransaction).toHaveBeenCalledWith(
      "p1",
      expect.objectContaining({ type: "buy", quantity: "0.5", price: "65000" }),
    );
  });

  it("records a bond coupon against a new instrument (no quantity/fees)", async () => {
    const client = makeClient();
    renderForm(client);

    selectBucket(messages.Manage.tx.bucketIncome);
    selectSubType(messages.TxType.coupon);
    // Coupon is instrument income, not cash — the instrument section stays.
    openCustomInstrument();
    fireEvent.change(screen.getByLabelText(m.symbol), {
      target: { value: "sr021" },
    });
    fireEvent.change(screen.getByLabelText(m.amount), {
      target: { value: "37500" },
    });
    fireEvent.change(screen.getByLabelText(m.date, { selector: "input" }), {
      target: { value: "2026-03-01" },
    });
    fireEvent.click(screen.getByRole("button", { name: m.submit }));

    await waitFor(() => expect(client.createTransaction).toHaveBeenCalled());
    expect(client.createTransaction).toHaveBeenCalledWith(
      "p1",
      expect.objectContaining({
        type: "coupon",
        instrumentId: "i1",
        quantity: "0",
        fees: "0",
        price: "37500",
      }),
    );
  });

  it("updates an existing transaction in edit mode", async () => {
    const client = makeClient();
    const onSuccess = vi.fn();
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <AddTransactionForm
          client={client}
          portfolioId="p1"
          transactionId="t9"
          initial={EDIT_INITIAL}
          onSuccess={onSuccess}
        />
      </NextIntlClientProvider>,
    );

    // Prefilled from the row, with the instrument already selected.
    expect(screen.getByDisplayValue("100")).toBeInTheDocument();
    expect(screen.getByText("BBCA")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(m.quantity), {
      target: { value: "120" },
    });
    fireEvent.click(screen.getByRole("button", { name: m.save }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(client.createTransaction).not.toHaveBeenCalled();
    expect(client.createInstrument).not.toHaveBeenCalled();
    expect(client.updateTransaction).toHaveBeenCalledWith(
      "p1",
      "t9",
      expect.objectContaining({ instrumentId: "i1", quantity: "120" }),
    );
  });

  it("sends tax and notes/tags in the payload for a sell (a buy never withholds tax — v2 design)", async () => {
    const client = makeClient();
    renderForm(client);

    selectSubType(messages.TxType.sell);
    openCustomInstrument();
    fireEvent.change(screen.getByLabelText(m.symbol), { target: { value: "BBCA" } });
    fireEvent.change(screen.getByLabelText(m.name), { target: { value: "BCA" } });
    fireEvent.change(screen.getByLabelText(m.quantity), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText(m.price), { target: { value: "9500" } });
    fireEvent.change(screen.getByLabelText(m.date, { selector: "input" }), {
      target: { value: "2026-03-01" },
    });
    openExtras();
    fireEvent.change(screen.getByLabelText(m.tax), { target: { value: "50" } });
    fireEvent.change(screen.getByLabelText(m.notes), { target: { value: "rebalance run" } });
    fireEvent.change(screen.getByLabelText(m.tags), { target: { value: "rebalance, idt" } });
    fireEvent.click(screen.getByRole("button", { name: m.submit }));

    await waitFor(() => expect(client.createTransaction).toHaveBeenCalled());
    expect(client.createTransaction).toHaveBeenCalledWith(
      "p1",
      expect.objectContaining({
        tax: "50",
        description: "rebalance run",
        tags: ["rebalance", "idt"],
      }),
    );
  });

  it("omits tax for a cash deposit", async () => {
    const client = makeClient();
    renderForm(client);

    selectBucket(messages.Manage.tx.bucketCash);
    // Tax field should not appear (deposit is a cash type, not a sale or income).
    expect(screen.queryByLabelText(m.tax)).toBeNull();

    fireEvent.change(screen.getByLabelText(m.amount), { target: { value: "1000000" } });
    fireEvent.change(screen.getByLabelText(m.date, { selector: "input" }), {
      target: { value: "2026-03-01" },
    });
    fireEvent.click(screen.getByRole("button", { name: m.submit }));

    await waitFor(() => expect(client.createTransaction).toHaveBeenCalled());
    expect(client.createTransaction).toHaveBeenCalledWith(
      "p1",
      expect.objectContaining({ tax: null }),
    );
  });

  // ---------------------------------------------------------------------------
  // New type coverage (the expanded type list)
  // ---------------------------------------------------------------------------

  it("savings_plan shows quantity and price, fees behind the collapsible, no tax (only sell/income withhold tax)", () => {
    const client = makeClient();
    renderForm(client);

    selectSubType(messages.TxType.savings_plan);
    expect(screen.getByLabelText(m.quantity)).toBeInTheDocument();
    expect(screen.getByLabelText(m.price)).toBeInTheDocument();
    expect(screen.queryByLabelText(m.fees)).toBeNull();
    // Buy/savings_plan never withholds tax — the collapsible's own label reflects that
    // ("Add fees", not "Add fees / tax").
    expect(screen.getByRole("button", { name: m.extrasFees })).toBeInTheDocument();
    openExtras();
    expect(screen.getByLabelText(m.fees)).toBeInTheDocument();
    expect(screen.queryByLabelText(m.tax)).toBeNull();
  });

  it("an existing legacy 'bonus' transaction (no longer creatable — see Instrument events) still renders correctly in edit mode", () => {
    const client = makeClient();
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <AddTransactionForm
          client={client}
          portfolioId="p1"
          transactionId="t-legacy-bonus"
          initial={{ ...EDIT_INITIAL, type: "bonus" }}
          onSuccess={vi.fn()}
        />
      </NextIntlClientProvider>,
    );

    // No bucket is active for a type the switcher no longer offers — but the amount
    // fields (quantity/price, no fees/tax) still render correctly for editing.
    for (const label of [
      messages.Manage.tx.bucketTrade,
      messages.Manage.tx.bucketIncome,
      messages.Manage.tx.bucketTransfer,
      messages.Manage.tx.bucketCash,
    ]) {
      expect(screen.getByRole("button", { name: label })).toHaveAttribute("aria-pressed", "false");
    }
    expect(screen.getByLabelText(m.quantity)).toBeInTheDocument();
    expect(screen.getByLabelText(m.price)).toBeInTheDocument();
    expect(screen.queryByLabelText(m.fees)).toBeNull();
    expect(screen.queryByRole("button", { name: m.extrasFees })).toBeNull();
    expect(screen.queryByRole("button", { name: m.extrasFeesTax })).toBeNull();
  });

  it("dividend shows instrument and inline tax but no quantity or fees (income)", () => {
    const client = makeClient();
    renderForm(client);

    selectBucket(messages.Manage.tx.bucketIncome);
    // Instrument section present (income, not cash).
    expect(screen.getByLabelText(m.search)).toBeInTheDocument();
    // No quantity or fees.
    expect(screen.queryByLabelText(m.quantity)).toBeNull();
    expect(screen.queryByLabelText(m.fees)).toBeNull();
    // Tax is inline for income — no collapsible needed.
    expect(screen.getByLabelText(m.tax)).toBeInTheDocument();
  });

  it("interest hides the instrument section (cash type)", () => {
    const client = makeClient();
    renderForm(client);

    selectBucket(messages.Manage.tx.bucketCash);
    selectSubType(messages.TxType.interest);
    expect(screen.queryByLabelText(m.symbol)).toBeNull();
    expect(screen.queryByLabelText(m.search)).toBeNull();
    expect(screen.queryByLabelText(m.quantity)).toBeNull();
  });

  it("bonus_cash hides the instrument section (cash type)", () => {
    const client = makeClient();
    renderForm(client);

    selectBucket(messages.Manage.tx.bucketCash);
    selectSubType(messages.TxType.bonus_cash);
    expect(screen.queryByLabelText(m.search)).toBeNull();
    expect(screen.queryByLabelText(m.quantity)).toBeNull();
  });

  it("edit mode preserves import provenance (source + externalId) on submit", async () => {
    const client = makeClient();
    const onSuccess = vi.fn();
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <AddTransactionForm
          client={client}
          portfolioId="p1"
          transactionId="t-import"
          initial={{
            ...EDIT_INITIAL,
            source: "pytr",
            externalId: "tr:exec:abc-123",
          }}
          onSuccess={onSuccess}
        />
      </NextIntlClientProvider>,
    );

    // Change only the notes field — provenance must survive.
    fireEvent.change(screen.getByLabelText(m.notes), { target: { value: "corrected note" } });
    fireEvent.click(screen.getByRole("button", { name: m.save }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(client.updateTransaction).toHaveBeenCalledWith(
      "p1",
      "t-import",
      expect.objectContaining({
        source: "pytr",
        externalId: "tr:exec:abc-123",
        description: "corrected note",
      }),
    );
  });

  it("sets kind in the payload when a sub-type is chosen (Advanced collapsible)", async () => {
    const client = makeClient();
    renderForm(client);

    selectSubType(messages.TxType.savings_plan);
    openCustomInstrument();
    fireEvent.change(screen.getByLabelText(m.symbol), { target: { value: "MSFT" } });
    fireEvent.change(screen.getByLabelText(m.name), { target: { value: "Microsoft" } });
    fireEvent.change(screen.getByLabelText(m.quantity), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText(m.price), { target: { value: "400" } });
    fireEvent.change(screen.getByLabelText(m.date, { selector: "input" }), {
      target: { value: "2026-05-01" },
    });
    openAdvanced();
    fireEvent.change(screen.getByLabelText(m.subType), { target: { value: "saveback" } });
    fireEvent.click(screen.getByRole("button", { name: m.submit }));

    await waitFor(() => expect(client.createTransaction).toHaveBeenCalled());
    expect(client.createTransaction).toHaveBeenCalledWith(
      "p1",
      expect.objectContaining({ kind: "saveback", type: "savings_plan" }),
    );
  });

  it("prefills tax, fxRate, description, tags from initial (edit round-trip guard)", async () => {
    const client = makeClient();
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <AddTransactionForm
          client={client}
          portfolioId="p1"
          transactionId="t9"
          initial={{
            ...EDIT_INITIAL,
            // A buy never withholds tax (v2 design) — use sell to round-trip a nonzero tax.
            type: "sell",
            tax: "25",
            fxRate: "15500",
            description: "import note",
            tags: ["tax-loss", "idx"],
          }}
          onSuccess={vi.fn()}
        />
      </NextIntlClientProvider>,
    );

    // A nonzero stored tax auto-opens the fees/tax collapsible in edit mode (so editing
    // never silently hides already-filled data behind a click).
    expect(screen.getByLabelText(m.tax)).toHaveValue("25");
    expect(screen.getByLabelText(m.notes)).toHaveValue("import note");
    expect(screen.getByLabelText(m.tags)).toHaveValue("tax-loss, idx");
  });

  it("preserves a legacy buy's existing nonzero tax on an unrelated edit, even though the field is hidden (review regression)", async () => {
    // A buy never shows a tax field (only sell/income withhold tax — v2 design), but a
    // transaction from before this change (or written directly via the API/an import) can
    // still carry one. Editing it — e.g. just fixing the quantity — must not silently wipe
    // that stored tax value out from under the user just because the field isn't rendered.
    const client = makeClient();
    const onSuccess = vi.fn();
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <AddTransactionForm
          client={client}
          portfolioId="p1"
          transactionId="t-legacy-tax"
          initial={{ ...EDIT_INITIAL, type: "buy", tax: "50" }}
          onSuccess={onSuccess}
        />
      </NextIntlClientProvider>,
    );

    // The tax field is genuinely absent for a buy — this isn't a hidden-but-present input.
    expect(screen.queryByLabelText(m.tax)).toBeNull();

    fireEvent.change(screen.getByLabelText(m.quantity), { target: { value: "150" } });
    fireEvent.click(screen.getByRole("button", { name: m.save }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(client.updateTransaction).toHaveBeenCalledWith(
      "p1",
      "t-legacy-tax",
      expect.objectContaining({ quantity: "150", tax: "50" }),
    );
  });
});

// ---------------------------------------------------------------------------
// TransactionSourcesSection + enrich hint (edit mode, #230)
// ---------------------------------------------------------------------------

const ms = messages.Transactions.sourcesSection;

const SOURCE_WITH_DOC: SourceSummary = {
  id: "src-pdf-1",
  sourceType: "pdf",
  externalId: "tr:exec:abc-123",
  orderRef: "tr:ord:xyz-456",
  documentId: "doc-1",
  taxComponents: { kapitalertragsteuer: "3.75", solidaritaetszuschlag: "0.21" },
  createdAt: "2026-03-01T12:00:00Z",
  filename: "settlement.pdf",
  hasDocument: true,
};

const SOURCE_NO_DOC: SourceSummary = {
  id: "src-pytr-1",
  sourceType: "pytr",
  externalId: "tr:exec:def-789",
  orderRef: null,
  documentId: null,
  taxComponents: null,
  createdAt: "2026-03-01T10:00:00Z",
  filename: null,
  hasDocument: false,
};

function renderEditForm(sources: SourceSummary[], hasFullTaxDetail: boolean) {
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <AddTransactionForm
        client={makeClient()}
        portfolioId="p1"
        transactionId="tx-edit-1"
        initial={{ ...EDIT_INITIAL, sources, hasFullTaxDetail }}
        onSuccess={vi.fn()}
      />
    </NextIntlClientProvider>,
  );
}

describe("TransactionSourcesSection (edit mode, #230)", () => {
  it("shows source type, imported date + filename (not the raw fingerprint) and tax components", () => {
    renderEditForm([SOURCE_WITH_DOC], true);

    expect(screen.getByText(ms.title)).toBeInTheDocument();
    // Clean localized source-type label (not the raw "pdf")
    expect(screen.getByText(messages.Transactions.sources.pdf)).toBeInTheDocument();
    // Imported date + filename replaces the internal externalId fingerprint
    expect(screen.getByText(/Imported.*settlement\.pdf/)).toBeInTheDocument();
    expect(screen.queryByText("tr:exec:abc-123")).toBeNull();
    // Tax breakdown: KapSt and SolZ labels
    expect(screen.getByText(/KapSt.*3\.75/)).toBeInTheDocument();
    expect(screen.getByText(/SolZ.*0\.21/)).toBeInTheDocument();
  });

  it("shows the download button when a document is available and calls getSourceDocumentUrl on click", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    renderEditForm([SOURCE_WITH_DOC], true);

    const btn = screen.getByRole("button", { name: ms.download });
    expect(btn).toBeInTheDocument();
    fireEvent.click(btn);

    await waitFor(() =>
      expect(getSourceDocumentUrl).toHaveBeenCalledWith("p1", "tx-edit-1", "src-pdf-1"),
    );
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith(
        expect.stringContaining("settlement.pdf"),
        "_blank",
        "noopener,noreferrer",
      ),
    );
    open.mockRestore();
  });

  it("shows no download button when no document is available for the source", () => {
    renderEditForm([SOURCE_NO_DOC], false);
    expect(screen.queryByRole("button", { name: ms.download })).toBeNull();
  });

  it("shows fullDetailBadge when hasFullTaxDetail", () => {
    renderEditForm([SOURCE_WITH_DOC], true);
    expect(screen.getByText(ms.fullDetailBadge)).toBeInTheDocument();
  });

  it("hides fullDetailBadge and shows enrichHint when !hasFullTaxDetail", () => {
    renderEditForm([SOURCE_NO_DOC], false);
    expect(screen.queryByText(ms.fullDetailBadge)).toBeNull();
    expect(screen.getByText(messages.Manage.tx.enrichHint)).toBeInTheDocument();
  });

  it("shows neither sources section nor enrich hint in create mode (no transactionId)", () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <AddTransactionForm client={makeClient()} portfolioId="p1" onSuccess={vi.fn()} />
      </NextIntlClientProvider>,
    );
    expect(screen.queryByText(ms.title)).toBeNull();
    expect(screen.queryByText(messages.Manage.tx.enrichHint)).toBeNull();
  });

  // Regression tests for #472: the submit button was buried at the bottom of a long
  // scrolling form with no way to pin it above the fold.
  it("wraps the submit button in a sticky footer when stickyFooter is set", () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <AddTransactionForm
          client={makeClient()}
          portfolioId="p1"
          onSuccess={vi.fn()}
          stickyFooter
        />
      </NextIntlClientProvider>,
    );
    const submit = screen.getByRole("button", { name: m.submit });
    expect(submit.closest(".sticky")).not.toBeNull();
  });

  it("does not wrap the submit button in a sticky footer by default", () => {
    renderForm(makeClient());
    const submit = screen.getByRole("button", { name: m.submit });
    expect(submit.closest(".sticky")).toBeNull();
  });
});
