import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { BestWorstCard } from "../src/components/insights/best-worst-card";
import type { Mover } from "../src/lib/movers";

const best: Mover = {
  instrumentId: "a",
  symbol: "BBCA",
  name: "Bank Central Asia",
  assetClass: "equity",
  pct: 0.032,
};
const worst: Mover = {
  instrumentId: "b",
  symbol: "ANTM",
  name: "Antam",
  assetClass: "gold",
  pct: -0.018,
};

describe("BestWorstCard", () => {
  it("renders both rows with signed, colored percentages", () => {
    render(
      <BestWorstCard
        best={best}
        worst={worst}
        title="Best & worst"
        timeframeLabel="24h"
        bestLabel="Best performer"
        worstLabel="Worst performer"
        locale="en"
      />,
    );
    expect(screen.getByText("Best & worst")).toBeInTheDocument();
    // Explicit timeframe label — this card is always a day-change ("24h") view.
    expect(screen.getByText("24h")).toBeInTheDocument();
    expect(screen.getByText("BBCA")).toBeInTheDocument();
    expect(screen.getByText("Best performer")).toBeInTheDocument();
    expect(screen.getByText("+3.20%")).toBeInTheDocument();
    expect(screen.getByText("ANTM")).toBeInTheDocument();
    expect(screen.getByText("Worst performer")).toBeInTheDocument();
    expect(screen.getByText("-1.80%")).toBeInTheDocument();
  });
});
