export function toDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function toMonthKey(d: Date): string {
  return d.toISOString().slice(0, 7);
}

export const MS_PER_DAY = 1000 * 60 * 60 * 24;

export function daysBetween(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / MS_PER_DAY));
}
