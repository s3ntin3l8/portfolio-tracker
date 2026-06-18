import type { Logger, ParserImage, ParseResult, ScreenshotParser } from "./types.js";
import {
  JSON_EXTRACTION_PROMPT,
  parseJsonObject,
  validateContracts,
  validateDrafts,
} from "./shared.js";

export interface OllamaParserOptions {
  /** Base URL of the Ollama (or LM Studio) instance. Empty string = not configured. */
  baseUrl?: string;
  /** Vision model to use (e.g. qwen2.5vl:7b). Falls back to OLLAMA_VISION_MODEL env. */
  model?: string;
  /** Override fetch for tests. */
  fetch?: typeof fetch;
}

/**
 * Ollama / LM Studio vision parser (OpenAI-compatible chat completions at /v1/chat/completions).
 * Requires a local multimodal model (e.g. qwen2.5vl:7b) to be running at the base URL.
 *
 * Configured via the `OLLAMA_BASE_URL` env var or an admin-managed DB url-override on the
 * "ollama" vision provider entry. When neither is set, `isConfigured()` returns false and
 * this parser is skipped in the fallback chain — the localhost default is NOT assumed to be
 * running. No API key is needed for local endpoints.
 *
 * **PDF limitation**: local multimodal models typically ingest images only. Passing a PDF
 * buffer will throw `ollama_pdf_not_supported`; the caller should pre-render PDF pages to
 * images before routing to this parser.
 */
export class OllamaVisionParser implements ScreenshotParser {
  readonly name = "ollama";
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly doFetch: typeof fetch;

  constructor(opts: OllamaParserOptions = {}) {
    this.baseUrl = opts.baseUrl ?? "";
    this.model = opts.model ?? process.env.OLLAMA_VISION_MODEL ?? "qwen2.5vl:7b";
    this.doFetch = opts.fetch ?? globalThis.fetch;
  }

  isConfigured(): boolean {
    return this.baseUrl.trim().length > 0;
  }

  async parse(image: ParserImage, log?: Logger): Promise<ParseResult> {
    if (!this.isConfigured()) {
      throw new Error("ollama_parser_not_configured");
    }
    if (image.mimeType === "application/pdf") {
      throw new Error("ollama_pdf_not_supported");
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

    const dataUrl = `data:${image.mimeType};base64,${image.data.toString("base64")}`;
    const res = await this.doFetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        messages: [
          {
            role: "user",
            content: [
              { type: "image_url", image_url: { url: dataUrl } },
              { type: "text", text: JSON_EXTRACTION_PROMPT },
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
      throw new Error(`ollama_vision_error_${res.status}`);
    }

    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const text = data.choices?.[0]?.message?.content ?? "";
    const obj = parseJsonObject(text) as {
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
