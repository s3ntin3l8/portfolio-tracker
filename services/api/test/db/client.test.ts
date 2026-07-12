import { describe, it, expect } from "vitest";
import { initDb, warmPool } from "../../src/db/client.js";

describe("warmPool", () => {
  it("is a no-op under PGlite (no real pool to warm) and never throws", async () => {
    // Tests always run against embedded PGlite (see usePglite()), so `sql` is never
    // set — warmPool must resolve immediately instead of erroring on a null client.
    await initDb();
    await expect(warmPool()).resolves.toBeUndefined();
    await expect(warmPool(1)).resolves.toBeUndefined();
  });
});
