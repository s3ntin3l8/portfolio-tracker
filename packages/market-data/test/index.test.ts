import { describe, it, expect } from "vitest";
import { ASSET_CLASSES, isAssetClass } from "../src/index.js";

describe("@portfolio/market-data", () => {
  it("lists the supported asset classes", () => {
    expect(ASSET_CLASSES).toContain("equity");
    expect(ASSET_CLASSES).toContain("gold");
    expect(ASSET_CLASSES).toContain("bond");
    expect(ASSET_CLASSES).toContain("mutual_fund");
  });

  it("narrows asset-class strings", () => {
    expect(isAssetClass("gold")).toBe(true);
    expect(isAssetClass("not-an-asset")).toBe(false);
  });
});
