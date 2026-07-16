import type { Logger, ParserImage, ParseResult, ScreenshotParser } from "./types.js";
import {
  EXTRACTION_PROMPT,
  TOOL_NAME,
  TRANSACTIONS_TOOL_SCHEMA,
  validateContracts,
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

  async parse(image: ParserImage, log?: Logger): Promise<ParseResult> {
    if (!this.isConfigured()) {
      throw new Error("claude_parser_not_configured");
    }

    log?.debug(
      {
        provider: this.name,
        model: this.model,
        mimeType: image.mimeType,
        bytes: image.data.length,
      },
      "vision request",
    );
    const t0 = Date.now();

    // PDFs go in a `document` block; screenshots in an `image` block. Both carry
    // base64 data + media type and are read by the same vision model.
    const source = {
      type: "base64" as const,
      media_type: image.mimeType,
      data: image.data.toString("base64"),
    };
    const mediaBlock =
      image.mimeType === "application/pdf"
        ? { type: "document", source }
        : { type: "image", source };

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
            description: "Record the transactions found in the document.",
            input_schema: TRANSACTIONS_TOOL_SCHEMA,
          },
        ],
        tool_choice: { type: "tool", name: TOOL_NAME },
        messages: [
          {
            role: "user",
            content: [mediaBlock, { type: "text", text: EXTRACTION_PROMPT }],
          },
        ],
      }),
    });

    if (!res.ok) {
      log?.error(
        { provider: this.name, status: res.status, statusText: res.statusText },
        "vision http error",
      );
      throw new Error(`claude_vision_error_${res.status}`);
    }

    const data = (await res.json()) as {
      content?: {
        type: string;
        input?: { transactions?: unknown; goldContracts?: unknown; accountNumber?: unknown };
      }[];
    };
    const toolUse = data.content?.find((c) => c.type === "tool_use");
    const parseErrors: { line: number; message: string }[] = [];
    const result = {
      drafts: validateDrafts(toolUse?.input?.transactions, parseErrors),
      contracts: validateContracts(toolUse?.input?.goldContracts),
      accountNumber:
        typeof toolUse?.input?.accountNumber === "string" ? toolUse.input.accountNumber : null,
      errors: parseErrors,
    };
    log?.info(
      {
        provider: this.name,
        drafts: result.drafts.length,
        contracts: result.contracts.length,
        latencyMs: Date.now() - t0,
      },
      "vision parse complete",
    );
    return result;
  }
}
