/**
 * Unit tests for the report-PDF detector (services/parsers/report-pdf.ts) — recognizes
 * Trade Republic's annual tax report when uploaded through the general Add-Transaction
 * flow, so it can be routed into the tax-reports inbox instead of the vision-LLM fallback.
 */
import { describe, it, expect } from "vitest";
import { detectReportPdf } from "../../../src/services/parsers/report-pdf.js";

describe("detectReportPdf", () => {
  it("matches the live-confirmed 'Jährlicher Steuerbericht' title with its year suffix", () => {
    const text =
      "TRADE REPUBLIC BANK GMBH BRUNNENSTRASSE 19-21 10119 BERLIN SEITE 1 von 12 Jährlicher Steuerbericht 2025 für das Kalenderjahr 2025 Max Mustermann Musterstr. 1 12345 Musterstadt";
    expect(detectReportPdf(text)).toEqual({
      category: "tax_report",
      taxYear: 2025,
      title: "Jährlicher Steuerbericht 2025",
    });
  });

  it("matches the pytr-taxonomy fallback title 'Jährlicher Steuerreport'", () => {
    const text = "Cover page Jährlicher Steuerreport 2022 Zusammenfassung Ihrer steuerlichen Daten";
    expect(detectReportPdf(text)).toEqual({
      category: "tax_report",
      taxYear: 2022,
      title: "Jährlicher Steuerreport 2022",
    });
  });

  it("returns taxYear: null when no year is found near the matched title", () => {
    const text = "Jährlicher Steuerbericht für Ihr Depot";
    expect(detectReportPdf(text)).toEqual({
      category: "tax_report",
      taxYear: null,
      title: "Jährlicher Steuerbericht",
    });
  });

  it("does not pick up an unrelated year elsewhere in the document", () => {
    // A year appears far from the title (e.g. a footer) — the narrow post-title window
    // must not reach across the whole document to grab it.
    const text = `Jährlicher Steuerbericht für Ihr Depot. ${"x".repeat(200)} Stand: 2019`;
    const result = detectReportPdf(text);
    expect(result?.taxYear).toBeNull();
  });

  it("returns null for a normal settlement PDF (not a report)", () => {
    const text =
      "TRADE REPUBLIC BANK GMBH DATUM 23.06.2026 AUSFÜHRUNG 30bf-b0e9 DEPOT 1234567890 WERTPAPIERABRECHNUNG POSITION ANZAHL PREIS BETRAG";
    expect(detectReportPdf(text)).toBeNull();
  });

  it("returns null for unrelated text", () => {
    expect(detectReportPdf("just some random PDF content")).toBeNull();
    expect(detectReportPdf("")).toBeNull();
  });
});
