import { describe, it, expect } from "vitest";
import { navActiveKey, MAIN_NAV } from "../src/components/nav-items";

describe("navActiveKey", () => {
  it("maps each primary route to its own tab", () => {
    expect(navActiveKey("/holdings")).toBe("holdings");
    expect(navActiveKey("/transactions")).toBe("activity");
    expect(navActiveKey("/reports")).toBe("reports");
    expect(navActiveKey("/insights")).toBe("insights");
    expect(navActiveKey("/settings")).toBe("profile");
  });

  it("maps leaf routes back onto their parent tab", () => {
    expect(navActiveKey("/dashboard")).toBe("holdings");
    expect(navActiveKey("/instruments/abc")).toBe("holdings");
    expect(navActiveKey("/income")).toBe("reports");
    expect(navActiveKey("/tax")).toBe("reports");
    expect(navActiveKey("/savings")).toBe("reports");
    expect(navActiveKey("/trades")).toBe("reports");
    expect(navActiveKey("/portfolios")).toBe("profile");
    expect(navActiveKey("/admin")).toBe("admin");
  });

  it("falls back to holdings for unknown routes", () => {
    expect(navActiveKey("/nope")).toBe("holdings");
  });

  it("exposes exactly the five destinations", () => {
    expect(MAIN_NAV.map((n) => n.key)).toEqual([
      "holdings",
      "activity",
      "reports",
      "insights",
      "profile",
    ]);
  });
});
