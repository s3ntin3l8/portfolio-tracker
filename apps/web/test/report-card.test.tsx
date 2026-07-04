import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Coins } from "lucide-react";
import { ReportCard } from "../src/components/reports/report-card";
import { TrendChip } from "../src/components/reports/trend-chip";
import { MiniSplitBar } from "../src/components/reports/mini-split-bar";
import { TwoStatFooter } from "../src/components/reports/two-stat-footer";

describe("TrendChip", () => {
  it("renders the label and an arrow glyph for up/down tones", () => {
    render(<TrendChip label="+18% vs 2025" tone="up" arrow />);
    expect(screen.getByText("+18% vs 2025")).toBeInTheDocument();
    expect(screen.getByText("▲")).toBeInTheDocument();
  });

  it("omits the arrow for a neutral tone even when arrow is requested", () => {
    render(<TrendChip label="Due 31 Jul 2027" tone="neutral" arrow />);
    expect(screen.queryByText("▲")).not.toBeInTheDocument();
    expect(screen.queryByText("▼")).not.toBeInTheDocument();
  });
});

describe("MiniSplitBar", () => {
  it("renders one segment per entry", () => {
    const { container } = render(
      <MiniSplitBar
        segments={[
          { pct: 70, color: "red" },
          { pct: 30, color: "blue" },
        ]}
      />,
    );
    const bar = container.querySelector(".bg-muted");
    expect(bar?.children).toHaveLength(2);
  });
});

describe("TwoStatFooter", () => {
  it("renders each metric and the open affordance", () => {
    render(
      <TwoStatFooter
        metrics={[
          { label: "TTM", value: "Rp 1.2jt" },
          { label: "Lifetime", value: "Rp 9jt" },
        ]}
        openLabel="Open"
        accentColor="#0E9F6E"
      />,
    );
    expect(screen.getByText("TTM")).toBeInTheDocument();
    expect(screen.getByText("Rp 1.2jt")).toBeInTheDocument();
    expect(screen.getByText("Lifetime")).toBeInTheDocument();
    expect(screen.getByText("Open")).toBeInTheDocument();
  });
});

describe("ReportCard", () => {
  it("renders as a single link with title, value, caption and metrics", () => {
    render(
      <ReportCard
        icon={Coins}
        iconBg="rgba(14,159,110,.12)"
        iconFg="#0E9F6E"
        title="Income"
        trend={{ label: "+18% vs 2025", tone: "up", arrow: true }}
        value="Rp 12.400.000"
        caption="This year"
        splitBar={[
          { pct: 70, color: "#0E9F6E" },
          { pct: 30, color: "#0D9488" },
        ]}
        metrics={[
          { label: "TTM", value: "Rp 1.2jt" },
          { label: "Lifetime", value: "Rp 9jt" },
        ]}
        href="/income"
        openLabel="Open"
      />,
    );

    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "/income");
    expect(screen.getByText("Income")).toBeInTheDocument();
    expect(screen.getByText("Rp 12.400.000")).toBeInTheDocument();
    expect(screen.getByText("This year")).toBeInTheDocument();
    expect(screen.getByText("+18% vs 2025")).toBeInTheDocument();
    expect(screen.getByText("TTM")).toBeInTheDocument();
  });

  it("omits the split bar when not provided", () => {
    const { container } = render(
      <ReportCard
        icon={Coins}
        iconBg="rgba(14,159,110,.12)"
        iconFg="#0E9F6E"
        title="Tax"
        value="Rp 0"
        caption="No allowance configured"
        metrics={[]}
        href="/tax"
        openLabel="Open"
      />,
    );
    expect(container.querySelector(".rounded-full.bg-muted")).not.toBeInTheDocument();
  });
});
