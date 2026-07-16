import { describe, it, expect } from "vitest";
import { sanitizeDispositionName } from "../../src/routes/storage.js";

describe("sanitizeDispositionName", () => {
  it("strips double quotes that would break out of the quoted filename", () => {
    expect(sanitizeDispositionName(`evil".pdf`)).toBe("evil.pdf");
  });

  it("strips CR/LF that would inject a header line", () => {
    expect(sanitizeDispositionName("file.pdf\r\nX-Injected: 1")).toBe("file.pdfX-Injected: 1");
  });

  it("leaves a normal structured filename untouched", () => {
    expect(sanitizeDispositionName("2024-01-15 AAPL buy.pdf")).toBe("2024-01-15 AAPL buy.pdf");
  });
});
