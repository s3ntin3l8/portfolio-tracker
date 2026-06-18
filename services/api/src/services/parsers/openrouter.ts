import type { Logger, ParserImage, ParseResult, ScreenshotParser } from "./types.js";
import {
  EXTRACTION_PROMPT,
  TOOL_NAME,
  TRANSACTIONS_TOOL_SCHEMA,
  parseJsonObject,
  validateContracts,
  validateDrafts,
} from "./shared.js";

export interface OpenRouterParserOptions {
  baseUrl?: string;
  model?: string;
  fetch?: typeof fetch;
}

/**
 * OpenRouter vision parser (OpenAI-compatible chat completions). Forces a function
 * call whose parameters mirror parsedTransactionSchema, then validates. A free-tier
 * fallback; the model is configurable via OPENROUTER_MODEL. Inert until
 * OPENROUTER_API_KEY is set.
 */
export class OpenRouterVisionParser implements ScreenshotParser {
  readonly name = "openrouter";
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly doFetch: typeof fetch;

  constructor(
    private readonly apiKey: string,
    opts: OpenRouterParserOptions = {},
  ) {
    this.baseUrl = opts.baseUrl ?? "https://openrouter.ai/api/v1";
    this.model = opts.model ?? "google/gemini-2.5-flash";
    this.doFetch = opts.fetch ?? globalThis.fetch;
  }

  isConfigured(): boolean {
    return this.apiKey.trim().length > 0;
  }

  async parse(image: ParserImage, log?: Logger): Promise<ParseResult> {
    if (!this.isConfigured()) {
      throw new Error("openrouter_parser_not_configured");
    }

    log?.debug(
      { provider: this.name, model: this.model, mimeType: image.mimeType, bytes: image.data.length },
      "vision request",
    );
    const t0 = Date.now();

    const dataUrl = `data:${image.mimeType};base64,${image.data.toString("base64")}`;
    const res = await this.doFetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        tools: [
          {
            type: "function",
            function: {
              name: TOOL_NAME,
              description: "Record the transactions found in the screenshot.",
              parameters: TRANSACTIONS_TOOL_SCHEMA,
            },
          },
        ],
        tool_choice: { type: "function", function: { name: TOOL_NAME } },
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: EXTRACTION_PROMPT },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
      }),
    });

    if (!res.ok) {
      log?.error(
        { provider: this.name, status: res.status, statusText: res.statusText },
        "vision http error",
      );
      throw new Error(`openrouter_vision_error_${res.status}`);
    }

    const data = (await res.json()) as {
      choices?: {
        message?: { tool_calls?: { function?: { arguments?: string } }[] };
      }[];
    };
    const args = data.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments ?? "{}";
    const obj = parseJsonObject(args) as {
      transactions?: unknown;
      goldContracts?: unknown;
      accountNumber?: unknown;
    };
    const result = {
      drafts: validateDrafts(obj.transactions),
      contracts: validateContracts(obj.goldContracts),
      accountNumber: typeof obj.accountNumber === "string" ? obj.accountNumber : null,
    };
    log?.info(
      { provider: this.name, drafts: result.drafts.length, contracts: result.contracts.length, latencyMs: Date.now() - t0 },
      "vision parse complete",
    );
    return result;
  }
}
