import { describe, it, expect } from "vitest";
import { Decimal } from "decimal.js";
import { forecastSeries, forecastValue } from "../src/index.js";

/** Closed-form future value: PV·(1+r)^n + C·((1+r)^n − 1)/r (r=0 → PV + C·n). */
function closedForm(PV: number, C: number, annual: number, n: number): number {
  const r = annual / 12;
  if (r === 0) return PV + C * n;
  const g = Math.pow(1 + r, n);
  return PV * g + (C * (g - 1)) / r;
}

describe("forecastSeries / forecastValue", () => {
  it("with no return, the value is just the contributions plus present value", () => {
    const v = forecastValue({
      presentValue: "0",
      monthlyContribution: "100",
      annualReturnRate: "0",
      horizonMonths: 12,
    });
    expect(v).toBe("1200");

    const series = forecastSeries({
      presentValue: "500",
      monthlyContribution: "100",
      annualReturnRate: "0",
      horizonMonths: 12,
    });
    expect(series[series.length - 1].value).toBe("1700"); // 500 + 1200
    expect(series[series.length - 1].contributed).toBe("1200");
  });

  it("compounds the present value monthly when there are no contributions", () => {
    // 1000 at 12% annual (1% monthly) for 12 months = 1000·(1.01)^12.
    const v = forecastValue({
      presentValue: "1000",
      monthlyContribution: "0",
      annualReturnRate: "0.12",
      horizonMonths: 12,
    });
    const expected = new Decimal("1.01").pow(12).mul(1000);
    expect(new Decimal(v).minus(expected).abs().lt("1e-9")).toBe(true);
  });

  it("matches the closed-form future value for a contributing, returning account", () => {
    const input = {
      presentValue: "5000",
      monthlyContribution: "250",
      annualReturnRate: "0.07",
      horizonMonths: 120,
    };
    const v = Number(forecastValue(input));
    const expected = closedForm(5000, 250, 0.07, 120);
    expect(Math.abs(v - expected)).toBeLessThan(1e-6);
  });

  it("emits horizonMonths + 1 points with strictly increasing contributions", () => {
    const series = forecastSeries({
      presentValue: "0",
      monthlyContribution: "50",
      annualReturnRate: "0.05",
      horizonMonths: 6,
    });
    expect(series).toHaveLength(7);
    expect(series[0]).toEqual({ monthIndex: 0, contributed: "0", value: "0" });
    for (let i = 1; i < series.length; i++) {
      expect(series[i].monthIndex).toBe(i);
      expect(Number(series[i].contributed)).toBeCloseTo(50 * i, 9);
    }
  });
});
