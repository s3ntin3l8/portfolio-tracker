import { z } from "zod";
import type { ImportIssue, ParsedAction, ParsedTransaction } from "@portfolio/schema";

// The normalized event shape tr_export.py emits (one JSON object per line). The Python
// side extracts isin/shares/fees from the timeline detail; any may be absent.
const trEventSchema = z.object({
  id: z.string().min(1),
  timestamp: z.string().min(1),
  eventType: z.string().min(1),
  title: z.string().nullish(),
  amount: z.number(), // signed: negative = cash out (buy/withdrawal), positive = cash in
  currency: z.string().default("EUR"),
  isin: z.string().nullish(),
  // WKN (German security id), fetched per ISIN from TR's instrument-detail channel —
  // the timeline events themselves carry only an ISIN. Best-effort / nullable.
  wkn: z.string().nullish(),
  shares: z.number().nullish(),
  fees: z.number().nullish(),
  savingsPlanId: z.string().nullish(),
  // TR booking status. Only EXECUTED events are real; CANCELED/PENDING are skipped (a
  // cancellation of an already-confirmed event is un-imported by the sync reconciler).
  // Absent on older fixtures — treated as EXECUTED for backward compatibility.
  status: z.string().nullish(),
  // Detail enrichment extracted by tr_export.py (all best-effort / nullable).
  executedPrice: z.number().nullish(),
  tax: z.number().nullish(),
  fxRate: z.number().nullish(),
  venue: z.string().nullish(),
  description: z.string().nullish(),
  documentRefs: z
    .array(z.object({ id: z.string(), type: z.string().nullish(), date: z.string().nullish() }))
    .nullish(),
});

// TR books crypto under synthetic ISINs (XF000<TICKER>…). Recognised at the source so the
// draft carries the right asset class; full symbol/venue resolution happens at confirm.
const TR_CRYPTO_ISIN = /^XF000[A-Z]{2,5}\d+$/;

// Acceptable gap between a trade's executed-price notional and its booked total before the
// draft is flagged for review (fees + tax are normally well within this).
const RECONCILE_TOLERANCE = 0.1;

// Savings-plan-funded buys come in two flavours TR distinguishes by event type.
const EVENT_KIND: Record<string, string> = {
  SAVEBACK_AGGREGATE: "saveback",
  SPARE_CHANGE_AGGREGATE: "roundup",
};

// Coarse import categories so a connection can opt out of (e.g.) day-to-day card spending
// without losing trades/dividends. TR is a full bank account, not just a brokerage.
export type ImportCategory = "trade" | "income" | "cashflow" | "card";

const CARD_EVENTS = new Set([
  "CARD_TRANSACTION",
  "CARD_ATM_WITHDRAWAL",
  "CARD_ORDER_FEE",
  "CARD_REFUND",
  "CARD_VERIFICATION",
  "CARD_AFT",
]);

/** Classify an event into a coarse import category (used by the per-connection filter). */
export function categoryForEventType(eventType: string): ImportCategory {
  if (CARD_EVENTS.has(eventType)) return "card";
  if (TRADE_EVENTS.has(eventType)) return "trade";
  if (eventType === CASH_CORPORATE_ACTION) return "income"; // Bardividende
  if (eventType === SHARE_CORPORATE_ACTION) return "income"; // stock dividend / bonus issue
  const action = FIXED_ACTIONS[eventType];
  if (action === "buy" || action === "sell" || action === "savings_plan") return "trade";
  if (action === "dividend" || action === "coupon" || action === "interest") return "income";
  return "cashflow"; // deposits/withdrawals/transfers and anything unmapped
}
export type TrEvent = z.infer<typeof trEventSchema>;

// The TR timeline event taxonomy (validated against a real 912-event account, 2026-06-15).
//
// eventType → action for events whose action is fixed. Trades (TRADE_EVENTS) resolve to
// buy/sell by the sign of `amount`; ambiguous cash transfers (CASH_BY_SIGN) resolve to
// deposit/withdrawal by sign. INTEREST_PAYOUT is folded into `deposit` (a cash increase
// with no instrument). Card spending is recorded as a `withdrawal` so the derived cash
// balance stays correct.
const FIXED_ACTIONS: Record<string, ParsedAction> = {
  // --- cash in ---
  PAYMENT_INBOUND: "deposit",
  PAYMENT_INBOUND_SEPA_DIRECT_DEBIT: "deposit",
  PAYMENT_INBOUND_CREDIT_CARD: "deposit",
  PAYMENT_INBOUND_APPLE_PAY: "deposit",
  PAYMENT_INBOUND_GOOGLE_PAY: "deposit",
  INCOMING_TRANSFER: "deposit",
  ACCOUNT_TRANSFER_INCOMING: "deposit",
  BANK_TRANSACTION_INCOMING: "deposit",
  // Interest on the cash balance is income, not a deposit (would otherwise be counted as a
  // contribution and skew invested capital / money-weighted return).
  // INTEREST_PAYOUT_CREATED is the pre-late-2024 name for the same monthly cash-interest
  // booking — validated against a real account (disjoint, continuous months with no overlap;
  // TR renamed the event type in late 2024, not a notice-then-settlement pair).
  INTEREST_PAYOUT: "interest",
  INTEREST_PAYOUT_CREATED: "interest",
  CARD_REFUND: "deposit",
  // --- cash out ---
  PAYMENT_OUTBOUND: "withdrawal",
  OUTGOING_TRANSFER: "withdrawal",
  BANK_TRANSACTION_OUTGOING: "withdrawal",
  CARD_TRANSACTION: "withdrawal", // debit-card spend from the cash account
  CARD_ATM_WITHDRAWAL: "withdrawal",
  CARD_ORDER_FEE: "withdrawal",
  // --- income tied to a holding (a bond would be a coupon; no asset class → dividend) ---
  CREDIT: "dividend",
  // --- recurring / fractional purchases (need an ISIN + a share count) ---
  SAVINGS_PLAN_EXECUTED: "savings_plan",
  SAVINGS_PLAN_INVOICE_CREATED: "savings_plan",
  TRADING_SAVINGSPLAN_EXECUTED: "savings_plan",
  SAVEBACK_AGGREGATE: "savings_plan", // cashback reinvested into the saveback asset
  SPARE_CHANGE_AGGREGATE: "buy", // round-up purchases
};
const TRADE_EVENTS = new Set(["ORDER_EXECUTED", "TRADE_INVOICE", "TRADING_TRADE_EXECUTED"]);

// Cash transfers whose direction is only known from the amount's sign.
const CASH_BY_SIGN = new Set(["JUNIOR_P2P_TRANSFER", "SSP_TAX_CORRECTION", "CARD_AFT"]);

// A cash corporate action (e.g. "Bardividende") — a dividend when tied to an instrument,
// otherwise a plain cash credit.
const CASH_CORPORATE_ACTION = "SSP_CORPORATE_ACTION_CASH";

// Events deliberately not turned into transactions, with the reason surfaced (not dropped).
//
// These are purely administrative/notification/report/order-lifecycle events with NO cash and
// NO share movement (validated against pytr's own event taxonomy + #359's ignore list). Each
// is skipped as `info` so it is recorded with a reason — never silently dropped — and so it
// no longer surfaces as an "unmapped event type" attention gap (which buries the real gaps the
// safety net is meant to flag). Anything that *could* carry value (TAXES/Vorabpauschale,
// MATURITY, SHAREBOOKING, corporate-action instructions, referral perks, …) is intentionally
// NOT here — those stay surfaced until classified.
const SKIP_EVENTS = new Map<string, string>([
  ["CARD_VERIFICATION", "card verification (no cash movement)"],
  ["TRADING_SAVINGSPLAN_EXECUTION_FAILED", "failed savings-plan execution"],
  // Order lifecycle — the only cash leg is the fill (ORDER_EXECUTED); these carry none.
  ["ORDER_CREATED", "order created (no fill, no cash)"],
  ["ORDER_CANCELED", "order cancelled (no fill, no cash)"],
  ["ORDER_EXPIRED", "order expired (no fill, no cash)"],
  ["ORDER_REJECTED", "order rejected (no fill, no cash)"],
  ["TRADING_ORDER_REJECTED", "order rejected (no fill, no cash)"],
  // Documents, statements and regulatory reports — informational, no cash/shares.
  ["DOCUMENTS_CREATED", "document created (informational)"],
  ["DOCUMENTS_ACCEPTED", "document accepted (informational)"],
  ["DOCUMENTS_CHANGED", "document changed (informational)"],
  ["EX_POST_COST_REPORT", "ex-post cost report (informational)"],
  ["EX_POST_COST_REPORT_CREATED", "ex-post cost report (informational)"],
  ["TAX_YEAR_END_REPORT", "year-end tax report (informational)"],
  ["TAX_YEAR_END_REPORT_CREATED", "year-end tax report (informational)"],
  ["YEAR_END_TAX_REPORT", "year-end tax report (informational)"],
  ["QUARTERLY_REPORT", "quarterly report (informational)"],
  ["CRYPTO_ANNUAL_STATEMENT", "crypto annual statement (informational)"],
  // Account / profile / device / onboarding admin — no financial effect.
  ["ADDRESS_CHANGED", "address changed (informational)"],
  ["REFERENCE_ACCOUNT_CHANGED", "reference account changed (informational)"],
  ["CASH_ACCOUNT_CHANGED", "cash account changed (informational)"],
  ["SECURITIES_ACCOUNT_CREATED", "securities account created (informational)"],
  ["CUSTOMER_CREATED", "customer created (informational)"],
  ["EMAIL_VALIDATED", "email validated (informational)"],
  ["DEVICE_RESET", "device reset (informational)"],
  ["PUK_CREATED", "PUK created (informational)"],
  ["INPAYMENTS_SEPA_MANDATE_CREATED", "SEPA mandate created (informational)"],
  ["AML_SOURCE_OF_WEALTH_RESPONSE_EXECUTED", "AML source-of-wealth response (informational)"],
  ["CSX_CHAT_ACTIVITY", "support chat activity (informational)"],
  ["RDD_FLOW", "regulatory due-diligence flow (informational)"],
  ["JUNIOR_ONBOARDING_GUARDIAN_B_CONSENT", "junior onboarding consent (informational)"],
  ["VERIFICATION_TRANSFER_ACCEPTED", "verification transfer accepted (informational)"],
  // Freistellungsauftrag (tax exemption order) changes — informational; the tax effect
  // itself lands on the dividend/interest events, not here.
  ["EXEMPTION_ORDER_CHANGED", "tax exemption order changed (informational)"],
  ["EXEMPTION_ORDER_CHANGE_REQUESTED", "tax exemption order change requested (informational)"],
  [
    "EXEMPTION_ORDER_CHANGE_REQUESTED_AUTOMATICALLY",
    "tax exemption order change requested (informational)",
  ],
  // Governance notification — no cash/shares (any resulting payout/issue is a separate event).
  ["GENERAL_MEETING", "general meeting notification (informational)"],
]);

// Skipped events the user may actually want to map (vs. ignorable info like a card ping).
const ATTENTION_SKIPS = new Set<string>();

// Share-based corporate action (stock dividend / bonus issue). TR event type for shares
// received with no cash; maps to `bonus` (no cash leg, quantity = received shares).
const SHARE_CORPORATE_ACTION = "SSP_CORPORATE_ACTION_INSTRUMENT";

// Actions that move shares (need an instrument + a per-share price). The rest are pure
// cash movements recorded as a lump sum in `price`.
const SECURITY_ACTIONS = new Set<ParsedAction>([
  "buy",
  "sell",
  "savings_plan",
  "dividend",
  "coupon",
  "bonus",
]);

export type MapResult =
  | { draft: ParsedTransaction }
  | {
      skip: true;
      reason: string;
      severity: "info" | "attention";
      code?: ImportIssue["code"];
      eventId?: string;
      eventType?: string;
      raw?: ImportIssue["raw"];
    };

// Format a JS number as a decimalString (no exponent, trailing zeros trimmed).
function dstr(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const s = n.toFixed(10).replace(/\.?0+$/, "");
  return s === "" || s === "-" ? "0" : s;
}

// Build a skip outcome, carrying the source event so the UI can offer to map it.
function skip(
  reason: string,
  severity: "info" | "attention",
  ev?: TrEvent,
  code?: ImportIssue["code"],
): MapResult {
  if (!ev) return { skip: true, reason, severity, code };
  return {
    skip: true,
    reason,
    severity,
    code,
    eventId: ev.id,
    eventType: ev.eventType,
    raw: {
      isin: ev.isin ?? null,
      name: ev.title ?? null,
      currency: ev.currency?.toUpperCase() ?? null,
      executedAt: ev.timestamp,
      amount: ev.amount,
      shares: ev.shares ?? null,
    },
  };
}

/**
 * Map one raw Trade Republic timeline event to a draft transaction, or skip it with a
 * reason (unknown event types are surfaced as errors, never silently dropped). Pure and
 * table-driven — the top unit-test target.
 */
export function mapTrEventToDraft(raw: unknown): MapResult {
  const parsed = trEventSchema.safeParse(raw);
  if (!parsed.success) {
    // A schema-level reject (e.g. a TR event with no `eventType` — the legacy securities-
    // transfer shape) surfaces as a self-announcing gap, not a silent drop.
    return skip(
      `unparseable event: ${parsed.error.issues[0]?.message}`,
      "attention",
      undefined,
      "unparseable_event",
    );
  }
  const ev = parsed.data;

  // Only EXECUTED events become drafts. A CANCELED/PENDING event is skipped here; if it was
  // previously confirmed, the sync reconciler removes the written transaction (status flips
  // in place on the same event id — e.g. annual dividend recalculations).
  if (ev.status && ev.status.toUpperCase() !== "EXECUTED") {
    return skip(`non-executed event (${ev.status})`, "info", ev);
  }

  const skipReason = SKIP_EVENTS.get(ev.eventType);
  if (skipReason) {
    return skip(skipReason, ATTENTION_SKIPS.has(ev.eventType) ? "attention" : "info", ev);
  }

  let action: ParsedAction | undefined = FIXED_ACTIONS[ev.eventType];
  if (!action && TRADE_EVENTS.has(ev.eventType)) {
    // Negative amount = cash out = buy; positive = proceeds = sell.
    action = ev.amount < 0 ? "buy" : "sell";
  }
  if (!action && CASH_BY_SIGN.has(ev.eventType)) {
    // Negative = money leaving the account; positive = money arriving.
    action = ev.amount < 0 ? "withdrawal" : "deposit";
  }
  if (!action && ev.eventType === CASH_CORPORATE_ACTION) {
    action = ev.isin ? "dividend" : "deposit";
  }
  if (!action && ev.eventType === SHARE_CORPORATE_ACTION) {
    action = "bonus";
  }
  if (!action) {
    return skip(`unmapped event type: ${ev.eventType}`, "attention", ev, "unmapped_event_type");
  }

  const amount = Math.abs(ev.amount);
  const fees = Math.abs(ev.fees ?? 0);
  const isSecurity = SECURITY_ACTIONS.has(action);

  if (isSecurity && !ev.isin) {
    return skip(`${ev.eventType} without an ISIN`, "attention", ev);
  }

  let quantity = "0";
  let price = dstr(amount); // cash lump sum by default (deposit/withdrawal/dividend/...)
  let confidence = 1;

  if (action === "buy" || action === "sell" || action === "savings_plan") {
    const shares = Math.abs(ev.shares ?? 0);
    if (shares === 0) {
      return skip(`${ev.eventType} without a share count`, "attention", ev);
    }
    quantity = dstr(shares);
    if (action === "sell") {
      // pytr `amount` = net cash credited (gross proceeds − fees − tax).
      // Reconstruct gross price so cashFlow = qty·grossPrice − fees − tax = amount.
      const sellTax = Math.abs(ev.tax ?? 0);
      price = dstr((amount + fees + sellTax) / shares);
    } else {
      // buy / savings_plan: amount = gross debit (before fees); reconstruct net per-share.
      price = dstr((amount - fees) / shares);
    }

    // Reconciliation: the executed price × shares should land near the booked total (fees +
    // tax are small). A large gap means the share count or price was mis-parsed — flag it for
    // review (low confidence drives the "needs review" badge + filter) rather than trust it.
    if (ev.executedPrice != null && amount > 0) {
      const notional = shares * Math.abs(ev.executedPrice);
      if (Math.abs(notional - amount) > Math.max(amount * RECONCILE_TOLERANCE, 0.5)) {
        confidence = 0.5;
      }
    }
  }

  if (action === "bonus") {
    // Stock dividend / bonus issue: shares received, no cash consideration.
    // The received share count should be extracted by tr_export.py (_extract_shares);
    // if missing, surface for manual mapping rather than producing a zero-quantity draft.
    const shares = Math.abs(ev.shares ?? 0);
    if (shares === 0) {
      return skip(
        `${ev.eventType} without a share count — check the event details`,
        "attention",
        ev,
      );
    }
    quantity = dstr(shares);
    price = "0"; // no cash consideration for a bonus share issue
  }

  // Asset class at the source: crypto when TR's synthetic ISIN says so, else equity/ETF
  // (refined at confirm via OpenFIGI). Avoids the old confirm-only crypto workaround.
  const assetClass = ev.isin && TR_CRYPTO_ISIN.test(ev.isin) ? "crypto" : "equity";

  const draft: ParsedTransaction = {
    assetClass,
    action,
    ticker: null,
    isin: ev.isin ?? null,
    wkn: ev.wkn ?? null,
    name: ev.title ?? ev.isin ?? ev.eventType,
    quantity,
    unit: "shares",
    price,
    fees: dstr(fees),
    total: dstr(amount),
    currency: ev.currency.toUpperCase(),
    executedAt: new Date(ev.timestamp),
    confidence,
    externalId: ev.id,
    savingsPlanId: ev.savingsPlanId ?? null,
    exchangeCode: null,
    // Enrichment (informational; persisted on the transaction at confirm).
    kind: EVENT_KIND[ev.eventType] ?? null,
    tax: ev.tax != null ? dstr(Math.abs(ev.tax)) : null,
    executedPrice: ev.executedPrice != null ? dstr(ev.executedPrice) : null,
    fxRate: ev.fxRate != null ? dstr(ev.fxRate) : null,
    venue: ev.venue ?? null,
    description: ev.description ?? null,
    documentRefs: ev.documentRefs ?? null,
  };
  return { draft };
}

/** Map a batch of raw events to drafts, collecting skips as issues (surfaced, not dropped). */
export function mapTrEvents(rawEvents: unknown[]): {
  drafts: ParsedTransaction[];
  errors: ImportIssue[];
} {
  const drafts: ParsedTransaction[] = [];
  const errors: ImportIssue[] = [];
  rawEvents.forEach((raw, i) => {
    const result = mapTrEventToDraft(raw);
    if ("draft" in result) drafts.push(result.draft);
    else
      errors.push({
        line: i,
        message: result.reason,
        severity: result.severity,
        code: result.code,
        eventId: result.eventId,
        eventType: result.eventType,
        raw: result.raw,
      });
  });
  return { drafts, errors };
}
