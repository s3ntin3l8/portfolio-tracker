import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";

// Mock the api hook so the card doesn't need a session provider.
const { getInstrumentFundamentals } = vi.hoisted(() => ({ getInstrumentFundamentals: vi.fn() }));
vi.mock("../src/lib/api", () => ({ useApiClient: () => ({ getInstrumentFundamentals }) }));

import { InstrumentFundamentalsCard } from "../src/components/instrument-fundamentals-card";

function renderCard(instrumentId = "inst-1") {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <InstrumentFundamentalsCard instrumentId={instrumentId} />
    </NextIntlClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  getInstrumentFundamentals.mockReset();
});

const FULL_EQUITY = {
  currency: "USD",
  asOf: "2026-07-15T00:00:00.000Z",
  marketCap: "4810109091840",
  trailingPE: 38.170162,
  forwardPE: 34.04044,
  trailingEps: "8.58",
  dividendYield: 0.0034,
  dividendRate: "1.08",
  beta: 1.097,
  fiftyTwoWeekLow: "201.5",
  fiftyTwoWeekHigh: "328.73",
  previousClose: "314.86",
  dayLow: "317.32",
  dayHigh: "328.72",
  volume: 60780931,
  averageVolume: 54481611,
  expenseRatio: null,
  targetMeanPrice: "316.75714",
  recommendationKey: "buy",
  numberOfAnalystOpinions: 42,
  analystTrend: { strongBuy: 6, buy: 22, hold: 17, sell: 1, strongSell: 1 },
  earningsDate: "2026-07-30",
  exDividendDate: "2026-05-11",
  financials: [
    { year: 2022, revenue: "394328000000", earnings: "99803000000" },
    { year: 2023, revenue: "383285000000", earnings: "96995000000" },
  ],
  externalUrl: "https://finance.yahoo.com/quote/AAPL",
};

describe("InstrumentFundamentalsCard", () => {
  it("fetches on mount and renders the full stat grid, analyst block, and chart for an equity", async () => {
    getInstrumentFundamentals.mockResolvedValue(FULL_EQUITY);

    renderCard();

    await waitFor(() =>
      expect(screen.getByText(messages.Instrument.fundamentalsTitle)).toBeInTheDocument(),
    );
    expect(getInstrumentFundamentals).toHaveBeenCalledWith("inst-1");

    // Coverage-driven stat grid.
    expect(screen.getByText(messages.Instrument.marketCapLabel)).toBeInTheDocument();
    expect(screen.getByText(messages.Instrument.trailingPeLabel)).toBeInTheDocument();
    expect(screen.getByText(messages.Instrument.dividendYieldLabel)).toBeInTheDocument();

    // Next earnings + ex-dividend highlight.
    expect(screen.getByText(messages.Instrument.nextEarningsLabel)).toBeInTheDocument();
    expect(screen.getByText(messages.Instrument.exDividendLabel)).toBeInTheDocument();

    // Analyst recommendations.
    expect(screen.getByText(messages.Instrument.analystRecommendationsLabel)).toBeInTheDocument();
    expect(screen.getByText(messages.Instrument.recommendation.buy)).toBeInTheDocument();

    // Revenue vs earnings chart section.
    expect(screen.getByText(messages.Instrument.revenueVsEarningsLabel)).toBeInTheDocument();

    // External link.
    const link = screen.getByRole("link", { name: messages.Instrument.viewOnYahoo });
    expect(link).toHaveAttribute("href", "https://finance.yahoo.com/quote/AAPL");
  });

  it("renders earningsDate/exDividendDate as the API's calendar day regardless of local timezone", async () => {
    // earningsDate/exDividendDate are YYYY-MM-DD strings; parsing them with a bare
    // `new Date(str)` reads as UTC midnight, which rolls back to the previous calendar day
    // once formatted in a timezone behind UTC (e.g. US Eastern) — verified this reproduces
    // ("2026-07-30" → "Jul 29, 2026") before the `T00:00:00` local-parse fix.
    const originalTz = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      getInstrumentFundamentals.mockResolvedValue(FULL_EQUITY);
      renderCard();

      await waitFor(() =>
        expect(screen.getByText(messages.Instrument.fundamentalsTitle)).toBeInTheDocument(),
      );

      expect(screen.getByText("Jul 30, 2026")).toBeInTheDocument(); // earningsDate
      expect(screen.getByText(/May 11, 2026/)).toBeInTheDocument(); // exDividendDate
    } finally {
      process.env.TZ = originalTz;
    }
  });

  it("renders only the fields present for a reduced ETF response (no PE/EPS/analyst)", async () => {
    getInstrumentFundamentals.mockResolvedValue({
      currency: "EUR",
      asOf: "2026-07-15T00:00:00.000Z",
      previousClose: "126.06",
      fiftyTwoWeekLow: "100.485",
      fiftyTwoWeekHigh: "126.65",
      expenseRatio: 0.002,
      trailingPE: null,
      forwardPE: null,
      trailingEps: null,
      dividendYield: null,
      dividendRate: null,
      beta: null,
      dayLow: null,
      dayHigh: null,
      volume: null,
      averageVolume: null,
      targetMeanPrice: null,
      recommendationKey: null,
      numberOfAnalystOpinions: null,
      analystTrend: null,
      earningsDate: null,
      exDividendDate: null,
      financials: null,
      externalUrl: "https://finance.yahoo.com/quote/EUNL.DE",
    });

    renderCard();

    await waitFor(() =>
      expect(screen.getByText(messages.Instrument.fundamentalsTitle)).toBeInTheDocument(),
    );

    expect(screen.getByText(messages.Instrument.expenseRatioLabel)).toBeInTheDocument();
    expect(screen.getByText(messages.Instrument.fiftyTwoWeekRangeLabel)).toBeInTheDocument();

    // Fields absent from the response never render.
    expect(screen.queryByText(messages.Instrument.trailingPeLabel)).toBeNull();
    expect(screen.queryByText(messages.Instrument.analystRecommendationsLabel)).toBeNull();
    expect(screen.queryByText(messages.Instrument.revenueVsEarningsLabel)).toBeNull();
    expect(screen.queryByText(messages.Instrument.nextEarningsLabel)).toBeNull();
  });

  it("renders nothing when the fetch resolves empty", async () => {
    getInstrumentFundamentals.mockResolvedValue(null);

    renderCard();

    await waitFor(() => expect(getInstrumentFundamentals).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.queryByText(messages.Instrument.fundamentalsTitle)).toBeNull(),
    );
  });

  it("renders nothing when the fetch rejects", async () => {
    getInstrumentFundamentals.mockRejectedValue(new Error("network down"));

    renderCard();

    await waitFor(() => expect(getInstrumentFundamentals).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.queryByText(messages.Instrument.fundamentalsTitle)).toBeNull(),
    );
  });
});
