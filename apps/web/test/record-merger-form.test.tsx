import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { RecordMergerForm, type RecordMergerClient } from "../src/components/record-merger-form";
import type { Instrument } from "@portfolio/api-client";
import messages from "../messages/en.json";

const m = messages.Merger;

function inst(id: string, symbol: string): Instrument {
  return {
    id,
    isin: null,
    wkn: null,
    symbol,
    market: "XETRA",
    assetClass: "etf",
    unit: "shares",
    currency: "EUR",
    name: symbol,
  };
}
const OLD = inst("i-old", "OLDF");
const NEW = inst("i-new", "NEWF");

function makeClient(over: Partial<RecordMergerClient> = {}): RecordMergerClient {
  return {
    searchInstruments: vi.fn(async (q?: string) => (q?.includes("new") ? [NEW] : [OLD])),
    createMerger: vi.fn(async () => [] as never),
    ...over,
  };
}

function renderForm(client: RecordMergerClient, onSuccess = vi.fn()) {
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <RecordMergerForm client={client} portfolioId="p1" onSuccess={onSuccess} />
    </NextIntlClientProvider>,
  );
  return onSuccess;
}

async function pick(labelText: string, query: string, symbol: RegExp) {
  fireEvent.change(screen.getByLabelText(labelText), { target: { value: query } });
  await waitFor(() => expect(screen.getByRole("button", { name: symbol })).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: symbol }));
}

describe("RecordMergerForm", () => {
  it("records a tax-neutral merger between two selected instruments", async () => {
    const client = makeClient();
    const onSuccess = renderForm(client);

    await pick(m.from, "old", /OLDF/);
    await pick(m.to, "new", /NEWF/);
    fireEvent.change(screen.getByLabelText(m.outQty), { target: { value: "48.1464" } });
    fireEvent.change(screen.getByLabelText(m.inQty), { target: { value: "360.218" } });
    fireEvent.change(screen.getByLabelText(m.date), { target: { value: "2024-01-23" } });
    fireEvent.click(screen.getByRole("button", { name: m.submit }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(client.createMerger).toHaveBeenCalledWith(
      "p1",
      expect.objectContaining({
        fromInstrumentId: "i-old",
        toInstrumentId: "i-new",
        outQty: "48.1464",
        inQty: "360.218",
        taxable: false,
        marketValue: undefined,
      }),
    );
  });

  it("sends a market value when the taxable toggle is on", async () => {
    const client = makeClient();
    renderForm(client);

    await pick(m.from, "old", /OLDF/);
    await pick(m.to, "new", /NEWF/);
    // German-formatted figures, as typed off a DKB document.
    fireEvent.change(screen.getByLabelText(m.outQty), { target: { value: "48,1464" } });
    fireEvent.change(screen.getByLabelText(m.inQty), { target: { value: "360,218" } });
    fireEvent.change(screen.getByLabelText(m.date), { target: { value: "2024-01-23" } });
    fireEvent.click(screen.getByLabelText(m.taxable));
    fireEvent.change(screen.getByLabelText(m.marketValue), { target: { value: "3.869,77" } });
    fireEvent.click(screen.getByRole("button", { name: m.submit }));

    await waitFor(() =>
      expect(client.createMerger).toHaveBeenCalledWith(
        "p1",
        // Normalised to plain decimal strings before submit.
        expect.objectContaining({ taxable: true, marketValue: "3869.77", outQty: "48.1464", inQty: "360.218" }),
      ),
    );
  });

  it("requires both instruments", async () => {
    const client = makeClient();
    renderForm(client);

    fireEvent.change(screen.getByLabelText(m.outQty), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText(m.inQty), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText(m.date), { target: { value: "2024-01-23" } });
    fireEvent.click(screen.getByRole("button", { name: m.submit }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(m.needInstruments));
    expect(client.createMerger).not.toHaveBeenCalled();
  });
});
