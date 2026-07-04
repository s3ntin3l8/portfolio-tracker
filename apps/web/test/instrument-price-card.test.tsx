import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import type { Candle } from "@portfolio/api-client";

const getInstrumentHistory = vi.fn();

vi.mock("@/lib/api", () => ({
  useApiClient: () => ({ getInstrumentHistory }),
}));

import { InstrumentPriceCard } from "../src/components/instrument-price-card";
import { InstrumentRangeToggle } from "../src/components/charts/instrument-range-toggle";
import { lastPriceInfo } from "../src/lib/instrument-price";

const HISTORY: Candle[] = [
  { date: "2026-01-01", close: "100", currency: "IDR" },
  { date: "2026-02-01", close: "108", currency: "IDR" },
];

function renderCard(initialRange?: "1m" | "6m" | "1y" | "all") {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <InstrumentPriceCard
        instrumentId="i1"
        initialHistory={HISTORY}
        initialRange={initialRange}
        currency="IDR"
        lastPrice={lastPriceInfo(HISTORY, "IDR")}
      />
    </NextIntlClientProvider>,
  );
}

describe("InstrumentRangeToggle", () => {
  it("renders exactly the 1M/6M/1Y/All chips, marking the active one pressed", () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <InstrumentRangeToggle value="1y" onChange={() => {}} />
      </NextIntlClientProvider>,
    );
    expect(screen.getByRole("button", { name: "1M" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "6M" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "1Y" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "All" })).toBeInTheDocument();
    // No 1D/7D/3M/YTD — this is a distinct, smaller vocabulary from the portfolio ranges.
    expect(screen.queryByRole("button", { name: "1D" })).toBeNull();
  });
});

describe("InstrumentPriceCard", () => {
  beforeEach(() => {
    getInstrumentHistory.mockReset();
  });

  it("defaults to 1Y and shows the initial history without an extra fetch", () => {
    renderCard();
    expect(screen.getByRole("button", { name: "1Y" })).toHaveAttribute("aria-pressed", "true");
    expect(getInstrumentHistory).not.toHaveBeenCalled();
  });

  it("renders the Last price headline with today's change, from the initial candles", () => {
    renderCard();
    expect(screen.getByText(messages.Instrument.lastPriceLabel)).toBeInTheDocument();
    // Last close 108, prior 100 → +8, +8%.
    expect(screen.getByText(/today/)).toBeInTheDocument();
  });

  it("omits the Last price headline when there's no history", () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <InstrumentPriceCard
          instrumentId="i1"
          initialHistory={[]}
          currency="IDR"
          lastPrice={null}
        />
      </NextIntlClientProvider>,
    );
    expect(screen.queryByText(messages.Instrument.lastPriceLabel)).toBeNull();
  });

  it("refetches with the mapped API range token when a chip is clicked", async () => {
    getInstrumentHistory.mockResolvedValue([
      { date: "2020-01-01", close: "1", currency: "IDR" },
    ]);
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "6M" }));
    await waitFor(() => expect(getInstrumentHistory).toHaveBeenCalledWith("i1", "6mo"));
    expect(screen.getByRole("button", { name: "6M" })).toHaveAttribute("aria-pressed", "true");
  });

  it("maps 1M and All to the provider's 1mo/max tokens", async () => {
    getInstrumentHistory.mockResolvedValue([]);
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "1M" }));
    await waitFor(() => expect(getInstrumentHistory).toHaveBeenCalledWith("i1", "1mo"));

    getInstrumentHistory.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    await waitFor(() => expect(getInstrumentHistory).toHaveBeenCalledWith("i1", "max"));
  });

  it("shows the empty state when a range refetch returns no candles", async () => {
    getInstrumentHistory.mockResolvedValue([]);
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "1M" }));
    await waitFor(() => expect(screen.getByText(messages.Instrument.noHistory)).toBeInTheDocument());
  });

  it("does not refetch when clicking the already-active chip", () => {
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "1Y" }));
    expect(getInstrumentHistory).not.toHaveBeenCalled();
  });
});
