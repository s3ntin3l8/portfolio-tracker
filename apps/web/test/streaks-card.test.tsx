import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { StreaksCard } from "../src/components/insights/streaks-card";
import type { InsightsStreaks } from "@portfolio/api-client";
import messages from "../messages/en.json";

function renderCard(streaks: InsightsStreaks) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <StreaksCard streaks={streaks} locale="en" />
    </NextIntlClientProvider>,
  );
}

describe("StreaksCard", () => {
  it("renders month-count streaks with month-truncated start/end dates (regression: no day counts mislabeled as months)", () => {
    // Regression: streakAnalysis now resamples to month-end points before computing
    // streaks, so `length` is a genuine month count (not a raw daily-point count) and
    // start/end are real dates within those months — the card truncates them to
    // "YYYY-MM" so the label reads as a month range, not a full date.
    renderCard({
      bestStreak: { length: 5, totalReturnPct: "0.12", start: "2026-01-31", end: "2026-05-31" },
      worstStreak: { length: 2, totalReturnPct: "-0.04", start: "2026-06-30", end: "2026-07-31" },
      bestMonth: { date: "2026-03", returnPct: "0.05" },
      worstMonth: { date: "2026-06", returnPct: "-0.03" },
      bestYear: { year: 2026, returnPct: "0.2" },
      worstYear: { year: 2026, returnPct: "0.2" },
      positiveMonths: 5,
      negativeMonths: 2,
      totalMonths: 7,
    });

    expect(screen.getByText("5mo")).toBeInTheDocument();
    expect(screen.getByText("2mo")).toBeInTheDocument();
    // Full dates ("2026-01-31") must not leak into the label — only the month.
    expect(screen.getByText("2026-01 → 2026-05")).toBeInTheDocument();
    expect(screen.getByText("2026-06 → 2026-07")).toBeInTheDocument();
    expect(screen.queryByText(/2026-01-31/)).not.toBeInTheDocument();
  });

  it("renders a dash when there is no streak in either direction", () => {
    renderCard({
      bestStreak: null,
      worstStreak: null,
      bestMonth: null,
      worstMonth: null,
      bestYear: null,
      worstYear: null,
      positiveMonths: 0,
      negativeMonths: 0,
      totalMonths: 0,
    });

    expect(screen.getAllByText("—")).toHaveLength(2);
  });
});
