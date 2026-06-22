import { describe, it, expect } from "vitest";
import { parserToTxSource, classifyMatch } from "../../../src/services/parsers/dedup.js";

describe("parserToTxSource", () => {
  it("maps pytr to pytr", () => {
    expect(parserToTxSource("pytr")).toBe("pytr");
  });

  it("maps csv parsers to csv", () => {
    expect(parserToTxSource("csv")).toBe("csv");
    expect(parserToTxSource("dkb")).toBe("csv");
    expect(parserToTxSource("tr-csv")).toBe("csv");
  });

  it("maps deterministic PDF parsers to pdf", () => {
    expect(parserToTxSource("dkb-pdf")).toBe("pdf");
    expect(parserToTxSource("tr-pdf")).toBe("pdf");
  });

  it("maps screenshot and unknown parsers to screenshot", () => {
    expect(parserToTxSource("screenshot")).toBe("screenshot");
    expect(parserToTxSource("mock")).toBe("screenshot");
    expect(parserToTxSource("")).toBe("screenshot");
  });
});

describe("classifyMatch", () => {
  it("screenshot import vs csv tx with enrichment value → enrichment", () => {
    expect(classifyMatch("screenshot", "csv", true)).toBe("enrichment");
  });

  it("screenshot import vs screenshot tx (same source) → duplicate", () => {
    expect(classifyMatch("screenshot", "screenshot", true)).toBe("duplicate");
  });

  it("screenshot import vs csv tx but no enrichment value → duplicate", () => {
    expect(classifyMatch("screenshot", "csv", false)).toBe("duplicate");
  });

  it("csv import vs screenshot tx with enrichment → enrichment", () => {
    expect(classifyMatch("csv", "screenshot", true)).toBe("enrichment");
  });

  it("pytr import vs csv tx with enrichment → enrichment (pytr ≠ csv)", () => {
    expect(classifyMatch("pytr", "csv", true)).toBe("enrichment");
  });

  it("csv import vs csv tx → duplicate (same source)", () => {
    expect(classifyMatch("csv", "csv", true)).toBe("duplicate");
  });

  it("dkb import vs csv tx → duplicate (dkb maps to csv, same source)", () => {
    expect(classifyMatch("dkb", "csv", true)).toBe("duplicate");
  });

  it("unknown parser vs csv tx with enrichment → enrichment (unknown maps to screenshot)", () => {
    expect(classifyMatch("vision-fallback", "csv", true)).toBe("enrichment");
  });
});
