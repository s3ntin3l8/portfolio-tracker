import { describe, it, expect } from "vitest";
import {
  resolveProviderConfig,
  getMarketData,
  invalidateMarketData,
  type ProviderDescriptor,
} from "../../src/services/market-data.js";

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
