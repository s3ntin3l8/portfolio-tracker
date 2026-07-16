import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { generateKeyPair, SignJWT } from "jose";
import { eq } from "drizzle-orm";
import { users, apiTokens } from "@portfolio/db";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { hashToken, PAT_PREFIX } from "../../src/plugins/auth.js";

const ISSUER = "https://auth.test/application/o/portfolio/";
const AUDIENCE = "portfolio-tracker";

type App = Awaited<ReturnType<typeof buildApp>>;
let app: App;
let privateKey: CryptoKey;

async function jwt(sub: string) {
  return new SignJWT({ email: `${sub}@example.com` })
    .setProtectedHeader({ alg: "ES256" })
    .setSubject(sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);
}

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

/** Mint a PAT via the API and return its plaintext secret. */
async function mintPat(
  ownerJwt: string,
  body: { name: string; scope?: "read" | "write"; expiresInDays?: number },
) {
  const res = await app.inject({
    method: "POST",
    url: "/me/tokens",
    headers: auth(ownerJwt),
    payload: body,
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; token: string; scope: string };
}

describe("/me/tokens (personal access tokens)", () => {
  beforeAll(async () => {
    const kp = await generateKeyPair("ES256");
    privateKey = kp.privateKey;
    process.env.AUTHENTIK_ISSUER = ISSUER;
    process.env.AUTHENTIK_AUDIENCE = AUDIENCE;
    process.env.RATE_LIMIT_MAX = "10000";
    app = await buildApp({ authKey: kp.publicKey });
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
    delete process.env.AUTHENTIK_ISSUER;
    delete process.env.AUTHENTIK_AUDIENCE;
    delete process.env.RATE_LIMIT_MAX;
  });

  it("creates a token (returning the secret once) and lists metadata only", async () => {
    const t = await jwt("pat-create");
    const created = await mintPat(t, { name: "dev-cli", scope: "read" });

    expect(created.token.startsWith(PAT_PREFIX)).toBe(true);
    expect(created.scope).toBe("read");

    const list = await app.inject({ method: "GET", url: "/me/tokens", headers: auth(t) });
    expect(list.statusCode).toBe(200);
    const rows = list.json() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    // The secret and its hash must never appear in list/metadata responses.
    expect(rows[0]).not.toHaveProperty("token");
    expect(rows[0]).not.toHaveProperty("tokenHash");
    expect(rows[0].name).toBe("dev-cli");
    expect(typeof rows[0].tokenPrefix).toBe("string");
  });

  it("authenticates API calls as the owning user and stamps lastUsedAt", async () => {
    const t = await jwt("pat-use");
    const { token } = await mintPat(t, { name: "reader", scope: "read" });

    const me = await app.inject({ method: "GET", url: "/me", headers: auth(token) });
    expect(me.statusCode).toBe(200);
    expect(me.json().authSub).toBe("pat-use");
    // PATs never carry admin.
    expect(me.json().isAdmin).toBe(false);

    const list = await app.inject({ method: "GET", url: "/me/tokens", headers: auth(t) });
    expect(list.json()[0].lastUsedAt).not.toBeNull();
  });

  it("rejects mutating requests from a read-scoped token (403 read_only_token)", async () => {
    const t = await jwt("pat-readonly");
    const { token } = await mintPat(t, { name: "ro", scope: "read" });

    // GET is allowed...
    const get = await app.inject({ method: "GET", url: "/portfolios", headers: auth(token) });
    expect(get.statusCode).toBe(200);

    // ...but a write is blocked before reaching the handler.
    const post = await app.inject({
      method: "POST",
      url: "/portfolios",
      headers: auth(token),
      payload: { name: "x", baseCurrency: "EUR" },
    });
    expect(post.statusCode).toBe(403);
    expect(post.json().error).toBe("read_only_token");
  });

  it("forbids minting a PAT with a PAT, even a write-scoped one", async () => {
    const t = await jwt("pat-no-mint");
    const { token } = await mintPat(t, { name: "writer", scope: "write" });

    const res = await app.inject({
      method: "POST",
      url: "/me/tokens",
      headers: auth(token),
      payload: { name: "nested", scope: "write" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("interactive_session_required");
  });

  it("never grants admin access to a write-scoped PAT", async () => {
    const t = await jwt("pat-not-admin");
    const { token } = await mintPat(t, { name: "writer", scope: "write" });

    const res = await app.inject({ method: "GET", url: "/admin/stats", headers: auth(token) });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("forbidden");
  });

  it("rejects an unknown token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/me",
      headers: auth(`${PAT_PREFIX}does-not-exist`),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("invalid_token");
  });

  it("rejects an expired token", async () => {
    const t = await jwt("pat-expired");
    // Create the user, then plant an already-expired token row directly.
    await app.inject({ method: "GET", url: "/me", headers: auth(t) });
    const [u] = await app.db.select().from(users).where(eq(users.authSub, "pat-expired")).limit(1);
    const secret = `${PAT_PREFIX}expired-secret`;
    await app.db.insert(apiTokens).values({
      userId: u.id,
      name: "old",
      tokenHash: hashToken(secret),
      tokenPrefix: secret.slice(0, 12),
      scope: "read",
      expiresAt: new Date(Date.now() - 1000),
    });

    const res = await app.inject({ method: "GET", url: "/me", headers: auth(secret) });
    expect(res.statusCode).toBe(401);
  });

  it("revokes a token (then it no longer authenticates) — scoped to the owner", async () => {
    const owner = await jwt("pat-owner");
    const other = await jwt("pat-other");
    const { id, token } = await mintPat(owner, { name: "revoke-me", scope: "read" });

    // A different user cannot delete it.
    const foreign = await app.inject({
      method: "DELETE",
      url: `/me/tokens/${id}`,
      headers: auth(other),
    });
    expect(foreign.statusCode).toBe(404);

    // The owner can.
    const del = await app.inject({
      method: "DELETE",
      url: `/me/tokens/${id}`,
      headers: auth(owner),
    });
    expect(del.statusCode).toBe(204);

    // The revoked secret no longer works.
    const after = await app.inject({ method: "GET", url: "/me", headers: auth(token) });
    expect(after.statusCode).toBe(401);
  });
});
