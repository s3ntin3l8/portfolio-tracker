import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";

// Stub the recharts-backed area chart so the test stays light and deterministic.
vi.mock("@/components/charts/price-chart", () => ({
  PriceChart: ({ data }: { data: { date: string; close: string }[] }) => (
    <div data-testid="chart" data-points={data.length} data-last={data[data.length - 1]?.close} />
  ),
}));

import { ContributionsChart } from "../src/components/charts/contributions-chart";

function renderChart(series: { month: string; contributed: string }[]) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ContributionsChart series={series} currency="EUR" />
    </NextIntlClientProvider>,
  );
}

describe("ContributionsChart", () => {
  it("renders a cumulative series (running total)", () => {
    renderChart([
      { month: "2026-01", contributed: "100" },
      { month: "2026-02", contributed: "100" },
      { month: "2026-03", contributed: "150" },
    ]);
    const chart = screen.getByTestId("chart");
    expect(chart).toHaveAttribute("data-points", "3");
    expect(chart).toHaveAttribute("data-last", "350"); // 100 + 100 + 150
  });

  it("shows an empty state when there is too little history to plot", () => {
    renderChart([{ month: "2026-01", contributed: "100" }]);
    expect(screen.queryByTestId("chart")).not.toBeInTheDocument();
    expect(screen.getByText(messages.Empty.historyTitle)).toBeInTheDocument();
  });
});
