import type { ParsedTransaction } from "@portfolio/schema";

export interface ParserImage {
  data: Buffer;
  mimeType: string;
}

/**
 * Turns a screenshot into draft transactions. Implementations: Claude vision
 * (default), local Ollama/LM Studio, Gemini, OpenRouter. The drafts are confirmed
 * by the user before any transaction is written.
 */
export interface ScreenshotParser {
  readonly name: string;
  isConfigured(): boolean;
  parse(image: ParserImage): Promise<ParsedTransaction[]>;
}
