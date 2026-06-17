import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import type { NetWorthPoint } from "@portfolio/api-client";

// Stub the recharts-backed chart so the test stays light and deterministic.
vi.mock("@/components/charts/price-chart", () => ({
  PriceChart: () => <div data-testid="chart" />,
}));
const getNetWorthHistory = vi.fn(async (): Promise<NetWorthPoint[]> => [
  { date: "2026-01-01", netWorth: "100" },
  { date: "2026-02-01", netWorth: "200" },
  { date: "2026-03-01", netWorth: "300" },
]);
const getPortfolioHistory = vi.fn(async (): Promise<NetWorthPoint[]> => [
  { date: "2026-01-01", netWorth: "50" },
  { date: "2026-02-01", netWorth: "75" },
]);
vi.mock("@/lib/api", () => ({
  useApiClient: () => ({ getNetWorthHistory, getPortfolioHistory }),
}));

import { NetWorthHistoryChart } from "../src/components/charts/net-worth-history-chart";

const initial: NetWorthPoint[] = [
  { date: "2026-01-01", netWorth: "100" },
  { date: "2026-02-01", netWorth: "200" },
];

function renderChart() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <NetWorthHistoryChart initial={initial} currency="IDR" />
    </NextIntlClientProvider>,
  );
}

describe("NetWorthHistoryChart", () => {
  beforeEach(() => {
    getNetWorthHistory.mockClear();
    getPortfolioHistory.mockClear();
  });

  it("renders the initial series without fetching", () => {
    renderChart();
    expect(screen.getByTestId("chart")).toBeInTheDocument();
    expect(getNetWorthHistory).not.toHaveBeenCalled();
  });

  it("refetches the series when the range changes", async () => {
    renderChart();
    fireEvent.click(screen.getByRole("button", { name: "3M" }));
    await waitFor(() => expect(getNetWorthHistory).toHaveBeenCalledWith("3m"));
  });

  it("uses getPortfolioHistory instead of getNetWorthHistory when selectedId is set", async () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <NetWorthHistoryChart initial={initial} currency="IDR" selectedId="p2" />
      </NextIntlClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "3M" }));
    await waitFor(() =>
      expect(getPortfolioHistory).toHaveBeenCalledWith("p2", "3m"),
    );
    expect(getNetWorthHistory).not.toHaveBeenCalled();
  });
});
