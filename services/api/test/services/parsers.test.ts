import { describe, it, expect, afterEach } from "vitest";
import { parseCsv } from "../../src/services/parsers/csv.js";
import { parseIbkr } from "../../src/services/parsers/ibkr.js";
import { parseCoinbase } from "../../src/services/parsers/coinbase.js";
import { detectCsvFormat } from "../../src/services/parsers/detect.js";
import { ClaudeVisionParser } from "../../src/services/parsers/claude.js";
import { GeminiVisionParser } from "../../src/services/parsers/gemini.js";
import { OpenRouterVisionParser } from "../../src/services/parsers/openrouter.js";
import { buildScreenshotParser } from "../../src/services/screenshot-parser.js";

const IMAGE = { data: Buffer.from("img"), mimeType: "image/png" } as const;

// One canonical draft the mocked APIs all return, shaped like parsedTransactionSchema.
const DRAFT = {
  assetClass: "gold",
  action: "buy",
  name: "Antam Gold",
  quantity: "5",
  unit: "grams",
  price: "1150000",
  currency: "IDR",
  executedAt: "2026-02-08T00:00:00.000Z",
  confidence: 0.9,
};

// A fake fetch returning a fixed JSON body with status 200 (or a custom status).
function mockFetch(body: unknown, ok = true, status = 200): typeof fetch {
  return (async () => ({
    ok,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

const CSV = `date,action,assetClass,ticker,name,quantity,unit,price,fees,currency
2026-01-15,buy,equity,BBCA,Bank Central Asia,100,shares,9500,0,IDR
2026-02-08,buy,gold,GOLD,Antam Gold,5,grams,1150000,0,IDR`;

describe("buildScreenshotParser (selection)", () => {
  const KEYS = [
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "OPENROUTER_API_KEY",
    "SCREENSHOT_PARSER",
  ] as const;
  const saved: Record<string, string | undefined> = {};
  for (const k of KEYS) saved[k] = process.env[k];

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  function clear() {
    for (const k of KEYS) delete process.env[k];
  }

  it("auto-selects the first configured parser (claude → gemini → openrouter)", () => {
    clear();
    process.env.GEMINI_API_KEY = "g";
    process.env.OPENROUTER_API_KEY = "o";
    expect(buildScreenshotParser().name).toBe("gemini");
  });

  it("honours a pinned SCREENSHOT_PARSER even over the order", () => {
    clear();
    process.env.ANTHROPIC_API_KEY = "a";
    process.env.SCREENSHOT_PARSER = "openrouter";
    expect(buildScreenshotParser().name).toBe("openrouter");
  });

  it("falls back to an inert claude parser when nothing is configured", () => {
    clear();
    const p = buildScreenshotParser();
    expect(p.name).toBe("claude");
    expect(p.isConfigured()).toBe(false);
  });
});

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

describe("detectCsvFormat", () => {
  it("detects a DKB depot snapshot header", () => {
    expect(detectCsvFormat('"Datum der Erstellung";"08.06.2026"\n')).toBe("dkb");
    // BOM-prefixed exports are still recognised.
    expect(detectCsvFormat('﻿"Datum der Erstellung";x')).toBe("dkb");
  });

  it("detects a DKB Girokonto Umsatzliste by its column headers", () => {
    const giro = '"Girokonto";"DE.."\n"Buchungsdatum";"Wertstellung";"Verwendungszweck";"Betrag (€)"';
    expect(detectCsvFormat(giro)).toBe("dkb");
  });

  it("detects an IBKR Flex Trades export by TradePrice + CurrencyPrimary", () => {
    expect(detectCsvFormat(IBKR_CSV)).toBe("ibkr");
  });

  it("detects a Coinbase export by Quantity Transacted", () => {
    expect(detectCsvFormat(COINBASE_CSV)).toBe("coinbase");
  });

  it("treats the generic column CSV (and anything else) as generic", () => {
    expect(detectCsvFormat(CSV)).toBe("generic");
    expect(detectCsvFormat("")).toBe("generic");
  });
});

const IBKR_CSV = [
  "Symbol,DateTime,Quantity,TradePrice,IBCommission,CurrencyPrimary,AssetClass,Description,TradeID",
  'AAPL,"20260115;093000",10,190.50,-1.00,USD,STK,"APPLE INC",111',
  'TSLA,"2026-01-16, 10:00:00",-5,250.00,-1.25,USD,STK,"TESLA INC",112',
  'BTC,20260117,0.5,60000,-3,USD,CRYPTO,"Bitcoin",113',
].join("\n");

const COINBASE_CSV = [
  "You can use this CSV for your records.",
  "",
  "Timestamp,Transaction Type,Asset,Quantity Transacted,Spot Price Currency,Spot Price at Transaction,Subtotal,Total,Fees and/or Spread,Notes",
  "2026-01-15T12:00:00Z,Buy,BTC,0.1,USD,60000,6000,6010,10,Bought 0.1 BTC",
  "2026-02-01T08:30:00Z,Sell,ETH,2,USD,3000,6000,5990,10,Sold 2 ETH",
  '2026-02-03T09:00:00Z,Receive,BTC,0.01,USD,61000,610,610,0,"From a friend"',
].join("\n");

describe("parseIbkr", () => {
  it("maps signed quantities to buy/sell and IBKR asset codes to classes", () => {
    const { drafts, errors } = parseIbkr(IBKR_CSV);
    expect(errors).toHaveLength(0);
    expect(drafts).toHaveLength(3);

    const [aapl, tsla, btc] = drafts;
    expect(aapl).toMatchObject({
      ticker: "AAPL",
      action: "buy",
      quantity: "10",
      price: "190.50",
      fees: "1",
      currency: "USD",
      assetClass: "equity",
      unit: "shares",
    });
    expect(aapl.executedAt).toEqual(new Date("2026-01-15"));
    expect(tsla).toMatchObject({ action: "sell", quantity: "5" });
    expect(btc).toMatchObject({ assetClass: "crypto", unit: "units", action: "buy" });
  });
});

describe("parseCoinbase", () => {
  it("parses Buy/Sell rows and skips transfers", () => {
    const { drafts, errors } = parseCoinbase(COINBASE_CSV);
    expect(errors).toHaveLength(0);
    expect(drafts).toHaveLength(2); // the Receive row is skipped
    expect(drafts[0]).toMatchObject({
      ticker: "BTC",
      action: "buy",
      assetClass: "crypto",
      unit: "units",
      quantity: "0.1",
      price: "60000",
      fees: "10",
      currency: "USD",
    });
    expect(drafts[1]).toMatchObject({ ticker: "ETH", action: "sell", quantity: "2" });
  });
});

describe("ClaudeVisionParser", () => {
  it("is inert without an API key", async () => {
    const parser = new ClaudeVisionParser("");
    expect(parser.isConfigured()).toBe(false);
    await expect(parser.parse(IMAGE)).rejects.toThrow();
  });

  it("reports configured when a key is present", () => {
    expect(new ClaudeVisionParser("sk-test").isConfigured()).toBe(true);
  });

  it("extracts drafts from a tool_use response", async () => {
    const parser = new ClaudeVisionParser("sk-test", {
      fetch: mockFetch({
        content: [{ type: "tool_use", input: { transactions: [DRAFT] } }],
      }),
    });
    const drafts = await parser.parse(IMAGE);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ assetClass: "gold", quantity: "5", unit: "grams" });
    expect(drafts[0].executedAt).toBeInstanceOf(Date);
  });

  it("throws on a non-200 response", async () => {
    const parser = new ClaudeVisionParser("sk-test", {
      fetch: mockFetch({}, false, 429),
    });
    await expect(parser.parse(IMAGE)).rejects.toThrow("claude_vision_error_429");
  });

  it("sends a PDF as a document block and an image as an image block", async () => {
    let body: { messages: { content: { type: string; source?: { media_type: string } }[] }[] };
    const capture = (async (_url: string, init: { body: string }) => {
      body = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ type: "tool_use", input: { transactions: [DRAFT] } }],
        }),
      };
    }) as unknown as typeof fetch;
    const parser = new ClaudeVisionParser("sk-test", { fetch: capture });

    await parser.parse({ data: Buffer.from("%PDF-1.4"), mimeType: "application/pdf" });
    expect(body!.messages[0].content[0]).toMatchObject({
      type: "document",
      source: { media_type: "application/pdf" },
    });

    await parser.parse(IMAGE);
    expect(body!.messages[0].content[0].type).toBe("image");
  });
});

describe("GeminiVisionParser", () => {
  it("is inert without an API key", async () => {
    const parser = new GeminiVisionParser("");
    expect(parser.isConfigured()).toBe(false);
    await expect(parser.parse(IMAGE)).rejects.toThrow();
  });

  it("extracts drafts from a JSON text response (tolerating code fences)", async () => {
    const parser = new GeminiVisionParser("g-test", {
      fetch: mockFetch({
        candidates: [
          {
            content: {
              parts: [{ text: "```json\n" + JSON.stringify({ transactions: [DRAFT] }) + "\n```" }],
            },
          },
        ],
      }),
    });
    const drafts = await parser.parse(IMAGE);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ name: "Antam Gold", currency: "IDR" });
  });

  it("throws on a non-200 response", async () => {
    const parser = new GeminiVisionParser("g-test", { fetch: mockFetch({}, false, 500) });
    await expect(parser.parse(IMAGE)).rejects.toThrow("gemini_vision_error_500");
  });
});

describe("OpenRouterVisionParser", () => {
  it("is inert without an API key", async () => {
    const parser = new OpenRouterVisionParser("");
    expect(parser.isConfigured()).toBe(false);
    await expect(parser.parse(IMAGE)).rejects.toThrow();
  });

  it("extracts drafts from a tool/function call response", async () => {
    const parser = new OpenRouterVisionParser("or-test", {
      fetch: mockFetch({
        choices: [
          {
            message: {
              tool_calls: [
                { function: { arguments: JSON.stringify({ transactions: [DRAFT] }) } },
              ],
            },
          },
        ],
      }),
    });
    const drafts = await parser.parse(IMAGE);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ assetClass: "gold", price: "1150000" });
  });

  it("throws on a non-200 response", async () => {
    const parser = new OpenRouterVisionParser("or-test", { fetch: mockFetch({}, false, 402) });
    await expect(parser.parse(IMAGE)).rejects.toThrow("openrouter_vision_error_402");
  });
});
