import { describe, it, expect } from "vitest";
import { buildApp } from "../../src/app.js";

describe("logging plugin", () => {
  it("configures structured JSON logging", async () => {
    const app = await buildApp();
    expect(app.log.level).toBe(app.config.LOG_LEVEL);
    await app.close();
  });
});