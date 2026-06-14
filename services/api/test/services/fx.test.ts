import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fxRates } from "@portfolio/db";
import { ensureDb, getDb, closeDb } from "../../src/db/client.js";
import {
  getFxRates,
  makeFxRateFn,
  HttpFxProvider,
  type FxProvider,
} from "../../src/services/fx.js";

describe("makeFxRateFn", () => {
  it("returns 1 for same currency and known foreign rates to base", () => {
    const fx = makeFxRateFn({ USD: "16000" }, "IDR");
    expect(fx("IDR", "IDR")).toBe("1");
    expect(fx("USD", "IDR")).toBe("16000");
    expect(fx("EUR", "IDR")).toBe("1"); // unknown → unconverted
  });
});

describe("HttpFxProvider", () => {
  it("reads rates.<to> from the response", async () => {
    const fetchMock = (async () =>
      ({ ok: true, json: async () => ({ rates: { IDR: 16500 } }) }) as Response) as typeof fetch;
    const p = new HttpFxProvider("https://fx.example/latest", fetchMock);
    expect(await p.getRate("USD", "IDR")).toBe(16500);
  });

  it("returns null on a failed request", async () => {
    const fetchMock = (async () => ({ ok: false }) as Response) as typeof fetch;
    const p = new HttpFxProvider("https://fx.example/latest", fetchMock);
    expect(await p.getRate("USD", "IDR")).toBeNull();
  });
});

describe("getFxRates", () => {
  beforeAll(async () => {
    await ensureDb();
  });
  afterAll(async () => {
    await closeDb();
  });

  const today = new Date().toISOString().slice(0, 10);
  const provider = (rate: number): FxProvider => ({
    getRate: async () => rate,
  });

  it("returns an empty map when every currency is the base", async () => {
    const out = await getFxRates(getDb(), ["IDR", "IDR"], "IDR", new Date(), null);
    expect(out).toEqual({});
  });

  it("serves a cached rate without calling the provider", async () => {
    const db = getDb();
    await db
      .insert(fxRates)
      .values({ base: "USD", quote: "IDR", rate: "16000", date: today });
    let called = false;
    const out = await getFxRates(db, ["USD"], "IDR", new Date(), {
      getRate: async () => {
        called = true;
        return 1;
      },
    });
    expect(out.USD).toBe("16000");
    expect(called).toBe(false);
  });

  it("back-fills a missing rate via the provider and caches it", async () => {
    const db = getDb();
    const out = await getFxRates(db, ["EUR"], "IDR", new Date(), provider(17500));
    expect(out.EUR).toBe("17500");
    const [row] = await db.select().from(fxRates);
    expect(
      (await db.select().from(fxRates)).some(
        (r) => r.base === "EUR" && r.quote === "IDR" && r.rate === "17500",
      ),
    ).toBe(true);
    expect(row).toBeDefined();
  });
});
