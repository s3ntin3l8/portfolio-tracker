import { describe, it, expect } from "vitest";

describe("zod-config", () => {
  it("sets jitless=true on globalThis.__zod_globalConfig before Zod loads", async () => {
    // Sanity: the global config object doesn't have jitless set yet (no Zod imported).
    expect(
      (globalThis as unknown as { __zod_globalConfig?: { jitless?: boolean } }).__zod_globalConfig
        ?.jitless,
    ).toBeUndefined();

    // Trigger the side-effect module.
    await import("../src/lib/zod-config");

    expect(
      (globalThis as unknown as { __zod_globalConfig: { jitless: boolean } }).__zod_globalConfig
        .jitless,
    ).toBe(true);
  });
});
