import { describe, it, expect } from "vitest";
import { DB_PACKAGE } from "../src/index.js";

describe("@portfolio/db", () => {
  it("exposes its package name", () => {
    expect(DB_PACKAGE).toBe("@portfolio/db");
  });
});
