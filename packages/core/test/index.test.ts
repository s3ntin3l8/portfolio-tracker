import { describe, it, expect } from "vitest";
import { CORE_PACKAGE } from "../src/index.js";

describe("@portfolio/core", () => {
  it("exposes its package name", () => {
    expect(CORE_PACKAGE).toBe("@portfolio/core");
  });
});
