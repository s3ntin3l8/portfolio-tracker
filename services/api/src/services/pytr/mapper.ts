import { z } from "zod";
import type { ImportIssue, ParsedAction, ParsedTransaction } from "@portfolio/schema";
import { formatDecimal } from "../parsers/numeric.js";
import { collapsePerkFundedAcquisitions } from "../parsers/perk-pairing.js";

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
  // Acquisition kind hint tr_export derives from the detail when eventType isn't enough
  // (e.g. "crypto_bonus" — a reward-funded crypto buy that must be booked cash-neutral).
  kind: z.string().nullish(),
  executedPrice: z.number().nullish(),
  tax: z.number().nullish(),
  fxRate: z.number().nullish(),
  venue: z.string().nullish(),
  description: z.string().nullish(),
  documentRefs: z
    .array(z.object({ id: z.string(), type: z.string().nullish(), date: z.string().nullish() }))
    .nullish(),
  // Present only on a TR "Dividend correction" event (tr_export.py's
  // _extract_reclassification): resolves the restated event's true period + the
  // already-recognized-vs-genuinely-new amount split. trueDistributionDate is TR's own
  // DD.MM.YYYY document-date format (not ISO, unlike `timestamp`). dateResolutionFailed is
  // true only when resolution failed — omitted/null on success or when not applicable.
  trueDistributionDate: z.string().nullish(),
  originalAmount: z.number().nullish(),
  correctionAmount: z.number().nullish(),
  dateResolutionFailed: z.boolean().nullish(),
  // Present only on a Vorabpauschale accrual event (tr_export.py's _extract_vorab_base):
  // the gross taxable base, before Teilfreistellung (applied downstream by @portfolio/core).
  // Null on every other event, and on a Vorabpauschale event whose base couldn't be parsed.
  vorabBase: z.number().nullish(),
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
  // Vorabpauschale: a fund-holding tax accrual, not generic cashflow — group with income
  // (like dividends/coupons) so opting out of "cashflow" (card spending, deposits) doesn't
  // silently disable it too.
  if (eventType === NO_CASH_CORPORATE_ACTION) return "income";
  const action = FIXED_ACTIONS[eventType];
  if (
    action === "buy" ||
    action === "sell" ||
    action === "savings_plan" ||
    action === "transfer_in" ||
    action === "transfer_out"
  )
    return "trade"; // securities transfers move positions — group with trades, not cashflow
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
  // Delegated (e.g. standing-order) variant of the same external cash-in — pytr maps it to
  // DEPOSIT too. Economically identical to INCOMING_TRANSFER, so safe to mirror.
  INCOMING_TRANSFER_DELEGATION: "deposit",
  ACCOUNT_TRANSFER_INCOMING: "deposit",
  BANK_TRANSACTION_INCOMING: "deposit",
  // Interest on the cash balance is income, not a deposit (would otherwise be counted as a
  // contribution and skew invested capital / money-weighted return).
  // INTEREST_PAYOUT_CREATED is the pre-late-2024 name for the same monthly cash-interest
  // booking — validated against a real account (disjoint, continuous months with no overlap;
  // TR renamed the event type in late 2024, not a notice-then-settlement pair).
  INTEREST_PAYOUT: "interest",
  INTEREST_PAYOUT_CREATED: "interest",
  // German Vorabpauschale (advance lump-sum fund tax) — a standalone tax debit, not income.
  // Best-guess live eventType (the CSV taxonomy name); if the real timeline name differs it
  // still surfaces as an attention gap until added. Magnitude resolved below (amount or tax).
  EARNINGS: "tax",
  CARD_REFUND: "deposit",
  // --- cash out ---
  PAYMENT_OUTBOUND: "withdrawal",
  OUTGOING_TRANSFER: "withdrawal",
  // Delegated variant of the same external cash-out — pytr maps it to REMOVAL (withdrawal).
  OUTGOING_TRANSFER_DELEGATION: "withdrawal",
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
  // --- securities transfers (Depotübertrag): shares move, cash-neutral, no P&L ---
  // tr_export normalises the activity-log transfer forms (explicit type + the eventType-less
  // "Aktien erhalten/übertragen" subtitle) to TRANSFER_IN / TRANSFER_OUT.
  TRANSFER_IN: "transfer_in",
  TRANSFER_OUT: "transfer_out",
  SSP_SECURITIES_TRANSFER_INCOMING: "transfer_in",
};
const TRADE_EVENTS = new Set(["ORDER_EXECUTED", "TRADE_INVOICE", "TRADING_TRADE_EXECUTED"]);

// Cash transfers whose direction is only known from the amount's sign.
const CASH_BY_SIGN = new Set(["JUNIOR_P2P_TRANSFER", "SSP_TAX_CORRECTION", "CARD_AFT"]);

// A cash corporate action (e.g. "Bardividende") — a dividend when tied to an instrument,
// otherwise a plain cash credit.
const CASH_CORPORATE_ACTION = "SSP_CORPORATE_ACTION_CASH";

// A non-cash corporate action. Only one variant is currently mapped: a Vorabpauschale
// accrual (tr_export.py flags it via `kind: "vorabpauschale"`, gated on the event's own
// subtitle — see _is_vorabpauschale). Any other SSP_CORPORATE_ACTION_NO_CASH event stays
// an unmapped_event_type gap rather than being guessed at.
const NO_CASH_CORPORATE_ACTION = "SSP_CORPORATE_ACTION_NO_CASH";

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

// --- Account-level report documents ---------------------------------------------------
//
// TR's annual tax report ("Jährlicher Steuerbericht") and its siblings are SKIP_EVENTS
// above — they carry no cash/share movement and never become a draft transaction. They
// live on the activity-log feed, not timelineTransactions — validated against a real
// captured account (5 YEAR_END_TAX_REPORT/TAX_YEAR_END_REPORT_CREATED events, 2021-2025,
// every one on the activity log) — so tr_export.py's _collect_transactions merges them in
// from there explicitly (see tr_export.py's _is_report_event); their postbox
// `documentRefs` are attached the same way as any other event's (_extract_documents,
// called unconditionally in _normalize). extractReportDocuments() below reads that
// already-fetched data straight out of the raw event batch the sync path has in memory,
// so pulling these into the tax-reports inbox needs no separate pytr session/entrypoint.

// Newer events carry an explicit eventType.
const REPORT_EVENT_TYPES = new Set(["TAX_YEAR_END_REPORT", "TAX_YEAR_END_REPORT_CREATED", "YEAR_END_TAX_REPORT"]);

// Legacy events (pre-eventType migration) carry eventType=null and only a German title —
// always suffixed with the covered year ("Jährlicher Steuerbericht 2021"), hence a prefix
// match rather than exact equality. "Jährlicher Steuerbericht" is the live-confirmed title
// (see above); "Jährlicher Steuerreport" is kept too as a defensive fallback — it's what
// pytr's own `title_subfolder_mapping` (vendored pytr/dl.py) uses, a possibly-stale or
// differently worded legacy variant.
//
// Exported for reuse by services/parsers/report-pdf.ts, which sniffs the SAME title out of
// an uploaded PDF's extracted text (the general Add-Transaction upload flow) — one source
// of truth for what counts as "the annual TR tax report" across both surfaces.
export const REPORT_TITLE_PREFIXES = ["Jährlicher Steuerbericht", "Jährlicher Steuerreport"];

export const REPORT_TITLE_YEAR_RE = /\b(20\d{2})\b/;

// Deliberately NOT trEventSchema: that schema requires `eventType` as a non-empty string,
// which rejects exactly the legacy (pre-eventType-migration) events this function needs to
// match by title (eventType null/absent — see REPORT_TITLES above). Only the fields this
// extraction actually reads are required here.
const reportEventSchema = z.object({
  id: z.string().min(1),
  timestamp: z.string().min(1),
  eventType: z.string().nullish(),
  title: z.string().nullish(),
  documentRefs: z
    .array(z.object({ id: z.string(), type: z.string().nullish(), date: z.string().nullish() }))
    .nullish(),
});

export interface ReportDocumentRef {
  eventId: string;
  docId: string;
  /**
   * Best-effort reporting year: parsed from a 4-digit year in the event title when
   * present, else the event's posting year minus one (TR issues the annual report in
   * Jan/Feb of year+1). Unverified against a live title carrying an explicit year — the
   * fallback may be off by one if TR's title format or issuance timing differs from this
   * assumption. Null only when the posting timestamp itself is unparseable.
   */
  taxYear: number | null;
  title: string | null;
}

/**
 * Extract account-level tax-report document references from a raw tr_export.py event
 * batch (the same array passed to mapTrEvents — call both over the same input). These
 * events are intentionally excluded from mapTrEvents' drafts (SKIP_EVENTS), so this is
 * the only path that surfaces their documents.
 */
export function extractReportDocuments(rawEvents: unknown[]): ReportDocumentRef[] {
  const out: ReportDocumentRef[] = [];
  for (const raw of rawEvents) {
    const parsed = reportEventSchema.safeParse(raw);
    if (!parsed.success) continue;
    const ev = parsed.data;
    const title = ev.title?.trim() ?? null;
    const isReport =
      REPORT_EVENT_TYPES.has(ev.eventType ?? "") ||
      (title != null && REPORT_TITLE_PREFIXES.some((prefix) => title.startsWith(prefix)));
    if (!isReport || !ev.documentRefs || ev.documentRefs.length === 0) continue;

    const titleYear = title ? REPORT_TITLE_YEAR_RE.exec(title)?.[1] : undefined;
    const postedYear = new Date(ev.timestamp).getFullYear();
    const taxYear = titleYear ? Number(titleYear) : Number.isFinite(postedYear) ? postedYear - 1 : null;

    for (const doc of ev.documentRefs) {
      if (!doc.id) continue;
      out.push({ eventId: ev.id, docId: doc.id, taxYear, title });
    }
  }
  return out;
}

// Share-based corporate action (stock dividend / bonus issue). TR event type for shares
// received with no cash; maps to `bonus` (no cash leg, quantity = received shares).
const SHARE_CORPORATE_ACTION = "SSP_CORPORATE_ACTION_INSTRUMENT";

// Genuine cash movements that a cash-outside (invest-only) portfolio must NOT import: cash
// is outside its value boundary, so deposits/withdrawals/card spending would manufacture
// phantom flows (CLAUDE.md "one boundary per portfolio"). Keyed off the mapped *action* — not
// the coarse `cashflow` category — so unknown/unmapped event types (which `categoryForEventType`
// also buckets as `cashflow`) are NOT swept up here: they must still surface as attention gaps,
// never be silently dropped. A cash-inside (savings) portfolio imports everything, including
// these. Card events are always cash movements (debit-card spend reduces the cash balance).
export function isCashMovementEvent(eventType: string): boolean {
  if (CARD_EVENTS.has(eventType)) return true;
  // CASH_BY_SIGN events (JUNIOR_P2P_TRANSFER, SSP_TAX_CORRECTION, CARD_AFT) resolve to
  // deposit/withdrawal by the amount's sign — all pure cash movements.
  if (CASH_BY_SIGN.has(eventType)) return true;
  return isCashMovementAction(FIXED_ACTIONS[eventType] ?? "");
}

// Action-level variant for already-parsed drafts (e.g. the TR PDF path, which has a draft
// `action` but no TR `eventType`). Deposits/withdrawals are the only cash movements a parsed
// draft carries — card spending never reaches a draft.
export function isCashMovementAction(action: string): boolean {
  return action === "deposit" || action === "withdrawal";
}

// Actions that move shares (need an instrument + a per-share price). The rest are pure
// cash movements recorded as a lump sum in `price`.
const SECURITY_ACTIONS = new Set<ParsedAction>([
  "buy",
  "sell",
  "savings_plan",
  "dividend",
  "coupon",
  "bonus",
  "transfer_in",
  "transfer_out",
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

// Suffix marking a "Dividend correction" event's backdated original-portion booking (see
// buildReclassificationSplit). Exported so sync.ts/cancellation.ts/documents.ts — which
// otherwise treat `transactions.externalId` as identical to the raw TR event id — can
// strip it back to the raw id wherever that assumption matters (dedup gating,
// cancellation matching, live document-id lookups). The correction leg deliberately keeps
// externalId = the raw event id UNCHANGED (see buildReclassificationSplit) specifically so
// none of those call sites need to know about the split at all; only this one suffixed,
// synthetic row does.
export const RECLASSIFICATION_ORIGINAL_SUFFIX = ":original";

/** Strip a trailing RECLASSIFICATION_ORIGINAL_SUFFIX, if present — recovers the raw TR
 * event id from a split draft/transaction's externalId. A no-op for every other
 * externalId in the codebase (they never contain this suffix). */
export function rawEventIdFromExternalId(externalId: string): string {
  return externalId.endsWith(RECLASSIFICATION_ORIGINAL_SUFFIX)
    ? externalId.slice(0, -RECLASSIFICATION_ORIGINAL_SUFFIX.length)
    : externalId;
}

const TR_DOC_DATE_RE = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/;

/** Parse TR's DD.MM.YYYY document-date format (used only for a resolved reclassification's
 * true distribution date — every other date on the timeline is already an ISO timestamp). */
function parseTrDocDate(text: string): Date | null {
  const m = TR_DOC_DATE_RE.exec(text.trim());
  if (!m) return null;
  const [, day, month, year] = m;
  const d = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Split a resolved TR "Dividend correction" event into two bookings: the "Original
 * dividend" component (already-recognized income, re-attributed to its true period) and
 * the "Correction" delta (genuinely new information, effective in the period discovered).
 * Returns null if the event isn't a resolved reclassification (the caller falls through to
 * the normal single-booking path).
 *
 * externalId scheme is deliberate: the correction leg keeps `ev.id` UNCHANGED — exactly
 * what today's (pre-split) single booking already uses — so every mechanism that assumes
 * `transactions.externalId === the raw TR event id` (sync dedup, the resolved-events
 * ledger, cancellation matching) keeps working without modification, gated entirely by
 * this one row's presence. Only the new "original" row, which has no pre-split
 * equivalent, gets a synthetic `${ev.id}:original` id — the few call sites that must
 * recognize it use rawEventIdFromExternalId to recover the raw id.
 */
function buildReclassificationSplit(ev: TrEvent): ParsedTransaction[] | null {
  if (ev.originalAmount == null || ev.correctionAmount == null || !ev.trueDistributionDate) {
    return null;
  }
  const trueDate = parseTrDocDate(ev.trueDistributionDate);
  if (!trueDate) return null;

  const assetClass: "crypto" | "equity" =
    ev.isin && TR_CRYPTO_ISIN.test(ev.isin) ? "crypto" : "equity";
  const shared = {
    assetClass,
    ticker: null,
    isin: ev.isin ?? null,
    wkn: ev.wkn ?? null,
    name: ev.title ?? ev.isin ?? ev.eventType,
    quantity: "0",
    unit: "shares" as const,
    fees: "0",
    currency: ev.currency.toUpperCase(),
    confidence: 1,
    savingsPlanId: ev.savingsPlanId ?? null,
    exchangeCode: null,
    executedPrice: null,
    fxRate: ev.fxRate != null ? formatDecimal(ev.fxRate) : null,
    venue: ev.venue ?? null,
    description: ev.description ?? null,
  };
  // Neither leg carries a per-component withholding split from the raw event (the
  // correction event's own `tax` is null — the full withholding lived on the now-canceled
  // original, which this booking replaces); left null here, same as the rest of this
  // mapper's other income actions when `ev.tax` is absent. A later settlement-PDF
  // enrichment pass may fill it in, same mechanism as any other dividend.
  const original: ParsedTransaction = {
    ...shared,
    action: "dividend",
    price: formatDecimal(Math.abs(ev.originalAmount)),
    total: formatDecimal(Math.abs(ev.originalAmount)),
    tax: null,
    executedAt: trueDate,
    externalId: `${ev.id}${RECLASSIFICATION_ORIGINAL_SUFFIX}`,
    kind: "reclassification-original",
    // Not `ev.documentRefs`: the one correction-event document links to the correction
    // leg's transaction (its externalId is the raw id documents.ts's sourceEventId
    // resolves to) — this leg would show a document reference in the UI it never
    // actually stores/attaches.
    documentRefs: null,
  };
  const correction: ParsedTransaction = {
    ...shared,
    action: "dividend",
    price: formatDecimal(Math.abs(ev.correctionAmount)),
    total: formatDecimal(Math.abs(ev.correctionAmount)),
    tax: null,
    executedAt: new Date(ev.timestamp),
    externalId: ev.id,
    kind: "reclassification-correction",
    documentRefs: ev.documentRefs ?? null,
  };
  return [original, correction];
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
    // A dividend reinvestment ("Reinvestition der Dividende") carries a real cash-out amount:
    // the dividend is paid (a paired SSP_CORPORATE_ACTION_CASH credit, booked separately as
    // income) and immediately spent buying shares. Book it as a buy so cash nets to 0 against
    // the dividend and the reinvested shares get a real cost basis. A zero-amount event is a
    // genuine free stock-dividend / bonus issue.
    action = ev.amount !== 0 ? "buy" : "bonus";
  }
  if (!action && ev.eventType === NO_CASH_CORPORATE_ACTION && ev.kind === "vorabpauschale") {
    // Vorabpauschale accrual: a standalone tax debit tied to a specific fund holding, no
    // cash movement. `ev.isin` may be absent (a base too — see the tax-block comment below);
    // both degrade gracefully rather than crashing (isin-less rows never reach the per-
    // instrument accrual in trade-log.ts, so they're a silent zero-effect booking).
    action = "tax";
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
  let price = formatDecimal(amount); // cash lump sum by default (deposit/withdrawal/dividend/...)
  let confidence = 1;
  // Overrides the default `ev.tax`-derived draft.tax below. Only set for a sell with a
  // reported executedPrice (see the sell branch) — every other action keeps using ev.tax as-is.
  let sellTaxOverride: number | null = null;

  if (action === "buy" || action === "sell" || action === "savings_plan") {
    const shares = Math.abs(ev.shares ?? 0);
    if (shares === 0) {
      return skip(`${ev.eventType} without a share count`, "attention", ev);
    }
    quantity = formatDecimal(shares);
    if (action === "sell") {
      if (ev.executedPrice != null) {
        // Prefer TR's own reported execution price over reconstructing one from `tax`. A
        // sell's `tax` at sync time is only ever TR's preliminary trade-time withholding
        // estimate — the real, cost-basis-aware figure is settled later (via the invoice PDF
        // or a "Steuerliche Optimierung" true-up) and can differ sharply (see tr_cash.md).
        price = formatDecimal(Math.abs(ev.executedPrice));
        // `amount` is TR's own net cash CREDITED for this sell — unlike the preliminary
        // trade-time `tax` estimate, it already reflects the real, settled withholding (this
        // is empirically confirmed: it exactly matches the settlement-PDF tax in every case
        // checked — see tr_cash.md). So derive `tax` from it instead of trusting `ev.tax`:
        // tax = notional − fees − netProceeds. This is the ONLY tax value for which
        // cashFlow (qty·price − fees − tax) reproduces `amount` exactly — using `ev.tax`
        // directly here would silently break that identity the same way the old
        // price-reconstruction did (see the 2026-07 cash-drift bug in tr_cash.md). Not
        // Math.abs'd: a sell whose withholding nets to a credit (losses offsetting gains)
        // yields a negative tax, which cashFlow already handles (subtracting a negative adds
        // cash back).
        // Rounded to cents (unlike `price`, which intentionally keeps full precision for
        // fractional-share math): this is a EUR currency amount, and shares×execPrice carries
        // float noise past the 2nd decimal that has no business surviving into `tax`.
        const notional = shares * Math.abs(ev.executedPrice);
        sellTaxOverride = Math.round((notional - fees - amount) * 100) / 100;
      } else {
        // Fallback when TR doesn't report an execution price: reconstruct gross price so
        // cashFlow = qty·grossPrice − fees − tax = amount (pytr `amount` = net cash credited).
        // No executedPrice means no independent cross-check on `tax` either, so this keeps
        // trusting the (possibly preliminary) ev.tax as before — unchanged fallback behavior.
        const sellTax = Math.abs(ev.tax ?? 0);
        price = formatDecimal((amount + fees + sellTax) / shares);
      }
    } else {
      // buy / savings_plan: amount = gross debit (before fees); reconstruct net per-share.
      price = formatDecimal((amount - fees) / shares);
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

  if (action === "transfer_in" || action === "transfer_out") {
    // Depot-to-depot securities transfer (Depotübertrag): shares move, cash-neutral, no P&L.
    // The transfer event carries no price, so the per-share cost basis is unknown at import —
    // leave it 0 (carried cost). For transfer_in this surfaces a `missing_transfer_basis`
    // anomaly prompting the user to set the carried cost; transfer_out is not a disposal.
    const shares = Math.abs(ev.shares ?? 0);
    if (shares === 0) {
      return skip(`${ev.eventType} without a share count`, "attention", ev);
    }
    quantity = formatDecimal(shares);
    price = "0";
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
    quantity = formatDecimal(shares);
    price = "0"; // no cash consideration for a bonus share issue
  }

  if (action === "tax") {
    // Two distinct "tax" representations share this action:
    //  - EARNINGS: a cash-effecting debit with gross amount 0 and the figure in the tax
    //    field — source the magnitude from `amount` and fall back to `tax` (the default
    //    `price = |amount|` alone would emit 0 and the debit would never reduce cash).
    //  - NO_CASH_CORPORATE_ACTION/vorabpauschale: genuinely non-cash (amount and tax are
    //    both 0/null), so this expression naturally yields price="0" — the magnitude lives
    //    in `vorabBase` below instead, which trade-log.ts reads directly (not via price).
    price = formatDecimal(amount !== 0 ? amount : Math.abs(ev.tax ?? 0));
    quantity = "0";
    // The base-extraction keywords (tr_export.py's _extract_vorab_base) are unverified
    // against a captured detail payload for this event (only its summary line survives in
    // any local export — see the plan). If detection fired (`kind` set) but no base could
    // be parsed, don't silently book a zero-effect row and let the gap go unnoticed — flag
    // it for review the same way a reconciliation mismatch does elsewhere in this function.
    if (ev.kind === "vorabpauschale" && ev.vorabBase == null) {
      confidence = 0.5;
    }
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
    fees: formatDecimal(fees),
    total: formatDecimal(amount),
    currency: ev.currency.toUpperCase(),
    executedAt: new Date(ev.timestamp),
    confidence,
    externalId: ev.id,
    savingsPlanId: ev.savingsPlanId ?? null,
    exchangeCode: null,
    // Enrichment (informational; persisted on the transaction at confirm).
    // A reinvestment buy is funded by the dividend (return), not external capital — tag it so
    // `contributions` excludes it (EXCLUDED_ACQUISITION_KINDS) while it still builds cost basis.
    // A tr_export-supplied kind (e.g. "crypto_bonus") takes precedence over the eventType map.
    kind:
      ev.kind ??
      (ev.eventType === SHARE_CORPORATE_ACTION && action === "buy"
        ? "reinvestment"
        : (EVENT_KIND[ev.eventType] ?? null)),
    // For a standalone `tax` debit the magnitude already lives in `price`; leave the tax
    // FIELD null so the display's gross (price + tax) doesn't double-count it. A sell with a
    // reported executedPrice uses the net-derived override (see above) instead of ev.tax.
    tax:
      action === "tax"
        ? null
        : sellTaxOverride != null
          ? formatDecimal(sellTaxOverride)
          : ev.tax != null
            ? formatDecimal(Math.abs(ev.tax))
            : null,
    executedPrice: ev.executedPrice != null ? formatDecimal(ev.executedPrice) : null,
    fxRate: ev.fxRate != null ? formatDecimal(ev.fxRate) : null,
    venue: ev.venue ?? null,
    description: ev.description ?? null,
    documentRefs: ev.documentRefs ?? null,
    // Vorabpauschale taxable base (gross); null on every other event, and on a
    // Vorabpauschale event whose base couldn't be extracted (see trEventSchema).
    vorabBase: ev.vorabBase != null ? formatDecimal(ev.vorabBase) : null,
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
    if ("draft" in result) {
      // A resolved "Dividend correction" event expands one raw event into two bookings
      // (see buildReclassificationSplit) — a batch-level transform, deliberately not done
      // inside mapTrEventToDraft itself, so that function's single-draft contract (and the
      // healing check in sync.ts that relies on it) stays untouched. `raw` is re-parsed
      // here rather than threading the already-validated event back out of
      // mapTrEventToDraft — cheap, and keeps that function's return type simple.
      const parsed = trEventSchema.safeParse(raw);
      const ev = parsed.success ? parsed.data : null;
      const split = ev ? buildReclassificationSplit(ev) : null;
      if (split) {
        drafts.push(...split);
      } else if (ev && ev.originalAmount != null && ev.correctionAmount != null) {
        // Detected as a reclassification correction but the true date couldn't be
        // resolved (dateResolutionFailed) — fall back to the normal single booking
        // mapTrEventToDraft already produced (today's behavior: full amount, correction's
        // own posting date) rather than silently mis-dating it, flagged for review.
        drafts.push({ ...result.draft, kind: "reclassification-unresolved" });
      } else {
        drafts.push(result.draft);
      }
    } else
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
  // Symmetric with the CSV path: fold a perk cash credit (bonus_cash) into the same-day buy
  // it funds → one `bonus` free-share row. No-op until the TR timeline perk eventType is
  // mapped to bonus_cash (see note below); wired here so the collapse is ready the moment it
  // is. NOTE: the live timeline's STOCKPERK/KINDERGELD eventType strings are not yet observed
  // — they currently surface as "unmapped → attention" (safe, never dropped). When one shows
  // up in a live sync, add it to FIXED_ACTIONS → "bonus_cash" (kind "bonus") and this collapse
  // handles the rest.
  return { drafts: collapsePerkFundedAcquisitions(drafts), errors };
}
