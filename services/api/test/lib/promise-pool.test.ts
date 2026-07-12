import { describe, it, expect } from "vitest";
import { mapPool } from "../../src/lib/promise-pool.js";

describe("mapPool", () => {
  it("preserves input order regardless of completion order", async () => {
    // Later items resolve first; results must still be in input order.
    const out = await mapPool([0, 1, 2, 3], 2, (n) =>
      new Promise<number>((resolve) => setTimeout(() => resolve(n * 10), (4 - n) * 5)),
    );
    expect(out).toEqual([0, 10, 20, 30]);
  });

  it("never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await mapPool(Array.from({ length: 12 }, (_, i) => i), 3, async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    });
    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBeGreaterThan(1); // actually ran concurrently
  });

  it("propagates a per-item rejection instead of swallowing it", async () => {
    // Unlike the web import flow (which tags outcomes), API callers let a portfolio
    // valuation failure fail the whole request — same as the pre-parallelization
    // serial `for` loop did.
    await expect(
      mapPool([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error("boom");
        return n;
      }),
    ).rejects.toThrow("boom");
  });

  it("handles an empty list and a limit larger than the list", async () => {
    expect(await mapPool([], 4, async (n) => n)).toEqual([]);
    expect(await mapPool([1, 2], 99, async (n) => n * 2)).toEqual([2, 4]);
  });
});
