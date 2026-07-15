import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { VolatilityCard } from "../src/components/insights/volatility-card";
import type { InsightsVolatility } from "@portfolio/api-client";
import messages from "../messages/en.json";

function renderCard(volatility: InsightsVolatility) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <VolatilityCard volatility={volatility} />
    </NextIntlClientProvider>,
  );
}

describe("VolatilityCard", () => {
  it("renders annualized volatility, Sharpe/Sortino, and an explanatory note", () => {
    renderCard({ annualizedVolatility: "0.371", sharpeRatio: "1.2", sortinoRatio: "1.6" });

    expect(screen.getByText("37.1%")).toBeInTheDocument();
    expect(screen.getByText("Annualized volatility")).toBeInTheDocument();
    expect(screen.getByText("1.20")).toBeInTheDocument();
    expect(screen.getByText("1.60")).toBeInTheDocument();
    // Explanatory note (the "Info" box) explaining how the figures are computed.
    expect(screen.getByText(/√252/)).toBeInTheDocument();
  });

  it("renders a dash when there is not enough data for volatility", () => {
    renderCard({ annualizedVolatility: null, sharpeRatio: null, sortinoRatio: null });
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});
