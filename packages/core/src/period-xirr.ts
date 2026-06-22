import { xirr, type CashFlowPoint } from "./xirr.js";

/**
 * Compute period-scoped XIRR. Treats the portfolio value at `anchorDate` (the date of
 * the first snapshot at or after the nominal period start) as an initial "cost" and
 * computes XIRR from that anchor to now.
 *
 * The caller must pass the **actual snapshot date** as `anchorDate`, not the nominal
 * period start (e.g., Jan 1 for YTD). This prevents double-counting flows that are
 * already embedded in the snapshot value but would otherwise fall between the nominal
 * period start and the snapshot date.
 *
 * @param allFlows    All boundary cash-flow points (before the terminal inflow).
 * @param currentValue  The current total net worth (used as the terminal inflow).
 * @param startNav    The portfolio's NAV at `anchorDate` — becomes the synthetic opening outflow.
 * @param anchorDate  The actual snapshot date used as the opening anchor.
 * @param asOf        The "as of" date for the terminal inflow (usually now).
 * @returns Annualised XIRR as a decimal (e.g. 0.12 = 12%), or null if undetermined.
 */
export function periodXirr(
  allFlows: CashFlowPoint[],
  currentValue: number,
  startNav: number,
  anchorDate: Date,
  asOf: Date,
): number | null {
  if (startNav <= 0) return null;

  // Filter to flows strictly after anchorDate — the opening NAV already embeds everything up to and
  // including that date, so re-adding those flows would double-count them.
  const postFlows = allFlows.filter((f) => f.date > anchorDate);

  // Synthetic outflow at anchorDate (the "cost" of holding at that date).
  const flows: CashFlowPoint[] = [
    { amount: -startNav, date: anchorDate },
    ...postFlows,
    { amount: currentValue, date: asOf },
  ];

  const rate = xirr(flows);
  // Clip obviously-broken results (e.g. near-zero startNav, single-day horizon).
  if (!Number.isFinite(rate) || Math.abs(rate) > 50) return null;
  return rate;
}
