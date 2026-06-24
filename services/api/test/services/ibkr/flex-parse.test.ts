import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFlexXml, parseIbkrDate } from "../../../src/services/ibkr/flex-parse.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, "../../fixtures/ibkr");

function loadFixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), "utf8");
}

describe("parseIbkrDate", () => {
  it("parses ISO date", () => {
    expect(parseIbkrDate("2024-02-15")).toBe("2024-02-15");
  });

  it("parses compact date", () => {
    expect(parseIbkrDate("20240215")).toBe("2024-02-15");
  });

  it("parses ISO date with time", () => {
    expect(parseIbkrDate("2024-02-15;09:30:00")).toBe("2024-02-15");
    expect(parseIbkrDate("2024-02-15, 09:30:00")).toBe("2024-02-15");
  });

  it("parses compact date with time", () => {
    expect(parseIbkrDate("20240215;093000")).toBe("2024-02-15");
  });

  it("returns null for empty string", () => {
    expect(parseIbkrDate("")).toBeNull();
  });

  it("returns null for garbage", () => {
    expect(parseIbkrDate("NOT_A_DATE")).toBeNull();
  });
});

describe("parseFlexXml", () => {
  it("parses the activity fixture and returns one statement", () => {
    const xml = loadFixture("activity.xml");
    const statements = parseFlexXml(xml);
    expect(statements).toHaveLength(1);
    const stmt = statements[0]!;
    expect(stmt.accountId).toBe("U1234567");
    expect(stmt.fromDate).toBe("2024-01-01");
    expect(stmt.toDate).toBe("2024-12-31");
  });

  it("parses trades", () => {
    const xml = loadFixture("activity.xml");
    const [stmt] = parseFlexXml(xml);
    expect(stmt!.trades).toHaveLength(3);

    const aapl = stmt!.trades.find((t) => t.tradeID === "1001")!;
    expect(aapl.symbol).toBe("AAPL");
    expect(aapl.isin).toBe("US0378331005");
    expect(aapl.buySell).toBe("BUY");
    expect(aapl.quantity).toBe("10");
    expect(aapl.tradePrice).toBe("184.92");
    expect(aapl.ibCommission).toBe("-0.35");
    expect(aapl.currency).toBe("USD");
    expect(aapl.tradeDate).toBe("2024-02-15");
    expect(aapl.assetCategory).toBe("STK");
  });

  it("parses cash transactions", () => {
    const [stmt] = parseFlexXml(loadFixture("activity.xml"));
    // All 5 cash transactions should be present (including WHT, deposit, withdrawal, interest).
    expect(stmt!.cashTransactions).toHaveLength(5);

    const div = stmt!.cashTransactions.find((t) => t.transactionID === "5001")!;
    expect(div.type).toBe("Dividends");
    expect(div.amount).toBe("2.13");
    expect(div.symbol).toBe("AAPL");
  });

  it("parses transfers", () => {
    const [stmt] = parseFlexXml(loadFixture("activity.xml"));
    expect(stmt!.transfers).toHaveLength(1);
    const xfer = stmt!.transfers[0]!;
    expect(xfer.symbol).toBe("MSFT");
    expect(xfer.direction).toBe("IN");
    expect(xfer.costBasisMoney).toBe("6200.00");
  });

  it("parses open positions", () => {
    const [stmt] = parseFlexXml(loadFixture("activity.xml"));
    expect(stmt!.openPositions).toHaveLength(2);
    const aapl = stmt!.openPositions.find((p) => p.symbol === "AAPL")!;
    expect(aapl.position).toBe("5");
    expect(aapl.markPrice).toBe("243.01");
    expect(aapl.costBasisPrice).toBe("184.92");
  });

  it("parses cash report", () => {
    const [stmt] = parseFlexXml(loadFixture("activity.xml"));
    expect(stmt!.cashReport).toHaveLength(2);
    const usd = stmt!.cashReport.find((c) => c.currency === "USD")!;
    expect(usd.endingCash).toBe("2345.67");
  });

  it("throws on non-Flex XML", () => {
    expect(() => parseFlexXml("<root><child/></root>")).toThrow(
      "root element must be <FlexQueryResponse>",
    );
  });

  it("returns empty array for empty FlexStatements", () => {
    const xml = `<?xml version="1.0"?><FlexQueryResponse><FlexStatements count="0"/></FlexQueryResponse>`;
    expect(parseFlexXml(xml)).toEqual([]);
  });

  it("throws on malformed XML (fast-xml-parser is lenient, but a completely empty string errors)", () => {
    // parseFlexXml wraps parser output — missing root → throws our error
    expect(() => parseFlexXml("not xml at all")).toThrow();
  });
});
