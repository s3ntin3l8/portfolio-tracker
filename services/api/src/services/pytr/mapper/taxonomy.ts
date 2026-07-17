import { z } from "zod";
import type { ParsedAction } from "@portfolio/schema";

export const trEventSchema = z.object({
  id: z.string().min(1),
  timestamp: z.string().min(1),
  eventType: z.string().min(1),
  title: z.string().nullish(),
  amount: z.number(),
  currency: z.string().default("EUR"),
  isin: z.string().nullish(),
  wkn: z.string().nullish(),
  shares: z.number().nullish(),
  fees: z.number().nullish(),
  savingsPlanId: z.string().nullish(),
  status: z.string().nullish(),
  kind: z.string().nullish(),
  executedPrice: z.number().nullish(),
  tax: z.number().nullish(),
  fxRate: z.number().nullish(),
  venue: z.string().nullish(),
  description: z.string().nullish(),
  documentRefs: z
    .array(z.object({ id: z.string(), type: z.string().nullish(), date: z.string().nullish() }))
    .nullish(),
  trueDistributionDate: z.string().nullish(),
  originalAmount: z.number().nullish(),
  correctionAmount: z.number().nullish(),
  dateResolutionFailed: z.boolean().nullish(),
  vorabBase: z.number().nullish(),
});

export type TrEvent = z.infer<typeof trEventSchema>;

export const TR_CRYPTO_ISIN = /^XF000[A-Z]{2,5}\d+$/;

export const RECONCILE_TOLERANCE = 0.1;

export const EVENT_KIND: Record<string, string> = {
  SAVEBACK_AGGREGATE: "saveback",
  SPARE_CHANGE_AGGREGATE: "roundup",
};

export const CARD_EVENTS = new Set([
  "CARD_TRANSACTION",
  "CARD_ATM_WITHDRAWAL",
  "CARD_ORDER_FEE",
  "CARD_REFUND",
  "CARD_VERIFICATION",
  "CARD_AFT",
]);

export const FIXED_ACTIONS: Record<string, ParsedAction> = {
  PAYMENT_INBOUND: "deposit",
  PAYMENT_INBOUND_SEPA_DIRECT_DEBIT: "deposit",
  PAYMENT_INBOUND_CREDIT_CARD: "deposit",
  PAYMENT_INBOUND_APPLE_PAY: "deposit",
  PAYMENT_INBOUND_GOOGLE_PAY: "deposit",
  INCOMING_TRANSFER: "deposit",
  INCOMING_TRANSFER_DELEGATION: "deposit",
  ACCOUNT_TRANSFER_INCOMING: "deposit",
  BANK_TRANSACTION_INCOMING: "deposit",
  INTEREST_PAYOUT: "interest",
  INTEREST_PAYOUT_CREATED: "interest",
  EARNINGS: "tax",
  CARD_REFUND: "deposit",
  PAYMENT_OUTBOUND: "withdrawal",
  OUTGOING_TRANSFER: "withdrawal",
  OUTGOING_TRANSFER_DELEGATION: "withdrawal",
  BANK_TRANSACTION_OUTGOING: "withdrawal",
  CARD_TRANSACTION: "withdrawal",
  CARD_ATM_WITHDRAWAL: "withdrawal",
  CARD_ORDER_FEE: "withdrawal",
  CREDIT: "dividend",
  SAVINGS_PLAN_EXECUTED: "savings_plan",
  SAVINGS_PLAN_INVOICE_CREATED: "savings_plan",
  TRADING_SAVINGSPLAN_EXECUTED: "savings_plan",
  SAVEBACK_AGGREGATE: "savings_plan",
  SPARE_CHANGE_AGGREGATE: "buy",
  TRANSFER_IN: "transfer_in",
  TRANSFER_OUT: "transfer_out",
  SSP_SECURITIES_TRANSFER_INCOMING: "transfer_in",
};

export const TRADE_EVENTS = new Set(["ORDER_EXECUTED", "TRADE_INVOICE", "TRADING_TRADE_EXECUTED"]);

export const CASH_BY_SIGN = new Set(["JUNIOR_P2P_TRANSFER", "SSP_TAX_CORRECTION", "CARD_AFT"]);

export const CASH_CORPORATE_ACTION = "SSP_CORPORATE_ACTION_CASH";

export const NO_CASH_CORPORATE_ACTION = "SSP_CORPORATE_ACTION_NO_CASH";

export const SHARE_CORPORATE_ACTION = "SSP_CORPORATE_ACTION_INSTRUMENT";

export const SKIP_EVENTS = new Map<string, string>([
  ["CARD_VERIFICATION", "card verification (no cash movement)"],
  ["TRADING_SAVINGSPLAN_EXECUTION_FAILED", "failed savings-plan execution"],
  ["ORDER_CREATED", "order created (no fill, no cash)"],
  ["ORDER_CANCELED", "order cancelled (no fill, no cash)"],
  ["ORDER_EXPIRED", "order expired (no fill, no cash)"],
  ["ORDER_REJECTED", "order rejected (no fill, no cash)"],
  ["TRADING_ORDER_REJECTED", "order rejected (no fill, no cash)"],
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
  ["EXEMPTION_ORDER_CHANGED", "tax exemption order changed (informational)"],
  ["EXEMPTION_ORDER_CHANGE_REQUESTED", "tax exemption order change requested (informational)"],
  [
    "EXEMPTION_ORDER_CHANGE_REQUESTED_AUTOMATICALLY",
    "tax exemption order change requested (informational)",
  ],
  ["GENERAL_MEETING", "general meeting notification (informational)"],
]);

export const ATTENTION_SKIPS = new Set<string>();

export const REPORT_EVENT_TYPES = new Set([
  "TAX_YEAR_END_REPORT",
  "TAX_YEAR_END_REPORT_CREATED",
  "YEAR_END_TAX_REPORT",
]);

export const SECURITY_ACTIONS = new Set<ParsedAction>([
  "buy",
  "sell",
  "savings_plan",
  "dividend",
  "coupon",
  "bonus",
  "transfer_in",
  "transfer_out",
]);

export const REPORT_TITLE_PREFIXES = ["Jährlicher Steuerbericht", "Jährlicher Steuerreport"];

export const REPORT_TITLE_YEAR_RE = /\b(20\d{2})\b/;

export const RECLASSIFICATION_ORIGINAL_SUFFIX = ":original";

export const TR_DOC_DATE_RE = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/;
