import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
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

import { IncomeBarChart, ChartTooltip } from "../src/components/charts/income-bar-chart";
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
    // 3 value cells + 3 projected cells (all zero, but still rendered)
    expect(cells).toHaveLength(6);
    // First value bar: forecast bar is muted
    const forecast = cells[2];
    expect(forecast).toHaveAttribute("data-fill", "var(--color-muted-foreground)");
    expect(forecast).toHaveAttribute("data-opacity", "0.4");
    expect(cells[0]).toHaveAttribute("data-fill", "var(--color-primary)");
  });

  it("renders a stacked projected segment for the current year", () => {
    wrap(
      <IncomeBarChart
        currency="IDR"
        data={[
          { label: "2025", value: 100 },
          { label: "2026", value: 200, projected: 80 },
          { label: "Next yr", value: 250, forecast: true },
        ]}
      />,
    );
    const cells = screen.getAllByTestId("cell");
    // value bar: 3 cells; projected bar: 3 cells
    expect(cells).toHaveLength(6);
    // The projected cell for 2026 (index 4 = 3 value cells + 1 projected cell)
    const projected = cells[4];
    expect(projected).toHaveAttribute("data-fill", "var(--color-primary)");
    expect(projected).toHaveAttribute("data-opacity", "0.25");
  });
});

describe("ChartTooltip", () => {
  const money = (v: number) => `Rp ${v}`;
  const t = (key: string) =>
    ({
      tooltipReceived: "Received",
      tooltipProjected: "Projected",
      tooltipTotal: "Total",
      tooltipForecast: "Forecast",
    })[key] ?? key;

  it("shows Received + Total for a past year (no projection)", () => {
    render(
      <ChartTooltip
        active
        label="2025"
        money={money}
        t={t}
        payload={[{ dataKey: "value", value: 100, payload: { label: "2025", value: 100 } }]}
      />,
    );
    expect(screen.getByText("Received")).toBeInTheDocument();
    expect(screen.getByText("Total")).toBeInTheDocument();
    expect(screen.queryByText("Projected")).not.toBeInTheDocument();
    // Both rows show the same amount since there's no projected segment.
    expect(screen.getAllByText("Rp 100")).toHaveLength(2);
  });

  it("shows Received + Projected + Total for the in-progress year", () => {
    render(
      <ChartTooltip
        active
        label="2026"
        money={money}
        t={t}
        payload={[
          {
            dataKey: "value",
            value: 200,
            payload: { label: "2026", value: 200, projected: 80 },
          },
        ]}
      />,
    );
    expect(screen.getByText("Received")).toBeInTheDocument();
    expect(screen.getByText("Projected")).toBeInTheDocument();
    expect(screen.getByText("Total")).toBeInTheDocument();
    expect(screen.getByText("Rp 200")).toBeInTheDocument();
    expect(screen.getByText("Rp 80")).toBeInTheDocument();
    expect(screen.getByText("Rp 280")).toBeInTheDocument();
  });

  it("shows only a Forecast row for the pure-forecast year", () => {
    render(
      <ChartTooltip
        active
        label="Next yr"
        money={money}
        t={t}
        payload={[
          {
            dataKey: "value",
            value: 250,
            payload: { label: "Next yr", value: 250, forecast: true },
          },
        ]}
      />,
    );
    expect(screen.getByText("Forecast")).toBeInTheDocument();
    expect(screen.queryByText("Received")).not.toBeInTheDocument();
    expect(screen.queryByText("Total")).not.toBeInTheDocument();
    expect(screen.getByText("Rp 250")).toBeInTheDocument();
  });

  it("renders nothing when inactive", () => {
    const { container } = render(
      <ChartTooltip
        active={false}
        label="2025"
        money={money}
        t={t}
        payload={[{ dataKey: "value", value: 100, payload: { label: "2025", value: 100 } }]}
      />,
    );
    expect(container).toBeEmptyDOMElement();
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
    // The peak month carries a title with its formatted amount (a colon marks a
    // real value, distinguishing it from the zero months' bare "Mon YYYY" title)
    // and full opacity.
    const peak = screen.getByTitle(/2026:/);
    expect(peak).toHaveStyle({ opacity: "1" });
  });

  it("defaults to a 'tap a cell' hint and updates it on click", () => {
    wrap(
      <IncomeHeatmap
        currency="IDR"
        monthly={[{ month: "2026-06", total: "532000" }]}
      />,
    );
    expect(
      screen.getByText("Tap a cell to see the month's income"),
    ).toBeInTheDocument();

    const cell = screen.getByTitle(/Jun 2026/);
    fireEvent.click(cell);

    expect(screen.getByText(/Jun 2026/)).toBeInTheDocument();
    expect(cell).toHaveAttribute("aria-pressed", "true");
  });

  it("shows an em-dash for a clicked cell with no income", () => {
    wrap(
      <IncomeHeatmap
        currency="IDR"
        monthly={[
          { month: "2026-01", total: "0" },
          { month: "2026-06", total: "100" },
        ]}
      />,
    );
    const zeroCell = screen.getByTitle("Jan 2026");
    fireEvent.click(zeroCell);
    expect(screen.getByText(/Jan 2026 · —/)).toBeInTheDocument();
  });
});
