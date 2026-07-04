import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { FlowBreakdownRow } from "../src/components/transactions/flow-breakdown-row";
import {
  AllFilterBanner,
  IncomeFilterBanner,
  TradeFilterBanner,
  ReconciliationBanner,
} from "../src/components/transactions/activity-banners";
import type {
  AllBannerData,
  IncomeBannerData,
  TradeBannerData,
} from "../src/lib/transaction-banners";

describe("FlowBreakdownRow", () => {
  it("renders the label, value, and a bar clamped to [0, 100]", () => {
    const { container } = render(
      <FlowBreakdownRow label="Buys" value="Rp 1.000" pct={140} color="#0E9F6E" />,
    );
    expect(screen.getByText("Buys")).toBeInTheDocument();
    expect(screen.getByText("Rp 1.000")).toBeInTheDocument();
    const bar = container.querySelector('div[style*="width"]') as HTMLElement;
    expect(bar.style.width).toBe("100%");
  });
});

describe("AllFilterBanner", () => {
  const data: AllBannerData = {
    currency: "IDR",
    tiles: [
      { label: "Invested", value: "Rp 2.000", sub: "2 buys", tone: "neutral" },
      { label: "Proceeds", value: "Rp 150", sub: "1 sells", tone: "neutral" },
      { label: "Income YTD", value: "Rp 1.000", sub: "+100% vs last year", tone: "up" },
    ],
    mix: [
      { label: "Buys", value: "Rp 2.000", pct: 100, color: "#0E9F6E" },
      { label: "Sells", value: "Rp 150", pct: 8, color: "#0D9488" },
      { label: "Income", value: "Rp 1.000", pct: 50, color: "#E0A53A" },
    ],
  };

  it("renders all 3 tiles and the cash-flow-mix breakdown", () => {
    render(<AllFilterBanner data={data} cashFlowMixLabel="Cash flow mix" />);
    expect(screen.getByText("Invested")).toBeInTheDocument();
    expect(screen.getAllByText("Rp 2.000").length).toBeGreaterThan(0);
    expect(screen.getByText("2 buys")).toBeInTheDocument();
    expect(screen.getByText("Cash flow mix")).toBeInTheDocument();
    // "Buys"/"Sells"/"Income" appear both as tile-adjacent labels and mix row labels.
    expect(screen.getAllByText("Income").length).toBeGreaterThan(0);
  });
});

describe("IncomeFilterBanner", () => {
  const data: IncomeBannerData = {
    currency: "IDR",
    ytd: "Rp 1.000",
    trendLabel: "New",
    trendTone: "neutral",
    projected: "Rp 1.200",
    projectedNote: "~ Rp 100/mo",
    bySource: [{ label: "Dividends", value: "Rp 700", pct: 70, color: "#0E9F6E" }],
  };

  it("renders Received/Projected stats and the By-source breakdown", () => {
    render(
      <IncomeFilterBanner
        data={data}
        receivedLabel="Received · YTD"
        projectedLabel="Projected · 12mo"
        bySourceLabel="By source"
      />,
    );
    expect(screen.getByText("Received · YTD")).toBeInTheDocument();
    expect(screen.getByText("Rp 1.000")).toBeInTheDocument();
    expect(screen.getByText("Projected · 12mo")).toBeInTheDocument();
    expect(screen.getByText("Rp 1.200")).toBeInTheDocument();
    expect(screen.getByText("By source")).toBeInTheDocument();
    expect(screen.getByText("Dividends")).toBeInTheDocument();
  });

  it("shows a placeholder when there is no by-source breakdown", () => {
    render(
      <IncomeFilterBanner
        data={{ ...data, bySource: [] }}
        receivedLabel="Received · YTD"
        projectedLabel="Projected · 12mo"
        bySourceLabel="By source"
      />,
    );
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});

describe("TradeFilterBanner", () => {
  const data: TradeBannerData = {
    currency: "IDR",
    total: "Rp 6.000",
    count: 2,
    avg: "Rp 3.000",
    bySymbol: [
      { label: "TLKM", value: "Rp 5.000", pct: 100, color: "#0E9F6E" },
      { label: "BBCA", value: "Rp 1.000", pct: 20, color: "#0D9488" },
    ],
  };

  it("renders totals and the per-symbol breakdown", () => {
    render(
      <TradeFilterBanner
        data={data}
        totalLabel="Invested · all time"
        ordersNote="2 orders"
        averageLabel="Average order"
        averageNote="capital deployed"
        headingLabel="Most bought"
      />,
    );
    expect(screen.getByText("Invested · all time")).toBeInTheDocument();
    expect(screen.getByText("Rp 6.000")).toBeInTheDocument();
    expect(screen.getByText("2 orders")).toBeInTheDocument();
    expect(screen.getByText("Most bought")).toBeInTheDocument();
    expect(screen.getByText("TLKM")).toBeInTheDocument();
    expect(screen.getByText("BBCA")).toBeInTheDocument();
  });
});

describe("ReconciliationBanner", () => {
  it("renders the title, detail, and portfolio tag", () => {
    render(
      <ReconciliationBanner
        title="Cash doesn't reconcile"
        detail="EUR: reported 100, derived 98"
        tag="Portfolio"
      />,
    );
    expect(screen.getByText("Cash doesn't reconcile")).toBeInTheDocument();
    expect(screen.getByText("EUR: reported 100, derived 98")).toBeInTheDocument();
    expect(screen.getByText("Portfolio")).toBeInTheDocument();
  });
});
