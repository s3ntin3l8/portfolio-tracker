import { describe, it, expect } from "vitest";
import { formatDecimal } from "../../../src/services/parsers/numeric.js";

describe("formatDecimal", () => {
  it("trims trailing zeros and the decimal point", () => {
    expect(formatDecimal(1.5)).toBe("1.5");
    expect(formatDecimal(2)).toBe("2");
    expect(formatDecimal(100.0)).toBe("100");
    expect(formatDecimal(0.25)).toBe("0.25");
  });

  it("normalizes zero, signed zero, and tiny rounding noise to \"0\"", () => {
    expect(formatDecimal(0)).toBe("0");
    expect(formatDecimal(-0)).toBe("0");
    // Below the precision floor → rounds to -0.0000000000 → must not leak as "-0".
    expect(formatDecimal(-0.00000000001)).toBe("0");
  });

  it("returns \"0\" for non-finite input", () => {
    expect(formatDecimal(NaN)).toBe("0");
    expect(formatDecimal(Infinity)).toBe("0");
    expect(formatDecimal(-Infinity)).toBe("0");
  });

  it("keeps negatives and reconstructed per-share precision", () => {
    expect(formatDecimal(-3.14)).toBe("-3.14");
    // A typical reconstructed per-share price: (amount - fees) / shares.
    expect(formatDecimal((100 - 1) / 3)).toBe("33");
    expect(formatDecimal(10 / 3)).toBe("3.3333333333");
  });

  it("respects an explicit precision", () => {
    expect(formatDecimal(10 / 3, 2)).toBe("3.33");
    expect(formatDecimal(1.005, 2)).toBe("1");
  });
});
