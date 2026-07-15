import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { ConcentrationTrendCard } from "../src/components/insights/concentration-trend-card";
import type { ConcentrationPoint } from "@portfolio/api-client";
import messages from "../messages/en.json";

function renderCard(trend: ConcentrationPoint[]) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ConcentrationTrendCard trend={trend} />
    </NextIntlClientProvider>,
  );
}

describe("ConcentrationTrendCard", () => {
  it("renders the latest top-1% and HHI, plus an explanatory note", () => {
    renderCard([
      { date: "2026-01", hhi: 0.2, top1Pct: 40, classCount: 3 },
      { date: "2026-02", hhi: 0.25, top1Pct: 42.5, classCount: 3 },
    ]);

    expect(screen.getByText("42.5%")).toBeInTheDocument();
    expect(screen.getByText(/HHI 25\.0/)).toBeInTheDocument();
    expect(screen.getByText(/2 monthly samples/)).toBeInTheDocument();
    // Explanatory note (the "Info" box) defining HHI.
    expect(screen.getByText(/Herfindahl-Hirschman/)).toBeInTheDocument();
  });

  it("renders an empty state when there is no trend data", () => {
    renderCard([]);
    expect(screen.getByText("Insufficient data")).toBeInTheDocument();
  });
});
