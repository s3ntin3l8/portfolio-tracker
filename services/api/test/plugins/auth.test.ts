import { describe, it, expect, vi, afterEach } from "vitest";
import type { JWTVerifyGetKey } from "jose";
import { createIssuerJwks } from "../../src/plugins/auth.js";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";

const ISSUER = "https://auth.test/application/o/portfolio/";
const WELL_KNOWN = `${ISSUER}.well-known/openid-configuration`;

function mockFetch(responder: (url: string) => { ok?: boolean; status?: number; body: unknown }) {
  return vi.fn(async (url: URL | string) => {
    const { ok = true, status = 200, body } = responder(String(url));
    return { ok, status, json: async () => body } as Response;
  }) as unknown as typeof fetch;
}

// A fake JWKS builder: never touches the network, records the JWKS URL it was handed,
// and returns a resolver yielding a dummy key.
function fakeJwksBuilder() {
  const urls: string[] = [];
  const build = vi.fn((jwksUri: URL): JWTVerifyGetKey => {
    urls.push(jwksUri.href);
    return (async () => ({ type: "public" })) as unknown as JWTVerifyGetKey;
  });
  return { build, urls };
}

const HEADER = { alg: "RS256", kid: "k1" } as const;
const call = (r: JWTVerifyGetKey) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Promise.resolve(r(HEADER as any, {} as any));

describe("createIssuerJwks", () => {
  it("discovers jwks_uri from the issuer's well-known endpoint", async () => {
    const fetchMock = mockFetch((url) => {
      expect(url).toBe(WELL_KNOWN);
      return { body: { jwks_uri: "https://auth.test/jwks/" } };
    });
    const { build, urls } = fakeJwksBuilder();
    const resolver = createIssuerJwks(ISSUER, fetchMock, build);

    await expect(call(resolver)).resolves.toEqual({ type: "public" });
    expect(urls).toEqual(["https://auth.test/jwks/"]);
  });

  it("appends the trailing slash when the issuer lacks one", async () => {
    let seen = "";
    const fetchMock = mockFetch((url) => {
      seen = url;
      return { ok: false, status: 404, body: {} };
    });
    const resolver = createIssuerJwks(
      "https://auth.test/application/o/portfolio",
      fetchMock,
      fakeJwksBuilder().build,
    );
    await expect(call(resolver)).rejects.toThrow("oidc_discovery_failed_404");
    expect(seen).toBe(WELL_KNOWN);
  });

  it("throws when the discovery document has no jwks_uri", async () => {
    const resolver = createIssuerJwks(
      ISSUER,
      mockFetch(() => ({ body: {} })),
      fakeJwksBuilder().build,
    );
    await expect(call(resolver)).rejects.toThrow("oidc_no_jwks_uri");
  });

  it("caches discovery — resolves the well-known and builds the JWKS only once", async () => {
    const fetchMock = mockFetch(() => ({
      body: { jwks_uri: "https://auth.test/jwks/" },
    }));
    const { build } = fakeJwksBuilder();
    const resolver = createIssuerJwks(ISSUER, fetchMock, build);

    await call(resolver);
    await call(resolver);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(build).toHaveBeenCalledTimes(1);
  });
});

describe("auth boot enforcement (issuer/audience)", () => {
  afterEach(async () => {
    delete process.env.AUTHENTIK_JWKS_URL;
    delete process.env.AUTHENTIK_ISSUER;
    delete process.env.AUTHENTIK_AUDIENCE;
    await closeDb();
  });

  it("refuses to start when a real key resolver is configured without audience", async () => {
    // Production-style config: a JWKS URL but no audience binding. Without an injected key
    // this must fail closed rather than validate tokens by signature alone.
    process.env.AUTHENTIK_JWKS_URL = "https://auth.test/jwks/";
    process.env.AUTHENTIK_ISSUER = ISSUER;
    // AUTHENTIK_AUDIENCE intentionally left unset.
    await expect(buildApp()).rejects.toThrow(/AUTHENTIK_AUDIENCE/);
  });

  it("starts when issuer and audience are both configured", async () => {
    process.env.AUTHENTIK_JWKS_URL = "https://auth.test/jwks/";
    process.env.AUTHENTIK_ISSUER = ISSUER;
    process.env.AUTHENTIK_AUDIENCE = "portfolio-tracker";
    const app = await buildApp();
    expect(app.authenticate).toBeTypeOf("function");
    await app.close();
  });
});
