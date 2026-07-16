import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import type { HistoryPoint } from "@portfolio/api-client";

vi.mock("@/components/charts/price-chart", () => ({
  PriceChart: () => <div data-testid="chart" />,
}));
const getNetWorthHistory = vi.fn(async (): Promise<HistoryPoint[]> => [
  { at: "2026-06-01T02:00:00.000Z", netWorth: "1000000", marketValue: "1000000" },
  { at: "2026-06-01T09:00:00.000Z", netWorth: "1050000", marketValue: "1050000" },
]);
vi.mock("@/lib/api", () => ({
  useApiClient: () => ({ getNetWorthHistory }),
}));

import { HeroGlanceCard } from "../src/components/holdings/hero-glance-card";

const initial: HistoryPoint[] = [
  { at: "2026-06-28T02:00:00.000Z", netWorth: "900000", marketValue: "900000" },
  { at: "2026-06-29T02:00:00.000Z", netWorth: "950000", marketValue: "950000" },
];

function renderCard() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <HeroGlanceCard
        netWorth="1050000"
        currency="IDR"
        initialHistory={initial}
        initialRange="7d"
      />
    </NextIntlClientProvider>,
  );
}

describe("HeroGlanceCard", () => {
  it("shows the static current net worth headline regardless of the chart range", () => {
    renderCard();
    expect(screen.getByText("Total portfolio value")).toBeInTheDocument();
    expect(screen.getByText(/IDR\s*1,050,000/)).toBeInTheDocument();
  });

  it("derives the period delta/pct pill from the chart's own emitted series and updates the period word on range change", async () => {
    renderCard();
    // Initial 7D series: 900000 -> 950000, so a "past 7D" pill should appear.
    await waitFor(() => expect(screen.getByText(/past 7D/)).toBeInTheDocument());
    expect(screen.getByText(/▲/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "1D" }));
    await waitFor(() => expect(getNetWorthHistory).toHaveBeenCalledWith("1d"));
    await waitFor(() => expect(screen.getByText(/past 1D/)).toBeInTheDocument());
  });

  it("hides the delta pill when fewer than 2 series points are available", () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <HeroGlanceCard netWorth="0" currency="IDR" initialHistory={[]} initialRange="7d" />
      </NextIntlClientProvider>,
    );
    expect(screen.queryByText(/▲/)).not.toBeInTheDocument();
    expect(screen.queryByText(/▼/)).not.toBeInTheDocument();
  });
});
