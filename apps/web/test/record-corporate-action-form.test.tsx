import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import {
  RecordCorporateActionForm,
  type RecordCorpActionClient,
} from "../src/components/record-corporate-action-form";
import type { Instrument } from "@portfolio/api-client";
import messages from "../messages/en.json";

const m = messages.CorpAction;

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

function makeClient(over: Partial<RecordCorpActionClient> = {}): RecordCorpActionClient {
  return {
    searchInstruments: vi.fn(async () => [INSTRUMENT]),
    lookupInstruments: vi.fn(async () => []),
    createCorporateAction: vi.fn(async () => ({}) as never),
    ...over,
  };
}

function renderForm(client: RecordCorpActionClient, onSuccess = vi.fn(), isAdmin?: boolean) {
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <RecordCorporateActionForm client={client} onSuccess={onSuccess} isAdmin={isAdmin} />
    </NextIntlClientProvider>,
  );
  return onSuccess;
}

describe("RecordCorporateActionForm", () => {
  it("records a split against a selected instrument", async () => {
    const client = makeClient();
    const onSuccess = renderForm(client, vi.fn(), true);

    fireEvent.change(screen.getByLabelText(m.search), {
      target: { value: "bbca" },
    });
    await waitFor(() => expect(screen.getByRole("button", { name: /BBCA/ })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /BBCA/ }));

    fireEvent.change(screen.getByLabelText(m.ratio), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText(m.exDate, { selector: "input" }), {
      target: { value: "2026-02-01" },
    });
    fireEvent.click(screen.getByRole("button", { name: m.submit }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(client.createCorporateAction).toHaveBeenCalledWith(
      expect.objectContaining({ instrumentId: "i1", type: "split", ratio: "2" }),
    );
  });

  it("requires an instrument", async () => {
    const client = makeClient();
    renderForm(client, vi.fn(), true);

    fireEvent.change(screen.getByLabelText(m.ratio), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText(m.exDate, { selector: "input" }), {
      target: { value: "2026-02-01" },
    });
    fireEvent.click(screen.getByRole("button", { name: m.submit }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(m.needInstrument));
    expect(client.createCorporateAction).not.toHaveBeenCalled();
  });

  // Regression test for #472: same buried-submit-button fix as AddTransactionForm,
  // shared by all three tabs in the manual-add sheet.
  it("wraps the submit button in a sticky footer when stickyFooter is set", () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <RecordCorporateActionForm client={makeClient()} onSuccess={vi.fn()} stickyFooter isAdmin />
      </NextIntlClientProvider>,
    );
    expect(screen.getByRole("button", { name: m.submit }).closest(".sticky")).not.toBeNull();
  });
});
