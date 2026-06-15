import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";

// Stub the recharts-backed chart; the panel's own math (via @portfolio/core)
// runs for real in-process — no network, no mock needed.
vi.mock("@/components/charts/forecast-chart", () => ({
  ForecastChart: () => <div data-testid="forecast-chart" />,
}));

import { ForecastPanel } from "../src/components/savings/forecast-panel";

function renderPanel() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ForecastPanel
        currentValue="0"
        monthlyAverage="100"
        seedAnnualReturn="0"
        currency="EUR"
      />
    </NextIntlClientProvider>,
  );
}

describe("ForecastPanel", () => {
  it("seeds the projection from the contribution defaults", () => {
    renderPanel();
    // 0 start, 100/mo, 0% return, 10y horizon → 100 * 120 = 12,000.
    expect(screen.getByTestId("projected-value")).toHaveTextContent("€12,000");
  });

  it("recomputes instantly when the monthly amount changes", () => {
    renderPanel();
    fireEvent.change(screen.getByLabelText("Monthly amount"), {
      target: { value: "200" },
    });
    // 200 * 120 = 24,000.
    expect(screen.getByTestId("projected-value")).toHaveTextContent("€24,000");
  });

  it("recomputes when the horizon changes", () => {
    renderPanel();
    fireEvent.change(screen.getByLabelText(/Horizon/), { target: { value: "5" } });
    // 100 * 60 = 6,000.
    expect(screen.getByTestId("projected-value")).toHaveTextContent("€6,000");
  });
});
