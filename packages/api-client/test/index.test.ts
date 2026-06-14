import { describe, it, expect } from "vitest";
import { API_CLIENT_PACKAGE } from "../src/index.js";

describe("@portfolio/api-client", () => {
  it("exposes its package name", () => {
    expect(API_CLIENT_PACKAGE).toBe("@portfolio/api-client");
  });
});
