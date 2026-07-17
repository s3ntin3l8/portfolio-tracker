import type { TxRow } from "./types";

export interface DayGroup {
  day: string;
  label: string;
  rows: TxRow[];
}

export function groupByDay(rows: TxRow[], dayFmt: Intl.DateTimeFormat): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const tx of rows) {
    const day = tx.executedAt.slice(0, 10);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.rows.push(tx);
    else groups.push({ day, label: dayFmt.format(new Date(tx.executedAt)), rows: [tx] });
  }
  return groups;
}
