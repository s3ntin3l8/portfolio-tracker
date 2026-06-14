import type { ScreenshotParser } from "./parsers/types.js";
import { ClaudeVisionParser } from "./parsers/claude.js";
import { GeminiVisionParser } from "./parsers/gemini.js";
import { OpenRouterVisionParser } from "./parsers/openrouter.js";

let parser: ScreenshotParser | null = null;

/**
 * Build the screenshot parser from the environment. Claude vision is the default;
 * Gemini Flash and OpenRouter are free-tier fallbacks. SCREENSHOT_PARSER pins a
 * specific one; otherwise the first configured (claude → gemini → openrouter) wins,
 * falling back to an inert Claude parser when no key is set.
 */
export function buildScreenshotParser(): ScreenshotParser {
  const claude = new ClaudeVisionParser(process.env.ANTHROPIC_API_KEY ?? "", {
    model: process.env.ANTHROPIC_VISION_MODEL,
  });
  const gemini = new GeminiVisionParser(process.env.GEMINI_API_KEY ?? "", {
    model: process.env.GEMINI_VISION_MODEL,
  });
  const openrouter = new OpenRouterVisionParser(process.env.OPENROUTER_API_KEY ?? "", {
    model: process.env.OPENROUTER_VISION_MODEL,
  });

  const byName: Record<string, ScreenshotParser> = {
    claude,
    gemini,
    openrouter,
  };

  const pinned = process.env.SCREENSHOT_PARSER?.trim().toLowerCase();
  if (pinned && byName[pinned]) {
    return byName[pinned];
  }

  return [claude, gemini, openrouter].find((p) => p.isConfigured()) ?? claude;
}

export function getScreenshotParser(): ScreenshotParser {
  if (!parser) {
    parser = buildScreenshotParser();
  }
  return parser;
}
