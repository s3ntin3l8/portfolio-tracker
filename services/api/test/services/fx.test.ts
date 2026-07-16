import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { fxRates } from "@portfolio/db";
import { ensureDb, getDb, closeDb } from "../../src/db/client.js";
import {
  getFxRates,
  getFxRatesForDates,
  makeFxRateFn,
  HttpFxProvider,
  FrankfurterFxProvider,
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

describe("FrankfurterFxProvider", () => {
  it("reads the rate from the flat-array latest response", async () => {
    const fetchMock = (async () =>
      ({
        ok: true,
        json: async () => [{ date: "2026-06-16", base: "USD", quote: "IDR", rate: 16500 }],
      }) as Response) as typeof fetch;
    const p = new FrankfurterFxProvider("https://fx.example/v2", fetchMock);
    expect(await p.getRate("USD", "IDR")).toBe(16500);
  });

  it("maps a time-series response to { date: rate }", async () => {
    const fetchMock = (async () =>
      ({
        ok: true,
        json: async () => [
          { date: "2026-05-01", base: "USD", quote: "IDR", rate: 16000 },
          { date: "2026-05-02", base: "USD", quote: "IDR", rate: 16100 },
        ],
      }) as Response) as typeof fetch;
    const p = new FrankfurterFxProvider("https://fx.example/v2", fetchMock);
    expect(await p.getRateHistory("USD", "IDR", "2026-05-01", "2026-05-02")).toEqual({
      "2026-05-01": 16000,
      "2026-05-02": 16100,
    });
  });

  it("returns {} for a history request that errors", async () => {
    const fetchMock = (async () => ({ ok: false }) as Response) as typeof fetch;
    const p = new FrankfurterFxProvider("https://fx.example/v2", fetchMock);
    expect(await p.getRateHistory("USD", "IDR", "2026-05-01", "2026-05-02")).toEqual({});
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
    await db.insert(fxRates).values({ base: "USD", quote: "IDR", rate: "16000", date: today });
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

describe("getFxRatesForDates", () => {
  beforeAll(async () => {
    await ensureDb();
  });
  afterAll(async () => {
    await closeDb();
  });

  it("back-fills the range, persists it, and carries rates forward and back", async () => {
    const db = getDb();
    const wanted = ["2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05"];
    let calls = 0;
    const fxProvider: FxProvider = {
      getRate: async () => null,
      // Only the two middle days are returned (leading/trailing dates are gaps).
      getRateHistory: async () => {
        calls++;
        return { "2026-03-03": 16000, "2026-03-04": 16100 };
      },
    };

    const out = await getFxRatesForDates(db, ["SGD"], "IDR", wanted, fxProvider);
    expect(calls).toBe(1);
    expect(out.get("2026-03-02")?.SGD).toBe("16000"); // carry-back to earliest
    expect(out.get("2026-03-03")?.SGD).toBe("16000");
    expect(out.get("2026-03-04")?.SGD).toBe("16100");
    expect(out.get("2026-03-05")?.SGD).toBe("16100"); // carry-forward from last

    // The fetched days are persisted to fx_rates.
    const persisted = await db
      .select()
      .from(fxRates)
      .where(and(eq(fxRates.base, "SGD"), eq(fxRates.quote, "IDR")));
    expect(persisted.map((r) => r.date).sort()).toEqual(["2026-03-03", "2026-03-04"]);
  });

  it("serves fully-cached dates without calling the provider", async () => {
    const db = getDb();
    await db.insert(fxRates).values([
      { base: "JPY", quote: "IDR", rate: "105", date: "2026-04-01" },
      { base: "JPY", quote: "IDR", rate: "106", date: "2026-04-02" },
    ]);
    let called = false;
    const fxProvider: FxProvider = {
      getRate: async () => null,
      getRateHistory: async () => {
        called = true;
        return {};
      },
    };
    const out = await getFxRatesForDates(
      db,
      ["JPY"],
      "IDR",
      ["2026-04-01", "2026-04-02"],
      fxProvider,
    );
    expect(called).toBe(false);
    expect(out.get("2026-04-01")?.JPY).toBe("105");
    expect(out.get("2026-04-02")?.JPY).toBe("106");
  });

  it("returns empty per-date maps when every currency is the base", async () => {
    const out = await getFxRatesForDates(getDb(), ["IDR"], "IDR", ["2026-04-01"], null);
    expect(out.get("2026-04-01")).toEqual({});
  });
});
