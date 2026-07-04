import { describe, it, expect } from "vitest";
import { lastPriceInfo } from "../src/lib/instrument-price";

describe("lastPriceInfo", () => {
  it("returns null when there is no history at all", () => {
    expect(lastPriceInfo([], "IDR")).toBeNull();
  });

  it("returns the last close with no change when there's only one candle", () => {
    const info = lastPriceInfo([{ close: "100", currency: "IDR" }], "USD");
    expect(info).toEqual({ price: 100, currency: "IDR", change: null, changePct: null });
  });

  it("computes change and changePct vs. the prior close", () => {
    const info = lastPriceInfo(
      [
        { close: "100", currency: "IDR" },
        { close: "110", currency: "IDR" },
      ],
      "IDR",
    );
    expect(info).toEqual({ price: 110, currency: "IDR", change: 10, changePct: 0.1 });
  });

  it("falls back to the instrument's currency when a candle carries none", () => {
    const info = lastPriceInfo([{ close: "50" }], "EUR");
    expect(info?.currency).toBe("EUR");
  });

  it("returns a null changePct when the prior close was zero", () => {
    const info = lastPriceInfo(
      [
        { close: "0", currency: "IDR" },
        { close: "5", currency: "IDR" },
      ],
      "IDR",
    );
    expect(info?.change).toBe(5);
    expect(info?.changePct).toBeNull();
  });
});
