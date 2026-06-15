/**
 * Sniff which CSV parser a document needs, so the UI can default to "auto" instead of
 * making the user pick. DKB exports are unmistakable: they are `;`-delimited and carry
 * German headers — a depot snapshot starts with `Datum der Erstellung`, a Girokonto
 * Umsatzliste has both `Buchungsdatum` and `Verwendungszweck`. Anything else is treated
 * as the generic column CSV. The signals mirror `parseDkb`'s own format detection.
 */
export type CsvFormat = "generic" | "dkb";

export function detectCsvFormat(content: string): CsvFormat {
  const stripped = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  const lines = stripped.split(/\r?\n/);
  const firstNonEmpty = lines.find((l) => l.trim().length > 0) ?? "";

  if (/^"?Datum der Erstellung"?;/.test(firstNonEmpty)) return "dkb";
  if (lines.some((l) => l.includes("Buchungsdatum") && l.includes("Verwendungszweck"))) {
    return "dkb";
  }
  return "generic";
}
