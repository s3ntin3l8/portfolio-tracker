import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";

const push = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/en/dashboard",
}));

const { PeriodSelector } = await import("../src/components/period-selector");

function renderWithIntl(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      {ui}
    </NextIntlClientProvider>,
  );
}

describe("PeriodSelector", () => {
  it("renders all four period chips", () => {
    renderWithIntl(<PeriodSelector current="max" />);
    expect(screen.getByText("YTD")).toBeInTheDocument();
    expect(screen.getByText("1Y")).toBeInTheDocument();
    expect(screen.getByText("5Y")).toBeInTheDocument();
    expect(screen.getByText("Max")).toBeInTheDocument();
  });

  it("highlights the current period with bg-primary class", () => {
    renderWithIntl(<PeriodSelector current="1y" />);
    const btn = screen.getByText("1Y");
    expect(btn.className).toMatch(/bg-primary/);
  });

  it("non-active periods do not have bg-primary", () => {
    renderWithIntl(<PeriodSelector current="max" />);
    const ytd = screen.getByText("YTD");
    expect(ytd.className).not.toMatch(/bg-primary/);
  });

  it("clicking a period calls router.push with period param", () => {
    push.mockClear();
    renderWithIntl(<PeriodSelector current="max" />);
    fireEvent.click(screen.getByText("1Y"));
    expect(push).toHaveBeenCalledWith(expect.stringContaining("period=1y"));
  });

  it("clicking max removes the period param", () => {
    push.mockClear();
    renderWithIntl(<PeriodSelector current="1y" />);
    fireEvent.click(screen.getByText("Max"));
    // max should remove the param — url should be just the pathname
    expect(push).toHaveBeenCalledWith("/en/dashboard");
  });
});
