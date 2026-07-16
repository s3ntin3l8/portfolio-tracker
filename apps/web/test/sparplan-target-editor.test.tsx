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
}));
// Return a STABLE client (like the real useMemo-based useApiClient) so the editor's
// mount effect doesn't re-run every render. Lazily built on first call to dodge the
// import-hoist ordering of the vi.fn() consts.
vi.mock("@/lib/api", () => {
  let client: {
    getPortfolioTargets: typeof getPortfolioTargets;
    putPortfolioTargets: typeof putPortfolioTargets;
  } | null = null;
  return {
    useApiClient: () => (client ??= { getPortfolioTargets, putPortfolioTargets }),
  };
});

import {
  SparplanTargetEditor,
  type TargetSleeve,
} from "../src/components/savings/sparplan-target-editor";

const SLEEVES: TargetSleeve[] = [
  { key: "vwce", name: "VWCE", color: "#7C5CFC" },
  { key: "gold", name: "Gold", color: "#C98A1E" },
];

function renderEditor(onClose = vi.fn()) {
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <SparplanTargetEditor portfolioId="pf-1" sleeves={SLEEVES} onClose={onClose} />
    </NextIntlClientProvider>,
  );
  return onClose;
}

describe("SparplanTargetEditor", () => {
  beforeEach(() => {
    refresh.mockClear();
    getPortfolioTargets.mockReset();
    putPortfolioTargets.mockReset();
    getPortfolioTargets.mockResolvedValue([]);
    putPortfolioTargets.mockResolvedValue([]);
  });

  it("seeds inputs from saved targets and renders a row per sleeve", async () => {
    getPortfolioTargets.mockResolvedValue([
      { key: "vwce", targetPct: 60 },
      { key: "gold", targetPct: 40 },
    ]);
    renderEditor();

    expect(await screen.findByText("Target allocation")).toBeInTheDocument();
    const vwce = (await screen.findByLabelText("VWCE")) as HTMLInputElement;
    const gold = screen.getByLabelText("Gold") as HTMLInputElement;
    expect(vwce.value).toBe("60");
    expect(gold.value).toBe("40");
    // 60 + 40 = 100 → valid total, no "must equal" suffix.
    expect(screen.getByText("Total 100.0%")).toBeInTheDocument();
  });

  it("flags an invalid total and blocks save until it equals 100", async () => {
    getPortfolioTargets.mockResolvedValue([{ key: "vwce", targetPct: 60 }]);
    renderEditor();

    // Only 60 seeded → total 60 → must-equal warning present.
    expect(await screen.findByText(/must equal 100%/)).toBeInTheDocument();

    fireEvent.click(screen.getByText("Save targets"));
    expect(putPortfolioTargets).not.toHaveBeenCalled();

    // Complete to 100 and save.
    fireEvent.change(screen.getByLabelText("Gold"), { target: { value: "40" } });
    fireEvent.click(screen.getByText("Save targets"));

    await waitFor(() => expect(putPortfolioTargets).toHaveBeenCalledTimes(1));
    expect(putPortfolioTargets).toHaveBeenCalledWith("pf-1", "instrument", [
      { key: "vwce", targetPct: 60 },
      { key: "gold", targetPct: 40 },
    ]);
    expect(refresh).toHaveBeenCalled();
  });

  it("closes without saving on Cancel", async () => {
    const onClose = renderEditor();
    await screen.findByText("Target allocation");
    fireEvent.click(screen.getByText("Cancel"));
    expect(onClose).toHaveBeenCalled();
    expect(putPortfolioTargets).not.toHaveBeenCalled();
  });
});
