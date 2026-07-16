import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import type { HistoryPoint, PerformancePoint, IntradayPoint } from "@portfolio/api-client";

// Stub the recharts-backed chart so the test stays light and deterministic.
vi.mock("@/components/charts/price-chart", () => ({
  PriceChart: () => <div data-testid="chart" />,
}));
const getNetWorthHistory = vi.fn(async (): Promise<HistoryPoint[]> => [
  { date: "2026-01-01", netWorth: "100" },
  { date: "2026-02-01", netWorth: "200" },
  { date: "2026-03-01", netWorth: "300" },
]);
const getPortfolioHistory = vi.fn(async (): Promise<HistoryPoint[]> => [
  { date: "2026-01-01", netWorth: "50" },
  { date: "2026-02-01", netWorth: "75" },
]);
vi.mock("@/lib/api", () => ({
  useApiClient: () => ({ getNetWorthHistory, getPortfolioHistory }),
}));

import { NetWorthHistoryChart } from "../src/components/charts/net-worth-history-chart";

const initial: PerformancePoint[] = [
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
    await waitFor(() => expect(getPortfolioHistory).toHaveBeenCalledWith("p2", "3m"));
    expect(getNetWorthHistory).not.toHaveBeenCalled();
  });

  it("renders timestamped 1D data (the intraday `at` shape) as a chart", async () => {
    const intradayPoints: IntradayPoint[] = [
      { at: "2026-06-01T02:00:00.000Z", netWorth: "100", marketValue: "100" },
      { at: "2026-06-01T02:15:00.000Z", netWorth: "110", marketValue: "110" },
    ];
    getNetWorthHistory.mockResolvedValueOnce(intradayPoints);
    renderChart();
    fireEvent.click(screen.getByRole("button", { name: "1D" }));
    await waitFor(() => expect(getNetWorthHistory).toHaveBeenCalledWith("1d"));
    expect(await screen.findByTestId("chart")).toBeInTheDocument();
  });

  it("shows a collecting-data note instead of a blank/broken chart when no intraday points exist yet", async () => {
    getNetWorthHistory.mockResolvedValueOnce([]);
    renderChart();
    fireEvent.click(screen.getByRole("button", { name: "1D" }));
    await waitFor(() => expect(screen.getByText(/Collecting intraday data/i)).toBeInTheDocument());
    expect(screen.queryByTestId("chart")).not.toBeInTheDocument();
  });

  it("disables the Performance mode toggle for intraday ranges", async () => {
    getNetWorthHistory.mockResolvedValueOnce([
      { at: "2026-06-01T02:00:00.000Z", netWorth: "100", marketValue: "100" },
      { at: "2026-06-01T02:15:00.000Z", netWorth: "110", marketValue: "110" },
    ] as IntradayPoint[]);
    renderChart();
    fireEvent.click(screen.getByRole("button", { name: "1D" }));
    await waitFor(() => expect(getNetWorthHistory).toHaveBeenCalledWith("1d"));
    const perfButton = screen.getByRole("button", { name: "Performance" });
    expect(perfButton).toBeDisabled();
  });

  describe("hero variant", () => {
    it("renders real intraday values (not the collecting note) once ≥2 points exist, with no mode toggle and only the 5 hero range chips", async () => {
      const intradayPoints: IntradayPoint[] = [
        { at: "2026-06-01T02:00:00.000Z", netWorth: "1000", marketValue: "1000" },
        { at: "2026-06-01T03:00:00.000Z", netWorth: "1050", marketValue: "1050" },
        { at: "2026-06-01T04:00:00.000Z", netWorth: "1020", marketValue: "1020" },
      ];
      getNetWorthHistory.mockResolvedValueOnce(intradayPoints);
      const onSeriesChange = vi.fn();

      render(
        <NextIntlClientProvider locale="en" messages={messages}>
          <NetWorthHistoryChart
            initial={initial}
            currency="IDR"
            variant="hero"
            onSeriesChange={onSeriesChange}
          />
        </NextIntlClientProvider>,
      );

      // Hero has no Performance/Value mode toggle.
      expect(screen.queryByRole("button", { name: "Performance" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Value" })).not.toBeInTheDocument();

      // Only the 5 hero chips render (no 3M/YTD).
      expect(screen.getByRole("button", { name: "1D" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "7D" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "1M" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "1Y" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "All" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "3M" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "YTD" })).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "1D" }));
      await waitFor(() => expect(getNetWorthHistory).toHaveBeenCalledWith("1d"));

      expect(await screen.findByTestId("chart")).toBeInTheDocument();
      expect(screen.queryByText(/Collecting intraday data/i)).not.toBeInTheDocument();

      // The caller-visible series carries the real fetched values, not a placeholder.
      await waitFor(() => {
        const lastCall = onSeriesChange.mock.calls.at(-1);
        expect(lastCall?.[1]).toBe("1d");
        expect(lastCall?.[0]).toEqual([
          { date: expect.any(String), close: 1000 },
          { date: expect.any(String), close: 1050 },
          { date: expect.any(String), close: 1020 },
        ]);
      });
    });

    it("shows the collecting note (not a broken chart) when fewer than 2 intraday points exist", async () => {
      getNetWorthHistory.mockResolvedValueOnce([]);
      render(
        <NextIntlClientProvider locale="en" messages={messages}>
          <NetWorthHistoryChart initial={initial} currency="IDR" variant="hero" />
        </NextIntlClientProvider>,
      );
      fireEvent.click(screen.getByRole("button", { name: "1D" }));
      await waitFor(() =>
        expect(screen.getByText(/Collecting intraday data/i)).toBeInTheDocument(),
      );
      expect(screen.queryByTestId("chart")).not.toBeInTheDocument();
    });
  });
});
