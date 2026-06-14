import { parsedTransactionSchema, type ParsedTransaction } from "@portfolio/schema";

// One JSON-Schema description of the extraction shape, reused across every cloud
// vision parser (Anthropic tool input_schema, OpenAI/OpenRouter function parameters,
// Gemini responseSchema — all accept this OpenAPI-compatible subset). It mirrors
// parsedTransactionSchema; the parser output is still validated by zod afterwards.
export const TRANSACTIONS_TOOL_SCHEMA = {
  type: "object",
  properties: {
    transactions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          assetClass: {
            type: "string",
            enum: ["equity", "gold", "bond", "mutual_fund", "etf", "crypto", "derivative"],
          },
          action: { type: "string", enum: ["buy", "sell", "dividend", "coupon"] },
          ticker: { type: "string" },
          isin: { type: "string" },
          name: { type: "string" },
          quantity: { type: "string", description: "Decimal string. Grams for gold." },
          unit: { type: "string", enum: ["shares", "grams", "units"] },
          price: { type: "string", description: "Decimal string, price per unit." },
          fees: { type: "string", description: "Decimal string, default 0." },
          total: { type: "string", description: "Decimal string, optional gross total." },
          currency: { type: "string", description: "ISO 4217, e.g. IDR." },
          executedAt: { type: "string", description: "ISO 8601 date/time." },
          confidence: { type: "number", description: "0–1 extraction confidence." },
        },
        required: [
          "assetClass",
          "action",
          "quantity",
          "unit",
          "price",
          "currency",
          "executedAt",
          "confidence",
        ],
      },
    },
  },
  required: ["transactions"],
} as const;

export const EXTRACTION_PROMPT =
  "Extract every transaction shown in this screenshot (broker order, gold app, or bank " +
  "confirmation). Use decimal strings for all amounts, grams for gold, the Indonesian " +
  "locale for parsing numbers, and a confidence between 0 and 1. Return the transactions.";

export const TOOL_NAME = "record_transactions";

// For parsers that return raw JSON text (Gemini, OpenRouter fallback) rather than a
// tool call — spells out the exact object shape so the model emits parseable JSON.
export const JSON_EXTRACTION_PROMPT = `${EXTRACTION_PROMPT}
Respond with ONLY a JSON object of the form:
{"transactions":[{
  "assetClass":"equity|gold|bond|mutual_fund|etf|crypto|derivative",
  "action":"buy|sell|dividend|coupon",
  "ticker":"string (optional)","isin":"string (optional)","name":"string (optional)",
  "quantity":"decimal string (grams for gold)","unit":"shares|grams|units",
  "price":"decimal string per unit","fees":"decimal string (optional, default 0)",
  "total":"decimal string (optional)","currency":"ISO 4217 e.g. IDR",
  "executedAt":"ISO 8601 date","confidence":0.0
}]}
No markdown, no code fences, no commentary.`;

/** Pull a JSON object out of a model's text response, tolerating code fences. */
export function parseJsonObject(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(trimmed);
}

/** Validate raw model output into draft transactions. */
export function validateDrafts(raw: unknown): ParsedTransaction[] {
  const list = Array.isArray(raw) ? raw : [];
  return list.map((r) => parsedTransactionSchema.parse(r));
}
