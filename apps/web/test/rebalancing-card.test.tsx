import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import type { TargetWeight, DriftRow } from "@portfolio/api-client";

const refresh = vi.fn();
const getNetworthTargets = vi.fn<() => Promise<TargetWeight[]>>(async () => []);
const putNetworthTargets = vi.fn<() => Promise<TargetWeight[]>>(async () => []);

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ refresh }),
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));
vi.mock("@/lib/api", () => ({
  useApiClient: () => ({ getNetworthTargets, putNetworthTargets }),
}));

import { RebalancingCard, type RebalancingSlice } from "../src/components/insights/rebalancing-card";

const SLICES: RebalancingSlice[] = [
  { key: "equity", label: "Stocks", actualPct: 62 },
  { key: "gold", label: "Gold", actualPct: 20 },
  { key: "bond", label: "Bonds", actualPct: 18 },
];

const DRIFT: DriftRow[] = [
  { key: "equity", targetPct: 55, actualPct: 62, driftPct: 7, actualValue: "0", status: "over" },
  { key: "gold", targetPct: 20, actualPct: 20, driftPct: 0, actualValue: "0", status: "on_target" },
  { key: "bond", targetPct: 25, actualPct: 18, driftPct: -7, actualValue: "0", status: "under" },
];

function renderCard(drift?: DriftRow[]) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <RebalancingCard slices={SLICES} drift={drift} />
    </NextIntlClientProvider>,
  );
}

describe("RebalancingCard", () => {
  beforeEach(() => {
    refresh.mockClear();
    getNetworthTargets.mockClear();
    putNetworthTargets.mockClear();
  });

  it("read view: shows actual% and signed drift per class when targets are saved", () => {
    renderCard(DRIFT);
    expect(screen.getByText("Rebalancing")).toBeInTheDocument();
    expect(screen.getByText("62.0%")).toBeInTheDocument();
    expect(screen.getByText("+7.0pp")).toBeInTheDocument();
    expect(screen.getByText("-7.0pp")).toBeInTheDocument();
    expect(screen.getByText("Drift 7.0%")).toBeInTheDocument();
  });

  it("shows the no-targets note when the scope has no saved targets", () => {
    renderCard(undefined);
    expect(screen.getByText(/No targets set for this scope yet/)).toBeInTheDocument();
    expect(screen.queryByText(/^Drift \d/)).not.toBeInTheDocument();
  });

  it("flips to the edit form on Edit, pre-filling from actualPct, and disables Save until the sum is 100", async () => {
    renderCard(DRIFT);
    fireEvent.click(screen.getByRole("button", { name: /Edit/ }));

    await waitFor(() => expect(getNetworthTargets).toHaveBeenCalledWith("asset_class"));
    const saveButton = await screen.findByRole("button", { name: "Save targets" });
    // Existing targets pre-fill; 55+20+25 = 100 so Save should already be enabled.
    expect(saveButton).not.toBeDisabled();

    const inputs = screen.getAllByRole("spinbutton");
    fireEvent.change(inputs[0], { target: { value: "90" } });
    expect(screen.getByRole("button", { name: "Save targets" })).toBeDisabled();
    expect(screen.getByText(/must equal 100%/)).toBeInTheDocument();
  });

  it("saves targets and refreshes on Save", async () => {
    getNetworthTargets.mockResolvedValueOnce([
      { key: "equity", targetPct: 55 },
      { key: "gold", targetPct: 20 },
      { key: "bond", targetPct: 25 },
    ]);
    renderCard(DRIFT);
    fireEvent.click(screen.getByRole("button", { name: /Edit/ }));
    const saveButton = await screen.findByRole("button", { name: "Save targets" });
    fireEvent.click(saveButton);

    await waitFor(() => expect(putNetworthTargets).toHaveBeenCalledWith("asset_class", [
      { key: "equity", targetPct: 55 },
      { key: "gold", targetPct: 20 },
      { key: "bond", targetPct: 25 },
    ]));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });
});
