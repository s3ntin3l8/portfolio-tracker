import type { ParsedTransaction } from "@portfolio/schema";
import type { ParserImage, ScreenshotParser } from "./types.js";
import {
  EXTRACTION_PROMPT,
  TOOL_NAME,
  TRANSACTIONS_TOOL_SCHEMA,
  validateDrafts,
} from "./shared.js";

export interface ClaudeParserOptions {
  baseUrl?: string;
  model?: string;
  fetch?: typeof fetch;
}

/**
 * Claude vision screenshot parser. Calls the Anthropic Messages API with a forced
 * tool call whose input_schema mirrors parsedTransactionSchema, then validates each
 * extracted row. Inert until ANTHROPIC_API_KEY is configured.
 */
export class ClaudeVisionParser implements ScreenshotParser {
  readonly name = "claude";
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly doFetch: typeof fetch;

  constructor(
    private readonly apiKey: string,
    opts: ClaudeParserOptions = {},
  ) {
    this.baseUrl = opts.baseUrl ?? "https://api.anthropic.com";
    this.model = opts.model ?? "claude-sonnet-4-6";
    this.doFetch = opts.fetch ?? globalThis.fetch;
  }

  isConfigured(): boolean {
    return this.apiKey.trim().length > 0;
  }

  async parse(image: ParserImage): Promise<ParsedTransaction[]> {
    if (!this.isConfigured()) {
      throw new Error("claude_parser_not_configured");
    }

    const res = await this.doFetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 1024,
        tools: [
          {
            name: TOOL_NAME,
            description: "Record the transactions found in the screenshot.",
            input_schema: TRANSACTIONS_TOOL_SCHEMA,
          },
        ],
        tool_choice: { type: "tool", name: TOOL_NAME },
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: image.mimeType,
                  data: image.data.toString("base64"),
                },
              },
              { type: "text", text: EXTRACTION_PROMPT },
            ],
          },
        ],
      }),
    });

    if (!res.ok) {
      throw new Error(`claude_vision_error_${res.status}`);
    }

    const data = (await res.json()) as {
      content?: { type: string; input?: { transactions?: unknown } }[];
    };
    const toolUse = data.content?.find((c) => c.type === "tool_use");
    return validateDrafts(toolUse?.input?.transactions);
  }
}
