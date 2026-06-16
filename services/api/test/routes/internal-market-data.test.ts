import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../../src/app.js";
import {
  upsertScrapedQuote,
  ANTAM_BUYBACK_KEY,
  GALERI24_BUYBACK_KEY,
  navKey,
} from "../../src/services/scrapers/store.js";
import type { FastifyInstance } from "fastify";

describe("internal market-data routes", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await upsertScrapedQuote(app.db, ANTAM_BUYBACK_KEY, 2591100, "harga-emas");
    await upsertScrapedQuote(app.db, GALERI24_BUYBACK_KEY, 2549000, "galeri24");
    await upsertScrapedQuote(app.db, navKey("RDPU"), 1234.56, "bibit");
  });

  afterAll(async () => {
    await app.close();
  });

  it("serves the cached Antam buyback in the provider's shape", async () => {
    const res = await app.inject({ method: "GET", url: "/internal/gold/antam-buyback" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ buyback: 2591100 });
  });

  it("serves the cached Galeri24 buyback in the provider's shape", async () => {
    const res = await app.inject({ method: "GET", url: "/internal/gold/galeri24-buyback" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ buyback: 2549000 });
  });

  it("serves a cached fund NAV by symbol", async () => {
    const res = await app.inject({ method: "GET", url: "/internal/nav/RDPU" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ nav: 1234.56 });
  });

  it("404s for an unknown fund symbol", async () => {
    const res = await app.inject({ method: "GET", url: "/internal/nav/UNKNOWN" });
    expect(res.statusCode).toBe(404);
  });

  it("does not require authentication", async () => {
    // No Authorization header → still 200 (these are the providers' own data source).
    const res = await app.inject({ method: "GET", url: "/internal/gold/antam-buyback" });
    expect(res.statusCode).toBe(200);
  });
});
