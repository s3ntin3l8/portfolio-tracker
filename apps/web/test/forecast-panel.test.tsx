import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";

// Stub the recharts-backed chart; the panel's own math (via @portfolio/core)
// runs for real in-process — no network, no mock needed.
vi.mock("@/components/charts/forecast-chart", () => ({
  ForecastChart: () => <div data-testid="forecast-chart" />,
}));

import { ForecastPanel } from "../src/components/savings/forecast-panel";

function renderPanel(props: Partial<React.ComponentProps<typeof ForecastPanel>> = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ForecastPanel
        currentValue="0"
        monthlyAverage="100"
        seedAnnualReturn="0"
        currency="EUR"
        {...props}
      />
    </NextIntlClientProvider>,
  );
}

afterEach(() => vi.useRealTimers());

describe("ForecastPanel", () => {
  it("seeds the projection from the contribution defaults", () => {
    renderPanel();
    // 0 start, 100/mo, 0% return, 10y horizon → 100 * 120 = 12,000.
    expect(screen.getByTestId("projected-value")).toHaveTextContent("€12,000");
  });

  it("recomputes instantly when the monthly amount changes", () => {
    renderPanel();
    fireEvent.change(screen.getByLabelText("Monthly amount"), {
      target: { value: "200" },
    });
    // 200 * 120 = 24,000.
    expect(screen.getByTestId("projected-value")).toHaveTextContent("€24,000");
  });

  it("recomputes when the horizon changes", () => {
    renderPanel();
    fireEvent.change(screen.getByLabelText(/Horizon/), { target: { value: "5" } });
    // 100 * 60 = 6,000.
    expect(screen.getByTestId("projected-value")).toHaveTextContent("€6,000");
  });

  it("offers a 'To age 18' preset that sets the horizon from the birth year", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T00:00:00.000Z"));
    // Born 2017 → age 9 in 2026 → 9 years to 18 → 100 * 108 = 10,800.
    renderPanel({ birthYear: 2017, portfolioType: "child" });
    fireEvent.click(screen.getByRole("button", { name: "To age 18" }));
    expect(screen.getByTestId("projected-value")).toHaveTextContent("€10,800");
  });

  it("accepts a horizon beyond 25 years (up to 50)", () => {
    renderPanel();
    fireEvent.change(screen.getByLabelText(/Horizon/), { target: { value: "40" } });
    // 100/mo × 480 months = 48,000 (0% return).
    expect(screen.getByTestId("projected-value")).toHaveTextContent("€48,000");
  });

  it("hides the 'To age 18' preset when no birth year is known", () => {
    renderPanel({ portfolioType: "child" });
    expect(screen.queryByRole("button", { name: "To age 18" })).not.toBeInTheDocument();
  });

  it("hides the 'To age 18' preset for non-child portfolios even with a birth year", () => {
    renderPanel({ birthYear: 2017, portfolioType: "standard" });
    expect(screen.queryByRole("button", { name: "To age 18" })).not.toBeInTheDocument();
  });

  it("offers a 'To retirement' preset that sets the horizon from birth year and retirement age", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T00:00:00.000Z"));
    // Born 1994 → age 32 in 2026 → retirement at 67 → 35 years to retirement.
    renderPanel({ birthYear: 1994, portfolioType: "standard", retirementAge: 67 });
    fireEvent.click(screen.getByRole("button", { name: "To retirement" }));
    // 100/mo * 35 years * 12 months = 42,000.
    expect(screen.getByTestId("projected-value")).toHaveTextContent("€42,000");
  });

  it("hides the 'To retirement' preset when no retirement age is set", () => {
    renderPanel({ birthYear: 1994, portfolioType: "standard" });
    expect(screen.queryByRole("button", { name: "To retirement" })).not.toBeInTheDocument();
  });

  it("prefers 'To age 18' over 'To retirement' for child portfolios even with retirementAge", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T00:00:00.000Z"));
    renderPanel({ birthYear: 2017, portfolioType: "child", retirementAge: 67 });
    expect(screen.queryByRole("button", { name: "To retirement" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "To age 18" })).toBeInTheDocument();
  });

  describe("scenario chips", () => {
    it("renders three chips at rate−3/rate/rate+3 with the current rate active", () => {
      // seedAnnualReturn=0.08 → returnPct=8 → chips at 5%, 8%, 11%.
      renderPanel({ seedAnnualReturn: "0.08" });
      const chips = screen.getAllByTestId("scenario-chip");
      expect(chips).toHaveLength(3);
      expect(chips.map((c) => c.textContent)).toEqual([
        expect.stringContaining("5"),
        expect.stringContaining("8"),
        expect.stringContaining("11"),
      ]);
      // The middle chip (current rate) is the active one.
      expect(chips[0]).toHaveAttribute("data-active", "false");
      expect(chips[1]).toHaveAttribute("data-active", "true");
      expect(chips[2]).toHaveAttribute("data-active", "false");
    });

    it("dedupes to two chips at the low clamp (rate=0)", () => {
      renderPanel({ seedAnnualReturn: "0" });
      const chips = screen.getAllByTestId("scenario-chip");
      // max(0, 0-3)=0 collides with rate=0 itself → deduped to [0, 3].
      expect(chips).toHaveLength(2);
      expect(chips[0]).toHaveAttribute("data-active", "true");
    });

    it("dedupes to two chips at the high clamp (rate=15)", () => {
      renderPanel({ seedAnnualReturn: "0.15" });
      const chips = screen.getAllByTestId("scenario-chip");
      // min(15, 15+3)=15 collides with rate=15 itself → deduped to [12, 15].
      expect(chips).toHaveLength(2);
      expect(chips[1]).toHaveAttribute("data-active", "true");
    });

    it("updates chip values when the horizon changes", () => {
      renderPanel({ currentValue: "0", monthlyAverage: "100", seedAnnualReturn: "0" });
      const before = screen.getAllByTestId("scenario-chip")[0].textContent;
      fireEvent.change(screen.getByLabelText(/Horizon/), { target: { value: "20" } });
      const after = screen.getAllByTestId("scenario-chip")[0].textContent;
      expect(after).not.toEqual(before);
    });
  });

  it("accounts for historical contributions and growth in the metrics and subtitles", () => {
    // Starting value: €10,000, of which €8,000 is net contributed (so €2,000 is historical growth).
    // Future projection: 10 years at €100/mo, 0% return.
    // Projected future contribution: 120 * €100 = €12,000.
    // Projected future growth: 0.
    // Total contributed: €8,000 (historical) + €12,000 (future) = €20,000.
    // Total growth: (€10,000 + €12,000) - €20,000 = €2,000 (which is exactly historical growth + 0 future growth).
    // Total projected value: €22,000.
    renderPanel({
      currentValue: "10000",
      netContributed: "8000",
    });

    expect(screen.getByTestId("projected-value")).toHaveTextContent("€22,000");
    expect(screen.getByTestId("projected-contributed")).toHaveTextContent("€20,000");
    expect(screen.getByTestId("projected-growth")).toHaveTextContent("€2,000");
  });
});
