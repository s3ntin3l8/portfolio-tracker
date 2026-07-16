import { describe, it, expect } from "vitest";
import { buildApp } from "../../src/app.js";

describe("GET /", () => {
  it("returns hello message", async () => {
    const app = await buildApp();
    const response = await app.inject({ method: "GET", url: "/" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ message: "Hello World" });
    await app.close();
  });
});
