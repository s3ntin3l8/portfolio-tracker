import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { CashOnHandCard } from "../src/components/savings/cash-on-hand-card";

function renderCard(cash: Record<string, string>) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <CashOnHandCard cash={cash} locale="en" />
    </NextIntlClientProvider>,
  );
}

describe("CashOnHandCard", () => {
  it("renders nothing when there's no positive idle cash", () => {
    const { container } = renderCard({ IDR: "0", EUR: "-50" });
    expect(container).toBeEmptyDOMElement();
  });

  it("renders one row per currency with a positive balance", () => {
    renderCard({ IDR: "1850000", EUR: "300" });
    expect(screen.getByText("IDR")).toBeInTheDocument();
    expect(screen.getByText("EUR")).toBeInTheDocument();
  });

  it("excludes zero/negative-balance currencies from the row list", () => {
    renderCard({ IDR: "1850000", USD: "0" });
    expect(screen.queryByText("USD")).not.toBeInTheDocument();
  });

  it("computes a real idle-cash nudge estimate from the total (not a hardcoded figure)", () => {
    renderCard({ IDR: "1000000" });
    // 4% p.a. of Rp 1,000,000 = Rp 40,000/yr.
    expect(screen.getByText(/4%/)).toBeInTheDocument();
    expect(screen.getByText(/Rp\s*40,000|IDR\s*40,000/)).toBeInTheDocument();
  });

  it("joins multi-currency totals with a middle dot rather than summing raw numbers", () => {
    renderCard({ IDR: "1000000", EUR: "100" });
    // The header total should show both currencies, not a single mixed figure.
    const totals = screen.getAllByText(/·/);
    expect(totals.length).toBeGreaterThan(0);
  });
});
