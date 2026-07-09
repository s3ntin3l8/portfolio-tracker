import { describe, it, expect } from "vitest";
import { isDiscardableTrDocType } from "../../src/services/pytr/documents.js";

describe("isDiscardableTrDocType", () => {
  it.each([
    // Cost-information sheets (any leg: buy/sell/savings-plan, versioned).
    ["COSTS_INFO_BUY_V2", true],
    ["COSTS_INFO_SELL_V2", true],
    ["COSTS_INFO_SAVINGS_PLAN", true],
    ["COSTS_INFO_SAVINGS_PLAN_V2", true],
    // Order confirmations.
    ["CONFIRM_ORDER_CREATE_V2", true],
    // Pre-trade ex-ante cost disclosures.
    ["EQUITIES_BUY_EX_ANTE", true],
    ["EQUITIES_SELL_EX_ANTE", true],
    // Savings-plan / benefit notifications.
    ["SAVINGS_PLAN_CREATED", true],
    ["BENEFIT_CASH_REWARD_INVOICE", true],
    ["BENEFIT_ACTIVATED", true],
    ["INFO", true],
    // Real settlement/income/transfer types — must never be discarded.
    ["SECURITIES_SETTLEMENT", false],
    ["SECURITIES_SETTLEMENT_SAVINGS_PLAN", false],
    ["SAVINGS_PLAN_EXECUTED_V2", false],
    ["CRYPTO_SECURITIES_SETTLEMENT", false],
    ["CA_INCOME_INVOICE", false],
    ["CA_INCOME_SECURITIES_INVOICE", false],
    ["INCOME", false],
    ["INVOICE", false],
    ["INTEREST_PAYOUT_INVOICE", false],
    ["INCOMING_TRANSFER", false],
    ["OUTGOING_TRANSFER", false],
    ["SHAREBOOKING", false],
    ["TAX_OPTIMIZATION_INVOICE", false],
    ["PAYMENT_INBOUND_INVOICE", false],
    ["CARD_BILLING_INVOICE", false],
    // Unrecognized/empty labels are kept by default (denylist, not allowlist) — the TR
    // postboxType is documented elsewhere as unreliable and includes real settlements.
    ["", false],
    ["SOME_FUTURE_TYPE_WE_DONT_KNOW", false],
  ])("%s -> discardable=%s", (postboxType, expected) => {
    expect(isDiscardableTrDocType(postboxType)).toBe(expected);
  });

  it("treats null and undefined as not discardable", () => {
    expect(isDiscardableTrDocType(null)).toBe(false);
    expect(isDiscardableTrDocType(undefined)).toBe(false);
  });
});
