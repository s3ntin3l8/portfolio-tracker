import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useTransactionBanners } from "../src/components/transactions-table/hooks";
import type { TxRow } from "../src/components/transactions-table";

function row(overrides: Partial<TxRow> & { type: string; executedAt: string }): TxRow {
  return {
    id: Math.random().toString(36).slice(2),
    portfolioId: "p1",
    quantity: "0",
    price: "0",
    fees: "0",
    tax: null,
    fxRate: null,
    currency: "IDR",
    source: "manual",
    instrument: null,
    ...overrides,
  } as TxRow;
}

const tBanner = (key: string) => `banner:${key}`;

const rows: TxRow[] = [
  row({ type: "buy", quantity: "10", price: "100", executedAt: "2026-06-01T00:00:00Z" }),
  row({ type: "sell", quantity: "5", price: "50", executedAt: "2026-05-01T00:00:00Z" }),
  row({ type: "dividend", price: "1000", executedAt: "2026-01-15T00:00:00Z" }),
];

describe("useTransactionBanners", () => {
  it("returns null for all banners when mode is null", () => {
    const { result } = renderHook(() =>
      useTransactionBanners(null, null, [], "IDR", "en", tBanner),
    );
    expect(result.current.allBanner).toBeNull();
    expect(result.current.incomeBanner).toBeNull();
    expect(result.current.tradeBanner).toBeNull();
  });

  describe("allBanner", () => {
    it("delegates to computeAllBanner when summary is null", () => {
      const { result } = renderHook(() =>
        useTransactionBanners("all", null, rows, "IDR", "en", tBanner),
      );
      expect(result.current.allBanner).not.toBeNull();
      expect(result.current.allBanner!.mix.length).toBeGreaterThan(0);
    });

    it("builds tiles from summary totals and leaves mix empty", () => {
      const summary = { totalInvested: "50000", totalProceeds: "30000", totalIncome: "5000" };
      const { result } = renderHook(() =>
        useTransactionBanners("all", summary, rows, "EUR", "de", tBanner, undefined),
      );
      const b = result.current.allBanner!;
      expect(b.mix.length).toBe(0);
      expect(b.tiles.length).toBe(3);
      expect(b.tiles[0].value).toContain("50.000");
    });

    it("shows em dash for tile values when a summary field is null", () => {
      const summary = { totalInvested: null, totalProceeds: "0", totalIncome: null } as unknown as {
        totalInvested: string;
        totalProceeds: string;
        totalIncome: string;
      };
      const { result } = renderHook(() =>
        useTransactionBanners("all", summary, rows, "EUR", "de", tBanner, undefined),
      );
      const b = result.current.allBanner!;
      expect(b.tiles[0].value).toBe("—");
      expect(b.tiles[1].value).not.toBe("—");
      expect(b.tiles[2].value).toBe("—");
    });

    it("returns null when mode is not all", () => {
      const { result } = renderHook(() =>
        useTransactionBanners("buy", null, rows, "IDR", "en", tBanner),
      );
      expect(result.current.allBanner).toBeNull();
    });
  });

  describe("incomeBanner", () => {
    it("delegates to computeIncomeBanner when mode is income", () => {
      const { result } = renderHook(() =>
        useTransactionBanners("income", null, rows, "IDR", "en", tBanner),
      );
      expect(result.current.incomeBanner).not.toBeNull();
    });

    it("returns null when mode is not income", () => {
      const { result } = renderHook(() =>
        useTransactionBanners("all", null, rows, "IDR", "en", tBanner),
      );
      expect(result.current.incomeBanner).toBeNull();
    });
  });

  describe("tradeBanner", () => {
    it("delegates to computeTradeBanner when summary is null", () => {
      const { result } = renderHook(() =>
        useTransactionBanners("buy", null, rows, "IDR", "en", tBanner),
      );
      const b = result.current.tradeBanner!;
      expect(b.avg).not.toBe("—");
      expect(b.bySymbol.length).toBeGreaterThan(0);
    });

    it("uses summary total and row-computed avg/bySymbol when summary is present", () => {
      const summary = { totalInvested: "50000", totalProceeds: "30000", totalIncome: "5000" };
      const { result } = renderHook(() =>
        useTransactionBanners("buy", summary, rows, "EUR", "de", tBanner),
      );
      const b = result.current.tradeBanner!;
      expect(b.total).toContain("50.000");
      expect(b.avg).not.toBe("—");
      expect(b.bySymbol.length).toBeGreaterThan(0);
    });

    it("falls back to placeholder when summary has total but no matching rows", () => {
      const summary = { totalInvested: "50000", totalProceeds: "30000", totalIncome: "5000" };
      const empty: TxRow[] = [];
      const { result } = renderHook(() =>
        useTransactionBanners("buy", summary, empty, "EUR", "de", tBanner),
      );
      const b = result.current.tradeBanner!;
      expect(b.total).toContain("50.000");
      expect(b.avg).toBe("—");
      expect(b.bySymbol).toEqual([]);
    });

    it("returns null when mode is not buy/sell", () => {
      const { result } = renderHook(() =>
        useTransactionBanners("all", null, rows, "IDR", "en", tBanner),
      );
      expect(result.current.tradeBanner).toBeNull();
    });
  });
});
