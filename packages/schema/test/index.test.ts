import { describe, it, expect } from "vitest";
import {
  decimalString,
  currencyCode,
  transactionInputSchema,
  parsedTransactionSchema,
  portfolioInputSchema,
  accountHolderInputSchema,
} from "../src/index.js";

const UUID = "11111111-1111-1111-1111-111111111111";

describe("decimalString", () => {
  it("accepts decimal strings", () => {
    for (const v of ["100", "9500.50", "-5", "0"]) {
      expect(decimalString.parse(v)).toBe(v);
    }
  });
  it("rejects non-decimals", () => {
    for (const v of ["abc", "1,000", "", "1.2.3"]) {
      expect(() => decimalString.parse(v)).toThrow();
    }
  });
});

describe("currencyCode", () => {
  it("normalises to upper case", () => {
    expect(currencyCode.parse("idr")).toBe("IDR");
    expect(currencyCode.parse(" eur ")).toBe("EUR");
  });
  it("requires exactly 3 letters", () => {
    expect(() => currencyCode.parse("RUPIAH")).toThrow();
  });
});

describe("portfolioInputSchema", () => {
  it("defaults the currency to IDR and leaves the holder unset", () => {
    const parsed = portfolioInputSchema.parse({ name: "Main" });
    expect(parsed.baseCurrency).toBe("IDR");
    expect(parsed.accountHolderId).toBeUndefined();
  });
  it("accepts an account holder id and allows clearing it with null", () => {
    expect(portfolioInputSchema.parse({ name: "Kid", accountHolderId: UUID }).accountHolderId).toBe(
      UUID,
    );
    expect(portfolioInputSchema.parse({ name: "Kid", accountHolderId: null }).accountHolderId).toBe(
      null,
    );
  });
  it("rejects a non-uuid account holder id", () => {
    expect(() =>
      portfolioInputSchema.parse({ name: "X", accountHolderId: "not-a-uuid" }),
    ).toThrow();
  });
  it("trims an optional brokerage and leaves it undefined when omitted", () => {
    expect(portfolioInputSchema.parse({ name: "X" }).brokerage).toBeUndefined();
    expect(
      portfolioInputSchema.parse({ name: "X", brokerage: "  Trade Republic  " })
        .brokerage,
    ).toBe("Trade Republic");
  });
});

describe("accountHolderInputSchema", () => {
  it("defaults the type to 'other' and trims the name", () => {
    const parsed = accountHolderInputSchema.parse({ name: "  Emma  " });
    expect(parsed.name).toBe("Emma");
    expect(parsed.type).toBe("other");
    expect(parsed.birthYear).toBeUndefined();
  });
  it("accepts a child holder with a birth year", () => {
    const parsed = accountHolderInputSchema.parse({ name: "Kid", type: "child", birthYear: 2017 });
    expect(parsed).toMatchObject({ name: "Kid", type: "child", birthYear: 2017 });
  });
  it("rejects an empty name and an unknown type", () => {
    expect(() => accountHolderInputSchema.parse({ name: "" })).toThrow();
    expect(() => accountHolderInputSchema.parse({ name: "X", type: "pet" })).toThrow();
  });
});

describe("transactionInputSchema", () => {
  it("applies defaults and uppercases the currency", () => {
    const tx = transactionInputSchema.parse({
      portfolioId: UUID,
      type: "buy",
      price: "9500",
      quantity: "100",
      currency: "idr",
      executedAt: "2026-01-15T03:00:00.000Z",
    });
    expect(tx.fees).toBe("0");
    expect(tx.source).toBe("manual");
    expect(tx.currency).toBe("IDR");
    expect(tx.executedAt).toBeInstanceOf(Date);
  });

  it("rejects an invalid portfolio id and bad decimals", () => {
    expect(() =>
      transactionInputSchema.parse({
        portfolioId: "not-a-uuid",
        type: "buy",
        currency: "IDR",
        executedAt: new Date(),
      }),
    ).toThrow();

    expect(() =>
      transactionInputSchema.parse({
        portfolioId: UUID,
        type: "buy",
        price: "nine thousand",
        currency: "IDR",
        executedAt: new Date(),
      }),
    ).toThrow();
  });
});

describe("parsedTransactionSchema", () => {
  it("parses a gold-per-gram draft and coerces the date", () => {
    const parsed = parsedTransactionSchema.parse({
      assetClass: "gold",
      action: "buy",
      name: "Tabungan Emas",
      quantity: "5.25",
      unit: "grams",
      price: "1100000",
      currency: "IDR",
      executedAt: "2026-02-01",
      confidence: 0.94,
    });
    expect(parsed.unit).toBe("grams");
    expect(parsed.fees).toBe("0");
    expect(parsed.executedAt).toBeInstanceOf(Date);
  });

  it("rejects confidence outside [0,1]", () => {
    expect(() =>
      parsedTransactionSchema.parse({
        assetClass: "equity",
        action: "buy",
        quantity: "1",
        unit: "shares",
        price: "100",
        currency: "USD",
        executedAt: "2026-02-01",
        confidence: 1.5,
      }),
    ).toThrow();
  });
});
