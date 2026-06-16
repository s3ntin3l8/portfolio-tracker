import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { providerUsage } from "@portfolio/db";
import {
  resolveProviderConfig,
  goldSources,
  getMarketData,
  invalidateMarketData,
  flushUsage,
  getProviderUsage,
  type ProviderDescriptor,
} from "../../src/services/market-data.js";
import { ensureDb, getDb, closeDb } from "../../src/db/client.js";

// A deterministic registry so the merge can be tested without touching env/network.
const REGISTRY: ProviderDescriptor[] = [
  {
    id: "alpha",
    label: "Alpha",
    defaultPriority: 1,
    configured: () => true,
    create: () => ({}) as never,
  },
  {
    id: "beta",
    label: "Beta",
    defaultPriority: 2,
    configured: () => false, // e.g. missing API key
    create: () => ({}) as never,
  },
];

describe("resolveProviderConfig", () => {
  it("returns registry defaults (enabled, registration order) with no DB rows", () => {
    const resolved = resolveProviderConfig([], REGISTRY);
    expect(resolved).toEqual([
      { id: "alpha", label: "Alpha", configured: true, enabled: true, priority: 1 },
      { id: "beta", label: "Beta", configured: false, enabled: true, priority: 2 },
    ]);
  });

  it("applies a DB row that disables a provider", () => {
    const resolved = resolveProviderConfig(
      [{ provider: "alpha", enabled: false, priority: 1 }],
      REGISTRY,
    );
    expect(resolved.find((r) => r.id === "alpha")?.enabled).toBe(false);
  });

  it("reorders by the DB priority override (lower first)", () => {
    const resolved = resolveProviderConfig(
      [{ provider: "beta", enabled: true, priority: 0 }],
      REGISTRY,
    );
    expect(resolved.map((r) => r.id)).toEqual(["beta", "alpha"]);
  });

  it("reports configured=false for providers whose env key/url is absent", () => {
    expect(resolveProviderConfig([], REGISTRY).find((r) => r.id === "beta")?.configured).toBe(
      false,
    );
  });
});

describe("goldSources", () => {
  // alpha & gamma are gold sources; gamma is unconfigured, delta has no goldMarket.
  const GOLD_REGISTRY: ProviderDescriptor[] = [
    {
      id: "alpha",
      label: "Alpha buyback",
      defaultPriority: 1,
      goldMarket: "ALPHA",
      configured: () => true,
      create: () => ({}) as never,
    },
    {
      id: "gamma",
      label: "Gamma buyback",
      defaultPriority: 2,
      goldMarket: "GAMMA",
      configured: () => false, // env not set yet
      create: () => ({}) as never,
    },
    {
      id: "delta",
      label: "Delta spot",
      defaultPriority: 3,
      configured: () => true,
      create: () => ({}) as never,
    },
  ];

  it("returns only configured, enabled providers that declare a goldMarket", () => {
    expect(goldSources([], GOLD_REGISTRY)).toEqual([{ market: "ALPHA", label: "Alpha buyback" }]);
  });

  it("omits a gold source disabled via a DB row", () => {
    const rows = [{ provider: "alpha", enabled: false, priority: 1 }];
    expect(goldSources(rows, GOLD_REGISTRY)).toEqual([]);
  });

  it("orders sources by the effective priority", () => {
    const configuredGamma: ProviderDescriptor[] = GOLD_REGISTRY.map((d) =>
      d.id === "gamma" ? { ...d, configured: () => true } : d,
    );
    const rows = [{ provider: "gamma", enabled: true, priority: 0 }];
    expect(goldSources(rows, configuredGamma).map((s) => s.market)).toEqual(["GAMMA", "ALPHA"]);
  });

  it("exposes the real Antam and Galeri24 buyback sources (default registry)", () => {
    const sources = goldSources([]);
    expect(sources).toContainEqual({ market: "ANTAM", label: "Antam buyback" });
    expect(sources).toContainEqual({ market: "GALERI24", label: "Galeri24 buyback" });
  });
});

describe("getMarketData / invalidateMarketData", () => {
  it("caches the service and rebuilds after invalidation", async () => {
    const a = await getMarketData();
    const b = await getMarketData();
    expect(a).toBe(b);

    invalidateMarketData();
    const c = await getMarketData();
    expect(c).not.toBe(a);
  });
});

describe("usage tracking", () => {
  beforeAll(async () => {
    await ensureDb();
  });

  afterAll(async () => {
    await closeDb();
  });

  it("flushUsage counts the service's provider calls, rolling stale windows over", async () => {
    const db = getDb();
    // A stale row from a prior day/month should reset before this flush's counts are added.
    await db
      .insert(providerUsage)
      .values({
        provider: "fixture",
        day: "2000-01-01",
        callsDay: 999,
        month: "2000-01",
        callsMonth: 999,
      })
      .onConflictDoNothing();

    const svc = await getMarketData(); // fixture-only in tests, with the onCall hook wired
    const ref = {
      symbol: "BBCA",
      market: "IDX",
      assetClass: "equity" as const,
      currency: "IDR",
    };
    await svc.getQuote(ref);
    await svc.getQuote(ref);
    await flushUsage();

    const [row] = await db
      .select()
      .from(providerUsage)
      .where(eq(providerUsage.provider, "fixture"));
    const today = new Date().toISOString().slice(0, 10);
    expect(row?.day).toBe(today);
    expect(row?.callsDay).toBe(2); // reset from the stale 999, then +2
    expect(row?.callsMonth).toBe(2);
  });

  it("getProviderUsage falls back to the local counter for providers without a usage endpoint", async () => {
    process.env.ANTAM_BUYBACK_URL = "https://example.test/antam";
    try {
      const now = new Date();
      const day = now.toISOString().slice(0, 10);
      const month = now.toISOString().slice(0, 7);
      await getDb()
        .insert(providerUsage)
        .values({ provider: "antam", day, callsDay: 5, month, callsMonth: 5 })
        .onConflictDoUpdate({
          target: providerUsage.provider,
          set: { day, callsDay: 5, month, callsMonth: 5 },
        });

      invalidateMarketData(); // drop the 60s usage cache so this read recomputes
      const usage = await getProviderUsage();
      // Antam has no getUsage(), so it surfaces the local month counter (no plan limit).
      expect(usage.antam).toEqual({
        source: "local",
        window: "month",
        used: 5,
        limit: null,
      });
    } finally {
      delete process.env.ANTAM_BUYBACK_URL;
      invalidateMarketData();
    }
  });
});
