import { describe, it, expect, afterEach } from "vitest";
import { buildApp } from "../../src/app.js";

describe("security plugin", () => {
  afterEach(() => {
    delete process.env.RATE_LIMIT_MAX;
    delete process.env.TRUSTED_PROXY_CIDRS;
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

  it("uses forwarded IPs as independent buckets only from trusted proxies", async () => {
    process.env.RATE_LIMIT_MAX = "1";
    process.env.TRUSTED_PROXY_CIDRS = "127.0.0.1";
    const app = await buildApp();

    const first = await app.inject({
      method: "GET",
      url: "/health",
      headers: { "x-forwarded-for": "203.0.113.10" },
    });
    const second = await app.inject({
      method: "GET",
      url: "/health",
      headers: { "x-forwarded-for": "203.0.113.11" },
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    await app.close();
  });

  it("ignores forwarded IPs when no trusted proxy is configured", async () => {
    process.env.RATE_LIMIT_MAX = "1";
    const app = await buildApp();

    const first = await app.inject({
      method: "GET",
      url: "/health",
      headers: { "x-forwarded-for": "203.0.113.10" },
    });
    const second = await app.inject({
      method: "GET",
      url: "/health",
      headers: { "x-forwarded-for": "203.0.113.11" },
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(429);
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

  it("allows PATCH on a preflight from an allowlisted origin", async () => {
    process.env.CORS_ORIGIN = "https://app.example.com";
    const app = await buildApp();
    const res = await app.inject({
      method: "OPTIONS",
      url: "/me",
      headers: {
        origin: "https://app.example.com",
        "access-control-request-method": "PATCH",
      },
    });
    expect(res.headers["access-control-allow-methods"]).toContain("PATCH");
    await app.close();
  });
});
