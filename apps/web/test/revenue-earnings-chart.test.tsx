import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import {
  ChartTooltip,
  RevenueEarningsChart,
  RevenueEarningsChartLegend,
} from "../src/components/charts/revenue-earnings-chart";

function wrap(ui: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      {ui}
    </NextIntlClientProvider>,
  );
}

const DATA = [
  { year: 2022, revenue: 394_328_000_000, earnings: 99_803_000_000 },
  { year: 2023, revenue: 383_285_000_000, earnings: 96_995_000_000 },
];

describe("RevenueEarningsChartLegend", () => {
  it("labels both series", () => {
    wrap(<RevenueEarningsChartLegend />);
    expect(screen.getByText(messages.Instrument.revenueLabel)).toBeInTheDocument();
    expect(screen.getByText(messages.Instrument.earningsLabel)).toBeInTheDocument();
  });
});

// `ChartTooltip` is unit-tested directly — recharts' `Tooltip` only invokes `content` at
// real SVG layout time, which jsdom test stubs don't simulate (same rationale as
// IncomeBarChart's ChartTooltip, see income-bar-chart.tsx).
describe("RevenueEarningsChart ChartTooltip", () => {
  const money = (v: number) => `$${(v / 1_000_000_000).toFixed(1)}B`;
  const t = (key: string) => (messages.Instrument as unknown as Record<string, string>)[key] ?? key;

  it("renders nothing when inactive or payload is empty", () => {
    const { container: inactive } = wrap(<ChartTooltip active={false} money={money} t={t} />);
    expect(inactive).toBeEmptyDOMElement();

    const { container: noPayload } = wrap(<ChartTooltip active t={t} money={money} payload={[]} />);
    expect(noPayload).toBeEmptyDOMElement();
  });

  it("renders revenue and earnings rows for the hovered year", () => {
    wrap(
      <ChartTooltip
        active
        money={money}
        t={t}
        label={2022}
        payload={[{ dataKey: "revenue", value: DATA[0].revenue, payload: DATA[0] }]}
      />,
    );
    expect(screen.getByText("2022")).toBeInTheDocument();
    expect(screen.getByText(messages.Instrument.revenueLabel)).toBeInTheDocument();
    expect(screen.getByText(messages.Instrument.earningsLabel)).toBeInTheDocument();
    expect(screen.getByText("$394.3B")).toBeInTheDocument();
    expect(screen.getByText("$99.8B")).toBeInTheDocument();
  });
});

describe("RevenueEarningsChart", () => {
  it("renders without crashing for a multi-year series", () => {
    const { container } = wrap(<RevenueEarningsChart data={DATA} currency="USD" />);
    expect(container.querySelector(".recharts-responsive-container")).toBeTruthy();
  });
});
