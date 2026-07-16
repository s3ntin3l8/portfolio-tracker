import { describe, it, expect } from "vitest";
import { parsePagination, paginate, cacheKey } from "../../src/routes/helpers.js";

describe("parsePagination", () => {
  it("returns page=1, pageSize=0 when no page param given", () => {
    expect(parsePagination({})).toEqual({ page: 1, pageSize: 0 });
  });

  it("parses page and pageSize from string query params", () => {
    expect(parsePagination({ page: "3", pageSize: "50" })).toEqual({ page: 3, pageSize: 50 });
  });

  it("clamps page to at least 1", () => {
    expect(parsePagination({ page: "0" })).toEqual({ page: 1, pageSize: 25 });
    expect(parsePagination({ page: "-5" })).toEqual({ page: 1, pageSize: 25 });
  });

  it("clamps pageSize to max 100", () => {
    expect(parsePagination({ page: "1", pageSize: "200" })).toEqual({ page: 1, pageSize: 100 });
  });

  it("defaults pageSize to 25 when absent but page is given", () => {
    expect(parsePagination({ page: "2" })).toEqual({ page: 2, pageSize: 25 });
  });

  it("falls back to defaults on NaN input", () => {
    expect(parsePagination({ page: "abc" })).toEqual({ page: 1, pageSize: 25 });
    expect(parsePagination({ page: "abc", pageSize: "xyz" })).toEqual({ page: 1, pageSize: 25 });
  });

  it("treats pageSize 0 as absent due to || fallback", () => {
    expect(parsePagination({ page: "2", pageSize: "0" })).toEqual({ page: 2, pageSize: 25 });
  });

  it("clamps negative pageSize to 1", () => {
    expect(parsePagination({ page: "1", pageSize: "-5" })).toEqual({ page: 1, pageSize: 1 });
  });
});

describe("paginate", () => {
  it("returns empty object when pageSize ≤ 0 (no pagination)", () => {
    expect(paginate({ page: 1, pageSize: 0 })).toEqual({});
  });

  it("computes limit and offset for page 1", () => {
    expect(paginate({ page: 1, pageSize: 25 })).toEqual({ limit: 25, offset: 0 });
  });

  it("computes limit and offset for page 3", () => {
    expect(paginate({ page: 3, pageSize: 50 })).toEqual({ limit: 50, offset: 100 });
  });
});

describe("cacheKey", () => {
  it("joins parts with colon", () => {
    expect(cacheKey("a", "b", "c")).toBe("a:b:c");
  });

  it("filters out null and undefined", () => {
    expect(cacheKey("pf1", null, "method", undefined)).toBe("pf1:method");
  });

  it("filters out empty strings", () => {
    expect(cacheKey("id", "", "range")).toBe("id:range");
  });

  it("handles numbers", () => {
    expect(cacheKey("page", 1, "size", 25)).toBe("page:1:size:25");
  });

  it("returns empty string for all-null input", () => {
    expect(cacheKey(null, undefined)).toBe("");
  });
});
