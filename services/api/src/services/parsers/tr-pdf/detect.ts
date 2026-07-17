export const TR_SIG_RE = /Trade Republic Bank GmbH|TRADE REPUBLIC BANK GMBH/;

export const TR_ISIN_LABELED_RE = /ISIN:\s+([A-Z]{2}[A-Z0-9]{9}\d)/;

export const BARE_ISIN_RE = /\b([A-Z]{2}[A-Z0-9]{9}\d)\b/;

export const TR_BUCHUNG_RE =
  /(?:WERTSTELLUNG|DATUM DER ZAHLUNG|BUCHUNGSDATUM)[^]*?(\d{2}\.\d{2}\.\d{4}|\d{4}-\d{2}-\d{2})\s+(-?[\d.,]+)\s+EUR/;

export function detectTrPdf(text: string): boolean {
  if (!TR_SIG_RE.test(text)) return false;
  const isCompoundZinskonto =
    /\b(?:WAHL)?DIVIDENDE\b|AUSSCHÜTTUNG/.test(text) && /ABRECHNUNG\s+ZINSEN/.test(text);
  if (isCompoundZinskonto) return false;
  if (/WERTPAPIERABRECHNUNG/.test(text) && /\bAUSFÜHRUNG\b/.test(text)) return true;
  const isCorrection = /STORNIERUNG DER DIVIDENDE|REKLASSIFIZIERUNG/.test(text);
  if (/\b(?:WAHL)?DIVIDENDE\b/.test(text) && /Stücke/.test(text) && !isCorrection) return true;
  if (
    !isCorrection &&
    /\b(?:WAHL)?DIVIDENDE\b|\bAUSSCHÜTTUNG\b/.test(text) &&
    /Stk\./.test(text) &&
    !/WERTPAPIERABRECHNUNG/.test(text)
  ) {
    return true;
  }
  if (/ABRECHNUNG\s+ZINSEN/.test(text)) return true;
  if (/STEUERLICHE OPTIMIERUNG/i.test(text)) return true;
  return false;
}
