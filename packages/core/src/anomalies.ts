import { Decimal } from "decimal.js";
import type { CoreTransaction, CorporateAction } from "./types.js";
import { cashFlow } from "./cash.js";

const D = (v: string) => new Decimal(v);
const ZERO = new Decimal(0);

export type AnomalyCode =
  | "oversell"
  | "sell_before_acquisition"
  | "negative_cash"
  | "income_on_non_held"
  | "missing_transfer_basis"
  | "zero_price"
  | "reconciliation_gap"
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
  cash: { currency: string; reported: string; derived: string; diff: string }[];
  /** Per-ISIN position diff from TR's compactPortfolio snapshot (absent on older syncs). */
  positions?: { isin: string; reported: string; derived: string; diff: string }[] | null;
}

type TxWithId = CoreTransaction & { id?: string };

type Event =
  | { kind: "tx"; at: Date; tx: TxWithId }
  | { kind: "ca"; at: Date; ca: CorporateAction };

// Cash reconciliation tolerance. We derive cash by reconstructing each event
// (qty×price ± fees ± tax); a live audit against a real 919-event Trade Republic account
// showed our derived balance (2808.29) matched TR's reported balance (2809.12) to within
// €0.83 — accumulated sub-euro per-event reconstruction drift (TR's internal balance vs our
// reconstruction across hundreds of trades/dividends/card-FX entries), NOT a single missing
// transaction. The DRIP-reinvestment and saveback events were verified cash-correct (modelling
// them differently moved the balance ~€90 the wrong way). €1 tolerates that drift while still
// catching a genuinely missed/extra transaction, which is materially larger.
const GAP_THRESHOLD = new Decimal("1.00");
// Position qty tolerance: TR savings-plan fractions go to ~6 dp. 1e-4 ignores floating-
// point noise while still catching meaningful discrepancies (e.g. a missed buy event).
const POSITION_GAP_THRESHOLD = new Decimal("0.0001");

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
      } else if (type === "buy" || type === "savings_plan" || type === "transfer_in") {
        qty = qty.add(q);
      }
    }
  }

  // ── 2. Cash integrity pass — only for inside-boundary portfolios ───────────
  if (opts?.cashCounted) {
    const sorted = [...transactions].sort(
      (a, b) => a.executedAt.getTime() - b.executedAt.getTime(),
    );
    // Track the first time each currency crosses into negative.
    const flagged = new Set<string>();
    const running = new Map<string, Decimal>();
    for (const tx of sorted) {
      const cur = tx.currency;
      const prev = running.get(cur) ?? ZERO;
      const next = prev.add(cashFlow(tx));
      running.set(cur, next);
      if (!flagged.has(cur) && next.lt(ZERO) && prev.gte(ZERO)) {
        flagged.add(cur);
        anomalies.push({
          code: "negative_cash",
          severity: "error",
          scope: "transaction",
          transactionId: tx.id,
          meta: { currency: cur, balance: next.toString() },
        });
      }
    }
  }

  // ── 3. Reconciliation gaps ─────────────────────────────────────────────────
  if (opts?.reconciliationGap) {
    for (const { currency, reported, derived, diff } of opts.reconciliationGap.cash) {
      if (new Decimal(diff).abs().gte(GAP_THRESHOLD)) {
        anomalies.push({
          code: "reconciliation_gap",
          severity: "warning",
          scope: "portfolio",
          meta: { currency, reported, derived, diff },
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
