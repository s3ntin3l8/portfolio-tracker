import { describe, it, expect } from "vitest";
import { normalizeIsoDate, parseIso8601Utc } from "../../src/services/date-utils.js";

describe("normalizeIsoDate", () => {
  it("appends Z to naive T-date strings", () => {
    expect(normalizeIsoDate("2026-01-01T12:00:00")).toBe("2026-01-01T12:00:00Z");
  });

  it("leaves offset and Z dates untouched", () => {
    expect(normalizeIsoDate("2026-01-01T12:00:00Z")).toBe("2026-01-01T12:00:00Z");
    expect(normalizeIsoDate("2026-01-01T12:00:00+02:00")).toBe("2026-01-01T12:00:00+02:00");
  });

  it("passes through null and empty strings", () => {
    expect(normalizeIsoDate(null)).toBeNull();
    expect(normalizeIsoDate("")).toBe("");
  });
});

describe("parseIso8601Utc", () => {
  it("parses Z-suffix ISO strings", () => {
    const dt = parseIso8601Utc("2026-01-01T00:00:00Z");
    expect(dt.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("parses offset ISO strings", () => {
    const dt = parseIso8601Utc("2026-01-01T00:00:00+00:00");
    expect(dt.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("rejects garbage input", () => {
    expect(() => parseIso8601Utc("not-a-date")).toThrow();
  });
});
