import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { generateKeyPair, SignJWT } from "jose";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";

const ISSUER = "https://auth.test/application/o/portfolio/";
const AUDIENCE = "portfolio-tracker";
const ADMIN_GROUP = "portfolio-admins";

type App = Awaited<ReturnType<typeof buildApp>>;

let app: App;
let privateKey: CryptoKey;

// A signed token; pass `groups` to exercise the admin-group claim.
async function token(sub: string, groups?: string[]) {
  return new SignJWT({ email: `${sub}@example.com`, ...(groups ? { groups } : {}) })
    .setProtectedHeader({ alg: "ES256" })
    .setSubject(sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);
}

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

describe("admin provider config", () => {
  beforeAll(async () => {
    const kp = await generateKeyPair("ES256");
    privateKey = kp.privateKey;
    process.env.AUTHENTIK_ISSUER = ISSUER;
    process.env.AUTHENTIK_AUDIENCE = AUDIENCE;
    process.env.AUTHENTIK_ADMIN_GROUP = ADMIN_GROUP;
    process.env.RATE_LIMIT_MAX = "10000";
    app = await buildApp({ authKey: kp.publicKey });
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
    delete process.env.AUTHENTIK_ISSUER;
    delete process.env.AUTHENTIK_AUDIENCE;
    delete process.env.AUTHENTIK_ADMIN_GROUP;
    delete process.env.RATE_LIMIT_MAX;
  });

  it("derives isAdmin on /me from the group claim", async () => {
    const plain = await app.inject({
      method: "GET",
      url: "/me",
      headers: auth(await token("plain-user")),
    });
    expect(plain.json().isAdmin).toBe(false);

    const admin = await app.inject({
      method: "GET",
      url: "/me",
      headers: auth(await token("admin-user", [ADMIN_GROUP])),
    });
    expect(admin.json().isAdmin).toBe(true);
  });

  it("guards /admin/providers — 403 for non-admins, 200 for admins", async () => {
    const forbidden = await app.inject({
      method: "GET",
      url: "/admin/providers",
      headers: auth(await token("nobody")),
    });
    expect(forbidden.statusCode).toBe(403);

    const ok = await app.inject({
      method: "GET",
      url: "/admin/providers",
      headers: auth(await token("admin-1", [ADMIN_GROUP])),
    });
    expect(ok.statusCode).toBe(200);
    const list = ok.json() as { id: string; configured: boolean }[];
    // Every registry provider is listed; the keyless Yahoo fallback is always configured.
    expect(list.map((p) => p.id)).toContain("yahoo");
    expect(list.find((p) => p.id === "yahoo")?.configured).toBe(true);
  });

  it("rejects unauthenticated requests with 401", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/providers" });
    expect(res.statusCode).toBe(401);
  });

  it("PATCH upserts enable/priority and reflects it on the next GET", async () => {
    const t = await token("admin-2", [ADMIN_GROUP]);
    const patch = await app.inject({
      method: "PATCH",
      url: "/admin/providers",
      headers: auth(t),
      payload: [
        { id: "yahoo", enabled: false, priority: 0 },
        { id: "eodhd", enabled: true, priority: 9 },
      ],
    });
    expect(patch.statusCode).toBe(200);
    const after = patch.json() as { id: string; enabled: boolean; priority: number }[];
    expect(after.find((p) => p.id === "yahoo")?.enabled).toBe(false);
    // priority 0 sorts strictly ahead of the unchanged defaults (which start at 1).
    expect(after[0].id).toBe("yahoo");

    const get = await app.inject({
      method: "GET",
      url: "/admin/providers",
      headers: auth(t),
    });
    expect(
      (get.json() as { id: string; enabled: boolean }[]).find((p) => p.id === "yahoo")
        ?.enabled,
    ).toBe(false);
  });

  it("PATCH rejects unknown provider ids with 400", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/admin/providers",
      headers: auth(await token("admin-3", [ADMIN_GROUP])),
      payload: [{ id: "not-a-provider", enabled: true, priority: 1 }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "unknown_provider" });
  });

  it("PATCH is forbidden for non-admins", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/admin/providers",
      headers: auth(await token("intruder")),
      payload: [{ id: "yahoo", enabled: true, priority: 1 }],
    });
    expect(res.statusCode).toBe(403);
  });
});
