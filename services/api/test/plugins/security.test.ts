import { describe, it, expect, afterEach } from "vitest";
import { buildApp } from "../../src/app.js";

describe("security plugin", () => {
  afterEach(() => {
    delete process.env.RATE_LIMIT_MAX;
    delete process.env.CORS_ORIGIN;
  });

  it("sets security headers from helmet", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBeDefined();
    await app.close();
  });

  it("rate-limits requests beyond the configured max", async () => {
    process.env.RATE_LIMIT_MAX = "2";
    const app = await buildApp();

    const first = await app.inject({ method: "GET", url: "/health" });
    const second = await app.inject({ method: "GET", url: "/health" });
    const third = await app.inject({ method: "GET", url: "/health" });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(third.statusCode).toBe(429);
    await app.close();
  });

  it("reflects an allowlisted CORS origin", async () => {
    process.env.CORS_ORIGIN = "https://app.example.com";
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "https://app.example.com" },
    });
    expect(res.headers["access-control-allow-origin"]).toBe("https://app.example.com");
    await app.close();
  });
});
