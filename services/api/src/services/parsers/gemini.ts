import type { Logger, ParserImage, ParseResult, ScreenshotParser } from "./types.js";
import {
  JSON_EXTRACTION_PROMPT,
  parseJsonObject,
  validateContracts,
  validateDrafts,
} from "./shared.js";

export interface GeminiParserOptions {
  baseUrl?: string;
  model?: string;
  fetch?: typeof fetch;
}

/**
 * Gemini Flash vision parser (Google Generative Language API). Sends the image plus a
 * JSON-only prompt with responseMimeType application/json, then validates the result.
 * A free-tier fallback to the Claude default. Inert until GEMINI_API_KEY is set.
 */
export class GeminiVisionParser implements ScreenshotParser {
  readonly name = "gemini";
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly doFetch: typeof fetch;

  constructor(
    private readonly apiKey: string,
    opts: GeminiParserOptions = {},
  ) {
    this.baseUrl = opts.baseUrl ?? "https://generativelanguage.googleapis.com";
    this.model = opts.model ?? "gemini-2.5-flash";
    this.doFetch = opts.fetch ?? globalThis.fetch;
  }

  isConfigured(): boolean {
    return this.apiKey.trim().length > 0;
  }

  async parse(image: ParserImage, log?: Logger): Promise<ParseResult> {
    if (!this.isConfigured()) {
      throw new Error("gemini_parser_not_configured");
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

    const url = `${this.baseUrl}/v1beta/models/${this.model}:generateContent`;
    const res = await this.doFetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": this.apiKey,
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              { inline_data: { mime_type: image.mimeType, data: image.data.toString("base64") } },
              { text: JSON_EXTRACTION_PROMPT },
            ],
          },
        ],
        generationConfig: { responseMimeType: "application/json", temperature: 0 },
      }),
    });

    if (!res.ok) {
      log?.error(
        { provider: this.name, status: res.status, statusText: res.statusText },
        "vision http error",
      );
      throw new Error(`gemini_vision_error_${res.status}`);
    }

    const data = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    const obj = parseJsonObject(text) as {
      transactions?: unknown;
      goldContracts?: unknown;
      accountNumber?: unknown;
    };
    const parseErrors: { line: number; message: string }[] = [];
    const result = {
      drafts: validateDrafts(obj.transactions, parseErrors),
      contracts: validateContracts(obj.goldContracts),
      accountNumber: typeof obj.accountNumber === "string" ? obj.accountNumber : null,
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
