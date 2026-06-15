/**
 * Sniff which CSV parser a document needs, so the UI can default to "auto" instead of
 * making the user pick. DKB exports are unmistakable: they are `;`-delimited and carry
 * German headers — a depot snapshot starts with `Datum der Erstellung`, a Girokonto
 * Umsatzliste has both `Buchungsdatum` and `Verwendungszweck`); IBKR Flex Trades carry
 * `TradePrice` + `CurrencyPrimary`; Coinbase carries `Quantity Transacted`. Anything
 * else is the generic column CSV.
 */
export type CsvFormat = "generic" | "dkb" | "ibkr" | "coinbase";

export function detectCsvFormat(content: string): CsvFormat {
  const stripped = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  const lines = stripped.split(/\r?\n/);
  const firstNonEmpty = lines.find((l) => l.trim().length > 0) ?? "";

  if (/^"?Datum der Erstellung"?;/.test(firstNonEmpty)) return "dkb";
  if (lines.some((l) => l.includes("Buchungsdatum") && l.includes("Verwendungszweck"))) {
    return "dkb";
  }
  if (lines.some((l) => /TradePrice/.test(l) && /CurrencyPrimary/.test(l))) {
    return "ibkr";
  }
  if (lines.some((l) => /Quantity Transacted/i.test(l))) return "coinbase";
  return "generic";
}
