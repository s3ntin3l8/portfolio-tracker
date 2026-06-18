import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  VISION_PROVIDER_REGISTRY,
  resolveVisionProviderConfig,
  getScreenshotParser,
  invalidateScreenshotParser,
} from "../../src/services/screenshot-parser.js";

// Tests run with NODE_ENV=test so getScreenshotParser() uses env-only selection,
// no DB calls. Parsers are tested via class-level unit tests or imports routes.

describe("VISION_PROVIDER_REGISTRY", () => {
  it("contains exactly claude, gemini, openrouter, ollama in default priority order", () => {
    const ids = VISION_PROVIDER_REGISTRY.map((d) => d.id);
    expect(ids).toEqual(["claude", "gemini", "openrouter", "ollama"]);
  });

  it("ollama is not configured when OLLAMA_BASE_URL is unset", () => {
    const ollama = VISION_PROVIDER_REGISTRY.find((d) => d.id === "ollama")!;
    delete process.env.OLLAMA_BASE_URL;
    expect(ollama.configured()).toBe(false);
  });

  it("ollama is configured when OLLAMA_BASE_URL is set", () => {
    const ollama = VISION_PROVIDER_REGISTRY.find((d) => d.id === "ollama")!;
    process.env.OLLAMA_BASE_URL = "http://localhost:11434";
    try {
      expect(ollama.configured()).toBe(true);
    } finally {
      delete process.env.OLLAMA_BASE_URL;
    }
  });

  it("ollama is configured when a DB url secret is provided", () => {
    const ollama = VISION_PROVIDER_REGISTRY.find((d) => d.id === "ollama")!;
    delete process.env.OLLAMA_BASE_URL;
    expect(ollama.configured({ url: "http://my-ollama:11434" })).toBe(true);
  });

  it("claude configured() checks apiKey from secrets before env", () => {
    const claude = VISION_PROVIDER_REGISTRY.find((d) => d.id === "claude")!;
    const old = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      expect(claude.configured()).toBe(false);
      expect(claude.configured({ apiKey: "sk-ant-test" })).toBe(true);
    } finally {
      if (old !== undefined) process.env.ANTHROPIC_API_KEY = old;
    }
  });
});

describe("resolveVisionProviderConfig", () => {
  it("returns registry defaults when no DB rows exist", () => {
    const resolved = resolveVisionProviderConfig([]);
    expect(resolved.map((r) => r.id)).toEqual(["claude", "gemini", "openrouter", "ollama"]);
    expect(resolved.find((r) => r.id === "claude")?.priority).toBe(1);
  });

  it("applies a DB row that disables a provider", () => {
    const resolved = resolveVisionProviderConfig([
      { provider: "claude", enabled: false, priority: 1 },
    ]);
    expect(resolved.find((r) => r.id === "claude")?.enabled).toBe(false);
  });

  it("reorders by DB priority override (lower first)", () => {
    const resolved = resolveVisionProviderConfig([
      { provider: "gemini", enabled: true, priority: 0 },
    ]);
    expect(resolved[0].id).toBe("gemini");
  });

  it("applies DB credential secrets to configured()", () => {
    const creds = new Map([["ollama", { url: "http://my-ollama:11434" }]]);
    const resolved = resolveVisionProviderConfig([], creds);
    expect(resolved.find((r) => r.id === "ollama")?.configured).toBe(true);
  });
});

describe("getScreenshotParser / invalidateScreenshotParser (test env, env-only)", () => {
  beforeEach(() => {
    invalidateScreenshotParser();
  });

  afterEach(() => {
    invalidateScreenshotParser();
    delete process.env.SCREENSHOT_PARSER;
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("caches the parser and returns the same instance on repeated calls", async () => {
    const a = await getScreenshotParser();
    const b = await getScreenshotParser();
    expect(a).toBe(b);
  });

  it("rebuilds after invalidation", async () => {
    const a = await getScreenshotParser();
    invalidateScreenshotParser();
    const b = await getScreenshotParser();
    expect(a).not.toBe(b);
  });

  it("honours SCREENSHOT_PARSER env pin (claude)", async () => {
    process.env.SCREENSHOT_PARSER = "claude";
    const p = await getScreenshotParser();
    expect(p.name).toBe("claude");
  });

  it("falls back to claude (unconfigured) when no provider has a key", async () => {
    // No keys set → all parsers unconfigured; falls back to the Claude instance.
    const p = await getScreenshotParser();
    expect(p.name).toBe("claude");
  });

  it("selects the first configured parser in env-only mode", async () => {
    // Simulate gemini being configured via env.
    process.env.GEMINI_API_KEY = "test-gemini-key";
    invalidateScreenshotParser();
    const p = await getScreenshotParser();
    expect(p.name).toBe("gemini");
    delete process.env.GEMINI_API_KEY;
  });
});
