import { describe, it, expect } from "vitest";
import { SCHEMA_PACKAGE } from "../src/index.js";

describe("@portfolio/schema", () => {
  it("exposes its package name", () => {
    expect(SCHEMA_PACKAGE).toBe("@portfolio/schema");
  });
});
