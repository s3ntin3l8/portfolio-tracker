import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { generateKeyPair, SignJWT } from "jose";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";

const ISSUER = "https://auth.test/application/o/portfolio/";
const AUDIENCE = "portfolio-tracker";

type App = Awaited<ReturnType<typeof buildApp>>;

let app: App;
let privateKey: CryptoKey;

async function token(sub: string, email = `${sub}@example.com`) {
  return new SignJWT({ email })
    .setProtectedHeader({ alg: "ES256" })
    .setSubject(sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);
}

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

describe("account holders", () => {
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

  it("creates, lists, updates and deletes a holder scoped to the user", async () => {
    const t = await token("ah-crud");

    // Create.
    const created = await app.inject({
      method: "POST",
      url: "/account-holders",
      headers: auth(t),
      payload: { name: "Emma", type: "child", birthYear: 2017 },
    });
    expect(created.statusCode).toBe(201);
    const holder = created.json();
    expect(holder).toMatchObject({ name: "Emma", type: "child", birthYear: 2017 });

    // List.
    const list = await app.inject({ method: "GET", url: "/account-holders", headers: auth(t) });
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0].id).toBe(holder.id);

    // Update.
    const updated = await app.inject({
      method: "PATCH",
      url: `/account-holders/${holder.id}`,
      headers: auth(t),
      payload: { name: "Emma R.", birthYear: 2018 },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ name: "Emma R.", type: "child", birthYear: 2018 });

    // Delete.
    const deleted = await app.inject({
      method: "DELETE",
      url: `/account-holders/${holder.id}`,
      headers: auth(t),
    });
    expect(deleted.statusCode).toBe(204);
    const after = await app.inject({ method: "GET", url: "/account-holders", headers: auth(t) });
    expect(after.json()).toHaveLength(0);
  });

  it("defaults the type to 'other' and the birth year to null", async () => {
    const t = await token("ah-defaults");
    const created = await app.inject({
      method: "POST",
      url: "/account-holders",
      headers: auth(t),
      payload: { name: "Someone" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ name: "Someone", type: "other", birthYear: null });
  });

  it("does not expose or mutate another user's holders", async () => {
    const owner = await token("ah-owner");
    const intruder = await token("ah-intruder");
    const holder = (
      await app.inject({
        method: "POST",
        url: "/account-holders",
        headers: auth(owner),
        payload: { name: "Private", type: "self" },
      })
    ).json();

    // Not listed for the intruder.
    const list = await app.inject({
      method: "GET",
      url: "/account-holders",
      headers: auth(intruder),
    });
    expect(list.json()).toHaveLength(0);

    // Cannot patch or delete it.
    const patch = await app.inject({
      method: "PATCH",
      url: `/account-holders/${holder.id}`,
      headers: auth(intruder),
      payload: { name: "Hacked" },
    });
    expect(patch.statusCode).toBe(404);
    const del = await app.inject({
      method: "DELETE",
      url: `/account-holders/${holder.id}`,
      headers: auth(intruder),
    });
    expect(del.statusCode).toBe(404);
  });

  it("unassigns a holder from its portfolios when deleted (set null)", async () => {
    const t = await token("ah-setnull");
    const holder = (
      await app.inject({
        method: "POST",
        url: "/account-holders",
        headers: auth(t),
        payload: { name: "Kid", type: "child", birthYear: 2015 },
      })
    ).json();
    const portfolioId = (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "Kid Depot", baseCurrency: "idr", accountHolderId: holder.id },
      })
    ).json().id;

    // Sanity: the portfolio derives child + birth year from the holder.
    const before = await app.inject({ method: "GET", url: "/portfolios", headers: auth(t) });
    expect(before.json().find((p: { id: string }) => p.id === portfolioId)).toMatchObject({
      accountHolderId: holder.id,
      portfolioType: "child",
      birthYear: 2015,
    });

    // Deleting the holder leaves the portfolio but unassigns it.
    const del = await app.inject({
      method: "DELETE",
      url: `/account-holders/${holder.id}`,
      headers: auth(t),
    });
    expect(del.statusCode).toBe(204);

    const after = await app.inject({ method: "GET", url: "/portfolios", headers: auth(t) });
    const pf = after.json().find((p: { id: string }) => p.id === portfolioId);
    expect(pf).toMatchObject({
      accountHolderId: null,
      accountHolder: null,
      portfolioType: "standard",
      birthYear: null,
    });
  });

  describe("loss carry-forward", () => {
    async function makeHolder(t: string, name = "LCF Holder") {
      const created = await app.inject({
        method: "POST",
        url: "/account-holders",
        headers: auth(t),
        payload: { name, type: "self" },
      });
      return created.json().id as string;
    }

    it("requires a taxYear on GET", async () => {
      const t = await token("lcf-noyear");
      const holderId = await makeHolder(t);
      const res = await app.inject({
        method: "GET",
        url: `/account-holders/${holderId}/loss-carryforward`,
        headers: auth(t),
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns an empty entry set before anything is seeded", async () => {
      const t = await token("lcf-empty");
      const holderId = await makeHolder(t);
      const res = await app.inject({
        method: "GET",
        url: `/account-holders/${holderId}/loss-carryforward?taxYear=2025`,
        headers: auth(t),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ taxYear: 2025, entries: [] });
    });

    it("seeds both pots atomically via PUT, and GET reflects them", async () => {
      const t = await token("lcf-seed");
      const holderId = await makeHolder(t);
      const put = await app.inject({
        method: "PUT",
        url: `/account-holders/${holderId}/loss-carryforward`,
        headers: auth(t),
        payload: {
          taxYear: 2025,
          entries: [
            { pot: "stock", amount: "500" },
            { pot: "general", amount: "120.50" },
          ],
        },
      });
      expect(put.statusCode).toBe(200);
      const entries = put
        .json()
        .entries.sort((a: { pot: string }, b: { pot: string }) => a.pot.localeCompare(b.pot));
      expect(entries).toEqual([
        { pot: "general", amount: "120.50" },
        { pot: "stock", amount: "500" },
      ]);

      const get = await app.inject({
        method: "GET",
        url: `/account-holders/${holderId}/loss-carryforward?taxYear=2025`,
        headers: auth(t),
      });
      expect(get.json().entries).toHaveLength(2);
    });

    it("PUT replaces the whole set for that year (delete-then-insert, not merge)", async () => {
      const t = await token("lcf-replace");
      const holderId = await makeHolder(t);
      await app.inject({
        method: "PUT",
        url: `/account-holders/${holderId}/loss-carryforward`,
        headers: auth(t),
        payload: { taxYear: 2025, entries: [{ pot: "stock", amount: "500" }] },
      });
      const second = await app.inject({
        method: "PUT",
        url: `/account-holders/${holderId}/loss-carryforward`,
        headers: auth(t),
        payload: { taxYear: 2025, entries: [{ pot: "general", amount: "80" }] },
      });
      expect(second.json().entries).toEqual([{ pot: "general", amount: "80" }]);
    });

    it("keeps different tax years independent", async () => {
      const t = await token("lcf-years");
      const holderId = await makeHolder(t);
      await app.inject({
        method: "PUT",
        url: `/account-holders/${holderId}/loss-carryforward`,
        headers: auth(t),
        payload: { taxYear: 2024, entries: [{ pot: "stock", amount: "100" }] },
      });
      await app.inject({
        method: "PUT",
        url: `/account-holders/${holderId}/loss-carryforward`,
        headers: auth(t),
        payload: { taxYear: 2025, entries: [{ pot: "stock", amount: "999" }] },
      });
      const y2024 = await app.inject({
        method: "GET",
        url: `/account-holders/${holderId}/loss-carryforward?taxYear=2024`,
        headers: auth(t),
      });
      expect(y2024.json().entries).toEqual([{ pot: "stock", amount: "100" }]);
    });

    it("rejects a duplicate pot in the same PUT payload", async () => {
      const t = await token("lcf-dup");
      const holderId = await makeHolder(t);
      const res = await app.inject({
        method: "PUT",
        url: `/account-holders/${holderId}/loss-carryforward`,
        headers: auth(t),
        payload: {
          taxYear: 2025,
          entries: [
            { pot: "stock", amount: "100" },
            { pot: "stock", amount: "200" },
          ],
        },
      });
      expect(res.statusCode).toBe(400);
    });

    it("404s for a holder that doesn't belong to the requesting user", async () => {
      const owner = await token("lcf-owner");
      const intruder = await token("lcf-intruder");
      const holderId = await makeHolder(owner);

      const get = await app.inject({
        method: "GET",
        url: `/account-holders/${holderId}/loss-carryforward?taxYear=2025`,
        headers: auth(intruder),
      });
      expect(get.statusCode).toBe(404);

      const put = await app.inject({
        method: "PUT",
        url: `/account-holders/${holderId}/loss-carryforward`,
        headers: auth(intruder),
        payload: { taxYear: 2025, entries: [{ pot: "stock", amount: "100" }] },
      });
      expect(put.statusCode).toBe(404);
    });

    it("404s for a nonexistent holder", async () => {
      const t = await token("lcf-missing");
      const res = await app.inject({
        method: "PUT",
        url: "/account-holders/00000000-0000-0000-0000-000000000000/loss-carryforward",
        headers: auth(t),
        payload: { taxYear: 2025, entries: [] },
      });
      expect(res.statusCode).toBe(404);
    });
  });
});
