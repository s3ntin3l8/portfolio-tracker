import { describe, it, expect } from "vitest";
import { indonesianFinalTax, ID_SALES_TAX_RATE, ID_DIVIDEND_TAX_RATE } from "../src/tax-id.js";

describe("indonesianFinalTax", () => {
  it("has the expected flat rates", () => {
    expect(ID_SALES_TAX_RATE).toBe("0.001");
    expect(ID_DIVIDEND_TAX_RATE).toBe("0.10");
  });

  it("returns all zeros for an empty input", () => {
    const result = indonesianFinalTax({ disposals: [], dividends: [], byYear: [] });
    expect(result.disposals).toEqual([]);
    expect(result.totalProceeds).toBe("0.00");
    expect(result.totalSalesTax).toBe("0.00");
    expect(result.dividends).toEqual([]);
    expect(result.totalDividendGross).toBe("0.00");
    expect(result.totalDividendTax).toBe("0.00");
    expect(result.totalDividendNet).toBe("0.00");
    expect(result.estimatedTax).toBe("0.00");
    expect(result.byYear).toEqual([]);
  });

  it("computes 0.1% sales tax per disposal and totals", () => {
    const result = indonesianFinalTax({
      disposals: [
        { symbol: "BBNI", when: "2026-05-18", proceeds: "1640000" },
        { symbol: "ARTO", when: "2026-05-02", proceeds: "2490000" },
        { symbol: "TLKM", when: "2026-06-24", proceeds: "602000" },
      ],
      dividends: [],
      byYear: [],
    });

    expect(result.disposals).toEqual([
      { symbol: "BBNI", when: "2026-05-18", proceeds: "1640000", tax: "1640.00" },
      { symbol: "ARTO", when: "2026-05-02", proceeds: "2490000", tax: "2490.00" },
      { symbol: "TLKM", when: "2026-06-24", proceeds: "602000", tax: "602.00" },
    ]);
    expect(result.totalProceeds).toBe("4732000.00");
    expect(result.totalSalesTax).toBe("4732.00");
    expect(result.estimatedTax).toBe("4732.00");
  });

  it("computes 10% dividend tax and gross/net split per row and totals", () => {
    const result = indonesianFinalTax({
      disposals: [],
      dividends: [
        { symbol: "BBCA", currency: "IDR", gross: "420000" },
        { symbol: "ORI023", currency: "IDR", gross: "312000" },
        { symbol: "BBRI", currency: "IDR", gross: "268000" },
        { symbol: "TLKM", currency: "IDR", gross: "168000" },
      ],
      byYear: [],
    });

    expect(result.dividends).toEqual([
      { symbol: "BBCA", currency: "IDR", gross: "420000", tax: "42000.00", net: "378000.00" },
      { symbol: "ORI023", currency: "IDR", gross: "312000", tax: "31200.00", net: "280800.00" },
      { symbol: "BBRI", currency: "IDR", gross: "268000", tax: "26800.00", net: "241200.00" },
      { symbol: "TLKM", currency: "IDR", gross: "168000", tax: "16800.00", net: "151200.00" },
    ]);
    expect(result.totalDividendGross).toBe("1168000.00");
    expect(result.totalDividendTax).toBe("116800.00");
    expect(result.totalDividendNet).toBe("1051200.00");
    expect(result.estimatedTax).toBe("116800.00");
  });

  it("estimatedTax sums sales tax and dividend tax together", () => {
    const result = indonesianFinalTax({
      disposals: [{ symbol: "BBNI", when: "2026-05-18", proceeds: "1000000" }],
      dividends: [{ symbol: "BBCA", currency: "IDR", gross: "500000" }],
      byYear: [],
    });
    // Sales tax: 1000 (0.1% of 1,000,000). Dividend tax: 50,000 (10% of 500,000).
    expect(result.totalSalesTax).toBe("1000.00");
    expect(result.totalDividendTax).toBe("50000.00");
    expect(result.estimatedTax).toBe("51000.00");
  });

  it("rounds fractional-rupiah tax to 2 decimal places without losing precision", () => {
    const result = indonesianFinalTax({
      disposals: [{ symbol: "X", when: "2026-01-01", proceeds: "333.33" }],
      dividends: [{ symbol: "Y", currency: "IDR", gross: "10.005" }],
      byYear: [],
    });
    // 333.33 * 0.001 = 0.33333 -> 0.33
    expect(result.disposals[0].tax).toBe("0.33");
    // 10.005 * 0.10 = 1.0005 -> 1.00 (rounds half-up per decimal.js default).
    // net is computed from the UNROUNDED tax (10.005 - 1.0005 = 9.0045), then
    // rounded independently — so it isn't simply gross-minus-displayed-tax.
    expect(result.dividends[0].tax).toBe("1.00");
    expect(result.dividends[0].net).toBe("9.00");
  });

  it("builds a by-year rollup with tax computed per year, sorted newest first", () => {
    const result = indonesianFinalTax({
      disposals: [],
      dividends: [],
      byYear: [
        { year: 2024, proceeds: "760000", dividendGross: "980000", realized: "760000" },
        { year: 2026, proceeds: "324000", dividendGross: "1284000", realized: "324000" },
        { year: 2025, proceeds: "1940000", dividendGross: "2110000", realized: "1940000" },
      ],
    });

    expect(result.byYear.map((y) => y.year)).toEqual([2026, 2025, 2024]);

    const y2026 = result.byYear.find((y) => y.year === 2026)!;
    // Sales tax: 324000 * 0.001 = 324.00. Dividend tax: 1284000 * 0.10 = 128400.00.
    expect(y2026.tax).toBe("128724.00");
    expect(y2026.realized).toBe("324000.00");
    expect(y2026.dividends).toBe("1284000.00");

    const y2025 = result.byYear.find((y) => y.year === 2025)!;
    // Sales tax: 1940000 * 0.001 = 1940.00. Dividend tax: 2110000 * 0.10 = 211000.00.
    expect(y2025.tax).toBe("212940.00");

    const y2024 = result.byYear.find((y) => y.year === 2024)!;
    // Sales tax: 760000 * 0.001 = 760.00. Dividend tax: 980000 * 0.10 = 98000.00.
    expect(y2024.tax).toBe("98760.00");
  });

  it("does not mutate estimatedTax based on byYear — hero figure is selected-year only", () => {
    const result = indonesianFinalTax({
      disposals: [{ symbol: "A", when: "2026-01-01", proceeds: "100000" }],
      dividends: [],
      byYear: [{ year: 2025, proceeds: "9999999", dividendGross: "9999999", realized: "0" }],
    });
    // estimatedTax must come only from the selected-year disposals/dividends inputs,
    // not from unrelated byYear totals for other years.
    expect(result.estimatedTax).toBe("100.00");
  });

  it("passes instrumentId through to disposal rows (for client-side row-key disambiguation)", () => {
    // indonesianFinalTax constructs IdDisposalTax by spreading the input row
    // (`{ ...r, tax: tax.toFixed(2) }`). The web tier relies on this pass-through
    // so that IdSalesTable can key its rows on `instrumentId` instead of `symbol`,
    // avoiding React-key + expand-state collisions between distinct instruments
    // that share a displayed symbol (dual-listed tickers, the
    // `instrumentId.slice(0, 8)` fallback for unnamed instruments). If a future
    // refactor replaces the spread with an explicit field list, this test catches
    // the silent break before it reaches production.
    const result = indonesianFinalTax({
      disposals: [
        { instrumentId: "inst-A", symbol: "DUP", when: "2026-05-15", proceeds: "100" },
        { instrumentId: "inst-B", symbol: "DUP", when: "2026-05-15", proceeds: "200" },
      ],
      dividends: [],
      byYear: [],
    });
    expect(result.disposals[0]?.instrumentId).toBe("inst-A");
    expect(result.disposals[1]?.instrumentId).toBe("inst-B");
    // And the rest of the row is still computed normally.
    expect(result.disposals[0]?.tax).toBe("0.10");
    expect(result.disposals[1]?.tax).toBe("0.20");
  });
});
