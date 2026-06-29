/**
 * Shared import error classification — used by the single-file and multi-file parse paths in
 * ImportFlow and by the background materialize/confirm write in ImportTasksProvider, so every
 * failure maps to the same typed reason.
 *
 * Reasons map 1:1 to `Import.errors.*` and `Import.skipped.*` i18n keys.
 */
import { visionProviderErrorFromError, apiErrorCode } from "@portfolio/api-client";

export type ImportSkipReason =
  | "notConfigured" // top-level 503 — vision parser has no API key
  | "tooLarge" // top-level 413 — file exceeds the 25 MB body limit (parse.ts / app.ts)
  | "parseFailed" // 415, or a 502 with no/unknown providerStatus (genuine parse rejection)
  | "rateLimited" // 502 + providerStatus 429 — vision provider rate/usage limit
  | "providerAuth" // 502 + providerStatus 401/403 — vision provider API key rejected
  | "providerDown" // 502 + providerStatus >= 500 — vision provider temporarily unavailable
  | "sessionExpired" // top-level 401/403 — the *user's* session token expired (not the provider's)
  | "fileRead" // browser FileReader failure
  | "alreadyConfirmed"
  | "noDrafts"
  | "generic";

/** Richer classification result: the reason plus optional context the UI can surface. */
export interface ImportErrorInfo {
  reason: ImportSkipReason;
  /** Provider name for rateLimited / providerAuth / providerDown (e.g. "claude"). */
  provider?: string;
  /** Raw HTTP status — attached on the `generic` path so the message can self-diagnose. */
  status?: number;
  /** Body `error` code — attached on the `generic` path alongside `status`. */
  code?: string;
}

/**
 * Classify an error thrown by `importScreenshot` / `importCsv` / `materializeImport` into a typed
 * reason plus context. The `generic` fallthrough attaches the real HTTP status + body code so the
 * UI can show "HTTP 500 · server_error" instead of an opaque "something went wrong" — robust
 * against failure modes (network, 500) that don't fit a named bucket.
 */
export function classifyImportError(err: unknown): ImportErrorInfo {
  if ((err as Error)?.message === "file_read_error") return { reason: "fileRead" };
  const status = (err as { status?: number })?.status;
  // Top-level 401/403 = the user's own session token, not the vision provider's key.
  if (status === 401 || status === 403) return { reason: "sessionExpired", status };
  if (status === 503) return { reason: "notConfigured" };
  if (status === 413) return { reason: "tooLarge" };
  if (status === 415) return { reason: "parseFailed" };
  if (status === 502) {
    const pe = visionProviderErrorFromError(err);
    const provider = pe?.provider ?? undefined;
    const ps = pe?.providerStatus ?? null;
    if (ps === 429) return { reason: "rateLimited", provider };
    if (ps === 401 || ps === 403) return { reason: "providerAuth", provider };
    if (ps != null && ps >= 500) return { reason: "providerDown", provider };
    return { reason: "parseFailed", provider };
  }
  // Self-diagnosing fallthrough: keep the real status + code so the message isn't opaque.
  return { reason: "generic", status, code: apiErrorCode(err) ?? undefined };
}

/**
 * Back-compat wrapper returning just the reason. Existing call sites that only need the reason
 * keep working unchanged.
 */
export function importSkipReason(err: unknown): ImportSkipReason {
  return classifyImportError(err).reason;
}

/**
 * Compact technical detail for the self-diagnosing `generic` message, e.g. "HTTP 500 · server_error"
 * (or "HTTP 500" when no body code is present). Returns null when there's no status to show.
 */
export function importErrorDetail(info: ImportErrorInfo): string | null {
  if (info.status == null) return null;
  return info.code ? `HTTP ${info.status} · ${info.code}` : `HTTP ${info.status}`;
}
