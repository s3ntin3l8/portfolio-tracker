import { FileSpreadsheet, FileText, PencilLine, ScanText } from "lucide-react";
import type { LucideIcon } from "lucide-react";

/**
 * Per-source-type icon + tint, transcribed from `Pocket Prototype.dc.html` (the `SRCTYPE`
 * map). A tinted rounded square keyed by import origin; unknown types fall back to neutral.
 * Shared by {@link TransactionSourcesSection} and {@link ImportHistory} so both surfaces use
 * the same palette instead of two copies drifting apart.
 */
export const SRC_STYLE: Record<string, { icon: LucideIcon; bg: string; fg: string }> = {
  csv: { icon: FileSpreadsheet, bg: "rgba(13,148,136,.16)", fg: "#0D9488" },
  pdf: { icon: FileText, bg: "rgba(229,72,77,.13)", fg: "#E5484D" },
  screenshot: { icon: ScanText, bg: "rgba(124,92,252,.16)", fg: "#7C5CFC" },
  pytr: { icon: FileText, bg: "rgba(13,148,136,.16)", fg: "#0D9488" },
  ibkr: { icon: FileText, bg: "rgba(13,148,136,.16)", fg: "#0D9488" },
  manual: { icon: PencilLine, bg: "var(--border)", fg: "var(--text-mute)" },
};

export const DEFAULT_SRC = { icon: FileText, bg: "var(--border)", fg: "var(--text-mute)" };

/**
 * Maps a stored `ImportRecord.parser` tag to one of the 5 friendly source categories used
 * for {@link SRC_STYLE} and the `Transactions.sources.*` labels.
 *
 * Mirrors `parserToTxSource()` in `services/api/src/services/parsers/dedup.ts` — same tag
 * semantics (csv/dkb/tr-csv → csv, dkb-pdf/tr-pdf → pdf, ibkr, pytr, else → screenshot).
 * Duplicated here because that module lives in the API service package (Node runtime) and
 * isn't reachable from the browser bundle. Keep the two in sync if the tag set changes.
 */
export function parserToSourceType(parser: string): string {
  if (parser === "pytr") return "pytr";
  if (parser === "ibkr") return "ibkr";
  if (parser === "dkb-pdf" || parser === "tr-pdf") return "pdf";
  if (parser === "csv" || parser === "dkb" || parser === "tr-csv") return "csv";
  return "screenshot";
}
