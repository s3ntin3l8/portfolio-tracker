import { describe, it, expect } from "vitest";
import { importSkipReason } from "../src/lib/import-errors";

describe("importSkipReason", () => {
  it("returns 'fileRead' for file_read_error message", () => {
    expect(importSkipReason(new Error("file_read_error"))).toBe("fileRead");
  });

  it("returns 'notConfigured' for 503 status", () => {
    expect(importSkipReason({ status: 503 })).toBe("notConfigured");
  });

  it("returns 'tooLarge' for 413 status", () => {
    expect(importSkipReason({ status: 413 })).toBe("tooLarge");
  });

  it("returns 'parseFailed' for 415 status", () => {
    expect(importSkipReason({ status: 415 })).toBe("parseFailed");
  });

  it("returns 'parseFailed' for 502 status", () => {
    expect(importSkipReason({ status: 502 })).toBe("parseFailed");
  });

  it("returns 'generic' for unknown status", () => {
    expect(importSkipReason({ status: 500 })).toBe("generic");
  });

  it("returns 'generic' for null/undefined", () => {
    expect(importSkipReason(null)).toBe("generic");
    expect(importSkipReason(undefined)).toBe("generic");
  });

  it("returns 'generic' for an empty object", () => {
    expect(importSkipReason({})).toBe("generic");
  });

  it("does not confuse fileRead when status is also present", () => {
    // message check takes priority
    expect(importSkipReason({ message: "file_read_error", status: 503 })).toBe("fileRead");
  });
});
