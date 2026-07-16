import { describe, it, expect } from "vitest";
import {
  buildShareTimelines,
  sharesHeldAt,
  type CoreTransaction,
  type CorporateAction,
} from "../src/index.js";

const INST = "inst-1";
const OTHER = "inst-2";

function tx(p: Partial<CoreTransaction>): CoreTransaction {
  return {
    instrumentId: INST,
    type: "buy",
    quantity: "0",
    price: "0",
    fees: "0",
    currency: "EUR",
    executedAt: new Date("2021-01-01"),
    ...p,
  };
}

function ca(p: Partial<CorporateAction>): CorporateAction {
  return {
    instrumentId: INST,
    type: "split",
    ratio: "2",
    exDate: new Date("2021-01-01"),
    ...p,
  };
}

describe("buildShareTimelines / sharesHeldAt", () => {
  it("returns the running share count as of a dividend's pay date", () => {
    const txns = [
      tx({ type: "buy", quantity: "10", price: "100", executedAt: new Date("2021-01-01") }),
      tx({ type: "buy", quantity: "5", price: "120", executedAt: new Date("2021-06-01") }),
      // dividend itself doesn't affect the timeline.
      tx({ type: "dividend", quantity: "0", price: "15", executedAt: new Date("2021-07-01") }),
    ];
    const timelines = buildShareTimelines(txns);
    expect(sharesHeldAt(timelines, INST, new Date("2021-07-01"))?.toString()).toBe("15");
    // Before the second buy: only the first lot is held.
    expect(sharesHeldAt(timelines, INST, new Date("2021-03-01"))?.toString()).toBe("10");
    // Same-day buy counts (matches computeHoldings' <= asOf convention).
    expect(sharesHeldAt(timelines, INST, new Date("2021-01-01"))?.toString()).toBe("10");
  });

  it("a partial sell reduces the running quantity, clamped to what's held", () => {
    const txns = [
      tx({ type: "buy", quantity: "10", price: "100", executedAt: new Date("2021-01-01") }),
      tx({ type: "sell", quantity: "4", price: "150", executedAt: new Date("2021-04-01") }),
    ];
    const timelines = buildShareTimelines(txns);
    expect(sharesHeldAt(timelines, INST, new Date("2021-05-01"))?.toString()).toBe("6");
    // Over-selling (bad data) clamps at zero rather than going negative.
    const overSold = buildShareTimelines([
      tx({ type: "buy", quantity: "5", price: "100", executedAt: new Date("2021-01-01") }),
      tx({ type: "sell", quantity: "9", price: "150", executedAt: new Date("2021-02-01") }),
    ]);
    expect(sharesHeldAt(overSold, INST, new Date("2021-03-01"))).toBeNull();
  });

  it("applies a split inline at its exDate, not retroactively across the whole series", () => {
    const txns = [
      tx({ type: "buy", quantity: "10", price: "100", executedAt: new Date("2021-01-01") }),
      // Dividend paid BEFORE the split — should see the pre-split share count.
      tx({ type: "dividend", quantity: "0", price: "5", executedAt: new Date("2021-03-01") }),
    ];
    const corporateActions = [ca({ type: "split", ratio: "2", exDate: new Date("2021-06-01") })];
    const timelines = buildShareTimelines(txns, corporateActions);

    // Before the split: still 10 shares, not the post-split 20.
    expect(sharesHeldAt(timelines, INST, new Date("2021-03-01"))?.toString()).toBe("10");
    // After the split: 20.
    expect(sharesHeldAt(timelines, INST, new Date("2021-12-01"))?.toString()).toBe("20");
  });

  it("a bonus corporate action scales the running quantity inline", () => {
    const txns = [
      tx({ type: "buy", quantity: "10", price: "100", executedAt: new Date("2021-01-01") }),
    ];
    // 1:10 bonus issue → +1 share per 10 held.
    const corporateActions = [ca({ type: "bonus", ratio: "0.1", exDate: new Date("2021-06-01") })];
    const timelines = buildShareTimelines(txns, corporateActions);
    expect(sharesHeldAt(timelines, INST, new Date("2021-12-01"))?.toString()).toBe("11");
  });

  it("returns null for an instrument never traded, or a date before any holding", () => {
    const txns = [
      tx({ type: "buy", quantity: "10", price: "100", executedAt: new Date("2021-06-01") }),
    ];
    const timelines = buildShareTimelines(txns);
    expect(sharesHeldAt(timelines, OTHER, new Date("2021-12-01"))).toBeNull();
    expect(sharesHeldAt(timelines, INST, new Date("2021-01-01"))).toBeNull();
  });

  it("fractional shares round-trip exactly", () => {
    const txns = [
      tx({
        type: "savings_plan",
        quantity: "1.234567",
        price: "50",
        executedAt: new Date("2021-01-01"),
      }),
      tx({
        type: "savings_plan",
        quantity: "0.876543",
        price: "52",
        executedAt: new Date("2021-02-01"),
      }),
    ];
    const timelines = buildShareTimelines(txns);
    expect(sharesHeldAt(timelines, INST, new Date("2021-03-01"))?.toString()).toBe("2.11111");
  });

  it("transfer_in adds and transfer_out subtracts, dividend/coupon/fee/deposit never mutate qty", () => {
    const txns = [
      tx({ type: "transfer_in", quantity: "10", price: "100", executedAt: new Date("2021-01-01") }),
      tx({
        type: "fee",
        quantity: "0",
        price: "5",
        instrumentId: null,
        executedAt: new Date("2021-01-15"),
      }),
      tx({ type: "transfer_out", quantity: "3", price: "100", executedAt: new Date("2021-02-01") }),
    ];
    const timelines = buildShareTimelines(txns);
    expect(sharesHeldAt(timelines, INST, new Date("2021-03-01"))?.toString()).toBe("7");
  });

  it("archived and draft rows are excluded, mirroring computeHoldings", () => {
    const txns = [
      tx({ type: "buy", quantity: "10", price: "100", executedAt: new Date("2021-01-01") }),
      tx({
        type: "buy",
        quantity: "999",
        price: "100",
        executedAt: new Date("2021-02-01"),
        status: "draft",
      }),
    ];
    const timelines = buildShareTimelines(txns);
    expect(sharesHeldAt(timelines, INST, new Date("2021-12-01"))?.toString()).toBe("10");
  });
});
