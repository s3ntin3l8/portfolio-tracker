import { describe, it, expect, afterAll } from "vitest";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { EncryptionService } from "../../src/services/encryption.js";

describe("db plugin", () => {
  afterAll(async () => {
    await closeDb();
  });

  it("decorates the app with db and encryption and runs migrations", async () => {
    const app = await buildApp();
    expect(app.db).toBeDefined();
    expect(app.encryption).toBeInstanceOf(EncryptionService);

    // Migrations ran at startup, so the users table is queryable.
    const res = await app.inject({ method: "GET", url: "/users" });
    expect(res.statusCode).toBe(200);

    // Closing the app tears down the DB without throwing.
    await expect(app.close()).resolves.not.toThrow();
  });
});
