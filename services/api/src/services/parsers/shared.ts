import type { ZodSchema } from "zod";
import {
  parsedGoldContractSchema,
  parsedTransactionSchema,
  type ParsedGoldContract,
  type ParsedTransaction,
} from "@portfolio/schema";

/** Collapse internal whitespace runs to single spaces and trim. */
export function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// One JSON-Schema description of the extraction shape, reused across every cloud
// vision parser (Anthropic tool input_schema, OpenAI/OpenRouter function parameters,
// Gemini responseSchema — all accept this OpenAPI-compatible subset). It mirrors
// parsedTransactionSchema; the parser output is still validated by zod afterwards.
export const TRANSACTIONS_TOOL_SCHEMA = {
  type: "object",
  properties: {
    accountNumber: {
      type: "string",
      description:
        "The account number shown on the document (e.g. SID, IBAN, broker account ID). " +
        "Extract verbatim; null if not present.",
    },
    transactions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          assetClass: {
            type: "string",
            enum: ["equity", "gold", "bond", "mutual_fund", "etf", "crypto", "derivative"],
          },
          action: {
            type: "string",
            enum: ["buy", "sell", "dividend", "coupon", "interest", "savings_plan", "bonus"],
          },
          ticker: { type: "string" },
          isin: { type: "string" },
          wkn: { type: "string" },
          name: { type: "string" },
          quantity: { type: "string", description: "Decimal string. Grams for gold." },
          unit: { type: "string", enum: ["shares", "grams", "units"] },
          price: {
            type: "string",
            description:
              "Decimal string. For a trade: price per unit. For an income row " +
              "(dividend/coupon/interest, quantity 0): the NET amount actually credited " +
              "(German 'Ausmachender Betrag'), in the booking currency.",
          },
          fees: { type: "string", description: "Decimal string, default 0." },
          total: {
            type: "string",
            description: "Decimal string, optional gross total (before tax).",
          },
          tax: {
            type: "string",
            description:
              "Decimal string. Total withholding/capital-gains tax deducted, summed — " +
              "German Kapitalertragsteuer + Solidaritätszuschlag + Kirchensteuer AND any " +
              "foreign withholding tax (Quellensteuer / anrechenbare Quellensteuer).",
          },
          executedPrice: {
            type: "string",
            description: "Decimal string. The actual execution price if it differs from price.",
          },
          fxRate: {
            type: "string",
            description:
              "Decimal string. FX rate (e.g. Devisenkurs) when the trade involves a currency conversion.",
          },
          exchangeCode: { type: "string", description: "Exchange/market code if shown." },
          venue: {
            type: "string",
            description:
              "Trading venue or counterparty (e.g. Handelsplatz / Ausführungsplatz / Gegenpartei).",
          },
          savingsPlanId: {
            type: "string",
            description: "Savings-plan identifier if the row is a plan execution.",
          },
          kind: { type: "string", description: "Sub-type label (e.g. saveback, roundup)." },
          externalId: {
            type: "string",
            description:
              "Broker/bank document or order reference (e.g. Ordernr/Auftragsnummer, " +
              "Belegnr/Abrechnungsnr, booking ref). Extract verbatim.",
          },
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
    goldContracts: {
      type: "array",
      description:
        "Financed gold-purchase contracts (Pegadaian/Galeri 24 'MULIA' cicilan emas). " +
        "Emit ONE entry per contract, combining all of its pages.",
      items: {
        type: "object",
        properties: {
          provider: { type: "string", description: "e.g. GALERI24 or PEGADAIAN." },
          contractNo: { type: "string", description: "No. Kontrak / No. Order." },
          currency: { type: "string", description: "ISO 4217, e.g. IDR." },
          grams: {
            type: "string",
            description:
              "Gold weight in grams, from the Bukti Pembelian Emas line item " +
              "(e.g. 'LM 50 Gram' → 50). NEVER infer grams from a price.",
          },
          goldName: { type: "string", description: "e.g. 'LM 50 Gram'." },
          purchasePrice: { type: "string", description: "Harga Pembelian dari G24." },
          downPayment: { type: "string", description: "Uang muka / Sejumlah Uang." },
          adminFee: { type: "string", description: "Biaya Administrasi." },
          discount: { type: "string", description: "Promo Nominal (positive); 0 if none." },
          principal: { type: "string", description: "Uang Pinjaman (financed amount)." },
          marginTotal: { type: "string", description: "Total Sewa Modal." },
          tenorMonths: { type: "number", description: "Jangka Waktu in months." },
          monthlyInstallment: { type: "string", description: "Angsuran per Bulan." },
          startDate: { type: "string", description: "Tgl Kredit, ISO 8601 date." },
          schedule: {
            type: "array",
            description: "The Jadwal Angsuran rows.",
            items: {
              type: "object",
              properties: {
                n: { type: "number" },
                dueDate: { type: "string", description: "ISO 8601 date." },
                pokok: { type: "string", description: "Principal portion." },
                sewaModal: { type: "string", description: "Financing margin portion." },
                angsuran: { type: "string", description: "Total installment." },
                sisaPokok: { type: "string", description: "Remaining principal." },
              },
              required: ["n", "dueDate", "pokok", "sewaModal", "angsuran", "sisaPokok"],
            },
          },
          confidence: { type: "number", description: "0–1 extraction confidence." },
        },
        required: ["grams", "purchasePrice", "principal", "tenorMonths", "startDate", "confidence"],
      },
    },
  },
  required: ["transactions"],
} as const;

export const EXTRACTION_PROMPT =
  "Extract every transaction shown in this document (broker order, gold app, bank " +
  "confirmation, or a German bank securities settlement / fund distribution — DKB " +
  "'Wertpapier Abrechnung' / 'Ausschüttung'). Use decimal strings for all amounts, grams " +
  "for gold, parse numbers in the document's own locale (German and Indonesian both write " +
  "'1.234,56'), and a confidence between 0 and 1. Return the transactions.\n" +
  "Capture these enrichments when present: the order/document reference " +
  "(Ordernr/Auftragsnummer, Belegnr/Abrechnungsnr, booking ref) → externalId; withholding " +
  "tax (Kapitalertragsteuer + Solidaritätszuschlag + Kirchensteuer, plus any foreign " +
  "Quellensteuer, summed) → tax; the trading venue/counterparty (Handels-/Ausführungsplatz, " +
  "Gegenpartei) → venue; an FX rate (Devisenkurs) → fxRate. For a savings-plan execution " +
  "(Sparplan / ETF-Sparplan) set action to 'savings_plan'.\n" +
  "For an income row (dividend / Ausschüttung / Dividendengutschrift / coupon / interest): " +
  "set quantity to 0, put the NET amount credited ('Ausmachender Betrag') in price and the " +
  "gross payout in total, use the currency the cash was booked in (e.g. EUR even if the " +
  "dividend was declared in USD) and record the Devisenkurs in fxRate.\n" +
  "Also extract the account number (SID, IBAN, broker account ID, or similar) if one " +
  "appears on the document — set accountNumber to the verbatim value, or omit it if absent.\n" +
  "A document may span multiple pages forming ONE financed gold-purchase contract " +
  "(Pegadaian / Galeri 24 'MULIA' cicilan emas): a loan-calculation page (Perhitungan " +
  "Pinjaman), a purchase receipt (Bukti Pembelian Emas), and an amortization schedule " +
  "(Jadwal Angsuran). When you recognise these, emit ONE goldContracts entry combining " +
  "all pages instead of separate transactions — the gram weight comes ONLY from the Bukti " +
  "Pembelian Emas line item (e.g. 'LM 50 Gram'); never infer grams from a price.";

export const TOOL_NAME = "record_transactions";

// For parsers that return raw JSON text (Gemini, OpenRouter fallback) rather than a
// tool call — spells out the exact object shape so the model emits parseable JSON.
export const JSON_EXTRACTION_PROMPT = `${EXTRACTION_PROMPT}
Respond with ONLY a JSON object of the form:
{"accountNumber":"string or omit if absent","transactions":[{
  "assetClass":"equity|gold|bond|mutual_fund|etf|crypto|derivative",
  "action":"buy|sell|dividend|coupon|interest|savings_plan|bonus",
  "ticker":"string (optional)","isin":"string (optional)","wkn":"string (optional)","name":"string (optional)",
  "quantity":"decimal string (grams for gold)","unit":"shares|grams|units",
  "price":"decimal string per unit","fees":"decimal string (optional, default 0)",
  "total":"decimal string (optional)","tax":"decimal string (optional)",
  "executedPrice":"decimal string (optional)","fxRate":"decimal string (optional)",
  "exchangeCode":"string (optional)","venue":"string (optional)",
  "savingsPlanId":"string (optional)","kind":"string (optional)",
  "externalId":"string (optional, order/document reference)","currency":"ISO 4217 e.g. IDR",
  "executedAt":"ISO 8601 date","confidence":0.0
}]}
For a financed gold contract (Pegadaian/Galeri 24 cicilan), instead add a "goldContracts"
array: [{"provider":"GALERI24","contractNo":"...","currency":"IDR","grams":"50",
"goldName":"LM 50 Gram","purchasePrice":"...","downPayment":"...","adminFee":"...",
"discount":"...","principal":"...","marginTotal":"...","tenorMonths":12,
"monthlyInstallment":"...","startDate":"ISO 8601 date","schedule":[{"n":1,
"dueDate":"ISO 8601 date","pokok":"...","sewaModal":"...","angsuran":"...",
"sisaPokok":"..."}],"confidence":0.0}]. Grams come ONLY from the Bukti Pembelian Emas page.
No markdown, no code fences, no commentary.`;

/** Pull a JSON object out of a model's text response, tolerating code fences. */
export function parseJsonObject(text: string): unknown {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  return JSON.parse(trimmed);
}

/**
 * Validate raw model output into draft transactions.
 *
 * Rows that fail Zod validation are **skipped** (not thrown) so that one
 * hallucinated field doesn't discard an otherwise-valid document. Callers that
 * want to surface per-row errors to the user can pass in a mutable `errors` array;
 * if omitted the bad rows are silently dropped (preserving backward-compat with
 * callers that don't propagate errors).
 */
export function validateDrafts(
  raw: unknown,
  errors: { line: number; message: string }[] = [],
): ParsedTransaction[] {
  const list = Array.isArray(raw) ? raw : [];
  const drafts: ParsedTransaction[] = [];
  for (let i = 0; i < list.length; i++) {
    const pe: ParserError[] = [];
    tryAddDraft(parsedTransactionSchema, list[i] as Record<string, unknown>, drafts, pe);
    for (const e of pe) {
      errors.push({ line: i + 1, message: e.issues[0]?.message ?? "invalid row" });
    }
  }
  return drafts;
}

export interface ParserError {
  row: Record<string, unknown>;
  issues: { path: string; message: string }[];
}

export function tryAddDraft<T>(
  schema: ZodSchema<T>,
  row: Record<string, unknown>,
  drafts: T[],
  errors: ParserError[],
): void {
  const parsed = schema.safeParse(row);
  if (parsed.success) {
    drafts.push(parsed.data);
  } else {
    errors.push({
      row,
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
  }
}

/** Validate raw model output into gold-contract drafts, skipping malformed entries. */
export function validateContracts(raw: unknown): ParsedGoldContract[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: ParsedGoldContract[] = [];
  for (const r of list) {
    tryAddDraft(parsedGoldContractSchema, r as Record<string, unknown>, out, []);
  }
  return out;
}
