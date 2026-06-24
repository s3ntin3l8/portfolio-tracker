import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFlexXml } from "../../../src/services/ibkr/flex-parse.js";
import { mapFlexToDrafts } from "../../../src/services/ibkr/mapper.js";
import type { FlexStatement } from "../../../src/services/ibkr/flex-parse.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, "../../fixtures/ibkr");
const xml = readFileSync(join(FIXTURE_DIR, "activity.xml"), "utf8");

function stmt(): FlexStatement {
  return parseFlexXml(xml)[0]!;
}

describe("mapFlexToDrafts — trades", () => {
  it("maps a BUY trade correctly", () => {
    const { drafts } = mapFlexToDrafts(stmt());
    const buy = drafts.find((d) => d.externalId === "ibkr:trade:1001")!;
    expect(buy).toBeDefined();
    expect(buy.action).toBe("buy");
    expect(buy.assetClass).toBe("equity");
    expect(buy.ticker).toBe("AAPL");
    expect(buy.isin).toBe("US0378331005");
    expect(buy.quantity).toBe("10");
    expect(buy.price).toBe("184.92");
    expect(buy.fees).toBe("0.35"); // abs(ibCommission)
    expect(buy.currency).toBe("USD");
    expect(buy.fxRate).toBe("0.9231");
    expect(buy.executedAt).toEqual(new Date("2024-02-15"));
    expect(buy.unit).toBe("shares");
    expect(buy.confidence).toBe(1);
  });

  it("maps a SELL trade correctly", () => {
    const { drafts } = mapFlexToDrafts(stmt());
    const sell = drafts.find((d) => d.externalId === "ibkr:trade:1002")!;
    expect(sell).toBeDefined();
    expect(sell.action).toBe("sell");
    // quantity is absolute even for sells
    expect(sell.quantity).toBe("5");
    expect(sell.price).toBe("213.25");
  });

  it("maps an ETF buy trade", () => {
    const { drafts } = mapFlexToDrafts(stmt());
    const etf = drafts.find((d) => d.externalId === "ibkr:trade:1003")!;
    expect(etf).toBeDefined();
    expect(etf.assetClass).toBe("etf");
    expect(etf.isin).toBe("IE00B4L5Y983");
    expect(etf.quantity).toBe("50");
    expect(etf.fees).toBe("1.25");
    expect(etf.currency).toBe("EUR");
  });

  it("skips ORDER-level rows (only EXECUTION rows)", () => {
    const s = stmt();
    // Add an ORDER-level row — should be skipped
    s.trades.push({
      assetCategory: "STK",
      symbol: "AAPL",
      tradeID: "ORDER-1",
      tradeDate: "2024-02-15",
      currency: "USD",
      quantity: "10",
      tradePrice: "184.92",
      ibCommission: "-0.35",
      buySell: "BUY",
      levelOfDetail: "ORDER",
    });
    const before = mapFlexToDrafts(stmt()).drafts.length;
    const after = mapFlexToDrafts(s).drafts.length;
    expect(after).toBe(before); // ORDER row skipped
  });
});

describe("mapFlexToDrafts — dividends and withholding tax", () => {
  it("maps a dividend and folds withholding tax into tax field", () => {
    const { drafts } = mapFlexToDrafts(stmt());
    const div = drafts.find((d) => d.externalId === "ibkr:cash:5001")!;
    expect(div).toBeDefined();
    expect(div.action).toBe("dividend");
    expect(div.ticker).toBe("AAPL");
    expect(div.isin).toBe("US0378331005");
    expect(div.price).toBe("2.13"); // net amount reported by IBKR
    expect(div.tax).toBe("0.32"); // withholding tax folded in (abs value)
    expect(div.fees).toBe("0");
    expect(div.currency).toBe("USD");
    expect(div.executedAt).toEqual(new Date("2024-05-16"));
  });

  it("does not emit a separate transaction for the withholding tax row", () => {
    const { drafts } = mapFlexToDrafts(stmt());
    // transactionID 5002 is the WHT row — it must NOT appear as a standalone draft
    const wht = drafts.find((d) => d.externalId === "ibkr:cash:5002");
    expect(wht).toBeUndefined();
  });

  it("dividend without matching WHT has no tax field", () => {
    const s = stmt();
    // Remove all withholding-tax rows
    s.cashTransactions = s.cashTransactions.filter((t) => t.type !== "Withholding Tax");
    const { drafts } = mapFlexToDrafts(s);
    const div = drafts.find((d) => d.externalId === "ibkr:cash:5001");
    expect(div?.tax).toBeUndefined();
  });
});

describe("mapFlexToDrafts — cash (deposit/withdrawal/interest)", () => {
  it("maps a deposit", () => {
    const { drafts } = mapFlexToDrafts(stmt());
    const dep = drafts.find((d) => d.externalId === "ibkr:cash:6001")!;
    expect(dep).toBeDefined();
    expect(dep.action).toBe("deposit");
    expect(dep.price).toBe("10000.00");
    expect(dep.currency).toBe("EUR");
    expect(dep.executedAt).toEqual(new Date("2024-01-02"));
  });

  it("maps a withdrawal", () => {
    const { drafts } = mapFlexToDrafts(stmt());
    const wd = drafts.find((d) => d.externalId === "ibkr:cash:6002")!;
    expect(wd).toBeDefined();
    expect(wd.action).toBe("withdrawal");
    expect(wd.price).toBe("500.00"); // absolute value
    expect(wd.currency).toBe("EUR");
  });

  it("maps credit interest", () => {
    const { drafts } = mapFlexToDrafts(stmt());
    const int = drafts.find((d) => d.externalId === "ibkr:cash:7001")!;
    expect(int).toBeDefined();
    expect(int.action).toBe("interest");
    expect(int.price).toBe("18.45");
    expect(int.currency).toBe("EUR");
  });
});

describe("mapFlexToDrafts — transfers", () => {
  it("maps an incoming transfer as transfer_in", () => {
    const { drafts } = mapFlexToDrafts(stmt());
    const xfer = drafts.find(
      (d) => d.action === "transfer_in" && d.ticker === "MSFT",
    )!;
    expect(xfer).toBeDefined();
    expect(xfer.quantity).toBe("20");
    // costBasisPrice = 310.00 from the fixture
    expect(xfer.price).toBe("310.00");
    expect(xfer.currency).toBe("USD");
    expect(xfer.executedAt).toEqual(new Date("2024-04-01"));
    expect(xfer.confidence).toBe(0.85);
  });
});

describe("mapFlexToDrafts — errors", () => {
  it("reports an error for an unparseable trade date", () => {
    const s = stmt();
    s.trades.push({
      assetCategory: "STK",
      symbol: "X",
      tradeID: "BAD",
      tradeDate: "NOTADATE",
      currency: "USD",
      quantity: "1",
      tradePrice: "100",
      ibCommission: "0",
      buySell: "BUY",
    });
    const { errors } = mapFlexToDrafts(s);
    expect(errors.some((e) => e.message.includes("tradeDate"))).toBe(true);
  });
});

describe("mapFlexToDrafts — full fixture totals", () => {
  it("produces the expected number of drafts from the activity fixture", () => {
    const { drafts, errors } = mapFlexToDrafts(stmt());
    // 3 trades + 1 dividend (WHT folded) + 1 deposit + 1 withdrawal + 1 interest + 1 transfer = 8
    expect(drafts).toHaveLength(8);
    // No parse errors from the well-formed fixture
    expect(errors).toHaveLength(0);
  });

  it("all draft externalIds are unique", () => {
    const { drafts } = mapFlexToDrafts(stmt());
    const ids = drafts.map((d) => d.externalId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
