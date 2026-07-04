import { describe, it, expect } from "vitest";
import { INSTRUMENT_PRICE_RANGES, toApiRange } from "../src/lib/instrument-price-range";

describe("instrument-price-range", () => {
  it("is exactly the 1M/6M/1Y/All vocabulary (no 1D/7D/3M/YTD)", () => {
    expect(INSTRUMENT_PRICE_RANGES).toEqual(["1m", "6m", "1y", "all"]);
  });

  it("maps each app-level token to the provider chain's own vocabulary", () => {
    expect(toApiRange("1m")).toBe("1mo");
    expect(toApiRange("6m")).toBe("6mo");
    expect(toApiRange("1y")).toBe("1y");
    expect(toApiRange("all")).toBe("max");
  });
});
