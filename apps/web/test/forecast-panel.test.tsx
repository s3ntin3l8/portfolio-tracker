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
    renderPanel({ birthYear: 2017 });
    fireEvent.click(screen.getByRole("button", { name: "To age 18" }));
    expect(screen.getByTestId("projected-value")).toHaveTextContent("€10,800");
  });

  it("hides the 'To age 18' preset when no birth year is known", () => {
    renderPanel();
    expect(screen.queryByRole("button", { name: "To age 18" })).not.toBeInTheDocument();
  });
});
