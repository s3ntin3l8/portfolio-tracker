import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatCard } from "../src/components/stat-card";

describe("StatCard", () => {
  it("renders label, value, delta and caption", () => {
    render(
      <StatCard label="Total" value="€1,000" delta="+5%" deltaTone="up" caption="Top: Gold" />,
    );
    expect(screen.getByText("Total")).toBeInTheDocument();
    expect(screen.getByText("€1,000")).toBeInTheDocument();
    expect(screen.getByText("+5%")).toBeInTheDocument();
    expect(screen.getByText("Top: Gold")).toBeInTheDocument();
  });

  // Regression test for #483: an escape-hatch className lets a page span an odd trailing
  // tile across both mobile grid columns instead of leaving it alone in a half-width cell.
  it("forwards a className to the root card for grid-placement overrides", () => {
    render(<StatCard label="XIRR" value="7%" className="col-span-2 lg:col-span-1" />);
    const card = screen.getByText("XIRR").closest("div.col-span-2");
    expect(card).not.toBeNull();
    expect(card).toHaveClass("lg:col-span-1");
  });
});
