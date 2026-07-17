import type { Trade } from "@portfolio/api-client";
import type { ColDef } from "@/lib/table-sort";

export type StatusFilter = "all" | "open" | "closed";

export const COLS: ColDef<Trade>[] = [
  { key: "instrument", get: (t) => t.instrument?.symbol ?? "", type: "text" },
  { key: "entryDate", get: (t) => t.entryDate, type: "date" },
  { key: "exitDate", get: (t) => t.exitDate, type: "date" },
  { key: "held", get: (t) => t.holdingDays, type: "numeric" },
  { key: "invested", get: (t) => Number(t.invested), type: "numeric" },
  { key: "realized", get: (t) => Number(t.realizedPnL), type: "numeric" },
  { key: "dividends", get: (t) => Number(t.dividends), type: "numeric" },
  { key: "totalReturn", get: (t) => Number(t.totalReturn), type: "numeric" },
  { key: "annualized", get: (t) => t.annualizedPct ?? 0, type: "numeric" },
];

export const tradeKey = (t: Trade) => `${t.instrumentId}:${t.entryDate}`;

export function toneClass(n: number): string {
  return n > 0 ? "text-success" : n < 0 ? "text-destructive" : "text-muted-foreground";
}
