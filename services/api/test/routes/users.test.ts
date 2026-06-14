import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { users } from "../../src/db/schema.js";

const tmpDir = path.join(
  os.tmpdir(),
  `users-test-${process.pid}-${crypto.randomBytes(4).toString("hex")}`,
);

describe("users route", () => {
  beforeAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.env.DATABASE_URL = `pglite://${tmpDir}`;
    process.env.DB_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64url");
  });

  afterAll(async () => {
    await closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.DATABASE_URL;
    delete process.env.DB_ENCRYPTION_KEY;
  });

  it("creates a user and returns decrypted notes", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/users",
      payload: { name: "Ada", email: "ada@example.com", notes: "top secret" },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ name: "Ada", email: "ada@example.com", notes: "top secret" });

    // Notes are stored encrypted at rest, not in plaintext.
    const [row] = await app.db.select().from(users);
    expect(row.notes).toMatch(/^enc:/);
    expect(row.notes).not.toContain("top secret");

    await app.close();
  });

  it("lists users with notes decrypted", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/users" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.length).toBeGreaterThan(0);
    expect(body[0].notes).toBe("top secret");
    await app.close();
  });

  it("rejects invalid payloads", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/users",
      payload: { name: "" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
