import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { generateKeyPair, SignJWT } from "jose";
import { eq } from "drizzle-orm";
import { users } from "@portfolio/db";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";

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

describe("POST /me/onboarding/complete", () => {
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

  it("rejects unauthenticated requests with 401", async () => {
    const res = await app.inject({ method: "POST", url: "/me/onboarding/complete" });
    expect(res.statusCode).toBe(401);
  });

  it("is null for a freshly-registered user, then set after completion", async () => {
    const t = await jwt("onboarding-flag-test");

    const before = await app.inject({ method: "GET", url: "/me", headers: auth(t) });
    expect(before.statusCode).toBe(200);
    expect((before.json() as { onboardingCompletedAt: string | null }).onboardingCompletedAt).toBe(
      null,
    );

    const res = await app.inject({
      method: "POST",
      url: "/me/onboarding/complete",
      headers: auth(t),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { onboardingCompletedAt: string | null };
    expect(body.onboardingCompletedAt).not.toBeNull();

    const after = await app.inject({ method: "GET", url: "/me", headers: auth(t) });
    expect((after.json() as { onboardingCompletedAt: string | null }).onboardingCompletedAt).toBe(
      body.onboardingCompletedAt,
    );

    const [row] = await app.db
      .select()
      .from(users)
      .where(eq(users.authSub, "onboarding-flag-test"));
    await app.db.delete(users).where(eq(users.id, row.id));
  });
});
