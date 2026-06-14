import type { ParsedTransaction } from "@portfolio/schema";
import type { ParserImage, ScreenshotParser } from "./types.js";

/**
 * Claude vision screenshot parser. Calls the Anthropic API with a strict tool-use
 * JSON schema (parsedTransactionSchema) to extract draft transactions. Inert until
 * ANTHROPIC_API_KEY is configured — the full request is wired in the live-data slice.
 */
export class ClaudeVisionParser implements ScreenshotParser {
  readonly name = "claude";

  constructor(private readonly apiKey: string) {}

  isConfigured(): boolean {
    return this.apiKey.trim().length > 0;
  }

  async parse(_image: ParserImage): Promise<ParsedTransaction[]> {
    if (!this.isConfigured()) {
      throw new Error("claude_parser_not_configured");
    }
    // Wired in the live-data slice: POST to the Anthropic Messages API with the
    // image + a tool whose input_schema is parsedTransactionSchema, then validate.
    throw new Error("claude_vision_not_implemented");
  }
}
