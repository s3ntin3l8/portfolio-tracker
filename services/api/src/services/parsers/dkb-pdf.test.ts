import { describe, it, expect } from "vitest";
import { detectDkbPdf, parseDkbPdf } from "./dkb-pdf.js";

// Fixtures are the real `unpdf` text output of actual DKB settlement PDFs (the flattened,
// space-joined stream), SANITISED: account holder names → Max Mustermann, IBANs / Konto /
// Kundennummer / Depotnummer → zeroed placeholders. The label structure the parser keys on
// (Ausmachender Betrag, Einbehaltene Quellensteuer, Devisenkurs, ISIN (WKN), …) is
// preserved verbatim, so these pin the parser against the genuine extraction shape.

const DIVIDEND = // Microsoft Ertragsabrechnung Dividenden — US stock, foreign Quellensteuer + FX
  "Seite 1 10919 Berlin Frau Max Mustermann Schloßgasse 1e 85120 Hepberg Depotnummer " +
  "999999001 Kundennummer 0000000000 Max Mustermann Abrechnungsnr. 11111111111 Datum " +
  "12.12.2025 Dividendengutschrift Nominale Wertpapierbezeichnung ISIN (WKN) Stück 1 " +
  "MICROSOFT CORP. REGISTERED SHARES DL-,00000625 US5949181045 (870747) Zahlbarkeitstag " +
  "11.12.2025 Bestandsstichtag 19.11.2025 Ex-Tag 20.11.2025 Geschäftsjahr 01.07.2025 - " +
  "30.06.2026 Devisenkurs EUR / USD 1,1777 Devisenkursdatum 12.12.2025 Dividende pro Stück " +
  "0,91 USD Herkunftsland USA Art der Dividende Quartalsdividende Dividendengutschrift 0,91 " +
  "USD 0,77+ EUR Umrechnung in EUR 0,77 EUR Einbehaltene Quellensteuer 15 % auf 0,91 USD " +
  "0,12- EUR Anrechenbare Quellensteuer 15 % auf 0,77 EUR 0,12 EUR " +
  "Kapitalertragsteuerpflichtige Dividende 0,77 EUR Verrechneter Sparer-Pauschbetrag 0,77 " +
  "- EUR Berechnungsgrundlage für die Kapitalertragsteuer 0,00 EUR Ausmachender Betrag " +
  "0,65+ EUR Lagerstelle Clearstream Banking FFM (849000 / 40030000) Den Betrag buchen wir " +
  "mit Wertstellung 12.12.2025 zu Gunsten des Kontos 0000000000 (IBAN DE00 0000 0000 0000 " +
  "0000 00), BLZ 120 300 00 (BIC BYLADEM1001). Keine Steuerbescheinigung.";

const FUND = // Amundi ETF Ausschüttung Investmentfonds — EUR, no FX, no withheld tax
  "10919 Berlin Frau Max Mustermann Schloßgasse 1e 85120 Hepberg Depotnummer 999999002 " +
  "Kundennummer 0000000000 Max Mustermann Abrechnungsnr. 22222222222 Datum 17.11.2021 " +
  "Ausschüttung Investmentfonds Nominale Wertpapierbezeichnung ISIN (WKN) Stück 8,348 " +
  "AMUNDI IND.SOL.-A.IN.MSCI E.M. ACT.NOM.UCITS ETF DR D ON LU1737652583 (A2H9Q0) " +
  "Zahlbarkeitstag 18.11.2021 Bestandsstichtag 15.11.2021 Ex-Tag 16.11.2021 Geschäftsjahr " +
  "01.10.2021 - 30.09.2022 Ausschüttung pro St. 1,200000000 EUR mit Teilfreistellung " +
  "(Aktien- fonds) 0,840000000 EUR Herkunftsland Luxemburg Ausschüttung 10,02+ EUR davon " +
  "steuerfreier Anteil wg. Teilfreistellung 3,01 EUR Kapitalertragsteuerpfl. Ertrag nach " +
  "Teilfreistellung 7,01 EUR Verrechneter Sparer-Pauschbetrag 7,01 - EUR " +
  "Berechnungsgrundlage für die Kapitalertragsteuer 0,00 EUR Ausmachender Betrag 10,02+ " +
  "EUR Lagerstelle Clearstream Banking FFM (849000 / 40030000) Den Betrag buchen wir mit " +
  "Wertstellung 18.11.2021 zu Gunsten des Kontos 0000000000 (IBAN DE00 0000 0000 0000 0000 " +
  "00), BLZ 120 300 00 (BIC BYLADEM1001). Keine Steuerbescheinigung.";

const KAUF = // Microsoft Wertpapierabrechnung Kauf Direkthandel — one-off equity buy
  "10919 Berlin Frau Max Mustermann Schloßgasse 1e 85120 Hepberg Depotnummer 999999001 " +
  "Kundennummer 0000000000 Max Mustermann Auftragsnummer 474464/99.00 Datum 10.02.2022 " +
  "Rechnungsnummer W00883-0001099679/22 Umsatzsteuer-ID DE137178746 Wertpapier Abrechnung " +
  "Kauf Direkthandel Nominale Wertpapierbezeichnung ISIN (WKN) Stück 1 MICROSOFT CORP. " +
  "REGISTERED SHARES DL-,00000625 US5949181045 (870747) Handels-/Ausführungsplatz " +
  "Außerbörslich (gemäß Weisung) Handelspartner Baader Bank Schlusstag/-Zeit 10.02.2022 " +
  "10:49:53 Ausführungskurs 270,55 EUR Auftraggeber Max Mustermann Auftragserteilung/ -ort " +
  "Online-Banking Girosammelverw. mehrere Sammelurkunden - kein Stückeausdruck - Kurswert " +
  "270,55- EUR Provision 10,00- EUR Ausmachender Betrag 280,55- EUR Den Gegenwert buchen " +
  "wir mit Valuta 14.02.2022 zu Lasten des Kontos 0000000000 (IBAN DE00 0000 0000 0000 " +
  "0000 00), BLZ 12030000 (BIC BYLADEM1001).";

const SPARPLAN = // Amundi ETF Ausgabe Investmentfonds — recurring ETF-Sparplan execution
  "10919 Berlin Frau Max Mustermann Schloßgasse 1e 85120 Hepberg Depotnummer 999999001 " +
  "Kundennummer 0000000000 Max Mustermann Auftragsnummer 178578/67.00 Datum 05.07.2021 " +
  "Rechnungsnummer W00883-0004251464/21 Umsatzsteuer-ID DE137178746 Wertpapier Abrechnung " +
  "Ausgabe Investmentfonds Auftrag vom 03.07.2021 00:24:38 Uhr Nominale " +
  "Wertpapierbezeichnung ISIN (WKN) Stück 1,3358 AIS-AMUNDI INDEX MSCI WORLD ACT.NOM.UCITS " +
  "ETF DR D ON LU1737652237 (A2H9QY) Handels-/Ausführungsplatz Außerbörslich (gemäß " +
  "Weisung) Schlusstag 05.07.2021 Ausführungskurs 72,614 EUR Auftraggeber Max Mustermann " +
  "Auftragserteilung/ -ort sonstige Girosammelverw. mehrere Sammelurkunden - kein " +
  "Stückeausdruck - Kurswert 97,00- EUR Provision 0,49- EUR Ausmachender Betrag 97,49- EUR " +
  "Den Gegenwert buchen wir mit Valuta 07.07.2021 zu Lasten des Kontos 0000000000 (IBAN " +
  "DE00 0000 0000 0000 0000 00), BLZ 12030000 (BIC BYLADEM1001). Gegenpartei bei diesem " +
  "Geschäft war Börse Tradegate ABR. OHNE AUSGABEAUFSCHLAG Ihr ETF-Sparplan Nr. 2";

// Synthetic (no real sell PDF was captured): a Verkauf credits the account (Ausmachender
// Betrag "+ EUR") and carries no Handelspartner, so venue falls back to the execution place.
const VERKAUF =
  "10919 Berlin Frau Max Mustermann Depotnummer 999999001 Kundennummer 0000000000 Max " +
  "Mustermann Auftragsnummer 555000/11.00 Datum 03.03.2023 Wertpapier Abrechnung Verkauf " +
  "Direkthandel Nominale Wertpapierbezeichnung ISIN (WKN) Stück 2 MICROSOFT CORP. " +
  "REGISTERED SHARES DL-,00000625 US5949181045 (870747) Handels-/Ausführungsplatz " +
  "Außerbörslich (gemäß Weisung) Schlusstag/-Zeit 03.03.2023 09:15:00 Ausführungskurs " +
  "250,00 EUR Kurswert 500,00+ EUR Provision 1,00- EUR Ausmachender Betrag 499,00+ EUR Den " +
  "Gegenwert buchen wir mit Valuta 07.03.2023 (IBAN DE00 0000 0000 0000 0000 00), BLZ " +
  "12030000 (BIC BYLADEM1001).";

describe("detectDkbPdf", () => {
  it("recognises DKB securities settlement PDFs", () => {
    for (const t of [DIVIDEND, FUND, KAUF, SPARPLAN]) expect(detectDkbPdf(t)).toBe(true);
  });

  it("rejects non-DKB / non-securities text", () => {
    expect(detectDkbPdf("Just some random invoice text with a total of 42 EUR")).toBe(false);
    // A different German broker's trade note (no DKB BLZ/BIC signature).
    expect(detectDkbPdf("Wertpapier Abrechnung Kauf ... BIC COBADEFFXXX")).toBe(false);
  });
});

describe("parseDkbPdf — stock dividend (foreign Quellensteuer + FX)", () => {
  const { drafts, errors, accountNumber } = parseDkbPdf(DIVIDEND);

  it("extracts the net payout, gross total, withheld tax, FX and identity", () => {
    expect(errors).toEqual([]);
    expect(accountNumber).toBe("999999001");
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      assetClass: "equity",
      action: "dividend",
      isin: "US5949181045",
      wkn: "870747",
      quantity: "0",
      price: "0.65", // NET Ausmachender Betrag — drives cashFlow
      total: "0.77", // gross (net + tax)
      tax: "0.12", // foreign Quellensteuer only (German KapSt = 0 via Sparer-Pauschbetrag)
      fxRate: "1.1777",
      currency: "EUR",
      externalId: "dkb:11111111111",
    });
    expect(drafts[0].executedAt?.toISOString()).toBe("2025-12-12T00:00:00.000Z");
    expect(drafts[0].name).toContain("MICROSOFT CORP.");
  });
});

describe("parseDkbPdf — fund distribution (EUR, no FX, no withheld tax)", () => {
  const { drafts, accountNumber } = parseDkbPdf(FUND);

  it("maps to a dividend with net = gross and no tax", () => {
    expect(accountNumber).toBe("999999002");
    expect(drafts[0]).toMatchObject({
      assetClass: "etf",
      action: "dividend",
      isin: "LU1737652583",
      wkn: "A2H9Q0",
      quantity: "0",
      price: "10.02",
      total: "10.02",
      currency: "EUR",
      externalId: "dkb:22222222222",
    });
    expect(drafts[0].tax ?? null).toBeNull();
    expect(drafts[0].fxRate ?? null).toBeNull();
    expect(drafts[0].executedAt?.toISOString()).toBe("2021-11-18T00:00:00.000Z");
  });
});

describe("parseDkbPdf — one-off buy (Kauf)", () => {
  const { drafts } = parseDkbPdf(KAUF);

  it("extracts price, fees (Provision), settlement total and venue", () => {
    expect(drafts[0]).toMatchObject({
      assetClass: "equity",
      action: "buy",
      isin: "US5949181045",
      wkn: "870747",
      quantity: "1",
      unit: "shares",
      price: "270.55",
      fees: "10.00",
      total: "280.55",
      venue: "Baader Bank",
      currency: "EUR",
      externalId: "dkb:4744649900",
    });
    expect(drafts[0].executedAt?.toISOString()).toBe("2022-02-10T00:00:00.000Z");
  });
});

describe("parseDkbPdf — sell (Verkauf)", () => {
  const { drafts } = parseDkbPdf(VERKAUF);

  it("classifies a Verkauf as a sell with the execution place as venue", () => {
    expect(drafts[0]).toMatchObject({
      action: "sell",
      isin: "US5949181045",
      quantity: "2",
      price: "250.00",
      fees: "1.00",
      total: "499.00",
      venue: "Außerbörslich (gemäß Weisung)",
      externalId: "dkb:5550001100",
    });
  });
});

describe("parseDkbPdf — ETF savings-plan execution", () => {
  const { drafts } = parseDkbPdf(SPARPLAN);

  it("classifies the Sparplan buy as savings_plan with the counterparty as venue", () => {
    expect(drafts[0]).toMatchObject({
      assetClass: "etf",
      action: "savings_plan",
      isin: "LU1737652237",
      wkn: "A2H9QY",
      quantity: "1.3358",
      price: "72.614",
      fees: "0.49",
      total: "97.49",
      venue: "Börse Tradegate",
      externalId: "dkb:1785786700",
    });
  });
});
