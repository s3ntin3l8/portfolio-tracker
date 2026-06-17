import { describe, it, expect } from "vitest";
import { txTypeEnum } from "@portfolio/db";
import { transactionTypeSchema } from "@portfolio/schema";

// The transaction-type enum is hand-mirrored across three packages (db pgEnum,
// schema zod enum, core TS union). The core union is compile-time enforced; this
// guards the two runtime mirrors from drifting.
describe("transaction-type enum mirrors", () => {
  it("db pgEnum and schema zod enum hold the same set", () => {
    expect([...txTypeEnum.enumValues].sort()).toEqual(
      [...transactionTypeSchema.options].sort(),
    );
  });

  it("includes the financing legs", () => {
    expect(txTypeEnum.enumValues).toContain("loan_drawdown");
    expect(txTypeEnum.enumValues).toContain("loan_repayment");
  });
});
