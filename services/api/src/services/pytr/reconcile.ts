import { Decimal } from "decimal.js";
import type { FastifyBaseLogger } from "fastify";
import {
  cashBalances,
  cashFlow,
  isAcquisitionType,
  isIncomeType,
  type CoreTransaction,
  type ReconciliationGap,
} from "@portfolio/core";
import { mapTrEvents } from "./mapper.js";
import type { TrExportSummary } from "./runner.js";

// Cash/position reconciliation for a TR sync: compare TR's own reported balances against
// what we derive from the full mapped timeline. Split out of sync.ts — these are the pure,
// heaviest-tested helpers (no DB, no network); the orchestrator just calls them.

export interface CashReconciliation {
  checkedAt: string;
  cash: {
    currency: string;
    reported: string;
    derived: string;
    diff: string;
    /** Change in `diff` vs the previous sync's reconciliation (incremental drift guard).
     * Absent on the first sync for a connection. */
    driftSincePrev?: string;
  }[];
  /** Per-ISIN position snapshot diff (null/absent until first position-enabled sync). */
  positions?: { isin: string; reported: string; derived: string; diff: string }[] | null;
  /** Postbox-PDF download outcome for this sync (only set when a download was attempted). */
  documents?: {
    requested: number;
    stored: number;
    checkedAt: string;
    /** Set when the whole download failed (e.g. session expired) so the UI can distinguish
     * "0 of 20 saved" (partial) from "download failed: …" (total). */
    error?: string;
  };
}

// Cash-reconciliation diff jump (in the reported currency's units) above which we emit a
// warn. The @portfolio/core guard treats sub-€1 movement as reconstruction noise; a jump
// past it between syncs is worth flagging in the logs so a real cash regression is greppable.
const DRIFT_WARN_THRESHOLD = new Decimal(1);

// Reads the app's OWN round-tripped JSONB column, so corruption is unlikely — but a malformed
// row (failed write, a future shape change, a manual DB edit) shouldn't throw mid-sync.
// Validate the shape just enough to use it safely and fall back to null otherwise; a dropped
// reconciliation just omits the incremental drift on this run.
export function asReconciliation(v: unknown, log?: FastifyBaseLogger): CashReconciliation | null {
  const o = v as Record<string, unknown> | null;
  if (o && Array.isArray(o.cash)) return o as unknown as CashReconciliation;
  if (v != null) log?.warn({ lastReconciliation: v }, "tr lastReconciliation malformed — ignoring");
  return null;
}

// Compare TR's reported cash balance against the cash we derive from the full event
// timeline. By deriving from the mapped events (not from confirmed transactions), this
// answers "did our mapper account for every cash movement TR knows about?" regardless of
// how many events have been confirmed by the user. This is deliberately boundary-AGNOSTIC:
// it maps the full timeline regardless of the cash-outside staging filter (issue #326), so
// deposits/withdrawals/card spending are always counted here even when a cash-outside
// portfolio doesn't stage them. Do NOT apply the staging filter to this — reconciliation must
// see every cash movement TR knows about, or its derived balance would diverge from reported.
// A near-zero diff means all events are mapped; a non-zero diff typically indicates
// events with unknown types or amounts the mapper can't yet handle. Returns undefined
// when TR didn't report a balance.
export function reconcileCash(
  allEvents: unknown[],
  summary: TrExportSummary | undefined,
  prev?: CashReconciliation | null,
): CashReconciliation | undefined {
  const reported = summary?.cash;
  if (!reported || reported.length === 0) return undefined;
  // The previous sync's diff per currency, so we can report how much it moved (the
  // incremental drift the @portfolio/core guard alarms on).
  const prevDiff = new Map<string, string>((prev?.cash ?? []).map((c) => [c.currency, c.diff]));

  // Map the full timeline (all categories, all event states — the mapper itself skips
  // non-EXECUTED events). Convert the resulting drafts to CoreTransaction for cashBalances.
  const { drafts } = mapTrEvents(allEvents);
  const coreTxns: CoreTransaction[] = drafts.map((d) => ({
    instrumentId: null,
    type: d.action as CoreTransaction["type"],
    quantity: d.quantity,
    price: d.price,
    fees: d.fees,
    // tax must be carried through: cashFlow() for sells subtracts tax from gross proceeds.
    // Omitting it would over-credit derived cash by the full capital-gains tax on each sell.
    tax: d.tax,
    // kind must be carried through: cashFlow() treats reward-funded acquisitions
    // (kind: "saveback" | "crypto_bonus") as cash-neutral — the reward covers the principal
    // and TR's feed never emits a separate credit for it. Omitting kind here made
    // reconcileCash count every saveback/crypto-bonus buy as a real outflow, understating
    // derived cash by the full reward amount (a purely cosmetic reconcile bug — confirmed
    // holdings cash already honors kind via the same @portfolio/core cashFlow()).
    kind: d.kind,
    currency: d.currency,
    executedAt: d.executedAt,
  }));

  const derived = cashBalances(coreTxns);
  const currencies = new Set([...reported.map((c) => c.currency), ...Object.keys(derived)]);
  const cash = [...currencies].map((currency) => {
    const reportedStr = String(reported.find((c) => c.currency === currency)?.amount ?? "0");
    const derivedStr = derived[currency] ?? "0";
    // Use Decimal arithmetic (not JS float) to avoid floating-point drift.
    const diff = new Decimal(reportedStr).sub(new Decimal(derivedStr)).toFixed(2);
    const prior = prevDiff.get(currency);
    return {
      currency,
      reported: reportedStr,
      derived: derivedStr,
      diff,
      ...(prior != null
        ? { driftSincePrev: new Decimal(diff).sub(new Decimal(prior)).toFixed(2) }
        : {}),
    };
  });
  return { checkedAt: new Date().toISOString(), cash };
}

// `reconcileCash` derives purely from the raw TR feed (mapTrEvents), never from stored
// rows — that's deliberate, it answers "did we map every feed event." A manual `adjustment`
// transaction is the user's own correction for a known feed-vs-reality gap the feed itself
// gives no signal for (see the 3b investigation); it lives only in storage, so it can't
// move `reconcileCash`'s derived total. Fold it in here, at read time, so booking the
// true-up actually clears the `reconciliation_gap` warning instead of just fixing the
// holdings-cash number on a different screen.
//
// A same-typed correction (e.g. a manual, negative-priced `dividend` reversing a feed-side
// ghost dividend — see tr_cash.md's Realty Income fix) needs the SAME fold, but must NOT be
// caught by a blanket "any source:manual row" rule: a manual `deposit`/`buy`/`withdrawal` is
// typically a REAL cash movement the feed independently reports (or will, once synced) —
// folding it in would mask a genuine mapping gap instead of fixing a known one (this broke
// a real deposit+adjustment test case; caught the hard way). The narrow, unambiguous signal
// is: a manual INCOME-type row (dividend/coupon/interest/bonus_cash) with a NEGATIVE price.
// TR never reports a real distribution as negative, so such a row can only be a correction,
// never a genuine income event — safe to fold unconditionally.
export function netManualAdjustments(
  rec: ReconciliationGap,
  transactions: CoreTransaction[],
): ReconciliationGap {
  const adjustments = transactions.filter(
    (tx) =>
      tx.type === "adjustment" ||
      (tx.source === "manual" && isIncomeType(tx.type) && new Decimal(tx.price).isNegative()),
  );
  if (adjustments.length === 0) return rec;

  const byCurrency = new Map<string, Decimal>();
  for (const tx of adjustments) {
    const prev = byCurrency.get(tx.currency) ?? new Decimal(0);
    byCurrency.set(tx.currency, prev.add(cashFlow(tx)));
  }

  return {
    ...rec,
    cash: rec.cash.map((c) => {
      const delta = byCurrency.get(c.currency);
      if (!delta || delta.isZero()) return c;
      const derived = new Decimal(c.derived).add(delta);
      const diff = new Decimal(c.reported).sub(derived).toFixed(2);
      return { ...c, derived: derived.toString(), diff };
    }),
  };
}

// Derive per-ISIN held quantities from the full event timeline. Maps all TR timeline
// events (same input as reconcileCash) so the derived side answers "what does the full
// event record say we hold?" regardless of what the user has confirmed. Excludes events
// whose status is not EXECUTED (same filter as the mapper).
export function reconcilePositions(
  allEvents: unknown[],
  summary: TrExportSummary | undefined,
): { isin: string; reported: string; derived: string; diff: string }[] | undefined {
  const reported = summary?.positions;
  if (!reported || reported.length === 0) return undefined;

  const { drafts } = mapTrEvents(allEvents);
  const derived = new Map<string, Decimal>();
  for (const d of drafts) {
    if (!d.isin || !d.quantity) continue;
    const isin = d.isin;
    const prev = derived.get(isin) ?? new Decimal(0);
    const qty = new Decimal(d.quantity);
    const action = d.action as string;
    if (isAcquisitionType(action) || action === "transfer_in") {
      derived.set(isin, prev.add(qty));
    } else if (action === "sell" || action === "transfer_out") {
      derived.set(isin, prev.sub(qty));
    }
  }

  const reportedMap = new Map(reported.map((p) => [p.isin, new Decimal(String(p.qty))]));
  const allIsins = new Set([...reportedMap.keys(), ...derived.keys()]);
  return [...allIsins].map((isin) => {
    const rep = reportedMap.get(isin) ?? new Decimal(0);
    const der = derived.get(isin) ?? new Decimal(0);
    return {
      isin,
      reported: rep.toFixed(6),
      derived: der.toFixed(6),
      diff: rep.sub(der).toFixed(6),
    };
  });
}

// Flag a cash-diff jump since the previous sync — the incremental drift guard. Logged (not
// fatal): a real regression is then greppable without a separate alerting path.
export function logCashDrift(
  cashRec: CashReconciliation | undefined,
  connectionId: string,
  log?: FastifyBaseLogger,
): void {
  for (const c of cashRec?.cash ?? []) {
    if (c.driftSincePrev != null && new Decimal(c.driftSincePrev).abs().gt(DRIFT_WARN_THRESHOLD)) {
      log?.warn(
        { connectionId, currency: c.currency, diff: c.diff, driftSincePrev: c.driftSincePrev },
        "tr cash reconciliation drift jumped",
      );
    }
  }
}
