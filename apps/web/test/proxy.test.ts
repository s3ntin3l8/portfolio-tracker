import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl/middleware", () => ({
  default: () => () => new Response(null, { status: 200 }),
}));

import { bypassI18n, config, isAllowedHost } from "../src/proxy";

describe("proxy host guard", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    delete process.env.AUTH_URL;
    delete process.env.WEB_ALLOWED_HOSTS;
  });

  it("allows the AUTH_URL host in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.AUTH_URL = "https://portfolio.example.com";

    expect(isAllowedHost("portfolio.example.com")).toBe(true);
  });

  it("allows WEB_ALLOWED_HOSTS entries in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.WEB_ALLOWED_HOSTS = "app.example.com, https://admin.example.com";

    expect(isAllowedHost("app.example.com")).toBe(true);
    expect(isAllowedHost("admin.example.com")).toBe(true);
  });

  it("rejects unexpected production hosts", () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.AUTH_URL = "https://portfolio.example.com";

    expect(isAllowedHost("evil.example.com")).toBe(false);
  });

  it("allows localhost-style hosts outside production only", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(isAllowedHost("localhost:3005")).toBe(true);
    expect(isAllowedHost("127.0.0.1:3005")).toBe(true);

    vi.stubEnv("NODE_ENV", "production");
    expect(isAllowedHost("localhost:3005")).toBe(false);
  });

  it("matches Auth.js routes but bypasses i18n routing for them", () => {
    expect(config.matcher).toContain("/api/auth/:path*");
    expect(bypassI18n("/api/auth/signin")).toBe(true);
    expect(bypassI18n("/dashboard")).toBe(false);
  });
});
