import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import type { TargetWeight } from "@portfolio/api-client";

const refresh = vi.fn();
const getPortfolioTargets = vi.fn<() => Promise<TargetWeight[]>>(async () => []);
const putPortfolioTargets = vi.fn<() => Promise<TargetWeight[]>>(async () => []);

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ refresh }),
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));
vi.mock("@/lib/api", () => ({
  useApiClient: () => ({ getPortfolioTargets, putPortfolioTargets }),
}));

import { RebalanceDialog } from "../src/components/savings/rebalance-dialog";
import type { DetectedPlan } from "@portfolio/api-client";

const PLANS: DetectedPlan[] = [
  {
    instrumentId: "inst-world",
    currency: "EUR",
    cadenceMonths: 1,
    currentAmount: "70",
    currentAmountDisplay: "70",
    status: "active",
    firstExecution: "2026-01-05",
    lastExecution: "2026-05-05",
    executionCount: 5,
    source: "tagged",
    levels: [{ amount: "70", amountDisplay: "70", currency: "EUR", since: "2026-01-05", until: null, executionCount: 5 }],
    name: "Vanguard FTSE All-World",
    symbol: "VWCE",
  } as DetectedPlan & { name: string; symbol: string },
  {
    instrumentId: "inst-em",
    currency: "EUR",
    cadenceMonths: 1,
    currentAmount: "30",
    currentAmountDisplay: "30",
    status: "active",
    firstExecution: "2026-01-05",
    lastExecution: "2026-05-05",
    executionCount: 5,
    source: "tagged",
    levels: [{ amount: "30", amountDisplay: "30", currency: "EUR", since: "2026-01-05", until: null, executionCount: 5 }],
    name: "iShares EM IMI",
    symbol: "EIMI",
  } as DetectedPlan & { name: string; symbol: string },
];

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <NextIntlClientProvider locale="en" messages={messages}>
      {children}
    </NextIntlClientProvider>
  );
}

describe("RebalanceDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPortfolioTargets.mockResolvedValue([]);
    putPortfolioTargets.mockResolvedValue([]);
  });

  it("renders the trigger button", () => {
    render(
      <Wrapper>
        <RebalanceDialog
          portfolioId="pf-1"
          plans={PLANS}
          activeMonthlyTotalDisplay="100"
          currency="EUR"
        />
      </Wrapper>,
    );
    expect(screen.getByRole("button", { name: /set target split/i })).toBeInTheDocument();
  });

  it("opens the dialog and shows one row per plan", async () => {
    render(
      <Wrapper>
        <RebalanceDialog
          portfolioId="pf-1"
          plans={PLANS}
          activeMonthlyTotalDisplay="100"
          currency="EUR"
        />
      </Wrapper>,
    );

    fireEvent.click(screen.getByRole("button", { name: /set target split/i }));

    await waitFor(() => {
      expect(screen.getByText("Vanguard FTSE All-World")).toBeInTheDocument();
      expect(screen.getByText("iShares EM IMI")).toBeInTheDocument();
    });
  });

  it("pre-fills existing targets when targets are returned from the API", async () => {
    getPortfolioTargets.mockResolvedValue([
      { key: "inst-world", targetPct: 70 },
      { key: "inst-em", targetPct: 30 },
    ]);

    render(
      <Wrapper>
        <RebalanceDialog
          portfolioId="pf-1"
          plans={PLANS}
          activeMonthlyTotalDisplay="100"
          currency="EUR"
        />
      </Wrapper>,
    );

    fireEvent.click(screen.getByRole("button", { name: /set target split/i }));

    await waitFor(() => {
      const inputs = screen.getAllByRole("spinbutton");
      // Two inputs: VWCE=70, EIMI=30
      expect(inputs.some((i) => (i as HTMLInputElement).value === "70")).toBe(true);
      expect(inputs.some((i) => (i as HTMLInputElement).value === "30")).toBe(true);
    });
  });

  it("shows sum-validation error when percentages do not sum to 100", async () => {
    getPortfolioTargets.mockResolvedValue([
      { key: "inst-world", targetPct: 80 },
      { key: "inst-em", targetPct: 10 },
    ]);

    render(
      <Wrapper>
        <RebalanceDialog
          portfolioId="pf-1"
          plans={PLANS}
          activeMonthlyTotalDisplay="100"
          currency="EUR"
        />
      </Wrapper>,
    );

    fireEvent.click(screen.getByRole("button", { name: /set target split/i }));

    await waitFor(() => {
      // 80 + 10 = 90, must equal 100
      expect(screen.getByText(/Must equal 100%/i)).toBeInTheDocument();
    });

    // Save button should be disabled.
    const saveBtn = screen.getByRole("button", { name: /save targets/i });
    expect(saveBtn).toBeDisabled();
  });

  it("enables save button and calls putPortfolioTargets when sum equals 100", async () => {
    getPortfolioTargets.mockResolvedValue([
      { key: "inst-world", targetPct: 70 },
      { key: "inst-em", targetPct: 30 },
    ]);

    render(
      <Wrapper>
        <RebalanceDialog
          portfolioId="pf-1"
          plans={PLANS}
          activeMonthlyTotalDisplay="100"
          currency="EUR"
        />
      </Wrapper>,
    );

    fireEvent.click(screen.getByRole("button", { name: /set target split/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /save targets/i })).not.toBeDisabled();
    });

    fireEvent.click(screen.getByRole("button", { name: /save targets/i }));

    await waitFor(() => {
      expect(putPortfolioTargets).toHaveBeenCalledWith(
        "pf-1",
        "instrument",
        expect.arrayContaining([
          expect.objectContaining({ key: "inst-world", targetPct: 70 }),
          expect.objectContaining({ key: "inst-em", targetPct: 30 }),
        ]),
      );
    });
  });

  it("shows recommended split section when drift and contributionSplit are provided", async () => {
    getPortfolioTargets.mockResolvedValue([
      { key: "inst-world", targetPct: 70 },
      { key: "inst-em", targetPct: 30 },
    ]);

    render(
      <Wrapper>
        <RebalanceDialog
          portfolioId="pf-1"
          plans={PLANS}
          activeMonthlyTotalDisplay="100"
          currency="EUR"
          drift={[
            { key: "inst-world", targetPct: 70, actualPct: 70, driftPct: 0, actualValue: "700", status: "on_target" },
            { key: "inst-em", targetPct: 30, actualPct: 30, driftPct: 0, actualValue: "300", status: "on_target" },
          ]}
          contributionSplit={[
            { key: "inst-world", amount: "70", sharePct: 70 },
            { key: "inst-em", amount: "30", sharePct: 30 },
          ]}
        />
      </Wrapper>,
    );

    fireEvent.click(screen.getByRole("button", { name: /set target split/i }));

    await waitFor(() => {
      expect(screen.getByText(/recommended monthly split/i)).toBeInTheDocument();
    });
  });
});
