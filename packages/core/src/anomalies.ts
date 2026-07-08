import { Decimal } from "decimal.js";
import type { CoreTransaction, CorporateAction } from "./types.js";
import { cashFlow } from "./cash.js";

const D = (v: string) => new Decimal(v);
const ZERO = new Decimal(0);

/** UTC year-month-day bucket key, e.g. "2026-06-28" (mirrors contributions.ts). */
const dayKey = (d: Date): string => d.toISOString().slice(0, 10);

export type AnomalyCode =
  | "oversell"
  | "sell_before_acquisition"
  | "negative_cash"
  | "income_on_non_held"
  | "missing_transfer_basis"
  | "zero_price"
  | "reconciliation_gap"
  | "reconciliation_drift"
  | "position_gap";

export interface Anomaly {
  code: AnomalyCode;
  severity: "error" | "warning";
  scope: "transaction" | "instrument" | "portfolio";
  transactionId?: string;
  instrumentId?: string;
  meta?: Record<string, unknown>;
}

export interface ReconciliationGap {
  cash: {
    currency: string;
    reported: string;
    derived: string;
    diff: string;
    /** Change in `diff` since the previous sync (this sync's diff − the last one's). The
     * incremental guard: a stable standing gap never alarms, only a fresh divergence does.
     * Absent on the first sync (no prior baseline) and on older stored reconciliations. */
    driftSincePrev?: string;
  }[];
  /** Per-ISIN position diff from TR's compactPortfolio snapshot (absent on older syncs). */
  positions?: { isin: string; reported: string; derived: string; diff: string }[] | null;
}

type TxWithId = CoreTransaction & { id?: string };

type Event =
  | { kind: "tx"; at: Date; tx: TxWithId }
  | { kind: "ca"; at: Date; ca: CorporateAction };

// Absolute cash-reconciliation tolerance. We derive cash by reconstructing each event
// (qty×price ± fees ± tax) and compare to the broker's reported balance. A standing gap can
// persist for instruments the feed represents in a way the timeline can't fully reconstruct
// (e.g. a dividend reconciliation booked only in the transactions-export); €1 tolerates that
// while still catching a materially-sized missed/extra transaction. The incremental
// {@link DRIFT_THRESHOLD} below is the sharper guard — it ignores the standing baseline and
// flags only a *new* divergence introduced by the latest sync.
const GAP_THRESHOLD = new Decimal("1.00");
// Incremental drift tolerance: how much the cash diff may move between two consecutive syncs
// before it is flagged. Tight (well under the absolute gap) so a single newly-mismapped event
// surfaces immediately and is attributable to the sync that introduced it — even when the
// absolute gap stays small. No hard-coded balance target, so it rides the growing account.
const DRIFT_THRESHOLD = new Decimal("0.50");
// Position qty tolerance: TR savings-plan fractions go to ~6 dp. 1e-4 ignores floating-
// point noise while still catching meaningful discrepancies (e.g. a missed buy event).
const POSITION_GAP_THRESHOLD = new Decimal("0.0001");
// Below this magnitude, a "negative" running cash balance is Decimal-reconstruction noise
// (observed live: ~1e-10 EUR after chaining hundreds of cashFlow() additions/subtractions),
// not a real negative balance — without this, a portfolio with no real negative-cash day
// still throws a spurious `error`-severity negative_cash anomaly. 1e-6 tolerates that noise
// (many orders of magnitude below a cent) while still catching a genuine shortfall.
const NEGATIVE_CASH_TOLERANCE = new Decimal("0.000001");

/**
 * Detect data-integrity anomalies in a portfolio's transactions.
 *
 * The quantity pass mirrors computeHoldings() exactly so that a split → sell sequence
 * is never a false positive: CAs and txns are sorted together, split/bonus are applied
 * to the running qty, and the oversell check fires before Decimal.min() clamps it.
 */
export function detectAnomalies(
  transactions: TxWithId[],
  corporateActions: CorporateAction[] = [],
  opts?: {
    /** Whether cash is inside the portfolio boundary (cashCounted). Gates negative-cash
     *  checks — outside-boundary portfolios intentionally exclude cash from valuation. */
    cashCounted?: boolean;
    /** Per-portfolio opt-out: accounts that routinely dip negative between deposits (a buy
     *  posts before its funding deposit clears) can suppress the negative-cash check entirely. */
    allowNegativeCash?: boolean;
    /** Broker-reported vs. derived cash reconciliation from the TR connection. */
    reconciliationGap?: ReconciliationGap | null;
  },
): Anomaly[] {
  const anomalies: Anomaly[] = [];

  // ── 1. Per-instrument quantity pass (mirrors holdings.ts) ──────────────────
  const byInstrument = new Map<string, Event[]>();

  for (const tx of transactions) {
    if (!tx.instrumentId) continue;
    const list = byInstrument.get(tx.instrumentId) ?? [];
    list.push({ kind: "tx", at: tx.executedAt, tx });
    byInstrument.set(tx.instrumentId, list);
  }
  for (const ca of corporateActions) {
    const list = byInstrument.get(ca.instrumentId) ?? [];
    list.push({ kind: "ca", at: ca.exDate, ca });
    byInstrument.set(ca.instrumentId, list);
  }

  for (const [instrumentId, events] of byInstrument) {
    events.sort((a, b) => a.at.getTime() - b.at.getTime());

    let qty = ZERO;

    for (const ev of events) {
      if (ev.kind === "ca") {
        const ratio = D(ev.ca.ratio);
        if (ev.ca.type === "split") {
          qty = qty.mul(ratio);
        } else if (ev.ca.type === "bonus") {
          qty = qty.add(qty.mul(ratio));
        }
        continue;
      }

      const { type, quantity, price } = ev.tx;
      const q = D(quantity);
      const p = D(price);
      const txId = ev.tx.id;

      // Missing basis / zero price
      if (type === "transfer_in" && p.isZero()) {
        anomalies.push({
          code: "missing_transfer_basis",
          severity: "warning",
          scope: "transaction",
          transactionId: txId,
          instrumentId,
        });
      } else if ((type === "buy" || type === "savings_plan" || type === "sell") && p.isZero()) {
        anomalies.push({
          code: "zero_price",
          severity: "warning",
          scope: "transaction",
          transactionId: txId,
          instrumentId,
        });
      }

      // Income on instrument not currently held
      if ((type === "dividend" || type === "coupon") && qty.isZero()) {
        anomalies.push({
          code: "income_on_non_held",
          severity: "warning",
          scope: "transaction",
          transactionId: txId,
          instrumentId,
        });
      }

      // Quantity integrity — check BEFORE clamping (mirrors holdings.ts:94 Decimal.min)
      if (type === "sell" || type === "transfer_out") {
        if (qty.isZero()) {
          anomalies.push({
            code: "sell_before_acquisition",
            severity: "error",
            scope: "transaction",
            transactionId: txId,
            instrumentId,
            meta: { attempted: quantity },
          });
        } else if (q.gt(qty)) {
          anomalies.push({
            code: "oversell",
            severity: "error",
            scope: "transaction",
            transactionId: txId,
            instrumentId,
            meta: { available: qty.toString(), attempted: quantity },
          });
        }
        // Mirror the Decimal.min clamp so the running qty stays consistent.
        qty = qty.sub(Decimal.min(q, qty));
      } else if (type === "buy" || type === "savings_plan" || type === "transfer_in" ||
                 type === "bonus") {
        // `bonus` free shares are real holdings (mirror holdings.ts) — counting them keeps
        // the running qty correct so a later sell of granted shares isn't false-flagged as
        // an oversell. A zero-price bonus is expected, so it's left out of the zero_price
        // check above.
        qty = qty.add(q);
      }
    }
  }

  // ── 2. Cash integrity pass — only for inside-boundary portfolios ───────────
  if (opts?.cashCounted && !opts?.allowNegativeCash) {
    // Deterministic total order: same-day rows share executedAt (stored at midnight) and
    // may even share createdAt, so id is the essential final tiebreaker. Without it the
    // attributed transaction would flip between reads and a keyed dismissal would un-stick.
    const sorted = [...transactions].sort((a, b) => {
      const byTime = a.executedAt.getTime() - b.executedAt.getTime();
      return byTime !== 0 ? byTime : (a.id ?? "").localeCompare(b.id ?? "");
    });
    // Track the first time each currency crosses into negative.
    const flagged = new Set<string>();
    const running = new Map<string, Decimal>();
    // Net a whole day's flows per currency before checking: a buy that posts before its
    // same-day funding deposit must not trip a transient intraday negative. Only cash still
    // short at the day's close is a real anomaly. Attribute it to that day's last transaction
    // in the currency (deterministic under the sort above).
    let i = 0;
    while (i < sorted.length) {
      const key = dayKey(sorted[i].executedAt);
      const dayFlow = new Map<string, Decimal>();
      const lastTx = new Map<string, string | undefined>();
      while (i < sorted.length && dayKey(sorted[i].executedAt) === key) {
        const tx = sorted[i];
        const flow = cashFlow(tx);
        dayFlow.set(tx.currency, (dayFlow.get(tx.currency) ?? ZERO).add(flow));
        // Attribute only to a spending row — never to a deposit/dividend/zero-flow row that
        // happens to sort last. A flagged day nets negative, so a negative-flow row exists.
        if (flow.lt(ZERO)) lastTx.set(tx.currency, tx.id);
        i++;
      }
      for (const [cur, flow] of dayFlow) {
        const prev = running.get(cur) ?? ZERO;
        const next = prev.add(flow);
        running.set(cur, next);
        // Both sides of the crossing check use the same tolerant "zero" so a noise-level dip
        // on an earlier day never counts as "already negative" for a later, real crossing.
        if (
          !flagged.has(cur) &&
          next.lt(ZERO.sub(NEGATIVE_CASH_TOLERANCE)) &&
          prev.gte(ZERO.sub(NEGATIVE_CASH_TOLERANCE))
        ) {
          flagged.add(cur);
          anomalies.push({
            code: "negative_cash",
            severity: "error",
            scope: "transaction",
            transactionId: lastTx.get(cur),
            meta: { currency: cur, balance: next.toString() },
          });
        }
      }
    }
  }

  // ── 3. Reconciliation gaps ─────────────────────────────────────────────────
  if (opts?.reconciliationGap) {
    for (const { currency, reported, derived, diff, driftSincePrev } of opts.reconciliationGap.cash) {
      if (new Decimal(diff).abs().gte(GAP_THRESHOLD)) {
        anomalies.push({
          code: "reconciliation_gap",
          severity: "warning",
          scope: "portfolio",
          meta: { currency, reported, derived, diff },
        });
      }
      // Incremental guard: a NEW divergence since the previous sync, regardless of how small
      // (or large and stable) the absolute gap is. This is what catches a freshly-mismapped
      // event the moment it appears, attributable to this sync.
      if (driftSincePrev != null && new Decimal(driftSincePrev).abs().gte(DRIFT_THRESHOLD)) {
        anomalies.push({
          code: "reconciliation_drift",
          severity: "warning",
          scope: "portfolio",
          meta: { currency, reported, derived, diff, driftSincePrev },
        });
      }
    }
    for (const { isin, reported, derived, diff } of opts.reconciliationGap.positions ?? []) {
      if (new Decimal(diff).abs().gte(POSITION_GAP_THRESHOLD)) {
        anomalies.push({
          code: "position_gap",
          severity: "warning",
          scope: "portfolio",
          meta: { isin, reported, derived, diff },
        });
      }
    }
  }

  return anomalies;
}
