import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import type { PerformancePoint } from "@portfolio/api-client";

// Stub the recharts-backed single-series chart so the degraded path stays deterministic.
vi.mock("@/components/charts/price-chart", () => ({
  PriceChart: ({ data }: { data: { date: string; close: string }[] }) => (
    <div
      data-testid="price-chart"
      data-points={data.length}
      data-last={data[data.length - 1]?.close}
    />
  ),
}));

// Stub recharts so the ComposedChart overlay path renders without SVG/canvas issues.
// Also stub the recharts v3 hooks used by the OverlayTooltip (they read from the
// recharts Redux store which is not available in jsdom without a full chart render).
vi.mock("recharts", () => ({
  ComposedChart: ({
    children,
    data,
  }: {
    children: React.ReactNode;
    data: unknown[];
  }) => (
    <div data-testid="overlay-chart" data-points={data.length}>
      {children}
    </div>
  ),
  Area: () => null,
  Line: ({ dataKey }: { dataKey: string }) => (
    <div data-testid={`line-${dataKey}`} />
  ),
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: () => null,
  CartesianGrid: () => null,
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  useActiveTooltipDataPoints: () => [],
  useActiveTooltipLabel: () => undefined,
  useIsTooltipActive: () => false,
}));

import { ContributionsChart } from "../src/components/charts/contributions-chart";

const series = [
  { month: "2026-01", contributed: "100" },
  { month: "2026-02", contributed: "100" },
  { month: "2026-03", contributed: "150" },
];

const dailySeries = [
  { date: "2026-01-10", contributed: "100" },
  { date: "2026-02-12", contributed: "100" },
  { date: "2026-03-08", contributed: "150" },
];

const valueHistory: PerformancePoint[] = [
  { date: "2026-01-15", netWorth: "95", marketValue: "95" },
  { date: "2026-01-31", netWorth: "105", marketValue: "105" },
  { date: "2026-02-28", netWorth: "220", marketValue: "220" },
  { date: "2026-03-31", netWorth: "380", marketValue: "380" },
];

function renderChart(
  s: typeof series,
  v: PerformancePoint[],
  currency = "EUR",
  d: typeof dailySeries = dailySeries,
) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ContributionsChart
        series={s}
        dailySeries={d}
        valueHistory={v}
        currency={currency}
      />
    </NextIntlClientProvider>,
  );
}

// ── Overlay path ──────────────────────────────────────────────────────────────

describe("ContributionsChart — overlay path", () => {
  it("renders the overlay chart when value history is available", () => {
    renderChart(series, valueHistory);
    expect(screen.getByTestId("overlay-chart")).toBeInTheDocument();
    expect(screen.queryByTestId("price-chart")).not.toBeInTheDocument();
  });

  it("exposes the value and contributed lines", () => {
    renderChart(series, valueHistory);
    expect(screen.getByTestId("line-value")).toBeInTheDocument();
    expect(screen.getByTestId("line-contributed")).toBeInTheDocument();
  });

  it("passes the correct number of daily points to the chart", () => {
    renderChart(series, valueHistory);
    const chart = screen.getByTestId("overlay-chart");
    // 4 daily history points → 4 merged rows
    expect(chart).toHaveAttribute("data-points", "4");
  });

  // Regression test for #483: a fixed `gap-6` flex row left-clustered the Invested/Gain/Now
  // worth footer into ~80% of the width on mobile instead of spreading evenly.
  it("spreads the Invested/Gain/Now worth footer across an even 3-col grid on mobile", () => {
    renderChart(series, valueHistory);
    const footer = screen
      .getByText(messages.Savings.footerInvested)
      .closest("div.grid");
    expect(footer).toHaveClass("grid-cols-3");
  });
});

// ── Degraded path ─────────────────────────────────────────────────────────────

describe("ContributionsChart — degraded path (no value history)", () => {
  it("renders the legacy PriceChart with cumulative contributions", () => {
    renderChart(series, []);
    const chart = screen.getByTestId("price-chart");
    expect(chart).toHaveAttribute("data-points", "3");
    expect(chart).toHaveAttribute("data-last", "350"); // 100 + 100 + 150
  });

  it("shows the info note about missing value history", () => {
    renderChart(series, []);
    expect(
      screen.getByText(messages.Savings.chartValueUnavailable),
    ).toBeInTheDocument();
  });

  it("shows an empty state when there is too little contribution history to plot", () => {
    renderChart([{ month: "2026-01", contributed: "100" }], []);
    expect(screen.queryByTestId("price-chart")).not.toBeInTheDocument();
    expect(screen.getByText(messages.Empty.historyTitle)).toBeInTheDocument();
  });

  it("degrades gracefully when value history has only 1 point", () => {
    renderChart(series, [{ date: "2026-01-15", netWorth: "95" }]);
    expect(screen.getByTestId("price-chart")).toBeInTheDocument();
  });
});
