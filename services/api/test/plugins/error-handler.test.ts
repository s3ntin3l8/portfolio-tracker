import { describe, it, expect } from "vitest";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";

describe("global error handler", () => {
  it("masks internal error details on an unhandled 5xx (no driver/message text leaked)", async () => {
    const app = await buildApp();
    app.get("/__test_boom", async () => {
      throw new Error('duplicate key value violates unique constraint "documents_storage_key_idx"');
    });
    const res = await app.inject({ method: "GET", url: "/__test_boom" });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "internal_error" });
    await app.close();
    await closeDb();
  });

  it("also masks an explicit statusCode >= 500", async () => {
    const app = await buildApp();
    app.get("/__test_bad_gateway", async () => {
      const err = new Error("upstream provider timed out at 10.0.0.5:443") as Error & {
        statusCode: number;
      };
      err.statusCode = 502;
      throw err;
    });
    const res = await app.inject({ method: "GET", url: "/__test_bad_gateway" });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: "internal_error" });
    await app.close();
    await closeDb();
  });

  it("keeps explicit 4xx error messages intact", async () => {
    const app = await buildApp();
    app.get("/__test_teapot", async () => {
      const err = new Error("not a teapot after all") as Error & { statusCode: number };
      err.statusCode = 418;
      throw err;
    });
    const res = await app.inject({ method: "GET", url: "/__test_teapot" });
    expect(res.statusCode).toBe(418);
    expect(res.json()).toEqual({ error: "not a teapot after all" });
    await app.close();
    await closeDb();
  });
});
