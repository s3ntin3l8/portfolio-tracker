import { describe, it, expect, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { EncryptionService } from "../../src/services/encryption.js";

const tmpDb = path.join(os.tmpdir(), `db-plugin-test-${process.pid}.db`);

describe("db plugin", () => {
  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  it("decorates the app with db and encryption and runs migrations", async () => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;

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
