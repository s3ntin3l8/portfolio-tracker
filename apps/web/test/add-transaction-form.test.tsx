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
    createInstrument: vi.fn(async () => INSTRUMENT),
    createTransaction: vi.fn(async () => ({}) as never),
    updateTransaction: vi.fn(async () => ({}) as never),
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
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /BBCA/ })).toBeInTheDocument(),
    );
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
});
