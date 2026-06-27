import { describe, it, expect } from "vitest";
import {
  parserToTxSource,
  classifyMatch,
  actionClass,
  findCrossSourceDuplicates,
} from "../../../src/services/parsers/dedup.js";

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

  // Contract guard: classifyMatch takes a *raw parser tag* and converts it internally.
  // Passing an already-converted tx source double-converts ("pdf" → "screenshot"), which is
  // the bug fixed in the /duplicates route — pin both behaviours so it can't silently return.
  it("dkb-pdf import (raw tag) vs csv tx → enrichment (pdf ≠ csv)", () => {
    expect(classifyMatch("dkb-pdf", "csv", true)).toBe("enrichment");
  });

  it("dkb-pdf import vs pdf tx (same source) → duplicate", () => {
    expect(classifyMatch("dkb-pdf", "pdf", true)).toBe("duplicate");
  });

  it("WRONG usage: pre-converted 'pdf' source double-converts to screenshot", () => {
    // Demonstrates why callers must pass the raw tag, not parserToTxSource(parser).
    expect(parserToTxSource("dkb-pdf")).toBe("pdf");
    expect(classifyMatch(parserToTxSource("dkb-pdf"), "pdf", true)).toBe("enrichment");
  });
});

describe("actionClass — bonus folds into the acquire class", () => {
  it("buy, savings_plan and bonus all share the acquire class", () => {
    expect(actionClass("buy")).toBe("acquire");
    expect(actionClass("savings_plan")).toBe("acquire");
    // A perk-funded buy that one source collapses into a `bonus` must still dedup against
    // the same trade arriving as a plain buy from another source (CSV bonus vs synced buy).
    expect(actionClass("bonus")).toBe("acquire");
    expect(actionClass("sell")).toBe("sell");
  });

  it("dedups a collapsed `bonus` draft against a committed `buy` of the same shares", () => {
    const committed = [
      {
        key: "inst-1",
        action: "buy",
        quantity: "2.7104",
        price: "37.335",
        executedAt: new Date("2025-08-26"),
        externalId: "tr-csv:buy",
      },
    ];
    const drafts = [
      {
        key: "inst-1",
        action: "bonus",
        quantity: "2.7104",
        price: "37.335",
        executedAt: new Date("2025-08-26"),
      },
    ];
    const matches = findCrossSourceDuplicates(drafts, committed);
    expect(matches).toHaveLength(1);
    expect(matches[0].matched.externalId).toBe("tr-csv:buy");
  });
});
