import { describe, it, expect, vi, beforeEach } from "vitest";
import { type JWT } from "next-auth/jwt";
import { type Account, type User } from "next-auth";

// Mock next-auth and providers so auth.ts imports cleanly
vi.mock("next-auth", () => ({
  default: vi.fn((config) => config),
}));
vi.mock("next-auth/providers/authentik", () => ({
  default: vi.fn(() => ({})),
}));

// Set required env vars before importing auth.ts
process.env.AUTH_SECRET = "test-secret-1234567890-test-secret-12345"; // pragma: allowlist secret
process.env.AUTHENTIK_ISSUER = "https://authentik.test";

import { authConfig } from "../src/auth";

describe("authConfig.callbacks.jwt", () => {
  const callbacks = authConfig.callbacks;
  if (!callbacks || !callbacks.jwt) {
    throw new Error("jwt callback must be defined");
  }
  const jwt = callbacks.jwt;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("stashes tokens on initial sign-in", async () => {
    const token = {} as JWT;
    const account = {
      access_token: "access-123",
      refresh_token: "refresh-123",
      expires_at: 10000,
    } as Account;

    const res = await jwt({ token, account, user: {} as User });
    expect(res?.accessToken).toBe("access-123");
    expect(res?.refreshToken).toBe("refresh-123");
    expect(res?.expiresAt).toBe(10000);
    expect(res?.error).toBeUndefined();
  });

  it("reuses token when it is comfortable before expiry", async () => {
    const token = {
      accessToken: "access-123",
      refreshToken: "refresh-123",
      expiresAt: Math.floor(Date.now() / 1000) + 120, // 120s from now (> 90s)
    } as JWT;

    const res = await jwt({ token, user: {} as User });
    expect(res).toBe(token);
    expect(res?.error).toBeUndefined();
  });

  it("sets RefreshTransientError on network failure during token refresh", async () => {
    const token = {
      accessToken: "access-123",
      refreshToken: "refresh-123",
      expiresAt: Math.floor(Date.now() / 1000) - 10, // expired
    } as JWT;

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const urlStr = String(url);
      if (urlStr.includes("openid-configuration")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ token_endpoint: "https://authentik.test/application/o/token/" }),
        } as Response;
      }
      if (urlStr.includes("application/o/token/")) {
        throw new TypeError("fetch failed");
      }
      return { ok: false, status: 404 } as Response;
    });

    const res = await jwt({ token, user: {} as User });
    expect(fetchSpy).toHaveBeenCalled();
    expect(res?.error).toBe("RefreshTransientError");
    // Ensure the old tokens are preserved, not deleted
    expect(res?.accessToken).toBe("access-123");
    expect(res?.refreshToken).toBe("refresh-123");

    fetchSpy.mockRestore();
  });

  it("sets RefreshTransientError on OIDC 5xx server failure during token refresh", async () => {
    const token = {
      accessToken: "access-123",
      refreshToken: "refresh-123",
      expiresAt: Math.floor(Date.now() / 1000) - 10,
    } as JWT;

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const urlStr = String(url);
      if (urlStr.includes("openid-configuration")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ token_endpoint: "https://authentik.test/application/o/token/" }),
        } as Response;
      }
      if (urlStr.includes("application/o/token/")) {
        return {
          ok: false,
          status: 503,
          json: async () => ({ error: "server_unavailable" }),
        } as Response;
      }
      return { ok: false, status: 404 } as Response;
    });

    const res = await jwt({ token, user: {} as User });
    expect(fetchSpy).toHaveBeenCalled();
    expect(res?.error).toBe("RefreshTransientError");
    expect(res?.accessToken).toBe("access-123");
    expect(res?.refreshToken).toBe("refresh-123");

    fetchSpy.mockRestore();
  });

  it("sets RefreshAccessTokenError on OIDC 4xx client failure during token refresh", async () => {
    const token = {
      accessToken: "access-123",
      refreshToken: "refresh-123",
      expiresAt: Math.floor(Date.now() / 1000) - 10,
    } as JWT;

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const urlStr = String(url);
      if (urlStr.includes("openid-configuration")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ token_endpoint: "https://authentik.test/application/o/token/" }),
        } as Response;
      }
      if (urlStr.includes("application/o/token/")) {
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: "invalid_grant" }),
        } as Response;
      }
      return { ok: false, status: 404 } as Response;
    });

    const res = await jwt({ token, user: {} as User });
    expect(fetchSpy).toHaveBeenCalled();
    expect(res?.error).toBe("RefreshAccessTokenError");

    fetchSpy.mockRestore();
  });
});
