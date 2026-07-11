import { describe, it, expect, afterEach } from "vitest";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";

describe("env plugin", () => {
  afterEach(async () => {
    delete process.env.PORT;
    delete process.env.LOG_LEVEL;
    delete process.env.DATABASE_URL;
    delete process.env.DB_ENCRYPTION_KEY;
    delete process.env.CORS_ORIGIN;
    delete process.env.RATE_LIMIT_MAX;
    delete process.env.RATE_LIMIT_WINDOW;
    delete process.env.TRUSTED_PROXY_CIDRS;
  });

  it("loads with default values (NODE_ENV may be set by test runner)", async () => {
    // Clear the per-file DATABASE_URL injected by test/setup.ts to assert the
    // schema default is applied.
    delete process.env.DATABASE_URL;
    const app = await buildApp();
    expect(app.config.PORT).toBe(3000);
    expect(app.config.LOG_LEVEL).toBe("info");
    expect(app.config.DATABASE_URL).toBe("postgres://postgres:postgres@localhost:5432/portfolio");
    expect(app.config.DB_ENCRYPTION_KEY).toBe("");
    expect(app.config.CORS_ORIGIN).toBe("");
    expect(app.config.RATE_LIMIT_MAX).toBe(100);
    expect(app.config.RATE_LIMIT_WINDOW).toBe("1 minute");
    expect(app.config.TRUSTED_PROXY_CIDRS).toBe("");
    expect(app.config.MARKET_DATA_TTL_MS).toBe(900000);
    // Storage defaults
    expect(app.config.STORAGE_ENDPOINT).toBe("");
    expect(app.config.STORAGE_REGION).toBe("us-east-1");
    expect(app.config.STORAGE_BUCKET).toBe("screenshots");
    expect(app.config.STORAGE_ACCESS_KEY).toBe("");
    expect(app.config.STORAGE_SECRET_KEY).toBe("");
    expect(app.config.STORAGE_FORCE_PATH_STYLE).toBe(true);
    expect(app.config.STORAGE_SIGNED_URL_TTL).toBe(3600);
    await app.close();
    await closeDb();
  });

  it("respects environment variable overrides", async () => {
    process.env.PORT = "4000";
    process.env.LOG_LEVEL = "debug";

    const app = await buildApp();
    expect(app.config.PORT).toBe(4000);
    expect(app.config.LOG_LEVEL).toBe("debug");
    await app.close();
  });
});
