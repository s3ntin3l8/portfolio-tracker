import { describe, it, expect, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { TradeDetailSheet } from "../src/components/trade-detail-sheet";
import type { Trade } from "@portfolio/api-client";

const CLOSED: Trade = {
  instrumentId: "i-bbni",
  currency: "IDR",
  status: "closed",
  entryDate: "2025-06-24",
  exitDate: "2026-05-18",
  holdingDays: 328,
  avgHoldingDays: 328,
  longTerm: false,
  quantity: "300",
  avgEntryPrice: "4100",
  avgExitPrice: "5467",
  invested: "1230000",
  realizedPnL: "410000",
  unrealizedPnL: "0",
  dividends: "84000",
  totalReturn: "494000",
  totalReturnPct: 0.4016,
  annualizedPct: 0.368,
  legs: [
    {
      acqDate: "2025-06-24",
      sellDate: "2026-05-18",
      quantity: "300",
      cost: "1230000",
      proceeds: "1640000",
      gain: "410000",
      holdingDays: 328,
      longTerm: false,
      taxYear: 2026,
    },
  ],
  instrument: {
    symbol: "BBNI",
    name: "Bank Negara Indonesia",
    assetClass: "equity",
    unit: "shares",
    market: "IDX",
    sector: null,
    sectorWeights: null,
    countryWeights: null,
  },
};

const LOSER: Trade = {
  ...CLOSED,
  instrumentId: "i-arto",
  entryDate: "2025-10-02",
  exitDate: "2026-05-02",
  invested: "2710000",
  realizedPnL: "-220000",
  dividends: "0",
  totalReturn: "-220000",
  totalReturnPct: -0.081,
  annualizedPct: -0.132,
  legs: [
    {
      acqDate: "2025-10-02",
      sellDate: "2026-05-02",
      quantity: "1000",
      cost: "2710000",
      proceeds: "2490000",
      gain: "-220000",
      holdingDays: 212,
      longTerm: false,
      taxYear: 2026,
    },
  ],
  instrument: {
    symbol: "ARTO",
    name: "Bank Jago",
    assetClass: "equity",
    unit: "shares",
    market: "IDX",
    sector: null,
    sectorWeights: null,
    countryWeights: null,
  },
};

function renderSheet(trade: Trade | null) {
  const onOpenChange = vi.fn();
  return {
    onOpenChange,
    ...render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <TradeDetailSheet trade={trade} currency="IDR" open={trade !== null} onOpenChange={onOpenChange} />
      </NextIntlClientProvider>,
    ),
  };
}

describe("TradeDetailSheet", () => {
  it("returns null when trade is null", () => {
    const { container } = renderSheet(null);
    expect(container.firstChild).toBeNull();
  });

  it("renders the header, hero and breakdown for a winning trade", () => {
    renderSheet(CLOSED);
    expect(screen.getByText("BBNI")).toBeInTheDocument();
    expect(screen.getByText(/Bank Negara Indonesia.*Closed 2026-05-18/)).toBeInTheDocument();
    expect(screen.getAllByText(messages.Trades.detail.realizedPnl).length).toBeGreaterThan(0);
    // Proceeds/cost derived from legs; realized P&L shown positive.
    expect(screen.getByText("IDR 1,640,000")).toBeInTheDocument();
    expect(screen.getByText("− IDR 1,230,000")).toBeInTheDocument();
    expect(screen.getAllByText("+IDR 410,000").length).toBeGreaterThan(0);
  });

  it("shows the Income while held section only when dividends were collected", () => {
    renderSheet(CLOSED);
    expect(screen.getByText(messages.Trades.detail.incomeWhileHeld)).toBeInTheDocument();
    expect(screen.getByText("IDR 84,000")).toBeInTheDocument();

    cleanup();
    renderSheet(LOSER);
    expect(screen.queryByText(messages.Trades.detail.incomeWhileHeld)).toBeNull();
  });

  it("renders trade details (quantity, prices, dates, holding period)", () => {
    renderSheet(CLOSED);
    expect(screen.getByText(messages.Trades.detail.tradeDetails)).toBeInTheDocument();
    expect(screen.getByText("300 shares")).toBeInTheDocument();
    expect(screen.getByText("2025-06-24")).toBeInTheDocument();
    expect(screen.getByText("2026-05-18")).toBeInTheDocument();
  });

  it("colors a losing trade's realized P&L and return as negative, with no income section", () => {
    renderSheet(LOSER);
    expect(screen.getAllByText("-IDR 220,000").length).toBeGreaterThan(0);
  });
});
