import { describe, it, expect } from "vitest";
import type { ParsedTransaction } from "@portfolio/schema";
import { collapsePerkFundedAcquisitions } from "../../../src/services/parsers/perk-pairing.js";

// Minimal ParsedTransaction factory — only the fields the collapse looks at matter.
function draft(p: Partial<ParsedTransaction>): ParsedTransaction {
  return {
    action: "buy",
    quantity: "0",
    price: "0",
    fees: "0",
    currency: "EUR",
    executedAt: new Date("2025-08-26T12:00:00Z"),
    confidence: 1,
    ...p,
  } as ParsedTransaction;
}

const buy = (over: Partial<ParsedTransaction>) =>
  draft({ action: "buy", isin: "IE00BMVB5R75", unit: "shares", ...over });
const perk = (over: Partial<ParsedTransaction>) =>
  draft({ action: "bonus_cash", kind: "bonus", quantity: "0", ...over });

describe("collapsePerkFundedAcquisitions", () => {
  it("collapses a STOCKPERK credit + the same-day buy it funds into one bonus row", () => {
    const out = collapsePerkFundedAcquisitions([
      buy({
        quantity: "2.7104",
        price: "37.335", // 2.7104 * 37.335 ≈ 101.19
        externalId: "tr-csv:buy",
        executedAt: new Date("2025-08-26T14:01:54Z"),
      }),
      perk({
        isin: "IE00BMVB5R75",
        price: "101.19",
        externalId: "tr-csv:perk",
        executedAt: new Date("2025-08-26T14:01:55Z"),
      }),
    ]);

    expect(out).toHaveLength(1);
    const b = out[0];
    expect(b.action).toBe("bonus");
    expect(b.kind).toBe("bonus");
    expect(b.quantity).toBe("2.7104");
    expect(b.price).toBe("37.335");
    expect(b.externalId).toBe("tr-csv:buy"); // the share-bearing event stays primary
    expect(b.extraSources).toEqual([
      { externalId: "tr-csv:perk", raw: { collapsedFrom: "perk_cash_credit" } },
    ]);
  });

  it("pairs two same-amount KINDERGELD credits with two same-day savings-plan buys 1:1", () => {
    const out = collapsePerkFundedAcquisitions([
      buy({
        action: "savings_plan",
        isin: "IE00BMVB5R75",
        quantity: "0.000269",
        price: "37.07",
        externalId: "b1",
      }),
      perk({ price: "0.01", externalId: "k1" }), // KINDERGELD carries no instrument
      perk({ price: "0.01", externalId: "k2" }),
      buy({
        action: "savings_plan",
        isin: "IE00BK5BQT80",
        quantity: "0.000074",
        price: "134.9",
        externalId: "b2",
      }),
    ]);

    const bonuses = out.filter((d) => d.action === "bonus");
    expect(bonuses).toHaveLength(2);
    expect(out.filter((d) => d.action === "bonus_cash")).toHaveLength(0);
    // Each buy kept its own instrument/shares; both perks consumed.
    expect(bonuses.map((b) => b.isin).sort()).toEqual(["IE00BK5BQT80", "IE00BMVB5R75"]);
  });

  it("pairs perks credited days before the buys they fund (amount disambiguates)", () => {
    // Real JUNIOR shape: two KINDERGELD credits on the 1st, two savings-plan buys on the 4th.
    // The 0.02 perk must fund the 0.02 buy (Lifestrategy), the 0.01 the 0.01 buy (FTSE).
    const out = collapsePerkFundedAcquisitions([
      perk({ price: "0.01", externalId: "k1", executedAt: new Date("2026-05-01T00:52:14Z") }),
      perk({ price: "0.02", externalId: "k2", executedAt: new Date("2026-05-01T00:52:32Z") }),
      buy({
        action: "savings_plan",
        isin: "IE00BMVB5R75",
        quantity: "0.00048",
        price: "41.625",
        externalId: "b-ls",
        executedAt: new Date("2026-05-04T12:13:01Z"),
      }), // ≈ 0.02
      buy({
        action: "savings_plan",
        isin: "IE00BK5BQT80",
        quantity: "0.000064",
        price: "155.46",
        externalId: "b-fw",
        executedAt: new Date("2026-05-04T16:39:49Z"),
      }), // ≈ 0.01
    ]);

    const bonuses = out.filter((d) => d.action === "bonus");
    expect(bonuses).toHaveLength(2);
    expect(out.filter((d) => d.action === "bonus_cash")).toHaveLength(0);
    // The 0.02 perk folded into the 0.02 Lifestrategy buy; the 0.01 perk into the FTSE buy.
    const ls = out.find((d) => d.externalId === "b-ls");
    const fw = out.find((d) => d.externalId === "b-fw");
    expect(ls?.extraSources?.[0].externalId).toBe("k2");
    expect(fw?.extraSources?.[0].externalId).toBe("k1");
  });

  it("does NOT pair a buy outside the day window (8 days after the perk)", () => {
    const out = collapsePerkFundedAcquisitions([
      perk({ price: "0.02", externalId: "k1", executedAt: new Date("2026-05-01T00:52:14Z") }),
      buy({
        quantity: "0.00048",
        price: "41.625",
        externalId: "b1",
        executedAt: new Date("2026-05-09T12:00:00Z"),
      }), // +8 days → beyond the 7-day window
    ]);
    expect(out).toHaveLength(2);
    expect(out.find((d) => d.externalId === "k1")?.action).toBe("bonus_cash");
    expect(out.find((d) => d.externalId === "b1")?.action).toBe("buy");
  });

  it("a 0.01 perk does not grab a 0.02 buy when only that buy is in range", () => {
    // Tightened tolerance: the 0.01 gap between funded buys exceeds the 0.005 abs tolerance.
    const out = collapsePerkFundedAcquisitions([
      perk({ price: "0.01", externalId: "k1", executedAt: new Date("2026-05-01T00:00:00Z") }),
      buy({
        quantity: "0.00048",
        price: "41.625",
        externalId: "b1",
        executedAt: new Date("2026-05-02T12:00:00Z"),
      }), // ≈ 0.02 — must NOT match a 0.01 perk
    ]);
    expect(out).toHaveLength(2);
    expect(out.find((d) => d.externalId === "k1")?.action).toBe("bonus_cash");
  });

  it("leaves a lone perk (no funding buy) as a bonus_cash row", () => {
    const out = collapsePerkFundedAcquisitions([
      perk({ price: "0.01", externalId: "k1", executedAt: new Date("2025-09-02T14:00:00Z") }),
      buy({
        quantity: "1",
        price: "50",
        externalId: "b1",
        executedAt: new Date("2025-09-05T10:00:00Z"),
      }), // unrelated buy: notional 50 ≠ perk 0.01
    ]);
    expect(out).toHaveLength(2);
    expect(out.find((d) => d.externalId === "k1")?.action).toBe("bonus_cash");
    expect(out.find((d) => d.externalId === "b1")?.action).toBe("buy");
  });

  it("requires instrument match when the perk carries one", () => {
    const out = collapsePerkFundedAcquisitions([
      buy({ isin: "DE000DIFFERENT", quantity: "2.7104", price: "37.335", externalId: "b1" }),
      perk({ isin: "IE00BMVB5R75", price: "101.19", externalId: "p1" }),
    ]);
    // Amount + day match, but the instrument differs → no collapse.
    expect(out).toHaveLength(2);
    expect(out.find((d) => d.externalId === "p1")?.action).toBe("bonus_cash");
  });

  it("is a no-op when there are no perk credits", () => {
    const input = [buy({ quantity: "1", price: "10", externalId: "b1" })];
    expect(collapsePerkFundedAcquisitions(input)).toBe(input);
  });
});
