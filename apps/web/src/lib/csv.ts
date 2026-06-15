/**
 * Serialise a header row + data rows to RFC-4180 CSV. Each value is stringified
 * and quoted only when it contains a comma, quote or newline (quotes doubled).
 */
export function toCsv(
  headers: string[],
  rows: (string | number)[][],
): string {
  const esc = (v: string | number) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers, ...rows].map((r) => r.map(esc).join(",")).join("\n");
}
