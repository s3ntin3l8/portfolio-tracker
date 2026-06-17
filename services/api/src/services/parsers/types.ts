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
}

/**
 * Turns a screenshot/PDF into draft transactions (and gold contracts).
 * Implementations: Claude vision (default), local Ollama/LM Studio, Gemini,
 * OpenRouter. The drafts are confirmed by the user before any transaction is written.
 */
export interface ScreenshotParser {
  readonly name: string;
  isConfigured(): boolean;
  parse(image: ParserImage): Promise<ParseResult>;
}
