import { describe, it, expect } from "vitest";
import { qualifyingHolders } from "../src/lib/portfolio-selection";

describe("qualifyingHolders", () => {
  const holders = [
    { id: "h1", name: "Self" },
    { id: "h2", name: "Child" },
    { id: "h3", name: "Other" },
  ];

  it("returns holders owning ≥2 portfolios", () => {
    const portfolios = [
      { accountHolderId: "h1" },
      { accountHolderId: "h1" },
      { accountHolderId: "h2" },
    ];
    expect(qualifyingHolders(portfolios, holders)).toEqual([{ id: "h1", name: "Self" }]);
  });

  it("returns an empty list when no holder owns ≥2 portfolios", () => {
    const portfolios = [
      { accountHolderId: "h1" },
      { accountHolderId: "h2" },
    ];
    expect(qualifyingHolders(portfolios, holders)).toEqual([]);
  });

  it("ignores portfolios with no accountHolderId", () => {
    const portfolios = [
      { accountHolderId: null },
      { accountHolderId: undefined },
      { accountHolderId: "h3" },
      { accountHolderId: "h3" },
    ];
    expect(qualifyingHolders(portfolios, holders)).toEqual([{ id: "h3", name: "Other" }]);
  });

  it("returns all qualifying holders when multiple qualify", () => {
    const portfolios = [
      { accountHolderId: "h1" },
      { accountHolderId: "h1" },
      { accountHolderId: "h2" },
      { accountHolderId: "h2" },
      { accountHolderId: "h2" },
    ];
    const result = qualifyingHolders(portfolios, holders);
    expect(result.map((h) => h.id).sort()).toEqual(["h1", "h2"]);
  });

  it("returns empty list when there are no portfolios", () => {
    expect(qualifyingHolders([], holders)).toEqual([]);
  });

  it("returns empty list when there are no holders", () => {
    const portfolios = [{ accountHolderId: "h1" }, { accountHolderId: "h1" }];
    expect(qualifyingHolders(portfolios, [])).toEqual([]);
  });
});
