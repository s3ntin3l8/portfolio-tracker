import { describe, it, expect, afterEach } from "vitest";
import { parseCsv } from "../../src/services/parsers/csv.js";
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
