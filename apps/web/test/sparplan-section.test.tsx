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

function renderSection(
  stats: SparplanStats,
  extra: Partial<React.ComponentProps<typeof SparplanSection>> = {},
) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <SparplanSection data={stats} currency="EUR" locale="en" {...extra} />
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
    // Header total subtitle shows the active monthly total.
    expect(screen.getByText(/\/mo total/)).toBeInTheDocument();
    // Active-count pill.
    expect(screen.getByText("1 active")).toBeInTheDocument();
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
    // Step hint is an icon whose title tooltip carries the change ("… since 2026-01").
    expect(screen.getByTitle(/2026-01/)).toBeInTheDocument();
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

  it("renders a per-plan deviation badge and the allocation section when targets are set", () => {
    const stats = makeStats([makePlan()]);
    renderSection(stats, {
      drift: [
        {
          key: "inst-vwce",
          label: "VWCE",
          targetPct: 60,
          actualPct: 52,
          driftPct: -8,
          actualValue: "5200",
          status: "under",
        },
      ],
      contributionSplit: [{ key: "inst-vwce", amount: "150", sharePct: 100 }],
    });

    // Deviation badge (under target → signed pp).
    expect(screen.getByText("−8.0pp")).toBeInTheDocument();
    // Allocation section heading + target/now legend + recommended top-up.
    expect(screen.getByText("Allocation · target vs actual")).toBeInTheDocument();
    expect(screen.getByText("target 60%")).toBeInTheDocument();
    expect(screen.getByText("now 52%")).toBeInTheDocument();
    expect(screen.getByText(/Recommended next top-up/)).toBeInTheDocument();
  });

  it("omits the allocation section when no targets/drift are present", () => {
    renderSection(makeStats([makePlan()]));
    expect(screen.queryByText("Allocation · target vs actual")).not.toBeInTheDocument();
  });

  it("shows multiple plans in the list", () => {
    const stats = makeStats([
      makePlan({ instrumentId: "vwce", name: "VWCE Fund" }),
      makePlan({
        instrumentId: "eimi",
        symbol: "EIMI",
        name: "EM Fund",
        currentAmountDisplay: "25",
      }),
    ]);
    renderSection(stats);
    expect(screen.getByText("VWCE Fund")).toBeInTheDocument();
    expect(screen.getByText("EM Fund")).toBeInTheDocument();
  });
});
