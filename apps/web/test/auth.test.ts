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

  describe("single-flight refresh (#613)", () => {
    // A dedicated openid-configuration + token-endpoint mock, counting only POSTs to
    // the token endpoint (the thing that must not double-fire for one refresh token).
    function mockTokenEndpoint(handler: (postCount: number) => Response | Promise<Response>): {
      fetchSpy: ReturnType<typeof vi.spyOn>;
      postCount: () => number;
    } {
      let posts = 0;
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
          posts += 1;
          return handler(posts);
        }
        return { ok: false, status: 404 } as Response;
      });
      return { fetchSpy, postCount: () => posts };
    }

    it("dedupes concurrent rotations sharing the same refresh token into one request", async () => {
      const refreshToken = "refresh-concurrent-1";
      const { fetchSpy, postCount } = mockTokenEndpoint(
        () =>
          ({
            ok: true,
            status: 200,
            json: async () => ({
              access_token: "access-rotated-1",
              expires_in: 300,
              refresh_token: "refresh-rotated-1",
            }),
          }) as Response,
      );

      const makeToken = () =>
        ({
          accessToken: "access-stale",
          refreshToken,
          expiresAt: Math.floor(Date.now() / 1000) - 10,
        }) as JWT;

      // Fire two callbacks concurrently (no await between them) — simulates the 60s
      // poll and a window-focus refetch (or a second tab) racing on the same cookie.
      const [resA, resB] = await Promise.all([
        jwt({ token: makeToken(), user: {} as User }),
        jwt({ token: makeToken(), user: {} as User }),
      ]);

      expect(postCount()).toBe(1);
      expect(resA?.accessToken).toBe("access-rotated-1");
      expect(resB?.accessToken).toBe("access-rotated-1");
      expect(resA?.refreshToken).toBe("refresh-rotated-1");
      expect(resB?.refreshToken).toBe("refresh-rotated-1");
      expect(resA?.error).toBeUndefined();
      expect(resB?.error).toBeUndefined();

      fetchSpy.mockRestore();
    });

    it("lets a straggler reuse a just-completed rotation instead of re-spending the old token", async () => {
      const refreshToken = "refresh-straggler-1";
      const { fetchSpy, postCount } = mockTokenEndpoint(
        () =>
          ({
            ok: true,
            status: 200,
            json: async () => ({
              access_token: "access-rotated-2",
              expires_in: 300,
              refresh_token: "refresh-rotated-2",
            }),
          }) as Response,
      );

      const makeToken = () =>
        ({
          accessToken: "access-stale",
          refreshToken,
          expiresAt: Math.floor(Date.now() / 1000) - 10,
        }) as JWT;

      const first = await jwt({ token: makeToken(), user: {} as User });
      expect(postCount()).toBe(1);
      expect(first?.accessToken).toBe("access-rotated-2");

      // A straggler request that still holds the pre-rotation cookie (same old
      // refreshToken) arrives shortly after — it must join the cached result, not
      // fire a second POST with the now-dead refresh token.
      const straggler = await jwt({ token: makeToken(), user: {} as User });
      expect(postCount()).toBe(1);
      expect(straggler?.accessToken).toBe("access-rotated-2");
      expect(straggler?.refreshToken).toBe("refresh-rotated-2");

      fetchSpy.mockRestore();
    });

    it("evicts a failed rotation immediately so the next call can retry", async () => {
      const refreshToken = "refresh-retry-1";
      const { fetchSpy, postCount } = mockTokenEndpoint((count) =>
        count === 1
          ? ({ ok: false, status: 400, json: async () => ({ error: "invalid_grant" }) } as Response)
          : ({
              ok: true,
              status: 200,
              json: async () => ({
                access_token: "access-rotated-3",
                expires_in: 300,
                refresh_token: "refresh-rotated-3",
              }),
            } as Response),
      );

      const makeToken = () =>
        ({
          accessToken: "access-stale",
          refreshToken,
          expiresAt: Math.floor(Date.now() / 1000) - 10,
        }) as JWT;

      const failed = await jwt({ token: makeToken(), user: {} as User });
      expect(postCount()).toBe(1);
      expect(failed?.error).toBe("RefreshAccessTokenError");

      // Not cached as a poison result — a later call with the same (still-live, since
      // the failed attempt never rotated it away) refresh token retries.
      const retried = await jwt({ token: makeToken(), user: {} as User });
      expect(postCount()).toBe(2);
      expect(retried?.accessToken).toBe("access-rotated-3");
      expect(retried?.error).toBeUndefined();

      fetchSpy.mockRestore();
    });
  });
});
