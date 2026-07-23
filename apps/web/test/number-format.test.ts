import { describe, it, expect } from "vitest";
import {
  caretForDigits,
  digitsBefore,
  formatGrouped,
  sanitizeNumericInput,
} from "../src/components/add-transaction-form/number-format";

describe("sanitizeNumericInput", () => {
  it("strips grouping commas back to a raw digit string", () => {
    expect(sanitizeNumericInput("1,234")).toBe("1234");
  });
  it("strips non-numeric characters", () => {
    expect(sanitizeNumericInput("IDR 1,234abc")).toBe("1234");
  });
  it("collapses redundant leading zeros", () => {
    expect(sanitizeNumericInput("007")).toBe("7");
    expect(sanitizeNumericInput("00")).toBe("0");
  });
  it("keeps a lone zero", () => {
    expect(sanitizeNumericInput("0")).toBe("0");
  });
  it("treats a leading dot as 0.x", () => {
    expect(sanitizeNumericInput(".5")).toBe("0.5");
  });
  it("caps the fractional part at 8 digits", () => {
    expect(sanitizeNumericInput("1.123456789")).toBe("1.12345678");
  });
  it("collapses multiple dots into one decimal point", () => {
    expect(sanitizeNumericInput("12.34.56")).toBe("12.3456");
  });
  it("preserves a leading minus sign (adjustment amounts are signed)", () => {
    expect(sanitizeNumericInput("-1,234.5")).toBe("-1234.5");
  });
  it("returns an empty string for blank input", () => {
    expect(sanitizeNumericInput("")).toBe("");
  });
});

describe("formatGrouped", () => {
  it("groups the integer part with thousands separators", () => {
    expect(formatGrouped("1234567")).toBe("1,234,567");
  });
  it("preserves the decimal part ungrouped", () => {
    expect(formatGrouped("1234.5678")).toBe("1,234.5678");
  });
  it("preserves a trailing dot while typing", () => {
    expect(formatGrouped("123.")).toBe("123.");
  });
  it("preserves a leading minus sign", () => {
    expect(formatGrouped("-1234")).toBe("-1,234");
  });
  it("returns an empty string for blank input", () => {
    expect(formatGrouped("")).toBe("");
    expect(formatGrouped(null)).toBe("");
  });
});

describe("caret preservation round-trip", () => {
  it("keeps the caret glued to the same digit after grouping is inserted", () => {
    // "1234" -> caret after "12" (2 digits before) -> becomes "1,234" -> caret after "12" still.
    const digits = digitsBefore("1234", 2);
    expect(digits).toBe(2);
    expect(caretForDigits(formatGrouped("1234"), digits)).toBe(3); // "1," + "2" -> index 3
  });

  it("keeps the caret glued to the same digit after grouping is removed", () => {
    // "1,234" caret after "1,2" (position 3) -> 2 digits before -> raw "1234" -> "1,234" caret at 3.
    const digits = digitsBefore("1,234", 3);
    expect(digits).toBe(2);
    expect(caretForDigits("1,234", digits)).toBe(3);
  });
});
