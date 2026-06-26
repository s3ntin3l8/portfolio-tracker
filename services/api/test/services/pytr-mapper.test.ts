import { describe, it, expect } from "vitest";
import { mapTrEventToDraft, mapTrEvents, categoryForEventType } from "../../src/services/pytr/mapper.js";

const base = {
  id: "evt-1",
  timestamp: "2026-03-01T10:00:00.000Z",
  currency: "EUR",
};

function draftOf(event: Record<string, unknown>) {
  const result = mapTrEventToDraft(event);
  if ("skip" in result) throw new Error(`unexpected skip: ${result.reason}`);
  return result.draft;
}

describe("mapTrEventToDraft", () => {
  it("maps ORDER_EXECUTED to buy/sell by the sign of amount", () => {
    const buy = draftOf({
      ...base,
      eventType: "ORDER_EXECUTED",
      amount: -1000,
      shares: 10,
      isin: "DE0007236101",
      wkn: "723610",
      title: "Siemens",
    });
    expect(buy).toMatchObject({
      action: "buy",
      isin: "DE0007236101",
      wkn: "723610",
      quantity: "10",
      price: "100",
      fees: "0",
      currency: "EUR",
      externalId: "evt-1",
    });
    expect(buy.executedAt).toEqual(new Date("2026-03-01T10:00:00.000Z"));

    const sell = draftOf({
      ...base,
      eventType: "ORDER_EXECUTED",
      amount: 500,
      shares: 5,
      isin: "DE0007236101",
    });
    expect(sell).toMatchObject({ action: "sell", quantity: "5", price: "100" });
  });

  it("excludes fees from the per-share buy price and carries them separately", () => {
    const buy = draftOf({
      ...base,
      eventType: "TRADE_INVOICE",
      amount: -1010,
      fees: 10,
      shares: 10,
      isin: "DE0007236101",
    });
    // buy: price = (|amount| − fees) / shares = (1010 − 10) / 10 = 100
    expect(buy).toMatchObject({ action: "buy", quantity: "10", price: "100", fees: "10" });
  });

  it("uses gross sell price so cashFlow = qty×price − fees − tax = net amount", () => {
    // Sell: amount = net cash (gross − fees − tax). Reconstruct gross so P&L is pre-tax.
    const sellWithTax = draftOf({
      ...base,
      eventType: "ORDER_EXECUTED",
      amount: 497, // net: 500 gross − 1 fee − 2 tax
      fees: -1,    // pytr signs are negative for costs
      tax: -2,
      shares: -5,  // negative shares for a sell
      isin: "DE0007236101",
    });
    // gross price = (497 + 1 + 2) / 5 = 100
    expect(sellWithTax).toMatchObject({ action: "sell", quantity: "5", price: "100", fees: "1", tax: "2" });

    const sellWithFeesOnly = draftOf({
      ...base,
      eventType: "ORDER_EXECUTED",
      amount: 490, // net: 500 − 10 fee
      fees: -10,
      shares: -5,
      isin: "DE0007236101",
    });
    // gross price = (490 + 10 + 0) / 5 = 100
    expect(sellWithFeesOnly).toMatchObject({ action: "sell", price: "100", fees: "10" });
  });

  it("maps savings plan executions and keeps the plan id", () => {
    const sp = draftOf({
      ...base,
      eventType: "SAVINGS_PLAN_EXECUTED",
      amount: -25,
      shares: 0.5,
      isin: "IE00B4L5Y983",
      savingsPlanId: "sp-7",
    });
    expect(sp).toMatchObject({
      action: "savings_plan",
      quantity: "0.5",
      price: "50",
      savingsPlanId: "sp-7",
    });
  });

  it("maps the aggregate purchases: saveback/savings-plan → savings_plan, round-up → buy", () => {
    expect(
      draftOf({ ...base, eventType: "SAVEBACK_AGGREGATE", amount: -1, shares: 0.02, isin: "X" }).action,
    ).toBe("savings_plan");
    expect(
      draftOf({ ...base, eventType: "TRADING_SAVINGSPLAN_EXECUTED", amount: -50, shares: 0.07, isin: "X" }).action,
    ).toBe("savings_plan");
    expect(
      draftOf({ ...base, eventType: "SPARE_CHANGE_AGGREGATE", amount: -0.5, shares: 0.01, isin: "X" }).action,
    ).toBe("buy");
  });

  it("maps TRADING_TRADE_EXECUTED to buy/sell by sign", () => {
    expect(
      draftOf({ ...base, eventType: "TRADING_TRADE_EXECUTED", amount: -100, shares: 1, isin: "X" }).action,
    ).toBe("buy");
    expect(
      draftOf({ ...base, eventType: "TRADING_TRADE_EXECUTED", amount: 100, shares: 1, isin: "X" }).action,
    ).toBe("sell");
  });

  it("maps CREDIT to a dividend lump sum on the paying instrument", () => {
    const div = draftOf({
      ...base,
      eventType: "CREDIT",
      amount: 12.5,
      isin: "US0378331005",
    });
    expect(div).toMatchObject({
      action: "dividend",
      isin: "US0378331005",
      quantity: "0",
      price: "12.5",
    });
  });

  it("maps cash movements with no instrument", () => {
    // Interest is income, not a deposit (so it isn't counted as a contribution).
    // Both the current and the pre-late-2024 event name map to the same action.
    expect(draftOf({ ...base, eventType: "INTEREST_PAYOUT", amount: 3 })).toMatchObject({
      action: "interest",
      isin: null,
      quantity: "0",
      price: "3",
    });
    // INTEREST_PAYOUT_CREATED is the pre-late-2024 name for the same monthly cash-interest
    // booking (TR renamed the event type; the streams are disjoint, never co-occurring).
    expect(draftOf({ ...base, eventType: "INTEREST_PAYOUT_CREATED", amount: 1.69 })).toMatchObject({
      action: "interest",
      isin: null,
      quantity: "0",
      price: "1.69",
    });
    expect(draftOf({ ...base, eventType: "PAYMENT_INBOUND", amount: 1000 }).action).toBe(
      "deposit",
    );
    // Delegated (standing-order) transfers are the same external cash movement as their
    // non-delegation counterparts.
    expect(
      draftOf({ ...base, eventType: "INCOMING_TRANSFER_DELEGATION", amount: 250 }).action,
    ).toBe("deposit");
    expect(
      draftOf({ ...base, eventType: "OUTGOING_TRANSFER_DELEGATION", amount: -250 }).action,
    ).toBe("withdrawal");
    expect(draftOf({ ...base, eventType: "BANK_TRANSACTION_INCOMING", amount: 50 }).action).toBe(
      "deposit",
    );
    expect(draftOf({ ...base, eventType: "CARD_REFUND", amount: 9.99 }).action).toBe(
      "deposit",
    );
    expect(
      draftOf({ ...base, eventType: "PAYMENT_OUTBOUND", amount: -200 }),
    ).toMatchObject({ action: "withdrawal", price: "200" });
  });

  it("carries detail enrichment, kind, and source asset-class onto the draft", () => {
    const div = draftOf({
      ...base,
      eventType: "CREDIT",
      amount: 6.7,
      isin: "US7561091049",
      title: "Realty Income",
      executedPrice: 142.76,
      tax: 2.31,
      fxRate: 0.8449,
      venue: "LS Exchange",
      description: "ACME Bank · DE12…",
      documentRefs: [{ id: "doc-1", type: "CA_INCOME_INVOICE", date: "16.06.2026" }],
    });
    expect(div).toMatchObject({
      tax: "2.31",
      executedPrice: "142.76",
      fxRate: "0.8449",
      venue: "LS Exchange",
      description: "ACME Bank · DE12…",
    });
    expect(div.documentRefs).toEqual([{ id: "doc-1", type: "CA_INCOME_INVOICE", date: "16.06.2026" }]);

    // kind from event type; tax stored as a magnitude even when TR signs it negative.
    expect(draftOf({ ...base, eventType: "SAVEBACK_AGGREGATE", amount: -9.62, shares: 0.0137, isin: "IE00B5BMR087" }).kind).toBe("saveback");
    expect(draftOf({ ...base, eventType: "SPARE_CHANGE_AGGREGATE", amount: -0.7, shares: 0.001, isin: "IE00B5BMR087" }).kind).toBe("roundup");
    expect(draftOf({ ...base, eventType: "CREDIT", amount: 5, isin: "US1", tax: -0.98 }).tax).toBe("0.98");

    // Crypto recognised at the source from TR's synthetic XF000… ISIN.
    expect(draftOf({ ...base, eventType: "ORDER_EXECUTED", amount: -100, shares: 0.001, isin: "XF000BTC0017" }).assetClass).toBe("crypto");
    expect(draftOf({ ...base, eventType: "ORDER_EXECUTED", amount: -100, shares: 1, isin: "DE0007236101" }).assetClass).toBe("equity");
  });

  it("flags a trade for review when executed price × shares doesn't reconcile", () => {
    // shares 10 × price 100 = 1000 ≈ total 1000 → trusted.
    expect(
      draftOf({ ...base, eventType: "ORDER_EXECUTED", amount: -1000, shares: 10, isin: "X", executedPrice: 100 }).confidence,
    ).toBe(1);
    // shares mis-parsed (1 instead of 10) → 1 × 100 = 100, far from total 1000 → flagged.
    expect(
      draftOf({ ...base, eventType: "ORDER_EXECUTED", amount: -1000, shares: 1, isin: "X", executedPrice: 100 }).confidence,
    ).toBeLessThan(0.9);
  });

  it("skips non-executed (cancelled/pending) events", () => {
    const cancelled = mapTrEventToDraft({
      ...base,
      eventType: "CREDIT",
      amount: 12,
      isin: "US7561091049",
      status: "CANCELED",
    });
    expect("skip" in cancelled && cancelled.skip).toBe(true);
    if ("skip" in cancelled) expect(cancelled.reason).toMatch(/non-executed/i);

    // EXECUTED (or absent status) still maps.
    expect(
      draftOf({ ...base, eventType: "PAYMENT_INBOUND", amount: 100, status: "EXECUTED" }).action,
    ).toBe("deposit");
  });

  it("records card spending as a withdrawal so the cash balance stays correct", () => {
    expect(
      draftOf({ ...base, eventType: "CARD_TRANSACTION", amount: -1.5 }),
    ).toMatchObject({ action: "withdrawal", price: "1.5" });
    expect(draftOf({ ...base, eventType: "CARD_ATM_WITHDRAWAL", amount: -50 }).action).toBe(
      "withdrawal",
    );
  });

  it("maps a cash corporate action to a dividend (or a plain deposit without an ISIN)", () => {
    expect(
      draftOf({ ...base, eventType: "SSP_CORPORATE_ACTION_CASH", amount: 1.93, isin: "US02079K3059" }),
    ).toMatchObject({ action: "dividend", quantity: "0", price: "1.93" });
    expect(
      draftOf({ ...base, eventType: "SSP_CORPORATE_ACTION_CASH", amount: 2 }).action,
    ).toBe("deposit");
  });

  it("resolves ambiguous transfers by the sign of the amount", () => {
    expect(draftOf({ ...base, eventType: "JUNIOR_P2P_TRANSFER", amount: -10 }).action).toBe(
      "withdrawal",
    );
    expect(draftOf({ ...base, eventType: "SSP_TAX_CORRECTION", amount: 5 }).action).toBe(
      "deposit",
    );
  });

  it("skips known no-ops with a reason (card verification, failed execution events)", () => {
    for (const eventType of [
      "CARD_VERIFICATION",
      "TRADING_SAVINGSPLAN_EXECUTION_FAILED",
    ]) {
      expect(mapTrEventToDraft({ ...base, eventType, amount: 0 })).toMatchObject({
        skip: true,
      });
    }
  });

  it("skips informational admin/report/order-lifecycle events as info (not unmapped gaps)", () => {
    // Representative sample across the categories added for noise reduction. These must be
    // `info` skips with a reason — NOT `attention` / `unmapped_event_type`, so they don't
    // bury the real gaps the safety net flags.
    for (const eventType of [
      "ORDER_REJECTED",
      "TRADING_ORDER_REJECTED",
      "DOCUMENTS_CREATED",
      "EX_POST_COST_REPORT",
      "ADDRESS_CHANGED",
      "EXEMPTION_ORDER_CHANGED",
      "GENERAL_MEETING",
    ]) {
      const result = mapTrEventToDraft({ ...base, eventType, amount: 0 });
      expect(result).toMatchObject({ skip: true, severity: "info" });
      if ("skip" in result) {
        expect(result.reason).toBeTruthy();
        expect(result.code).toBeUndefined();
      }
    }
  });

  it("does NOT skip value-bearing types — they stay surfaced until classified", () => {
    // Guardrail: types that can carry cash/shares must remain unmapped (attention/gap),
    // never silently absorbed into the info skip-list.
    for (const eventType of ["TAXES", "MATURITY", "SHAREBOOKING"]) {
      expect(mapTrEventToDraft({ ...base, eventType, amount: -1 })).toMatchObject({
        skip: true,
        severity: "attention",
        code: "unmapped_event_type",
      });
    }
  });

  it("maps SSP_CORPORATE_ACTION_INSTRUMENT to a bonus draft when shares are known", () => {
    // Stock dividend: company issues shares with no cash consideration.
    const result = mapTrEventToDraft({
      ...base,
      eventType: "SSP_CORPORATE_ACTION_INSTRUMENT",
      isin: "US0378331005",
      shares: 3.5,
      amount: 0,
    });
    expect(result).toMatchObject({
      draft: {
        action: "bonus",
        quantity: "3.5",
        price: "0",
        isin: "US0378331005",
        externalId: base.id,
      },
    });
  });

  it("maps a dividend reinvestment (non-zero SSP_CORPORATE_ACTION_INSTRUMENT) to a cash-out buy", () => {
    // "Reinvestition der Dividende": the dividend is spent buying shares → a real cash-out at a
    // real cost basis (not a €0 bonus). The paired SSP_CORPORATE_ACTION_CASH dividend is booked
    // separately, so dividend + reinvestment net to 0 cash, +shares at basis.
    const reinv = draftOf({
      ...base,
      eventType: "SSP_CORPORATE_ACTION_INSTRUMENT",
      isin: "GB0007188757",
      shares: 1.01327,
      amount: -54.5,
      title: "Rio Tinto",
    });
    expect(reinv).toMatchObject({
      action: "buy",
      kind: "reinvestment",
      isin: "GB0007188757",
      quantity: "1.01327",
    });
    // price = |amount| / shares ≈ 53.79 → cashFlow = -(qty×price) = -54.5
    expect(Number(reinv.price)).toBeCloseTo(54.5 / 1.01327, 4);
    expect(Number(reinv.quantity) * Number(reinv.price)).toBeCloseTo(54.5, 2);
  });

  it("carries a tr_export-supplied kind (crypto_bonus) onto the draft", () => {
    // A crypto "1% bonus" buy: tr_export tags it kind:"crypto_bonus" (the timeline gives no
    // distinguishing eventType); the mapper carries it through so cash.ts books it cash-neutral.
    const cb = draftOf({
      ...base,
      eventType: "TRADING_TRADE_EXECUTED",
      amount: -20.11,
      shares: 0.0002,
      isin: "XF000BTC0017",
      kind: "crypto_bonus",
    });
    expect(cb).toMatchObject({ action: "buy", kind: "crypto_bonus", assetClass: "crypto" });
  });

  it("maps securities transfers (Depotübertrag) to cash-neutral transfer_in/out at carried cost", () => {
    // tr_export normalises the activity-log transfer forms to TRANSFER_IN / TRANSFER_OUT.
    const tin = draftOf({
      ...base,
      eventType: "TRANSFER_IN",
      amount: 0,
      isin: "GB0002875804",
      shares: 1,
      title: "British American Tobacco",
    });
    expect(tin).toMatchObject({
      action: "transfer_in",
      quantity: "1",
      price: "0", // carried cost unknown at import → surfaces missing_transfer_basis anomaly
      isin: "GB0002875804",
    });
    const tout = draftOf({ ...base, eventType: "TRANSFER_OUT", amount: 0, isin: "GB0002875804", shares: 14 });
    expect(tout).toMatchObject({ action: "transfer_out", quantity: "14", price: "0" });
    // #359's incoming-transfer event type normalises to transfer_in.
    expect(
      draftOf({ ...base, eventType: "SSP_SECURITIES_TRANSFER_INCOMING", amount: 0, isin: "X", shares: 2 }).action,
    ).toBe("transfer_in");
  });

  it("rejects a transfer missing its share count or ISIN", () => {
    expect(
      mapTrEventToDraft({ ...base, eventType: "TRANSFER_IN", amount: 0, isin: "X" }),
    ).toMatchObject({ skip: true, reason: expect.stringContaining("share count") });
    expect(
      mapTrEventToDraft({ ...base, eventType: "TRANSFER_IN", amount: 0, shares: 1 }),
    ).toMatchObject({ skip: true, reason: expect.stringContaining("ISIN") });
  });

  it("classifies transfers under the 'trade' import category", () => {
    expect(categoryForEventType("TRANSFER_IN")).toBe("trade");
    expect(categoryForEventType("TRANSFER_OUT")).toBe("trade");
    expect(categoryForEventType("SSP_SECURITIES_TRANSFER_INCOMING")).toBe("trade");
  });

  it("surfaces SSP_CORPORATE_ACTION_INSTRUMENT as attention when share count is missing", () => {
    // No shares extracted by Python yet — fall back to manual mapping.
    expect(
      mapTrEventToDraft({ ...base, eventType: "SSP_CORPORATE_ACTION_INSTRUMENT", isin: "US123", amount: 0 }),
    ).toMatchObject({ skip: true, severity: "attention", reason: expect.stringContaining("share count") });
  });

  it("surfaces SSP_CORPORATE_ACTION_INSTRUMENT as attention when ISIN is missing", () => {
    expect(
      mapTrEventToDraft({ ...base, eventType: "SSP_CORPORATE_ACTION_INSTRUMENT", shares: 2, amount: 0 }),
    ).toMatchObject({ skip: true, severity: "attention", reason: expect.stringContaining("ISIN") });
  });

  it("tags unmapped and unparseable events with a machine-readable code (safety net)", () => {
    // Unknown event type → flagged for the dashboard/admin safety-net surface.
    expect(mapTrEventToDraft({ ...base, eventType: "MYSTERY_EVENT", amount: 1 })).toMatchObject({
      skip: true,
      code: "unmapped_event_type",
      eventType: "MYSTERY_EVENT",
    });
    // A TR event with no eventType (the legacy securities-transfer shape) fails schema parse
    // and must surface as a gap — not be silently dropped.
    expect(mapTrEventToDraft({ id: "x", timestamp: base.timestamp, amount: 0 })).toMatchObject({
      skip: true,
      code: "unparseable_event",
    });
  });

  it("skips (never drops) unknown types and securities missing key data", () => {
    expect(mapTrEventToDraft({ ...base, eventType: "MYSTERY_EVENT", amount: 1 })).toMatchObject(
      { skip: true, reason: expect.stringContaining("unmapped event type") },
    );
    expect(
      mapTrEventToDraft({ ...base, eventType: "ORDER_EXECUTED", amount: -100, shares: 1 }),
    ).toMatchObject({ skip: true, reason: expect.stringContaining("ISIN") });
    expect(
      mapTrEventToDraft({ ...base, eventType: "ORDER_EXECUTED", amount: -100, isin: "X" }),
    ).toMatchObject({ skip: true, reason: expect.stringContaining("share count") });
    expect(mapTrEventToDraft({ ...base, eventType: "ORDER_EXECUTED" })).toMatchObject({
      skip: true,
    });
  });

  it("carries the event cash leg and type on a share-count rejection so reconciliation can account for it", () => {
    // When tr_export.py fails to extract a share count (e.g. due to a transient detail
    // fetch failure), the mapper surfaces an attention error.  The raw.amount field lets
    // a future cash-reconciliation pass identify the cash movement even without shares.
    const result = mapTrEventToDraft({
      ...base,
      eventType: "ORDER_EXECUTED",
      amount: -75.5,
      isin: "DE0007236101",
      // shares intentionally absent → triggers "without a share count"
    });
    expect("skip" in result && result.skip).toBe(true);
    if (!("skip" in result)) throw new Error("expected a skip result");
    expect(result.severity).toBe("attention");
    expect(result.reason).toMatch(/share count/i);
    expect(result.eventType).toBe("ORDER_EXECUTED");
    expect(result.raw).toMatchObject({ amount: -75.5, isin: "DE0007236101" });
  });
});

describe("mapTrEvents", () => {
  it("collects drafts and surfaces skips as errors", () => {
    const { drafts, errors } = mapTrEvents([
      { ...base, id: "a", eventType: "PAYMENT_INBOUND", amount: 100 },
      { ...base, id: "b", eventType: "MYSTERY", amount: 1 },
      { ...base, id: "c", eventType: "CREDIT", amount: 5, isin: "X" },
    ]);
    expect(drafts.map((d) => d.externalId)).toEqual(["a", "c"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      line: 1,
      eventId: "b",
      eventType: "MYSTERY",
      severity: "attention",
      message: expect.stringContaining("unmapped"),
    });
    // The raw event is carried so the UI can offer to map it.
    expect(errors[0].raw).toMatchObject({ name: null });
  });
});
