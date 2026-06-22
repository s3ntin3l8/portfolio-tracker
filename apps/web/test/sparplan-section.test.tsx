import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import type { SparplanStats, DetectedPlan } from "@portfolio/api-client";
import { SparplanSection } from "../src/components/savings/sparplan-section";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePlan(overrides: Partial<DetectedPlan> = {}): DetectedPlan {
  return {
    instrumentId: "inst-vwce",
    symbol: "VWCE",
    name: "Vanguard FTSE All-World",
    currency: "EUR",
    cadenceMonths: 1,
    currentAmount: "150",
    currentAmountDisplay: "150",
    status: "active",
    firstExecution: "2025-01-05",
    lastExecution: "2026-05-05",
    executionCount: 17,
    source: "tagged",
    levels: [
      {
        amount: "150",
        amountDisplay: "150",
        currency: "EUR",
        since: "2025-01-05",
        until: null,
        executionCount: 17,
      },
    ],
    ...overrides,
  };
}

function makeStats(plans: DetectedPlan[]): SparplanStats {
  const active = plans.filter((p) => p.status === "active");
  const monthly = active.reduce(
    (sum, p) => sum + Number(p.currentAmountDisplay) / p.cadenceMonths,
    0,
  );
  return {
    displayCurrency: "EUR",
    plans,
    activeMonthlyTotalDisplay: monthly.toFixed(2),
    activePlanCount: active.length,
  };
}

function renderSection(stats: SparplanStats) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <SparplanSection data={stats} currency="EUR" locale="en" />
    </NextIntlClientProvider>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SparplanSection", () => {
  it("renders the instrument name and monthly total for an active plan", () => {
    const stats = makeStats([makePlan()]);
    renderSection(stats);

    expect(screen.getByText("Vanguard FTSE All-World")).toBeInTheDocument();
    // Active monthly total: the card header shows it.
    expect(screen.getByText("Active monthly total")).toBeInTheDocument();
    // Active badge
    expect(screen.getByText("Active")).toBeInTheDocument();
  });

  it("renders a stopped badge for a stopped plan", () => {
    const stats = makeStats([makePlan({ status: "stopped" })]);
    renderSection(stats);
    expect(screen.getByText("Stopped")).toBeInTheDocument();
  });

  it("renders a step-history line when there are multiple levels", () => {
    const plan = makePlan({
      levels: [
        {
          amount: "100",
          amountDisplay: "100",
          currency: "EUR",
          since: "2025-01-05",
          until: "2025-12-05",
          executionCount: 12,
        },
        {
          amount: "150",
          amountDisplay: "150",
          currency: "EUR",
          since: "2026-01-05",
          until: null,
          executionCount: 5,
        },
      ],
    });
    const stats = makeStats([plan]);
    renderSection(stats);
    // Step label contains the date part "2026-01"
    expect(screen.getByText(/2026-01/)).toBeInTheDocument();
  });

  it("renders a 'Detected' badge for heuristic plans", () => {
    const stats = makeStats([makePlan({ source: "heuristic" })]);
    renderSection(stats);
    expect(screen.getByText("Detected")).toBeInTheDocument();
  });

  it("renders nothing (returns null) when plans list is empty", () => {
    const stats = makeStats([]);
    const { container } = renderSection(stats);
    expect(container.firstChild).toBeNull();
  });

  it("shows multiple plans in the list", () => {
    const stats = makeStats([
      makePlan({ instrumentId: "vwce", name: "VWCE Fund" }),
      makePlan({ instrumentId: "eimi", symbol: "EIMI", name: "EM Fund", currentAmountDisplay: "25" }),
    ]);
    renderSection(stats);
    expect(screen.getByText("VWCE Fund")).toBeInTheDocument();
    expect(screen.getByText("EM Fund")).toBeInTheDocument();
  });
});
