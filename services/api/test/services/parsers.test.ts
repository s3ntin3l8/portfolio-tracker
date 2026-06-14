import { describe, it, expect } from "vitest";
import { parseCsv } from "../../src/services/parsers/csv.js";
import { ClaudeVisionParser } from "../../src/services/parsers/claude.js";

const CSV = `date,action,assetClass,ticker,name,quantity,unit,price,fees,currency
2026-01-15,buy,equity,BBCA,Bank Central Asia,100,shares,9500,0,IDR
2026-02-08,buy,gold,GOLD,Antam Gold,5,grams,1150000,0,IDR`;

describe("parseCsv", () => {
  it("parses valid rows into drafts", () => {
    const { drafts, errors } = parseCsv(CSV);
    expect(errors).toHaveLength(0);
    expect(drafts).toHaveLength(2);
    expect(drafts[0]).toMatchObject({
      assetClass: "equity",
      action: "buy",
      ticker: "BBCA",
      quantity: "100",
      unit: "shares",
      currency: "IDR",
    });
    expect(drafts[0].executedAt).toBeInstanceOf(Date);
  });

  it("collects errors for invalid rows instead of failing", () => {
    const bad = `date,action,assetClass,ticker,quantity,unit,price,currency
2026-01-01,buy,equity,X,abc,shares,100,IDR`;
    const { drafts, errors } = parseCsv(bad);
    expect(drafts).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].line).toBe(2);
  });

  it("returns empty for empty/headerless input", () => {
    expect(parseCsv("").drafts).toHaveLength(0);
    expect(parseCsv("just a header line").drafts).toHaveLength(0);
  });
});

describe("ClaudeVisionParser", () => {
  it("is inert without an API key", async () => {
    const parser = new ClaudeVisionParser("");
    expect(parser.isConfigured()).toBe(false);
    await expect(
      parser.parse({ data: Buffer.from(""), mimeType: "image/png" }),
    ).rejects.toThrow();
  });

  it("reports configured when a key is present", () => {
    expect(new ClaudeVisionParser("sk-test").isConfigured()).toBe(true);
  });
});
