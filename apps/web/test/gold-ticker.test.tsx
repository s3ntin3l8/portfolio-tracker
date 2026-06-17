import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";

// Mock the api hook so the ticker doesn't need a session provider.
const { getQuote } = vi.hoisted(() => ({ getQuote: vi.fn() }));
vi.mock("../src/lib/api", () => ({ useApiClient: () => ({ getQuote }) }));

import { GoldTicker } from "../src/components/gold-ticker";

function renderTicker(currency = "EUR") {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <GoldTicker currency={currency} />
    </NextIntlClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  getQuote.mockReset();
});

describe("GoldTicker", () => {
  it("passes the currency prop into the quote request and displays the result", async () => {
    getQuote.mockResolvedValue({
      symbol: "GOLD",
      market: "XAU",
      assetClass: "gold",
      currency: "EUR",
      price: "119.60",
      asOf: "2026-02-08T03:00:00.000Z",
    });

    renderTicker("EUR");

    await waitFor(() =>
      expect(screen.getByText(/as of/i)).toBeInTheDocument(),
    );
    expect(getQuote).toHaveBeenCalledWith({
      symbol: "GOLD",
      market: "XAU",
      assetClass: "gold",
      currency: "EUR",
    });
    expect(screen.getByText(messages.Gold.title)).toBeInTheDocument();
  });

  it("requests the correct currency when rendered with IDR", async () => {
    getQuote.mockResolvedValue({
      symbol: "GOLD",
      market: "XAU",
      assetClass: "gold",
      currency: "IDR",
      price: "1150000",
      asOf: "2026-02-08T03:00:00.000Z",
    });

    renderTicker("IDR");

    await waitFor(() => expect(getQuote).toHaveBeenCalled());
    expect(getQuote).toHaveBeenCalledWith({
      symbol: "GOLD",
      market: "XAU",
      assetClass: "gold",
      currency: "IDR",
    });
  });

  it("renders nothing when no quote source is reachable", async () => {
    getQuote.mockRejectedValue(new Error("unavailable"));

    renderTicker();

    await waitFor(() => expect(getQuote).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.queryByText(messages.Gold.title)).toBeNull(),
    );
  });
});
