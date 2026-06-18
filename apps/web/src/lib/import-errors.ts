/**
 * Shared import error classification — used by both the single-file and multi-file
 * paths in ImportFlow so every failure maps to the same typed reason.
 *
 * Reasons map 1:1 to `Import.errors.*` and `Import.skipped.*` i18n keys.
 */
export type ImportSkipReason =
  | "notConfigured" // 503 — vision parser has no API key
  | "tooLarge"      // 413 — file exceeds the 25 MB limit
  | "parseFailed"   // 502 / 415 — provider rejected the file
  | "fileRead"      // browser FileReader failure
  | "alreadyConfirmed"
  | "noDrafts"
  | "generic";

/**
 * Classify an error thrown by `importScreenshot` / `importCsv` into a typed reason.
 * Falls back to `"generic"` for unknown errors.
 */
export function importSkipReason(err: unknown): ImportSkipReason {
  if ((err as Error)?.message === "file_read_error") return "fileRead";
  const status = (err as { status?: number })?.status;
  if (status === 503) return "notConfigured";
  if (status === 413) return "tooLarge";
  if (status === 415) return "parseFailed";
  if (status === 502) return "parseFailed";
  return "generic";
}
