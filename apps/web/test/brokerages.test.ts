import { describe, it, expect } from "vitest";
import { resolveBrokerage, monogram, tintFor, KNOWN_BROKERAGES } from "../src/lib/brokerages";

describe("resolveBrokerage", () => {
  it("matches a known brokerage by label, case- and punctuation-insensitively", () => {
    expect(resolveBrokerage("Trade Republic")?.key).toBe("trade-republic");
    expect(resolveBrokerage("  trade republic  ")?.key).toBe("trade-republic");
    expect(resolveBrokerage("TRADE-REPUBLIC")?.key).toBe("trade-republic");
  });

  it("matches via aliases", () => {
    expect(resolveBrokerage("IBKR")?.key).toBe("interactive-brokers");
    expect(resolveBrokerage("Deutsche Kreditbank")?.key).toBe("dkb");
  });

  it("returns null for unknown or empty values", () => {
    expect(resolveBrokerage("Some Local Broker")).toBeNull();
    expect(resolveBrokerage("")).toBeNull();
    expect(resolveBrokerage(null)).toBeNull();
    expect(resolveBrokerage(undefined)).toBeNull();
  });

  it("resolves a brokerage with no bundled logo (no icon field)", () => {
    expect(resolveBrokerage("Stockbit")?.icon).toBeUndefined();
  });
});

describe("monogram", () => {
  it("uses the initials of the first two words", () => {
    expect(monogram("Trade Republic")).toBe("TR");
  });

  it("uses the first two letters of a single word", () => {
    expect(monogram("Stockbit")).toBe("ST");
  });

  it("handles extra whitespace and empty input", () => {
    expect(monogram("  Bibit  ")).toBe("BI");
    expect(monogram("")).toBe("");
  });
});

describe("tintFor", () => {
  it("is deterministic for the same name", () => {
    expect(tintFor("Stockbit")).toBe(tintFor("Stockbit"));
  });

  it("returns an hsl color string", () => {
    expect(tintFor("Bibit")).toMatch(/^hsl\(\d+ \d+% \d+%\)$/);
  });
});

describe("KNOWN_BROKERAGES", () => {
  it("exposes display labels for the form datalist", () => {
    expect(KNOWN_BROKERAGES).toContain("Trade Republic");
    expect(KNOWN_BROKERAGES).toContain("Stockbit");
  });
});
