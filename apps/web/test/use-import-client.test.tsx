import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";

const api = {
  importScreenshot: vi.fn(async () => ({ importId: "i", drafts: [], contracts: [], errors: [] })),
  importCsv: vi.fn(async () => ({ importId: "i", drafts: [], contracts: [], errors: [] })),
  confirmImport: vi.fn(async () => ({ confirmed: 1 })),
  materializeImport: vi.fn(async () => ({ materializedCount: 1, excludedCashMovements: 0 })),
};
vi.mock("@/lib/api", () => ({ useApiClient: () => api }));

import { useImportClient } from "../src/lib/use-import-client";

describe("useImportClient", () => {
  beforeEach(() => {
    api.importScreenshot.mockClear();
    api.importCsv.mockClear();
    api.confirmImport.mockClear();
    api.materializeImport.mockClear();
  });

  it("forwards each call to the session-bound api client", async () => {
    const { result } = renderHook(() => useImportClient());
    const client = result.current;

    const file = new File([new Uint8Array([1])], "x.png", { type: "image/png" });
    await client.importScreenshot(file, true);
    expect(api.importScreenshot).toHaveBeenCalledWith(file, true);

    await client.importCsv("a,b", "auto", false);
    expect(api.importCsv).toHaveBeenCalledWith("a,b", "auto", false);

    await client.confirmImport("imp", [], [], "p1", true, false);
    expect(api.confirmImport).toHaveBeenCalledWith("imp", [], [], "p1", true, false);

    await client.materializeImport("imp", "p1", true);
    expect(api.materializeImport).toHaveBeenCalledWith("imp", "p1", true);
  });

  it("is memoised while the api client is stable", () => {
    const { result, rerender } = renderHook(() => useImportClient());
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
