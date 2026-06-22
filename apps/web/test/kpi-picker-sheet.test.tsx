import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock("@/lib/api", () => ({
  useApiClient: () => ({
    putPreferences: vi.fn().mockResolvedValue({ dashboardPeriod: "max", dashboardKpis: null }),
  }),
}));

const { KpiPickerSheet } = await import("../src/components/kpi-picker-sheet");

function renderWithIntl(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      {ui}
    </NextIntlClientProvider>,
  );
}

describe("KpiPickerSheet", () => {
  it("renders the settings button", () => {
    renderWithIntl(<KpiPickerSheet currentKpis={null} />);
    // The sr-only text should exist in the DOM
    expect(screen.getByText("Customize dashboard")).toBeInTheDocument();
  });

  it("renders with pre-selected KPIs", () => {
    renderWithIntl(<KpiPickerSheet currentKpis={["netWorth", "xirr"]} />);
    expect(screen.getByText("Customize dashboard")).toBeInTheDocument();
  });
});
