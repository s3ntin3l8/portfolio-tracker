import { describe, it, expect } from "vitest";
import {
  loanBalances,
  liabilityBalances,
  totalLiabilities,
  financingByInstrument,
  cashFlow,
  cashBalances,
  summarizePortfolio,
  contributionStats,
  type CoreTransaction,
} from "../src/index.js";

// --- Worked example: Galeri 24 MULIA, 50g, 12-month cicilan -----------------
// purchase 80,243,000 = down-payment 12,036,450 + loan 68,206,550.
// upfront cash = 12,036,450 + admin 50,000 − discount 1,250,000 = 10,836,450.
// 12 installments of 6,422,116 (Pokok 5,683,880 + Sewa Modal 738,236);
// the final installment rounds to Pokok 5,683,870 / total 6,422,106.
const GOLD = "gold-g24-50g";
const LOAN = "loan-1";
const START = new Date("2025-02-13");
const PRICE_PER_GRAM = "1604860"; // 80,243,000 / 50 → gold MV == purchase price
const PURCHASE = "80243000";

function leg(p: Partial<CoreTransaction>): CoreTransaction {
  return {
    instrumentId: null,
    type: "fee",
    quantity: "0",
    price: "0",
    fees: "0",
    currency: "IDR",
    executedAt: START,
    loanId: LOAN,
    ...p,
  };
}

/** The four legs booked on the contract date. */
function bookingLegs(): CoreTransaction[] {
  return [
    leg({ type: "buy", instrumentId: GOLD, quantity: "50", price: PRICE_PER_GRAM }),
    leg({ type: "loan_drawdown", price: "68206550" }),
    leg({ type: "fee", price: "50000" }), // admin
    leg({ type: "fee", price: "-1250000" }), // promo discount (negative fee = cash in)
  ];
}

/** `n` past installments (n ≤ 12), each Pokok in price + Sewa Modal in fees. */
function installments(n: number): CoreTransaction[] {
  const out: CoreTransaction[] = [];
  for (let i = 1; i <= n; i++) {
    const last = i === 12;
    out.push(
      leg({
        type: "loan_repayment",
        price: last ? "5683870" : "5683880",
        fees: "738236",
        executedAt: new Date(2025, 1 + i, 13), // 13/03/2025, 13/04/2025, ...
      }),
    );
  }
  return out;
}

const PRICES = { [GOLD]: { price: PRICE_PER_GRAM, currency: "IDR" } };

function nw(txns: CoreTransaction[], costBasisMode?: "purchase_price" | "total_paid") {
  return summarizePortfolio({
    transactions: txns,
    prices: PRICES,
    displayCurrency: "IDR",
    costBasisMode,
  });
}

describe("cashFlow — financing legs", () => {
  const base = leg({});
  it("loan_drawdown is cash in (price)", () => {
    expect(cashFlow({ ...base, type: "loan_drawdown", price: "68206550" }).toString()).toBe(
      "68206550",
    );
  });
  it("loan_repayment is principal + margin out", () => {
    expect(
      cashFlow({ ...base, type: "loan_repayment", price: "5683880", fees: "738236" }).toString(),
    ).toBe("-6422116");
  });
});

describe("loanBalances / liabilities", () => {
  it("outstanding = drawdown − repayments, per loan", () => {
    const txns = [...bookingLegs(), ...installments(1)];
    expect(loanBalances(txns)[LOAN]).toBe("62522670"); // 68,206,550 − 5,683,880
  });

  it("zero outstanding after the full schedule", () => {
    const txns = [...bookingLegs(), ...installments(12)];
    expect(loanBalances(txns)[LOAN]).toBe("0");
  });

  it("liabilityBalances groups by currency; totalLiabilities sums", () => {
    const txns = [...bookingLegs(), ...installments(1)];
    expect(liabilityBalances(txns)).toEqual({ IDR: "62522670" });
    expect(totalLiabilities(txns, "IDR")).toBe("62522670");
  });

  it("tracks two independent loans", () => {
    const txns = [
      leg({ type: "loan_drawdown", price: "100", loanId: "a" }),
      leg({ type: "loan_repayment", price: "30", loanId: "a" }),
      leg({ type: "loan_drawdown", price: "200", loanId: "b" }),
    ];
    expect(loanBalances(txns)).toEqual({ a: "70", b: "200" });
  });
});

describe("net worth — worked example (50g cicilan)", () => {
  it("after booking: +1,200,000 (discount − admin)", () => {
    const s = nw(bookingLegs());
    expect(cashBalances(bookingLegs())).toEqual({ IDR: "-10836450" });
    expect(s.totalLiabilities).toBe("68206550");
    expect(s.totalMarketValue).toBe(PURCHASE);
    expect(s.netWorth).toBe("1200000");
  });

  it("each installment costs exactly the Sewa Modal (−738,236)", () => {
    const before = nw(bookingLegs()).netWorth;
    const after = nw([...bookingLegs(), ...installments(1)]).netWorth;
    // Integer rupiah → BigInt diff is exact.
    expect((BigInt(after) - BigInt(before)).toString()).toBe("-738236");
  });

  it("end of term: net financing cost realized = 7,658,832", () => {
    const txns = [...bookingLegs(), ...installments(12)];
    const s = nw(txns);
    expect(s.totalLiabilities).toBe("0");
    // gold MV 80,243,000 − total cash out 87,901,832 = −7,658,832
    expect(cashBalances(txns)).toEqual({ IDR: "-87901832" });
    expect(s.netWorth).toBe("-7658832");
  });
});

describe("cost-basis toggle", () => {
  it("financingByInstrument sums admin + margin − discount to date", () => {
    const txns = [...bookingLegs(), ...installments(12)];
    // 50,000 − 1,250,000 + 12·738,236 = 7,658,832
    expect(financingByInstrument(txns)[GOLD]).toBe("7658832");
  });

  it("total_paid capitalizes financing; purchase_price does not", () => {
    const txns = [...bookingLegs(), ...installments(12)];
    const purchase = nw(txns, "purchase_price");
    const total = nw(txns, "total_paid");
    expect(purchase.holdings[0].costBasis).toBe(PURCHASE);
    expect(total.holdings[0].costBasis).toBe("87901832"); // 80,243,000 + 7,658,832
  });

  it("net worth is invariant to the cost-basis mode", () => {
    const txns = [...bookingLegs(), ...installments(6)];
    const purchase = nw(txns, "purchase_price");
    const total = nw(txns, "total_paid");
    expect(total.netWorth).toBe(purchase.netWorth);
    expect(total.totalMarketValue).toBe(purchase.totalMarketValue);
    // Only attribution moves.
    expect(total.holdings[0].costBasis).not.toBe(purchase.holdings[0].costBasis);
  });
});

describe("XIRR / contribution non-contamination", () => {
  it("loan legs are not counted as external contributions", () => {
    const deposit = leg({
      type: "deposit",
      price: "10836450",
      loanId: null,
      executedAt: START,
    });
    const withLoan = contributionStats({
      txns: [deposit, ...bookingLegs(), ...installments(3)],
      displayCurrency: "IDR",
    });
    const baseline = contributionStats({ txns: [deposit], displayCurrency: "IDR" });
    expect(withLoan.netContributed).toBe(baseline.netContributed);
    expect(withLoan.netContributed).toBe("10836450");
  });
});
