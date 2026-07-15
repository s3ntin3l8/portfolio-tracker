import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useTableSort } from "../src/lib/table-sort";
import type { ColDef } from "../src/lib/table-sort";

interface Row {
  name: string;
  amount: string;
  date: string;
}

const COLS: ColDef<Row>[] = [
  { key: "name", get: (r) => r.name, type: "text" },
  { key: "amount", get: (r) => r.amount, type: "numeric" },
  { key: "date", get: (r) => r.date, type: "date" },
];

const ROWS: Row[] = [
  { name: "Banana", amount: "10", date: "2026-03-01" },
  { name: "apple", amount: "2", date: "2026-01-01" },
  { name: "cherry", amount: "100", date: "2026-02-01" },
];

describe("useTableSort", () => {
  it("returns rows unchanged when no sort key is set", () => {
    const { result } = renderHook(() => useTableSort<Row>(COLS));
    expect(result.current.sort(ROWS)).toEqual(ROWS);
  });

  it("sorts text ascending (case-insensitive, locale-aware)", () => {
    const { result } = renderHook(() => useTableSort<Row>(COLS));
    act(() => result.current.toggle("name"));
    const sorted = result.current.sort(ROWS);
    expect(sorted.map((r) => r.name)).toEqual(["apple", "Banana", "cherry"]);
  });

  it("sorts text descending on second toggle of same key", () => {
    const { result } = renderHook(() => useTableSort<Row>(COLS));
    act(() => result.current.toggle("name"));
    act(() => result.current.toggle("name"));
    expect(result.current.sortDir).toBe("desc");
    const sorted = result.current.sort(ROWS);
    expect(sorted.map((r) => r.name)).toEqual(["cherry", "Banana", "apple"]);
  });

  it("resets to ascending when switching to a different key", () => {
    const { result } = renderHook(() => useTableSort<Row>(COLS));
    act(() => result.current.toggle("name"));
    act(() => result.current.toggle("name")); // now desc
    act(() => result.current.toggle("amount")); // switch key → asc
    expect(result.current.sortKey).toBe("amount");
    expect(result.current.sortDir).toBe("asc");
  });

  it("sorts numerically (not lexicographic): '10' > '9' not '10' < '9'", () => {
    const rows: Row[] = [
      { name: "A", amount: "10", date: "2026-01-01" },
      { name: "B", amount: "9", date: "2026-01-01" },
      { name: "C", amount: "2", date: "2026-01-01" },
    ];
    const { result } = renderHook(() => useTableSort<Row>(COLS));
    act(() => result.current.toggle("amount"));
    const sorted = result.current.sort(rows);
    expect(sorted.map((r) => r.amount)).toEqual(["2", "9", "10"]);
  });

  it("sorts numeric descending correctly", () => {
    const { result } = renderHook(() => useTableSort<Row>(COLS));
    act(() => result.current.toggle("amount"));
    act(() => result.current.toggle("amount"));
    const sorted = result.current.sort(ROWS);
    expect(sorted.map((r) => r.amount)).toEqual(["100", "10", "2"]);
  });

  it("sorts dates ascending", () => {
    const { result } = renderHook(() => useTableSort<Row>(COLS));
    act(() => result.current.toggle("date"));
    const sorted = result.current.sort(ROWS);
    expect(sorted.map((r) => r.date)).toEqual([
      "2026-01-01",
      "2026-02-01",
      "2026-03-01",
    ]);
  });

  it("sorts dates descending", () => {
    const { result } = renderHook(() => useTableSort<Row>(COLS));
    act(() => result.current.toggle("date"));
    act(() => result.current.toggle("date"));
    const sorted = result.current.sort(ROWS);
    expect(sorted.map((r) => r.date)).toEqual([
      "2026-03-01",
      "2026-02-01",
      "2026-01-01",
    ]);
  });

  it("does not mutate the original array", () => {
    const { result } = renderHook(() => useTableSort<Row>(COLS));
    act(() => result.current.toggle("name"));
    const original = [...ROWS];
    result.current.sort(ROWS);
    expect(ROWS).toEqual(original);
  });

  it("handles decimal string amounts correctly", () => {
    const rows: Row[] = [
      { name: "A", amount: "1234.56", date: "2026-01-01" },
      { name: "B", amount: "999.99", date: "2026-01-01" },
      { name: "C", amount: "100.00", date: "2026-01-01" },
    ];
    const { result } = renderHook(() => useTableSort<Row>(COLS));
    act(() => result.current.toggle("amount"));
    const sorted = result.current.sort(rows);
    expect(sorted.map((r) => r.amount)).toEqual(["100.00", "999.99", "1234.56"]);
  });

  it("reads latest cols from ref when cols identity changes between renders", () => {
    const extract: (r: { n: string }) => string = (r) => r.n;
    const COLS_A: ColDef<{ n: string }>[] = [
      { key: "f", get: (r) => extract(r), type: "text" },
    ];
    const COLS_B: ColDef<{ n: string }>[] = [
      { key: "f", get: () => "same", type: "text" },
    ];
    const ROWS = [{ n: "z" }, { n: "a" }];

    const { result, rerender } = renderHook(
      ({ cols }: { cols: ColDef<{ n: string }>[] }) => useTableSort(cols),
      { initialProps: { cols: COLS_A } },
    );

    act(() => result.current.toggle("f"));

    // COLS_A's get returns r.n → "a" < "z"
    expect(result.current.sort(ROWS).map((r) => r.n)).toEqual(["a", "z"]);

    // Re-render with a different COLS identity (same key, different get)
    rerender({ cols: COLS_B });

    // The sort callback reads colsRef.current (latest cols), so it uses COLS_B's
    // get which returns "same" for both — stable sort preserves original order.
    // Without the ref fix it would still use COLS_A (stale closure) → "a", "z".
    expect(result.current.sort(ROWS).map((r) => r.n)).toEqual(["z", "a"]);
  });
});
