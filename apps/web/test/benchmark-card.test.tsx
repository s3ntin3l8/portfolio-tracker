import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { BenchmarkCard } from "../src/components/insights/benchmark-card";
import type { InsightsBenchmark } from "@portfolio/api-client";
import messages from "../messages/en.json";

const refresh = vi.fn();
const putPreferences = vi.fn();

vi.mock("@/i18n/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/lib/api", () => ({
  useApiClient: () => ({ putPreferences, lookupInstruments: vi.fn(async () => []) }),
}));

function renderCard(benchmark: InsightsBenchmark | null) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <BenchmarkCard benchmark={benchmark} locale="en" />
    </NextIntlClientProvider>,
  );
}

describe("BenchmarkCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders a friendly benchmark name and a single-signed percentage (regression: no doubled '+')", () => {
    renderCard({
      symbol: "^GSPC",
      activeReturn: "0.032",
      trackingError: "0.021",
      correlation: "0.85",
    });

    expect(screen.getByText("vs S&P 500")).toBeInTheDocument();
    expect(screen.getByText("+3.20%")).toBeInTheDocument();
    expect(screen.queryByText("++3.20%")).not.toBeInTheDocument();
    expect(screen.getByText(/2\.10%/)).toBeInTheDocument();
    expect(screen.queryByText(/210\.0/)).not.toBeInTheDocument();
  });

  it("falls back to the raw ticker for an unrecognized benchmark symbol", () => {
    renderCard({
      symbol: "^WEIRD123",
      activeReturn: "-0.05",
      trackingError: "0.01",
      correlation: "0.5",
    });

    expect(screen.getByText("vs ^WEIRD123")).toBeInTheDocument();
    expect(screen.getByText("-5.00%")).toBeInTheDocument();
  });

  it("shows a placeholder when no benchmark is configured", () => {
    renderCard(null);

    const els = screen.getAllByText("Set benchmark");
    expect(els.length).toBeGreaterThanOrEqual(1);
    expect(els[0]).toBeInTheDocument();
  });

  it("shows an edit button when a benchmark is configured", () => {
    renderCard({
      symbol: "^GSPC",
      activeReturn: "0.01",
      trackingError: "0.02",
      correlation: "0.9",
    });

    expect(screen.getByRole("button", { name: /Edit/i })).toBeInTheDocument();
  });

  it("opens a dialog when the edit button is clicked", async () => {
    renderCard({
      symbol: "^GSPC",
      activeReturn: "0.01",
      trackingError: "0.02",
      correlation: "0.9",
    });
    fireEvent.click(screen.getByRole("button", { name: /Edit/i }));

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
    expect(screen.getByPlaceholderText("Search benchmark...")).toBeInTheDocument();
  });

  it("saves a new benchmark symbol via putPreferences when a suggested benchmark is picked", async () => {
    putPreferences.mockResolvedValue({ benchmarkSymbol: "^GDAXI", riskFreeRate: null });
    renderCard({
      symbol: "^GSPC",
      activeReturn: "0.01",
      trackingError: "0.02",
      correlation: "0.9",
    });
    fireEvent.click(screen.getByRole("button", { name: /Edit/i }));

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("DAX"));
    fireEvent.click(screen.getByRole("button", { name: /Save/i }));

    await waitFor(() => {
      expect(putPreferences).toHaveBeenCalledWith({ benchmarkSymbol: "^GDAXI" });
    });
  });

  it("allows removing the benchmark", async () => {
    putPreferences.mockResolvedValue({ benchmarkSymbol: null, riskFreeRate: null });
    renderCard({
      symbol: "^GSPC",
      activeReturn: "0.01",
      trackingError: "0.02",
      correlation: "0.9",
    });
    fireEvent.click(screen.getByRole("button", { name: /Edit/i }));

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: /Remove/i }));

    await waitFor(() => {
      expect(putPreferences).toHaveBeenCalledWith({ benchmarkSymbol: null });
    });
  });
});
