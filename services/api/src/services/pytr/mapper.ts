import { z } from "zod";
import type { ParsedAction, ParsedTransaction } from "@portfolio/schema";

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
  shares: z.number().nullish(),
  fees: z.number().nullish(),
  savingsPlanId: z.string().nullish(),
});
export type TrEvent = z.infer<typeof trEventSchema>;

// eventType → action for events whose action is fixed. ORDER_EXECUTED / TRADE_INVOICE
// are resolved to buy/sell by the sign of `amount` (see below). INTEREST is folded into
// `deposit` for v1 (a cash increase with no instrument).
const FIXED_ACTIONS: Record<string, ParsedAction> = {
  PAYMENT_INBOUND: "deposit",
  PAYMENT_INBOUND_APPLE_PAY: "deposit",
  PAYMENT_INBOUND_GOOGLE_PAY: "deposit",
  INCOMING_TRANSFER: "deposit",
  ACCOUNT_TRANSFER_INCOMING: "deposit",
  card_refund: "deposit",
  PAYMENT_OUTBOUND: "withdrawal",
  OUTGOING_TRANSFER: "withdrawal",
  card_successful_transaction: "withdrawal",
  card_successful_atm_withdrawal: "withdrawal",
  INTEREST_PAYOUT: "deposit",
  INTEREST_PAYOUT_CREATED: "deposit",
  CREDIT: "dividend", // a bond would be a coupon; mapper has no asset class → default dividend
  SAVINGS_PLAN_EXECUTED: "savings_plan",
  SAVINGS_PLAN_INVOICE_CREATED: "savings_plan",
  benefits_saveback_execution: "savings_plan",
  benefits_spare_change_execution: "buy",
};
const TRADE_EVENTS = new Set(["ORDER_EXECUTED", "TRADE_INVOICE"]);

// Actions that move shares (need an instrument + a per-share price). The rest are pure
// cash movements recorded as a lump sum in `price`.
const SECURITY_ACTIONS = new Set<ParsedAction>([
  "buy",
  "sell",
  "savings_plan",
  "dividend",
  "coupon",
]);

export type MapResult =
  | { draft: ParsedTransaction }
  | { skip: true; reason: string };

// Format a JS number as a decimalString (no exponent, trailing zeros trimmed).
function dstr(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const s = n.toFixed(10).replace(/\.?0+$/, "");
  return s === "" || s === "-" ? "0" : s;
}

/**
 * Map one raw Trade Republic timeline event to a draft transaction, or skip it with a
 * reason (unknown event types are surfaced as errors, never silently dropped). Pure and
 * table-driven — the top unit-test target.
 */
export function mapTrEventToDraft(raw: unknown): MapResult {
  const parsed = trEventSchema.safeParse(raw);
  if (!parsed.success) {
    return { skip: true, reason: `unparseable event: ${parsed.error.issues[0]?.message}` };
  }
  const ev = parsed.data;

  let action: ParsedAction | undefined = FIXED_ACTIONS[ev.eventType];
  if (!action && TRADE_EVENTS.has(ev.eventType)) {
    // Negative amount = cash out = buy; positive = proceeds = sell.
    action = ev.amount < 0 ? "buy" : "sell";
  }
  if (!action) {
    return { skip: true, reason: `unmapped event type: ${ev.eventType}` };
  }

  const amount = Math.abs(ev.amount);
  const fees = Math.abs(ev.fees ?? 0);
  const isSecurity = SECURITY_ACTIONS.has(action);

  if (isSecurity && !ev.isin) {
    return { skip: true, reason: `${ev.eventType} without an ISIN` };
  }

  let quantity = "0";
  let price = dstr(amount); // cash lump sum by default (deposit/withdrawal/dividend/...)

  if (action === "buy" || action === "sell" || action === "savings_plan") {
    const shares = Math.abs(ev.shares ?? 0);
    if (shares === 0) {
      return { skip: true, reason: `${ev.eventType} without a share count` };
    }
    quantity = dstr(shares);
    price = dstr((amount - fees) / shares); // per-share, fees carried separately
  }

  const draft: ParsedTransaction = {
    assetClass: "equity", // TR is equities/ETFs; refined at confirm if needed
    action,
    ticker: null,
    isin: ev.isin ?? null,
    name: ev.title ?? ev.isin ?? ev.eventType,
    quantity,
    unit: "shares",
    price,
    fees: dstr(fees),
    total: dstr(amount),
    currency: ev.currency.toUpperCase(),
    executedAt: new Date(ev.timestamp),
    confidence: 1,
    externalId: ev.id,
    savingsPlanId: ev.savingsPlanId ?? null,
    exchangeCode: null,
  };
  return { draft };
}

/** Map a batch of raw events to drafts, collecting skips as errors (not dropped). */
export function mapTrEvents(rawEvents: unknown[]): {
  drafts: ParsedTransaction[];
  errors: { line: number; message: string }[];
} {
  const drafts: ParsedTransaction[] = [];
  const errors: { line: number; message: string }[] = [];
  rawEvents.forEach((raw, i) => {
    const result = mapTrEventToDraft(raw);
    if ("draft" in result) drafts.push(result.draft);
    else errors.push({ line: i, message: result.reason });
  });
  return { drafts, errors };
}
