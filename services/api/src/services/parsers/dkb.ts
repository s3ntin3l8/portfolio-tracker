import { parsedTransactionSchema, type ParsedTransaction } from "@portfolio/schema";
import type { CsvParseResult } from "./csv.js";
import { shortHash } from "./hash.js";

/**
 * Parser for DKB (Deutsche Kreditbank) CSV exports. DKB has no usable live-sync API, so
 * — like Parqet and Portfolio Performance — we import its CSV documents. Two formats are
 * supported, auto-detected from the header:
 *
 *  - **Depot positions snapshot** (`Datum der Erstellung;…`): one *holdings* row per
 *    security (avg entry price + quantity + asset class). Each becomes a synthetic `buy`
 *    so cost basis is reproduced; the export date is the (editable) acquisition date.
 *  - **Girokonto Umsatzliste** (`…Buchungsdatum;…;Verwendungszweck;…`): the real
 *    transaction history of the cash account that funds the savings plan. Securities data
 *    is embedded as free text in `Verwendungszweck`; rows are classified into
 *    savings-plan buys, dividends, and pure cash deposits/withdrawals.
 *
 * Everything is EUR. German conventions are handled throughout: `;` delimiter, `"`-quoted
 * fields, decimal comma / thousands dot, `€` suffixes, and `DD.MM.YYYY` / `DD.MM.YY` dates.
 */
export function parseDkb(content: string): CsvParseResult {
  const stripped = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  const lines = stripped.split(/\r?\n/);
  const firstNonEmpty = lines.find((l) => l.trim().length > 0) ?? "";

  if (/^"?Datum der Erstellung"?;/.test(firstNonEmpty)) {
    return parseDkbDepot(lines);
  }
  if (lines.some((l) => l.includes("Buchungsdatum") && l.includes("Verwendungszweck"))) {
    return parseDkbUmsatzliste(lines);
  }
  return {
    drafts: [],
    errors: [{ line: 1, message: "unrecognised DKB CSV format" }],
  };
}

// --- shared helpers ------------------------------------------------------

/**
 * Split one CSV line on `;`, honouring `"`-quoted fields (which may contain `;`, `,` or
 * runs of spaces) and `""` escapes. Each field is trimmed of surrounding whitespace.
 */
export function splitDkbLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ";") {
      out.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}

/**
 * Parse a German-formatted money/quantity string into a decimal string (the format
 * `@portfolio/schema`'s `decimalString` expects). Strips `€`, NBSP and spaces; treats `,`
 * as the decimal separator (with `.` as thousands), and a lone `.` only as a thousands
 * separator when it groups three digits — so `"1.674,43 €"`→`1674.43`, `"-25"`→`-25`,
 * `"74,50600000"`→`74.50600000`, `"1.674"`→`1674`. Returns null when unparseable.
 */
export function parseEuroDecimal(raw: string | undefined | null): string | null {
  if (raw == null) return null;
  // Strip the euro sign and all whitespace (JS \s covers the non-breaking space).
  let s = raw.replace(/[€\s]/g, "");
  if (!s) return null;
  if (s.includes(",")) {
    s = s.replace(/\./g, "").replace(",", ".");
  } else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) {
    // No decimal comma but dot-grouped thousands (e.g. "1.674").
    s = s.replace(/\./g, "");
  }
  return /^-?\d+(\.\d+)?$/.test(s) ? s : null;
}

/** Parse `DD.MM.YYYY` or `DD.MM.YY` (2-digit year → 20YY) as a UTC date. */
export function parseDkbDate(raw: string | undefined | null): Date | null {
  const m = (raw ?? "").trim().match(/^(\d{2})\.(\d{2})\.(\d{2}|\d{4})$/);
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Map DKB's `Assetklasse` label to our internal asset class. */
function assetClassFromAssetklasse(label: string): ParsedTransaction["assetClass"] {
  const l = label.trim().toLowerCase();
  if (l.startsWith("etf")) return "etf";
  if (l.includes("anleihe") || l.includes("renten")) return "bond";
  if (l.includes("fonds")) return "mutual_fund";
  if (l.includes("krypto") || l.includes("crypto")) return "crypto";
  return "equity"; // "Aktien" and anything unrecognised
}

/** Collapse internal whitespace runs to single spaces and trim. */
function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// Index a header row by lower-cased column name.
function headerIndex(cols: string[]): (name: string) => number {
  const lower = cols.map((c) => c.trim().toLowerCase());
  return (name: string) => lower.indexOf(name.toLowerCase());
}

// --- A. Depot positions snapshot ----------------------------------------

function parseDkbDepot(lines: string[]): CsvParseResult {
  const drafts: ParsedTransaction[] = [];
  const errors: { line: number; message: string }[] = [];

  const rows = lines
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => l.trim().length > 0);
  if (rows.length < 2) return { drafts, errors };

  const header = splitDkbLine(rows[0].l);
  const idx = headerIndex(header);
  const cName = idx("Wertpapierbezeichnung");
  const cIsin = idx("ISIN");
  const cEntry = idx("Einstiegskurs");
  const cQty = idx("Stückzahl");
  const cAsset = idx("Assetklasse");
  const cDate = idx("Datum der Erstellung");

  for (const { l, i } of rows.slice(1)) {
    const cols = splitDkbLine(l);
    const assetClass = assetClassFromAssetklasse(cols[cAsset] ?? "");
    const draft = {
      assetClass,
      action: "buy" as const,
      isin: cols[cIsin] || undefined,
      name: collapse(cols[cName] ?? "") || undefined,
      quantity: parseEuroDecimal(cols[cQty]) ?? "",
      unit: assetClass === "bond" ? ("units" as const) : ("shares" as const),
      price: parseEuroDecimal(cols[cEntry]) ?? "",
      fees: "0",
      currency: "EUR",
      executedAt: parseDkbDate(cols[cDate]) ?? undefined,
      confidence: 1,
    };
    const parsed = parsedTransactionSchema.safeParse(draft);
    if (parsed.success) drafts.push(parsed.data);
    else errors.push({ line: i + 1, message: parsed.error.issues[0]?.message ?? "invalid row" });
  }

  return { drafts, errors };
}

// --- B. Girokonto Umsatzliste -------------------------------------------

const ISIN_RE = /\b([A-Z]{2}[A-Z0-9]{9}[0-9])\b/;
const PRICE_RE = /Preis\s+([\d.,]+)/;
const QTY_RE = /Stück\s+([\d.,]+)/; // "Stück <qty>"
const BOOKING_REF_RE = /\b(\d{15,})\b/;

function parseDkbUmsatzliste(lines: string[]): CsvParseResult {
  const drafts: ParsedTransaction[] = [];
  const errors: { line: number; message: string }[] = [];

  const headerLineNo = lines.findIndex(
    (l) => l.includes("Buchungsdatum") && l.includes("Verwendungszweck"),
  );
  if (headerLineNo < 0) return { drafts, errors };

  const header = splitDkbLine(lines[headerLineNo]);
  const idx = headerIndex(header);
  const cDate = idx("Buchungsdatum");
  const cPayer = idx("Zahlungspflichtige*r");
  const cPayee = idx("Zahlungsempfänger*in");
  const cVz = idx("Verwendungszweck");
  const cType = idx("Umsatztyp");
  // The amount header is "Betrag (€)" — match by prefix to survive encoding quirks.
  const cAmount = header.findIndex((h) => h.trim().toLowerCase().startsWith("betrag"));

  for (let i = headerLineNo + 1; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim().length === 0) continue;
    const cols = splitDkbLine(raw);
    const vz = cols[cVz] ?? "";
    const amount = parseEuroDecimal(cols[cAmount]);
    if (amount == null) {
      errors.push({ line: i + 1, message: "unparseable Betrag" });
      continue;
    }
    const amountNum = Number(amount);
    if (amountNum === 0) continue; // e.g. periodic "Abrechnung" statement rows

    const booking = vz.match(BOOKING_REF_RE)?.[1];
    const date = parseDkbDate(cols[cDate]) ?? undefined;

    let draft: Record<string, unknown>;

    if (vz.includes("Wertp.Abrechn.")) {
      // Securities trade (savings-plan execution or one-off buy/sell).
      const execDate =
        parseDkbDate(vz.match(/Wertp\.Abrechn\.\s+(\d{2}\.\d{2}\.\d{4})/)?.[1]) ?? date;
      const isin = vz.match(ISIN_RE)?.[1];
      const price = parseEuroDecimal(vz.match(PRICE_RE)?.[1]);
      const quantity = parseEuroDecimal(vz.match(QTY_RE)?.[1]);
      const name = collapse(vz.match(/Gesch\.Art\s+\S+\s+(.*?)\s+ISIN\b/)?.[1] ?? "");
      const isSavingsPlan = vz.includes("Wertpapier-Sparplan");
      const action = isSavingsPlan ? "savings_plan" : amountNum > 0 ? "sell" : "buy";
      draft = {
        assetClass: "equity",
        action,
        isin,
        name: name || undefined,
        quantity: quantity ?? "",
        unit: "shares",
        price: price ?? "",
        fees: "0",
        currency: "EUR",
        executedAt: execDate,
        externalId: booking ? `dkb:${booking}` : undefined,
        confidence: 1,
      };
    } else if (vz.includes("Wertpapierertrag")) {
      // Dividend / distribution paid into the cash account.
      const execDate =
        parseDkbDate(vz.match(/Wertpapierertrag\s+(\d{2}\.\d{2}\.\d{4})/)?.[1]) ?? date;
      const isin = vz.match(ISIN_RE)?.[1];
      const name = collapse(vz.match(/WKN\s+\S+\s+(.*?)\s+ISIN\b/)?.[1] ?? "");
      draft = {
        assetClass: "equity",
        action: "dividend",
        isin,
        name: name || undefined,
        quantity: "0",
        price: amount, // lump sum recorded in price (see core/cash.ts cashFlow)
        fees: "0",
        currency: "EUR",
        executedAt: execDate,
        externalId: booking ? `dkb:${booking}` : undefined,
        confidence: 1,
      };
    } else {
      // Pure cash movement: deposit (money in) or withdrawal (money out).
      const action = amountNum > 0 ? "deposit" : "withdrawal";
      const counterparty = collapse(
        (amountNum > 0 ? cols[cPayer] : cols[cPayee]) ?? "",
      );
      const label = counterparty || collapse(vz) || "DKB cash";
      const fallbackId = shortHash(
        [cols[cDate], cols[cType], amount, cols[cPayer], cols[cPayee], vz].join("|"),
      );
      draft = {
        action,
        name: label || undefined,
        quantity: "0",
        price: Math.abs(amountNum).toString(),
        fees: "0",
        currency: "EUR",
        executedAt: date,
        externalId: booking ? `dkb:${booking}` : `dkb:cash:${fallbackId}`,
        confidence: 1,
      };
    }

    const parsed = parsedTransactionSchema.safeParse(draft);
    if (parsed.success) drafts.push(parsed.data);
    else errors.push({ line: i + 1, message: parsed.error.issues[0]?.message ?? "invalid row" });
  }

  return { drafts, errors };
}
