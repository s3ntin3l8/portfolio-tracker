import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";

// Light recharts stubs so the bar chart's data/Cell mapping is exercised in jsdom
// without a real SVG layout.
vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  BarChart: ({ children, data }: { children: React.ReactNode; data: unknown[] }) => (
    <div data-testid="barchart" data-count={data.length}>
      {children}
    </div>
  ),
  Bar: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Cell: ({ fill, fillOpacity }: { fill: string; fillOpacity: number }) => (
    <div data-testid="cell" data-fill={fill} data-opacity={fillOpacity} />
  ),
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: () => null,
  CartesianGrid: () => null,
}));

import { IncomeBarChart } from "../src/components/charts/income-bar-chart";
import { IncomeHeatmap } from "../src/components/charts/income-heatmap";

function wrap(ui: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      {ui}
    </NextIntlClientProvider>,
  );
}

describe("IncomeBarChart", () => {
  it("renders a bar per year plus a muted forecast bar", () => {
    wrap(
      <IncomeBarChart
        currency="IDR"
        data={[
          { label: "2025", value: 100 },
          { label: "2026", value: 200 },
          { label: "Next yr", value: 250, forecast: true },
        ]}
      />,
    );
    expect(screen.getByTestId("barchart")).toHaveAttribute("data-count", "3");
    const cells = screen.getAllByTestId("cell");
    expect(cells).toHaveLength(3);
    // The forecast bar reads as a projection: muted fill, reduced opacity.
    const forecast = cells[2];
    expect(forecast).toHaveAttribute("data-fill", "var(--color-muted-foreground)");
    expect(forecast).toHaveAttribute("data-opacity", "0.4");
    expect(cells[0]).toHaveAttribute("data-fill", "var(--color-primary)");
  });
});

describe("IncomeHeatmap", () => {
  it("renders one row per year with month cells scaled by amount", () => {
    wrap(
      <IncomeHeatmap
        currency="IDR"
        monthly={[
          { month: "2025-03", total: "50" },
          { month: "2026-03", total: "100" }, // the busiest month → full opacity
        ]}
      />,
    );
    expect(screen.getByText("2025")).toBeInTheDocument();
    expect(screen.getByText("2026")).toBeInTheDocument();
    // The peak month carries a title with its formatted amount and full opacity.
    const peak = screen.getByTitle(/2026/);
    expect(peak).toHaveStyle({ opacity: "1" });
  });
});
