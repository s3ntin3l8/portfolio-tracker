import { describe, it, expect } from "vitest";
import { render, fireEvent, screen } from "@testing-library/react";
import { HoldingSparkline } from "../src/components/holding-sparkline";

function points(container: HTMLElement): string[] {
  const pl = container.querySelector("polyline");
  return (pl?.getAttribute("points") ?? "").trim().split(/\s+/).filter(Boolean);
}

describe("HoldingSparkline", () => {
  it("renders one polyline point per value", () => {
    const { container } = render(<HoldingSparkline values={[1, 2, 3, 4]} />);
    expect(points(container)).toHaveLength(4);
  });

  it("renders nothing for fewer than two points", () => {
    const { container } = render(<HoldingSparkline values={[5]} />);
    expect(container.querySelector("svg")).toBeNull();
  });

  it("colors an upward series green and a downward series red (by first→last)", () => {
    const up = render(<HoldingSparkline values={[1, 5]} />);
    expect(up.container.querySelector("svg")?.getAttribute("class")).toContain("text-success");
    const down = render(<HoldingSparkline values={[5, 1]} />);
    expect(down.container.querySelector("svg")?.getAttribute("class")).toContain(
      "text-destructive",
    );
  });

  it("draws a flat midline (no NaN) when all values are equal", () => {
    const { container } = render(<HoldingSparkline values={[3, 3, 3]} />);
    const pts = points(container);
    expect(pts.join(" ")).not.toContain("NaN");
    const ys = pts.map((p) => Number(p.split(",")[1]));
    expect(new Set(ys)).toEqual(new Set([13])); // H/2 with H=26
  });

  it("is focusable with role=img and an aria-label summarizing the range", () => {
    const { container } = render(<HoldingSparkline values={[1, 5, 2, 8, 3]} />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("aria-hidden")).toBeNull();
    expect(svg?.getAttribute("role")).toBe("img");
    expect(svg?.getAttribute("tabindex")).toBe("0");
    const label = svg?.getAttribute("aria-label") ?? "";
    // The localized range is computed by Intl.NumberFormat (the test
    // runtime's default locale), so we just check it mentions "1" (the
    // min) and "8" (the max) — that survives any locale's separators.
    expect(label).toMatch(/1/);
    expect(label).toMatch(/8/);
  });

  it("shows a floating tooltip on mouseenter with the formatted range", () => {
    render(<HoldingSparkline values={[1, 5, 2, 8, 3]} />);
    const svg = screen.getByRole("img");
    // No tooltip in the DOM before hover.
    expect(screen.queryByText("Range")).not.toBeInTheDocument();
    fireEvent.mouseEnter(svg);
    expect(screen.getByText("Range")).toBeInTheDocument();
    // The range row carries the formatted min and max (joined by an en-dash,
    // but we check for the values alone to avoid locale coupling).
    const valueNodes = screen.getAllByText(/[18]/);
    expect(valueNodes.length).toBeGreaterThan(0);
    fireEvent.mouseLeave(svg);
    // The tooltip is unmounted on mouseleave (state-driven, not CSS-hidden).
    expect(screen.queryByText("Range")).not.toBeInTheDocument();
  });
});
