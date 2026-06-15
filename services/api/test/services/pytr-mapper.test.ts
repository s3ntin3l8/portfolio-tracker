import { describe, it, expect } from "vitest";
import { mapTrEventToDraft, mapTrEvents } from "../../src/services/pytr/mapper.js";

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
      title: "Siemens",
    });
    expect(buy).toMatchObject({
      action: "buy",
      isin: "DE0007236101",
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

  it("excludes fees from the per-share price and carries them separately", () => {
    const buy = draftOf({
      ...base,
      eventType: "TRADE_INVOICE",
      amount: -1010,
      fees: 10,
      shares: 10,
      isin: "DE0007236101",
    });
    expect(buy).toMatchObject({ action: "buy", quantity: "10", price: "100", fees: "10" });
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
    expect(draftOf({ ...base, eventType: "INTEREST_PAYOUT", amount: 3 })).toMatchObject({
      action: "deposit",
      isin: null,
      quantity: "0",
      price: "3",
    });
    expect(draftOf({ ...base, eventType: "PAYMENT_INBOUND", amount: 1000 }).action).toBe(
      "deposit",
    );
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

  it("skips known no-ops with a reason (card verification, failed/accrual, share corp action)", () => {
    for (const eventType of [
      "CARD_VERIFICATION",
      "INTEREST_PAYOUT_CREATED",
      "TRADING_SAVINGSPLAN_EXECUTION_FAILED",
      "SSP_CORPORATE_ACTION_INSTRUMENT",
    ]) {
      expect(mapTrEventToDraft({ ...base, eventType, amount: 0 })).toMatchObject({
        skip: true,
      });
    }
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
});

describe("mapTrEvents", () => {
  it("collects drafts and surfaces skips as errors", () => {
    const { drafts, errors } = mapTrEvents([
      { ...base, id: "a", eventType: "PAYMENT_INBOUND", amount: 100 },
      { ...base, id: "b", eventType: "MYSTERY", amount: 1 },
      { ...base, id: "c", eventType: "CREDIT", amount: 5, isin: "X" },
    ]);
    expect(drafts.map((d) => d.externalId)).toEqual(["a", "c"]);
    expect(errors).toEqual([{ line: 1, message: expect.stringContaining("unmapped") }]);
  });
});
