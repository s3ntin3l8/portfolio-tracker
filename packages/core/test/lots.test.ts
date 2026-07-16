import { describe, it, expect } from "vitest";
import { openLots, type CoreTransaction, type CorporateAction } from "../src/index.js";

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

describe("openLots", () => {
  it("creates ordered lots for sequential buys", () => {
    const txns = [
      tx({ type: "buy", quantity: "10", price: "100", executedAt: new Date("2021-01-01") }),
      tx({ type: "buy", quantity: "5", price: "120", executedAt: new Date("2021-03-01") }),
    ];
    const lots = openLots(txns);
    const instLots = lots.get(INST);
    expect(instLots).toHaveLength(2);
    expect(instLots![0]).toEqual({
      acqDate: "2021-01-01",
      qty: "10",
      unitCost: "100",
      cost: "1000",
    });
    expect(instLots![1]).toEqual({
      acqDate: "2021-03-01",
      qty: "5",
      unitCost: "120",
      cost: "600",
    });
  });

  it("includes fees in the per-unit cost of a lot", () => {
    const txns = [
      tx({
        type: "buy",
        quantity: "10",
        price: "100",
        fees: "10",
        executedAt: new Date("2021-01-01"),
      }),
    ];
    const lots = openLots(txns);
    expect(lots.get(INST)![0]).toEqual({
      acqDate: "2021-01-01",
      qty: "10",
      unitCost: "101", // (10*100 + 10) / 10
      cost: "1010",
    });
  });

  it("a partial sell consumes the oldest lot first (FIFO), leaving the remainder plus untouched newer lots", () => {
    const txns = [
      tx({ type: "buy", quantity: "10", price: "100", executedAt: new Date("2021-01-01") }),
      tx({ type: "buy", quantity: "5", price: "120", executedAt: new Date("2021-03-01") }),
      tx({ type: "sell", quantity: "6", price: "150", executedAt: new Date("2021-06-01") }),
    ];
    const lots = openLots(txns)!.get(INST)!;
    expect(lots).toHaveLength(2);
    // First lot had 10, 6 consumed → 4 left at the same unit cost.
    expect(lots[0]).toEqual({
      acqDate: "2021-01-01",
      qty: "4",
      unitCost: "100",
      cost: "400",
    });
    // Second lot untouched.
    expect(lots[1]).toEqual({
      acqDate: "2021-03-01",
      qty: "5",
      unitCost: "120",
      cost: "600",
    });
  });

  it("a sell that fully drains a lot removes it and continues into the next", () => {
    const txns = [
      tx({ type: "buy", quantity: "10", price: "100", executedAt: new Date("2021-01-01") }),
      tx({ type: "buy", quantity: "5", price: "120", executedAt: new Date("2021-03-01") }),
      tx({ type: "sell", quantity: "12", price: "150", executedAt: new Date("2021-06-01") }),
    ];
    const lots = openLots(txns)!.get(INST)!;
    expect(lots).toHaveLength(1);
    expect(lots[0]).toEqual({
      acqDate: "2021-03-01",
      qty: "3", // 5 - (12 - 10)
      unitCost: "120",
      cost: "360",
    });
  });

  it("a 2:1 split doubles every open lot's qty and halves unitCost, with total cost unchanged", () => {
    const txns = [
      tx({ type: "buy", quantity: "10", price: "100", executedAt: new Date("2021-01-01") }),
      tx({ type: "buy", quantity: "5", price: "120", executedAt: new Date("2021-03-01") }),
    ];
    const cas: CorporateAction[] = [
      { instrumentId: INST, type: "split", ratio: "2", exDate: new Date("2021-06-01") },
    ];
    const lots = openLots(txns, cas)!.get(INST)!;
    expect(lots).toHaveLength(2);
    expect(lots[0]).toEqual({
      acqDate: "2021-01-01",
      qty: "20",
      unitCost: "50",
      cost: "1000",
    });
    expect(lots[1]).toEqual({
      acqDate: "2021-03-01",
      qty: "10",
      unitCost: "60",
      cost: "600",
    });
  });

  it("transfer_out reduces standing lots FIFO with no P&L bookkeeping", () => {
    const txns = [
      tx({ type: "buy", quantity: "10", price: "100", executedAt: new Date("2021-01-01") }),
      tx({ type: "buy", quantity: "5", price: "120", executedAt: new Date("2021-03-01") }),
      tx({ type: "transfer_out", quantity: "8", price: "0", executedAt: new Date("2021-06-01") }),
    ];
    const lots = openLots(txns)!.get(INST)!;
    expect(lots).toHaveLength(2);
    expect(lots[0].qty).toBe("2");
    expect(lots[1].qty).toBe("5");
  });

  it("transfer_in creates a lot at the carried cost basis", () => {
    const txns = [
      tx({ type: "transfer_in", quantity: "10", price: "80", executedAt: new Date("2021-01-01") }),
    ];
    const lots = openLots(txns)!.get(INST)!;
    expect(lots).toEqual([{ acqDate: "2021-01-01", qty: "10", unitCost: "80", cost: "800" }]);
  });

  it("tracks a zero-cost bonus lot correctly", () => {
    const txns = [
      tx({ type: "bonus", quantity: "5", price: "0", executedAt: new Date("2021-01-01") }),
    ];
    const lots = openLots(txns)!.get(INST)!;
    expect(lots).toEqual([{ acqDate: "2021-01-01", qty: "5", unitCost: "0", cost: "0" }]);
  });

  it("excludes draft and archived transactions", () => {
    const txns = [
      tx({ type: "buy", quantity: "10", price: "100", executedAt: new Date("2021-01-01") }),
      tx({
        type: "buy",
        quantity: "999",
        price: "1",
        executedAt: new Date("2021-02-01"),
        status: "draft",
      }),
      tx({
        type: "buy",
        quantity: "999",
        price: "1",
        executedAt: new Date("2021-02-02"),
        status: "archived",
      }),
    ];
    const lots = openLots(txns)!.get(INST)!;
    expect(lots).toHaveLength(1);
    expect(lots[0].qty).toBe("10");
  });

  it("keys lots per instrument and omits instruments fully closed out", () => {
    const txns = [
      tx({ instrumentId: INST, type: "buy", quantity: "10", price: "100" }),
      tx({ instrumentId: OTHER, type: "buy", quantity: "3", price: "50" }),
      tx({
        instrumentId: OTHER,
        type: "sell",
        quantity: "3",
        price: "60",
        executedAt: new Date("2021-06-01"),
      }),
    ];
    const lots = openLots(txns);
    expect(lots.has(INST)).toBe(true);
    expect(lots.has(OTHER)).toBe(false);
  });

  it("respects asOf, replaying only transactions up to that date (corporate actions always applied)", () => {
    const txns = [
      tx({ type: "buy", quantity: "10", price: "100", executedAt: new Date("2021-01-01") }),
      tx({ type: "buy", quantity: "5", price: "120", executedAt: new Date("2021-06-01") }),
    ];
    const lots = openLots(txns, [], new Date("2021-03-01"))!.get(INST)!;
    expect(lots).toHaveLength(1);
    expect(lots[0].qty).toBe("10");
  });
});
