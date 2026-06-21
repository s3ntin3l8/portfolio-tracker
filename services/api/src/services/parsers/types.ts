import type { ParsedGoldContract, ParsedTransaction } from "@portfolio/schema";

export interface ParserImage {
  data: Buffer;
  mimeType: string;
}

/**
 * What a vision parse yields: flat transaction drafts plus any structured
 * financed-gold contracts (Pegadaian/Galeri24 cicilan) read across the document's
 * pages. Both are *drafts* the user confirms before anything is written.
 */
export interface ParseResult {
  drafts: ParsedTransaction[];
  contracts: ParsedGoldContract[];
  /** Account number found on the document (e.g. SID, IBAN), used for portfolio auto-detect. */
  accountNumber?: string | null;
  /**
   * Per-row validation errors from the LLM output — rows that failed Zod validation
   * are skipped rather than aborting the whole parse. Line numbers are 1-based indices
   * into the raw `transactions` array from the model response.
   */
  errors?: { line: number; message: string }[];
}

/**
 * Minimal structured logger interface — satisfied structurally by pino/fastify loggers.
 * Defined here to keep the parser implementations free of a fastify import.
 */
export interface Logger {
  debug(obj: object, msg: string): void;
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

/**
 * Turns a screenshot/PDF into draft transactions (and gold contracts).
 * Implementations: Claude vision (default), local Ollama/LM Studio, Gemini,
 * OpenRouter. The drafts are confirmed by the user before any transaction is written.
 */
export interface ScreenshotParser {
  readonly name: string;
  isConfigured(): boolean;
  /** Optional logger receives debug/info/error lines for the LLM call lifecycle. */
  parse(image: ParserImage, log?: Logger): Promise<ParseResult>;
}
