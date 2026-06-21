import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";

// Stub the recharts-backed chart; the panel's own math (via @portfolio/core)
// runs for real in-process — no network, no mock needed.
vi.mock("@/components/charts/forecast-chart", () => ({
  ForecastChart: () => <div data-testid="forecast-chart" />,
}));

import { ForecastPanel } from "../src/components/savings/forecast-panel";

function renderPanel(props: Partial<React.ComponentProps<typeof ForecastPanel>> = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ForecastPanel
        currentValue="0"
        monthlyAverage="100"
        seedAnnualReturn="0"
        currency="EUR"
        {...props}
      />
    </NextIntlClientProvider>,
  );
}

afterEach(() => vi.useRealTimers());

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

  it("offers a 'To age 18' preset that sets the horizon from the birth year", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T00:00:00.000Z"));
    // Born 2017 → age 9 in 2026 → 9 years to 18 → 100 * 108 = 10,800.
    renderPanel({ birthYear: 2017, portfolioType: "child" });
    fireEvent.click(screen.getByRole("button", { name: "To age 18" }));
    expect(screen.getByTestId("projected-value")).toHaveTextContent("€10,800");
  });

  it("accepts a horizon beyond 25 years (up to 50)", () => {
    renderPanel();
    fireEvent.change(screen.getByLabelText(/Horizon/), { target: { value: "40" } });
    // 100/mo × 480 months = 48,000 (0% return).
    expect(screen.getByTestId("projected-value")).toHaveTextContent("€48,000");
  });

  it("hides the 'To age 18' preset when no birth year is known", () => {
    renderPanel({ portfolioType: "child" });
    expect(screen.queryByRole("button", { name: "To age 18" })).not.toBeInTheDocument();
  });

  it("hides the 'To age 18' preset for non-child portfolios even with a birth year", () => {
    renderPanel({ birthYear: 2017, portfolioType: "standard" });
    expect(screen.queryByRole("button", { name: "To age 18" })).not.toBeInTheDocument();
  });

  it("accounts for historical contributions and growth in the metrics and subtitles", () => {
    // Starting value: €10,000, of which €8,000 is net contributed (so €2,000 is historical growth).
    // Future projection: 10 years at €100/mo, 0% return.
    // Projected future contribution: 120 * €100 = €12,000.
    // Projected future growth: 0.
    // Total contributed: €8,000 (historical) + €12,000 (future) = €20,000.
    // Total growth: (€10,000 + €12,000) - €20,000 = €2,000 (which is exactly historical growth + 0 future growth).
    // Total projected value: €22,000.
    renderPanel({
      currentValue: "10000",
      netContributed: "8000",
    });

    expect(screen.getByTestId("projected-value")).toHaveTextContent("€22,000");
    expect(screen.getByTestId("projected-contributed")).toHaveTextContent("€20,000");
    expect(screen.getByTestId("projected-growth")).toHaveTextContent("€2,000");

    expect(screen.getByText("incl. €8,000.00 contributed so far")).toBeInTheDocument();
    expect(screen.getByText("incl. €2,000.00 growth so far")).toBeInTheDocument();
  });
});
