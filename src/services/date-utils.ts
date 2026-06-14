export function normalizeIsoDate(value: string): string;
export function normalizeIsoDate(value: null | undefined): null;
export function normalizeIsoDate(value: string | null | undefined): string | null;
export function normalizeIsoDate(value: string | null | undefined): string | null {
  if (value == null) return null;
  if (value === "") return "";
  if (typeof value !== "string") return value as unknown as string;
  if (value.includes("T") && !value.includes("Z") && !value.includes("+")) {
    return `${value}Z`;
  }
  return value;
}

export function parseIso8601Utc(value: string): Date {
  const normalized = value.replace("Z", "+00:00");
  const parsed = new Date(normalized);
  if (isNaN(parsed.getTime())) {
    throw new Error(`Invalid ISO 8601 date: ${value}`);
  }
  return parsed;
}