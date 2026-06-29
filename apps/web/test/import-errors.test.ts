import { describe, it, expect } from "vitest";
import { ApiError } from "@portfolio/api-client";
import {
  importSkipReason,
  classifyImportError,
  importErrorDetail,
} from "../src/lib/import-errors";

/** A 502 `screenshot_parse_failed` with a given provider status. */
function visionFail(providerStatus: number | null, provider = "claude") {
  return new ApiError(
    502,
    JSON.stringify({ error: "screenshot_parse_failed", reason: "provider_error", provider, providerStatus }),
  );
}

describe("importSkipReason (back-compat wrapper)", () => {
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

  it("returns 'parseFailed' for a plain 502 object (no body to classify)", () => {
    expect(importSkipReason({ status: 502 })).toBe("parseFailed");
  });

  it("returns 'generic' for unknown status", () => {
    expect(importSkipReason({ status: 500 })).toBe("generic");
  });

  it("returns 'generic' for null/undefined/empty", () => {
    expect(importSkipReason(null)).toBe("generic");
    expect(importSkipReason(undefined)).toBe("generic");
    expect(importSkipReason({})).toBe("generic");
  });

  it("prefers the fileRead message even when a status is present", () => {
    expect(importSkipReason({ message: "file_read_error", status: 503 })).toBe("fileRead");
  });
});

describe("classifyImportError (rich)", () => {
  it("maps a top-level 401/403 to sessionExpired and keeps the status", () => {
    expect(classifyImportError({ status: 401 })).toEqual({ reason: "sessionExpired", status: 401 });
    expect(classifyImportError({ status: 403 })).toEqual({ reason: "sessionExpired", status: 403 });
  });

  it("maps a 502 provider 429 to rateLimited with the provider name", () => {
    expect(classifyImportError(visionFail(429))).toEqual({ reason: "rateLimited", provider: "claude" });
  });

  it("maps a 502 provider 401/403 to providerAuth", () => {
    expect(classifyImportError(visionFail(401, "gemini")).reason).toBe("providerAuth");
    expect(classifyImportError(visionFail(403)).reason).toBe("providerAuth");
  });

  it("maps a 502 provider 5xx to providerDown", () => {
    expect(classifyImportError(visionFail(500)).reason).toBe("providerDown");
    expect(classifyImportError(visionFail(503)).reason).toBe("providerDown");
  });

  it("falls back to parseFailed for a 502 with no/unknown providerStatus", () => {
    expect(classifyImportError(visionFail(null)).reason).toBe("parseFailed");
  });

  it("attaches the real status + body code on the generic fallthrough", () => {
    const err = new ApiError(500, JSON.stringify({ error: "server_error" }));
    expect(classifyImportError(err)).toEqual({ reason: "generic", status: 500, code: "server_error" });
  });
});

describe("importErrorDetail", () => {
  it("formats status + code", () => {
    expect(importErrorDetail({ reason: "generic", status: 500, code: "server_error" })).toBe(
      "HTTP 500 · server_error",
    );
  });

  it("formats status alone when no code", () => {
    expect(importErrorDetail({ reason: "generic", status: 503 })).toBe("HTTP 503");
  });

  it("returns null when there is no status", () => {
    expect(importErrorDetail({ reason: "rateLimited", provider: "claude" })).toBeNull();
  });
});
