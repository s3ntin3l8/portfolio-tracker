import type { ScreenshotParser } from "./parsers/types.js";
import { ClaudeVisionParser } from "./parsers/claude.js";
import { GeminiVisionParser } from "./parsers/gemini.js";
import { OpenRouterVisionParser } from "./parsers/openrouter.js";
import { OllamaVisionParser } from "./parsers/ollama.js";
import { visionProviderSettings, providerCredentials } from "@portfolio/db";
import { getDb, getEncryption } from "../db/client.js";
import type { ResolvedSecret } from "./market-data.js";

/**
 * A vision screenshot-parser provider descriptor — mirrors {@link ProviderDescriptor} in
 * market-data.ts. Drives the admin UI (GET/PATCH /admin/vision-providers) and the
 * DB-based factory ({@link getScreenshotParser}).
 */
export interface VisionProviderDescriptor {
  id: string;
  label: string;
  /** Default priority when no DB override exists (lower = tried first). */
  defaultPriority: number;
  /**
   * Whether this parser can be used given the supplied secrets.
   * DB credential wins over env key/url when `secrets` is provided.
   */
  configured: (secrets?: ResolvedSecret) => boolean;
  /**
   * Instantiate the parser. `secrets.apiKey`/`secrets.url` take precedence over env.
   * Only called when `configured(secrets)` is true.
   */
  create: (secrets?: ResolvedSecret) => ScreenshotParser;
  /**
   * Name of the environment variable that supplies this provider's API key or URL.
   * Used by the admin UI to show a "from .env" indicator when no DB credential is set
   * but an env key/url is present. Never exposed as a value — presence only.
   */
  keyEnvVar?: string;
}

/**
 * The selectable vision providers, in default priority order. Admins can reorder and
 * enable/disable these via the admin UI; the active parser is chosen at request time.
 * Ollama/LM Studio is included but shows as "not configured" until OLLAMA_BASE_URL is
 * set (or an admin sets a DB url-override) — the localhost default is not assumed running.
 */
export const VISION_PROVIDER_REGISTRY: VisionProviderDescriptor[] = [
  {
    id: "claude",
    label: "Claude (Anthropic)",
    defaultPriority: 1,
    keyEnvVar: "ANTHROPIC_API_KEY",
    configured: (s) => Boolean(s?.apiKey ?? process.env.ANTHROPIC_API_KEY),
    create: (s) =>
      new ClaudeVisionParser(s?.apiKey ?? process.env.ANTHROPIC_API_KEY ?? "", {
        model: process.env.ANTHROPIC_VISION_MODEL,
      }),
  },
  {
    id: "gemini",
    label: "Gemini (Google)",
    defaultPriority: 2,
    keyEnvVar: "GEMINI_API_KEY",
    configured: (s) => Boolean(s?.apiKey ?? process.env.GEMINI_API_KEY),
    create: (s) =>
      new GeminiVisionParser(s?.apiKey ?? process.env.GEMINI_API_KEY ?? "", {
        model: process.env.GEMINI_VISION_MODEL,
      }),
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    defaultPriority: 3,
    keyEnvVar: "OPENROUTER_API_KEY",
    configured: (s) => Boolean(s?.apiKey ?? process.env.OPENROUTER_API_KEY),
    create: (s) =>
      new OpenRouterVisionParser(s?.apiKey ?? process.env.OPENROUTER_API_KEY ?? "", {
        model: process.env.OPENROUTER_VISION_MODEL,
      }),
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    defaultPriority: 4,
    keyEnvVar: "OLLAMA_BASE_URL",
    // Configured only when an explicit URL is set (OLLAMA_BASE_URL or DB override).
    // The http://localhost:11434 default is NOT treated as "configured" because we don't
    // know if a local Ollama is running.
    configured: (s) => Boolean(s?.url ?? process.env.OLLAMA_BASE_URL),
    create: (s) =>
      new OllamaVisionParser({
        baseUrl: s?.url ?? process.env.OLLAMA_BASE_URL ?? "",
        model: process.env.OLLAMA_VISION_MODEL,
      }),
  },
];

/** Effective config for one vision provider after the DB overlay is applied. */
export interface ResolvedVisionProvider {
  id: string;
  label: string;
  configured: boolean;
  enabled: boolean;
  priority: number;
}

/**
 * Overlay the DB `vision_provider_settings` rows onto {@link VISION_PROVIDER_REGISTRY}
 * defaults and return every provider in effective priority order (lower first). Pure —
 * no async, no network — so it can be unit-tested independently of DB access.
 *
 * Mirrors {@link resolveProviderConfig} from market-data; duplicated here because the
 * `create` return types differ (`ScreenshotParser` vs `MarketDataProvider`), making a
 * shared generic impractical without TypeScript gymnastics.
 */
export function resolveVisionProviderConfig(
  rows: { provider: string; enabled: boolean; priority: number }[],
  credentials?: Map<string, ResolvedSecret>,
): ResolvedVisionProvider[] {
  const byId = new Map(rows.map((r) => [r.provider, r]));
  return VISION_PROVIDER_REGISTRY.map((d) => {
    const row = byId.get(d.id);
    const secret = credentials?.get(d.id);
    return {
      id: d.id,
      label: d.label,
      configured: d.configured(secret),
      enabled: row ? row.enabled : true,
      priority: row ? row.priority : d.defaultPriority,
    };
  }).sort((a, b) => a.priority - b.priority);
}

/**
 * Fetch and decrypt DB credential overrides for vision providers. Vision providers are
 * stored in `provider_credentials` with a "vision:" namespace prefix (e.g. "vision:gemini").
 * DB key wins over the env key; missing rows fall back to env transparently.
 *
 * NOTE (see #105): invalidation is in-process only — multi-replica setups need
 * LISTEN/NOTIFY to propagate changes. Tracked as a deferred follow-up.
 */
export async function resolveVisionCredentials(): Promise<Map<string, ResolvedSecret>> {
  const enc = getEncryption();
  const db = getDb();
  const prefix = "vision:";

  const rows = await db
    .select()
    .from(providerCredentials)
    .then((rs) => rs.filter((r) => r.provider.startsWith(prefix)));

  const out = new Map<string, ResolvedSecret>();
  for (const row of rows) {
    const id = row.provider.slice(prefix.length); // strip "vision:" → "claude" etc.
    const secret: ResolvedSecret = {};
    if (row.apiKeyEnc) {
      try {
        secret.apiKey = enc.decryptString(row.apiKeyEnc);
      } catch {
        // Decryption failure: skip this key; env will act as fallback
      }
    }
    if (row.urlOverride) {
      secret.url = row.urlOverride;
    }
    if (secret.apiKey !== undefined || secret.url !== undefined) {
      out.set(id, secret);
    }
  }
  return out;
}

// ── Singleton parser cache ────────────────────────────────────────────────────

let visionParser: ScreenshotParser | null = null;

/**
 * Build and return the active screenshot parser. Selects the highest-priority
 * configured + enabled provider from the DB `vision_provider_settings` overlay.
 *
 * The singleton is cached and rebuilt only after {@link invalidateScreenshotParser} is
 * called (admin settings change). In tests, the `buildApp({ screenshotParser })` seam
 * injects a mock directly, so this factory is bypassed.
 *
 * Selection priority (each falls through to the next when not satisfied):
 * 1. `SCREENSHOT_PARSER` env-var pin (a specific provider id, e.g. "claude")
 * 2. Highest-priority enabled + configured DB-registered provider
 * 3. Inert Claude parser (logs parse attempts but won't actually succeed without a key)
 */
export async function getScreenshotParser(): Promise<ScreenshotParser> {
  if (visionParser) return visionParser;

  // In tests, skip the DB lookup and use env-only selection.
  if (process.env.NODE_ENV === "test") {
    visionParser = buildScreenshotParser();
    return visionParser;
  }

  const db = getDb();
  const [rows, credentials] = await Promise.all([
    db
      .select({
        provider: visionProviderSettings.provider,
        enabled: visionProviderSettings.enabled,
        priority: visionProviderSettings.priority,
      })
      .from(visionProviderSettings),
    resolveVisionCredentials(),
  ]);

  // Honour an explicit provider pin (env) even if the DB disabled it.
  const pinned = process.env.SCREENSHOT_PARSER?.trim().toLowerCase();
  if (pinned) {
    const d = VISION_PROVIDER_REGISTRY.find((d) => d.id === pinned);
    if (d) {
      const secret = credentials.get(d.id);
      visionParser = d.create(secret);
      return visionParser;
    }
  }

  // Pick the top enabled + configured provider.
  const resolved = resolveVisionProviderConfig(rows, credentials);
  const active = resolved.find((p) => p.enabled && p.configured);
  if (active) {
    const d = VISION_PROVIDER_REGISTRY.find((d) => d.id === active.id)!;
    visionParser = d.create(credentials.get(d.id));
    return visionParser;
  }

  // Fallback: inert Claude parser (returns an error from parse(), not null).
  visionParser = new ClaudeVisionParser("", {});
  return visionParser;
}

/** Drop the cached parser so the next call rebuilds from current DB settings. */
export function invalidateScreenshotParser(): void {
  visionParser = null;
}

/**
 * Env-only parser selection — synchronous. Keeps the pre-registry behaviour for tests
 * and for the test-mode fast path inside {@link getScreenshotParser}.
 * Checks SCREENSHOT_PARSER pin first, then the first configured provider in default order.
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
  const ollama = new OllamaVisionParser({
    baseUrl: process.env.OLLAMA_BASE_URL ?? "",
    model: process.env.OLLAMA_VISION_MODEL,
  });

  const byName: Record<string, ScreenshotParser> = { claude, gemini, openrouter, ollama };
  const pinned = process.env.SCREENSHOT_PARSER?.trim().toLowerCase();
  if (pinned && byName[pinned]) return byName[pinned];

  return [claude, gemini, openrouter, ollama].find((p) => p.isConfigured()) ?? claude;
}
