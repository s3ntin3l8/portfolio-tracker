import { describe, it, expect } from "vitest";
import type { transactions } from "@portfolio/db";
import { toCoreTxns } from "../../src/services/tx-core.js";

type TxRow = typeof transactions.$inferSelect;

// Minimal row factory — only the fields toCoreTxns reads matter.
function row(over: Partial<TxRow>): TxRow {
  return {
    id: over.id ?? "t1",
    instrumentId: over.instrumentId ?? "i1",
    type: over.type ?? "buy",
    quantity: over.quantity ?? "1",
    price: over.price ?? "10",
    fees: over.fees ?? "0",
    currency: over.currency ?? "EUR",
    executedAt: over.executedAt ?? new Date("2024-01-01"),
    loanId: over.loanId ?? null,
    kind: over.kind ?? null,
    tax: over.tax ?? null,
    savingsPlanId: over.savingsPlanId ?? null,
    status: over.status ?? "normal",
    // remaining columns are untouched by toCoreTxns
    ...over,
  } as TxRow;
}

describe("toCoreTxns chokepoint", () => {
  it("excludes archived and draft rows by default", () => {
    const rows = [
      row({ id: "n", status: "normal" }),
      row({ id: "a", status: "archived" }),
      row({ id: "d", status: "draft" }),
      row({ id: "cn", status: "cash_neutral" }),
    ];
    const ids = toCoreTxns(rows).map((t) => t.id);
    expect(ids).toEqual(["n", "cn"]);
  });

  it("never includes draft rows even with includeArchived", () => {
    const rows = [
      row({ id: "n", status: "normal" }),
      row({ id: "a", status: "archived" }),
      row({ id: "d", status: "draft" }),
    ];
    const ids = toCoreTxns(rows, { includeArchived: true }).map((t) => t.id);
    expect(ids).toEqual(["n", "a"]);
  });
});
