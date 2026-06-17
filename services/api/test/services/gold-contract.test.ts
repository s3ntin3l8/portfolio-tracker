import { describe, it, expect } from "vitest";
import { Decimal } from "decimal.js";
import { parsedGoldContractSchema } from "@portfolio/schema";
import {
  buildContractLegs,
  goldInstrumentForContract,
} from "../../src/services/parsers/gold-contract.js";

// Installment due dates: 13th of each month, March 2025 → February 2026.
function dueDate(n: number): string {
  const monthIndex = 1 + n; // n=1 → month index 2 (March)
  const year = 2025 + Math.floor(monthIndex / 12);
  const month = (monthIndex % 12) + 1;
  return `${year}-${String(month).padStart(2, "0")}-13`;
}

// The 50g Galeri 24 MULIA contract from the worked example.
const RAW = {
  provider: "GALERI24",
  contractNo: "1411125370001253",
  currency: "IDR",
  grams: "50",
  goldName: "LM 50 Gram",
  purchasePrice: "80243000",
  downPayment: "12036450",
  adminFee: "50000",
  discount: "1250000",
  principal: "68206550",
  marginTotal: "8858832",
  tenorMonths: 12,
  monthlyInstallment: "6422116",
  startDate: "2025-02-13",
  schedule: Array.from({ length: 12 }, (_, i) => ({
    n: i + 1,
    dueDate: dueDate(i + 1),
    pokok: i === 11 ? "5683870" : "5683880",
    sewaModal: "738236",
    angsuran: i === 11 ? "6422106" : "6422116",
    sisaPokok: "0",
  })),
  confidence: 0.95,
};

const CONTRACT = parsedGoldContractSchema.parse(RAW);

describe("parsedGoldContractSchema", () => {
  it("accepts the contract and coerces dates", () => {
    expect(CONTRACT.grams).toBe("50");
    expect(CONTRACT.startDate).toBeInstanceOf(Date);
    expect(CONTRACT.schedule).toHaveLength(12);
  });

  it("rejects a float quantity and requires grams", () => {
    expect(parsedGoldContractSchema.safeParse({ ...RAW, grams: 50 }).success).toBe(false);
    const { grams: _omit, ...noGrams } = RAW;
    void _omit;
    expect(parsedGoldContractSchema.safeParse(noGrams).success).toBe(false);
  });
});

describe("goldInstrumentForContract", () => {
  it("routes to the GALERI24 buyback market, keyed per contract", () => {
    const g = goldInstrumentForContract(CONTRACT);
    expect(g.market).toBe("GALERI24");
    expect(g.symbol).toBe("G24:1411125370001253");
    expect(g.name).toBe("LM 50 Gram");
  });
});

describe("buildContractLegs", () => {
  it("books the four contract legs on the credit date (cost basis == purchase price)", () => {
    // `now` before any installment is due.
    const legs = buildContractLegs(CONTRACT, new Date("2025-02-14"));
    expect(legs).toHaveLength(4);

    const [buy, drawdown, admin, discount] = legs;
    expect(buy).toMatchObject({
      role: "gold_buy",
      type: "buy",
      quantity: "50",
      price: "1604860", // 80,243,000 / 50, exact
      fees: "0",
    });
    expect(drawdown).toMatchObject({ type: "loan_drawdown", price: "68206550" });
    expect(admin).toMatchObject({ type: "fee", price: "50000" });
    expect(discount).toMatchObject({ type: "fee", price: "-1250000" }); // negative fee = cash in
  });

  it("books only installments due on/before now", () => {
    const legs = buildContractLegs(CONTRACT, new Date("2025-05-20")); // 3 installments due
    const repayments = legs.filter((l) => l.role === "repayment");
    expect(repayments).toHaveLength(3);
    expect(repayments[0]).toMatchObject({
      type: "loan_repayment",
      price: "5683880", // Pokok in price
      fees: "738236", // Sewa Modal in fees
    });
  });

  it("books the full schedule once the term has elapsed", () => {
    const legs = buildContractLegs(CONTRACT, new Date("2027-01-01"));
    expect(legs.filter((l) => l.role === "repayment")).toHaveLength(12);
  });

  it("absorbs a rounding remainder into the buy fees so cost basis stays exact", () => {
    const odd = parsedGoldContractSchema.parse({
      ...RAW,
      grams: "7",
      purchasePrice: "10000000",
    });
    const [buy] = buildContractLegs(odd, new Date("2025-02-14"));
    // grams * per-gram price + remainder fees must equal the purchase price exactly.
    const cost = new Decimal(buy.quantity).mul(buy.price).add(buy.fees);
    expect(cost.toString()).toBe("10000000");
    expect(new Decimal(buy.fees).gte(0)).toBe(true);
  });
});
