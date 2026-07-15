import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { BenchmarkCard } from "../src/components/insights/benchmark-card";
import type { InsightsBenchmark } from "@portfolio/api-client";
import messages from "../messages/en.json";

function renderCard(benchmark: InsightsBenchmark) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <BenchmarkCard benchmark={benchmark} locale="en" />
    </NextIntlClientProvider>,
  );
}

describe("BenchmarkCard", () => {
  it("renders a friendly benchmark name and a single-signed percentage (regression: no doubled '+')", () => {
    renderCard({ symbol: "^GSPC", activeReturn: "0.032", trackingError: "0.021", correlation: "0.85" });

    expect(screen.getByText("vs S&P 500")).toBeInTheDocument();
    // Exactly one leading "+" — formatPercent's own signDisplay already adds it;
    // the card must not also prepend one (that produced "++3.20%" before the fix).
    expect(screen.getByText("+3.20%")).toBeInTheDocument();
    expect(screen.queryByText("++3.20%")).not.toBeInTheDocument();
    // Tracking error: API returns a fraction (0.021 = 2.1%); the card must not also
    // multiply by 100 a second time (that produced "210.0%" before the fix).
    expect(screen.getByText(/2\.10%/)).toBeInTheDocument();
    expect(screen.queryByText(/210\.0/)).not.toBeInTheDocument();
  });

  it("falls back to the raw ticker for an unrecognized benchmark symbol", () => {
    renderCard({ symbol: "^WEIRD123", activeReturn: "-0.05", trackingError: "0.01", correlation: "0.5" });

    expect(screen.getByText("vs ^WEIRD123")).toBeInTheDocument();
    expect(screen.getByText("-5.00%")).toBeInTheDocument();
  });
});
