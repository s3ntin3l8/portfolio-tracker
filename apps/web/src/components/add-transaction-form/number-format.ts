/**
 * Thousands-grouping for numeric text inputs (quantity/price/fees/tax), matching the Add
 * Transaction v2 design's `_num` input helper. The canonical value stored in form state is
 * always the RAW, comma-free string (so `use-transaction-form.ts`'s submit payload is
 * unaffected) — these helpers only govern what's *displayed* in the input.
 *
 * A leading "-" is preserved (not part of the design, which has no negative fields) because
 * the existing `adjustment` cash type accepts a signed amount (see `pricing-fields.tsx`'s
 * `adjustmentHint`) — stripping it here would regress that.
 */

/** Recovers the canonical raw numeric string from whatever's currently in the text box
 *  (grouped display + the just-typed edit merged in by the browser). Strips everything but
 *  digits/dot/leading-minus, collapses redundant leading zeros, caps the fractional part at
 *  8 digits. */
export function sanitizeNumericInput(raw: string): string {
  const negative = raw.trimStart().startsWith("-");
  const cleaned = raw.replace(/[^\d.]/g, "");
  const dotIndex = cleaned.indexOf(".");
  let result: string;
  if (dotIndex === -1) {
    result = cleaned.replace(/^0+(?=\d)/, "");
  } else {
    const intPart = cleaned.slice(0, dotIndex).replace(/^0+(?=\d)/, "");
    const decPart = cleaned
      .slice(dotIndex + 1)
      .replace(/\./g, "")
      .slice(0, 8);
    result = `${intPart || "0"}.${decPart}`;
  }
  return negative && result ? `-${result}` : result;
}

/** `"1234.5"` → `"1,234.5"` (display only — see module doc). */
export function formatGrouped(raw: string | null | undefined): string {
  if (!raw) return "";
  const negative = raw.startsWith("-");
  const body = negative ? raw.slice(1) : raw;
  const dotIndex = body.indexOf(".");
  const intPart = dotIndex === -1 ? body : body.slice(0, dotIndex);
  const decPart = dotIndex === -1 ? "" : body.slice(dotIndex);
  const groupedInt = intPart === "" ? "" : Number(intPart).toLocaleString("en-US");
  return `${negative ? "-" : ""}${groupedInt}${decPart}`;
}

/** Number of digit characters in `value` strictly before `caret` — the anchor used to keep
 *  the caret glued to "the same digit" across a reformat (see `caretForDigits`). */
export function digitsBefore(value: string, caret: number): number {
  return value.slice(0, caret).replace(/\D/g, "").length;
}

/** Inverse of `digitsBefore`: the index in `formatted` immediately after its Nth digit. */
export function caretForDigits(formatted: string, digits: number): number {
  if (digits <= 0) return 0;
  let count = 0;
  for (let i = 0; i < formatted.length; i++) {
    if (/\d/.test(formatted[i])) {
      count++;
      if (count === digits) return i + 1;
    }
  }
  return formatted.length;
}
