import { describe, it, expect } from "vitest";
import { buildApp } from "../../src/app.js";

describe("GET /health", () => {
  it("returns healthy status", async () => {
    const app = await buildApp();
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "healthy" });
    await app.close();
  });
});

describe("GET /ready", () => {
  it("returns ready when the database is reachable", async () => {
    const app = await buildApp();
    const response = await app.inject({ method: "GET", url: "/ready" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ready" });
    await app.close();
  });
});