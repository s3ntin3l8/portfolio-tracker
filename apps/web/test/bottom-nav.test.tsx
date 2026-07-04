import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { BottomNav } from "../src/components/bottom-nav";

function renderNav(props?: { anomalyCount?: number; anomalyError?: boolean }) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <BottomNav {...props} />
    </NextIntlClientProvider>,
  );
}

describe("BottomNav", () => {
  it("renders all five Pocket destinations", () => {
    renderNav();
    for (const label of ["Holdings", "Activity", "Reports", "Insights", "Profile"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it("shows the anomaly badge on Activity when there is work to review", () => {
    renderNav({ anomalyCount: 3 });
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("hides the anomaly badge when the count is zero", () => {
    renderNav({ anomalyCount: 0 });
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("caps the badge at 99+", () => {
    renderNav({ anomalyCount: 250 });
    expect(screen.getByText("99+")).toBeInTheDocument();
  });
});
