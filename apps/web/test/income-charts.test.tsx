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
  useXAxisScale: () => undefined,
  useYAxisScale: () => undefined,
  Cell: ({
    fill,
    fillOpacity,
    stroke,
    strokeDasharray,
  }: {
    fill: string;
    fillOpacity?: number;
    stroke?: string;
    strokeDasharray?: string;
  }) => (
    <div
      data-testid="cell"
      data-fill={fill}
      data-opacity={fillOpacity}
      data-stroke={stroke}
      data-stroke-dash={strokeDasharray}
    />
  ),
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: () => null,
  CartesianGrid: () => null,
}));

import {
  IncomeBarChart,
  IncomeBarChartLegend,
  ChartTooltip,
} from "../src/components/charts/income-bar-chart";
import { IncomeHeatmap } from "../src/components/charts/income-heatmap";

function wrap(ui: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      {ui}
    </NextIntlClientProvider>,
  );
}

describe("IncomeBarChart", () => {
  it("renders a bar per year plus a dashed-outline forecast bar", () => {
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
    // The forecast bar reads as a dashed green outline, not a filled/muted bar.
    const forecast = cells[2];
    expect(forecast).toHaveAttribute("data-fill", "var(--color-primary)");
    expect(forecast).toHaveAttribute("data-opacity", "0.12");
    expect(forecast).toHaveAttribute("data-stroke", "var(--color-primary)");
    expect(forecast).toHaveAttribute("data-stroke-dash", "4 3");
    expect(cells[0]).toHaveAttribute("data-fill", "var(--color-primary)");
  });

  it("renders a striped-pattern projected segment for the current year", () => {
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
    // The projected cell for 2026 (index 4 = 3 value cells + 1 projected cell) uses the
    // diagonal-stripe hatch pattern, not a flat fill.
    const projected = cells[4];
    expect(projected).toHaveAttribute("data-fill", "url(#income-projected-stripe)");
  });
});

describe("IncomeBarChartLegend", () => {
  it("renders the Received/Projected/Forecast key", () => {
    wrap(<IncomeBarChartLegend />);
    expect(screen.getByText("Received")).toBeInTheDocument();
    expect(screen.getByText("Projected")).toBeInTheDocument();
    expect(screen.getByText("Forecast")).toBeInTheDocument();
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

    // Subtitle updates to the cell's month + amount.
    expect(screen.getByText(/Jun 2026 · IDR/)).toBeInTheDocument();
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

  it("surfaces a floating tooltip on mouseenter with month + amount", () => {
    wrap(
      <IncomeHeatmap
        currency="IDR"
        monthly={[{ month: "2026-06", total: "532000" }]}
      />,
    );
    const cell = screen.getByTitle(/Jun 2026/);
    fireEvent.mouseEnter(cell);
    // Title row (panel heading) carries the month label.
    expect(screen.getByText("Jun 2026")).toBeInTheDocument();
    // The "Amount" row uses the new i18n key, formatted via formatMoney.
    expect(screen.getByText("Amount")).toBeInTheDocument();
    // The exact formatted value is locale-dependent; just check that the
    // raw number 532000 appears in the value cell (Intl.NumberFormat
    // preserves the integer IDR value).
    expect(screen.getByText(/532[.,\s\u00a0\u202f]?000/)).toBeInTheDocument();
  });

  it("dismisses the floating tooltip on mouseleave", () => {
    wrap(
      <IncomeHeatmap
        currency="IDR"
        monthly={[{ month: "2026-06", total: "532000" }]}
      />,
    );
    const cell = screen.getByTitle(/Jun 2026/);
    fireEvent.mouseEnter(cell);
    expect(screen.getByText("Amount")).toBeInTheDocument();
    fireEvent.mouseLeave(cell);
    // The tooltip is state-driven: the panel unmounts on leave (so the
    // page is keyboard/SSR-clean). The subtitle is *not* the floating
    // tooltip — it remains as the no-hover fallback.
    expect(screen.queryByText("Amount")).not.toBeInTheDocument();
  });

  it("opens the floating tooltip on click (tap-to-toggle, mobile parity)", () => {
    // #478 review #1 regression guard: the cell's onClick used to
    // override the hook's tap-toggle because JSX prop merge is
    // left-to-right. The fix composes both: setActive (subtitle) +
    // listeners.onClick (floating tooltip). If the override ever sneaks
    // back, this test fails — `Amount` (the floating tooltip's row)
    // would not be in the DOM after `click` on a touch device.
    wrap(
      <IncomeHeatmap
        currency="IDR"
        monthly={[{ month: "2026-06", total: "532000" }]}
      />,
    );
    const cell = screen.getByTitle(/Jun 2026/);
    expect(screen.queryByText("Amount")).not.toBeInTheDocument();
    fireEvent.click(cell);
    // Subtitle updates (existing behavior).
    expect(cell).toHaveAttribute("aria-pressed", "true");
    // Floating tooltip also opens (this is what #1 broke on mobile).
    expect(screen.getByText("Amount")).toBeInTheDocument();
    expect(screen.getByText("Jun 2026")).toBeInTheDocument();
    // Second click toggles the floating tooltip off while still updating
    // the subtitle (subtitle stays pinned to the last-clicked cell).
    fireEvent.click(cell);
    expect(screen.queryByText("Amount")).not.toBeInTheDocument();
    expect(cell).toHaveAttribute("aria-pressed", "true");
  });
});
