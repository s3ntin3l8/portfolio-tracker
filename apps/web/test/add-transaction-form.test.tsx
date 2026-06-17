import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import {
  AddTransactionForm,
  type AddTransactionClient,
} from "../src/components/add-transaction-form";
import type { Instrument } from "@portfolio/api-client";
import messages from "../messages/en.json";

const m = messages.Manage.tx;

const INSTRUMENT: Instrument = {
  id: "i1",
  isin: null,
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

describe("AddTransactionForm", () => {
  it("creates a new instrument and records a buy", async () => {
    const client = makeClient();
    const onSuccess = renderForm(client);

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
    fireEvent.change(screen.getByLabelText(m.date), {
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

    fireEvent.change(screen.getByLabelText(m.kind), { target: { value: "gold" } });

    // The symbol/search fields are replaced by the gold source + label.
    expect(screen.queryByLabelText(m.symbol)).toBeNull();
    expect(screen.queryByLabelText(m.search)).toBeNull();
    await screen.findByRole("option", { name: "Antam buyback" });

    fireEvent.change(screen.getByLabelText(m.goldLabel), {
      target: { value: "Antam 5g bar" },
    });
    fireEvent.change(screen.getByLabelText(m.grams), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText(m.pricePerGram), {
      target: { value: "1150000" },
    });
    fireEvent.change(screen.getByLabelText(m.date), {
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

    fireEvent.change(screen.getByLabelText(m.kind), { target: { value: "gold" } });
    await screen.findByRole("option", { name: "Antam buyback" });
    fireEvent.change(screen.getByLabelText(m.grams), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText(m.pricePerGram), {
      target: { value: "1150000" },
    });
    fireEvent.change(screen.getByLabelText(m.date), {
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

    // Equity is the default kind; leave the symbol empty.
    fireEvent.change(screen.getByLabelText(m.quantity), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText(m.price), { target: { value: "100" } });
    fireEvent.change(screen.getByLabelText(m.date), {
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

    fireEvent.change(screen.getByLabelText(m.type), {
      target: { value: "deposit" },
    });
    // Instrument section is hidden for cash types.
    expect(screen.queryByLabelText(m.symbol)).toBeNull();

    fireEvent.change(screen.getByLabelText(m.amount), {
      target: { value: "5000000" },
    });
    fireEvent.change(screen.getByLabelText(m.date), {
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
    fireEvent.change(screen.getByLabelText(m.date), {
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

  it("auto-fills the new-instrument fields from a market-data match", async () => {
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

    // Fields are prefilled (and editable) from the discovery result.
    expect(screen.getByLabelText(m.symbol)).toHaveValue("AAPL");
    expect(screen.getByLabelText(m.name)).toHaveValue("Apple Inc");
    expect(screen.getByLabelText(m.currency)).toHaveValue("USD");

    fireEvent.change(screen.getByLabelText(m.quantity), {
      target: { value: "10" },
    });
    fireEvent.change(screen.getByLabelText(m.price), {
      target: { value: "190" },
    });
    fireEvent.change(screen.getByLabelText(m.date), {
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

    fireEvent.change(screen.getByLabelText(m.kind), { target: { value: "crypto" } });
    fireEvent.change(screen.getByLabelText(m.symbol), { target: { value: "btc" } });
    fireEvent.change(screen.getByLabelText(m.name), { target: { value: "Bitcoin" } });
    fireEvent.change(screen.getByLabelText(m.currency), { target: { value: "USD" } });
    fireEvent.change(screen.getByLabelText(m.quantity), { target: { value: "0.5" } });
    fireEvent.change(screen.getByLabelText(m.price), { target: { value: "65000" } });
    fireEvent.change(screen.getByLabelText(m.date), { target: { value: "2026-02-03" } });
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

    fireEvent.change(screen.getByLabelText(m.type), {
      target: { value: "coupon" },
    });
    // Coupon is instrument income, not cash — the instrument section stays.
    fireEvent.change(screen.getByLabelText(m.symbol), {
      target: { value: "sr021" },
    });
    fireEvent.change(screen.getByLabelText(m.amount), {
      target: { value: "37500" },
    });
    fireEvent.change(screen.getByLabelText(m.date), {
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

  it("sends tax and notes/tags in the payload for a buy", async () => {
    const client = makeClient();
    renderForm(client);

    fireEvent.change(screen.getByLabelText(m.symbol), { target: { value: "BBCA" } });
    fireEvent.change(screen.getByLabelText(m.name), { target: { value: "BCA" } });
    fireEvent.change(screen.getByLabelText(m.quantity), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText(m.price), { target: { value: "9500" } });
    fireEvent.change(screen.getByLabelText(m.date), { target: { value: "2026-03-01" } });
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

    fireEvent.change(screen.getByLabelText(m.type), { target: { value: "deposit" } });
    // Tax field should not appear (isTrade is false for deposit).
    expect(screen.queryByLabelText(m.tax)).toBeNull();

    fireEvent.change(screen.getByLabelText(m.amount), { target: { value: "1000000" } });
    fireEvent.change(screen.getByLabelText(m.date), { target: { value: "2026-03-01" } });
    fireEvent.click(screen.getByRole("button", { name: m.submit }));

    await waitFor(() => expect(client.createTransaction).toHaveBeenCalled());
    expect(client.createTransaction).toHaveBeenCalledWith(
      "p1",
      expect.objectContaining({ tax: null }),
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
            tax: "25",
            fxRate: "15500",
            description: "import note",
            tags: ["tax-loss", "idx"],
          }}
          onSuccess={vi.fn()}
        />
      </NextIntlClientProvider>,
    );

    expect(screen.getByLabelText(m.tax)).toHaveValue("25");
    expect(screen.getByLabelText(m.notes)).toHaveValue("import note");
    expect(screen.getByLabelText(m.tags)).toHaveValue("tax-loss, idx");
  });
});
