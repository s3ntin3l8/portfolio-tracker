/**
 * Unit tests for the deterministic Trade Republic settlement-PDF parser.
 *
 * Fixtures are the real extracted text of one document of each class, with PII
 * (name/address/IBAN/depot/Steuer-ID) scrubbed to placeholders — the financial figures,
 * ISINs, dates and German wording (which the parser depends on) are kept verbatim. They
 * pin the four extraction bugs fixed alongside this test:
 *   - dividend: the BUCHUNG line is `… BETRAG <IBAN> <DD.MM.YYYY> <amount> EUR`, not the
 *     ISO-date-immediately-after-label the old regex assumed → it returned no draft;
 *   - sell: `Kapitalertragsteuer Optimierung 3,38 EUR` (Steueroptimierung wording) was
 *     dropped, and the name regex swallowed the whole ABRECHNUNG block;
 *   - trade: `executedPrice` was never populated;
 *   - interest / tax-optimisation: no parser branch existed at all.
 */
import { describe, it, expect } from "vitest";
import { detectTrPdf, parseTrPdf } from "../../../src/services/parsers/tr-pdf.js";

// --- Fixtures (sanitised real text) ----------------------------------------

const BUY_ROUNDUP =
  "Trade Republic Bank GmbH Brunnenstraße 19-21 10119 Berlin www.traderepublic.com Sitz der Gesellschaft: Berlin AG Charlottenburg HRB 244347 B Umsatzsteuer-ID DE307510626 Geschäftsführer Andreas Torner Gernot Mittendorfer Christian Hecker Thomas Pischke TRADE REPUBLIC BANK GMBH BRUNNENSTRASSE 19-21 10119 BERLIN SEITE 1 von 1 DATUM 23.06.2026 AUSFÜHRUNG 30bf-b0e9 ROUND UP 8920-471a DEPOT 1234567890 WERTPAPIERABRECHNUNG ROUND UP ÜBERSICHT Ausführung von Round up am 23.06.2026 an der Lang und Schwarz Exchange. Der Kontrahent der Transaktion ist Lang & Schwarz TradeCenter AG & Co. KG. POSITION ANZAHL DURCHSCHNITTSKURS BETRAG Core S&P 500 USD (Acc) ISIN: IE00B5BMR087 0,001425 Stk. 701,38 EUR 1,00 EUR GESAMT 1,00 EUR BUCHUNG VERRECHNUNGSKONTO WERTSTELLUNG BETRAG DE00000000000000000000 2026-06-25 -1,00 EUR Core S&P 500 USD (Acc) nicht in Sammelverwahrung Diese Abrechnung wird maschinell erstellt und daher nicht unterschrieben. Wird keine Umsatzsteuer ausgewiesen, handelt es sich gemäß § 4 Nr. 8 UStG um eine umsatzsteuerfreie Leistung. Max Mustermann Musterstr. 1 12345 Musterstadt";

const SELL_TAX =
  "TRADE REPUBLIC BANK GMBH BRUNNENSTRASSE 19-21 10119 BERLIN SEITE 1 von 1 DATUM 30.05.2024 ORDER 4f56-2985 AUSFÜHRUNG 8580-8546 DEPOT 1234567890 Max Mustermann Musterstr. 1 12345 Musterstadt Trade Republic Bank GmbH Brunnenstraße 19-21 10119 Berlin www.traderepublic.com service@traderepublic.com Sitz der Gesellschaft: Berlin AG Charlottenburg HRB 244347 B USt-ID DE307510626 Geschäftsführer Andreas Torner Gernot Mittendorfer ABRE / 30.05.2024 / 43829370 / f204-4bc1 WERTPAPIERABRECHNUNG ABRECHNUNG POSITION BETRAG Fremdkostenzuschlag -1,00 EUR Kapitalertragsteuer Optimierung 3,38 EUR Solidaritätszuschlag Optimierung 0,18 EUR GESAMT 1.287,40 EUR BUCHUNG VERRECHNUNGSKONTO WERTSTELLUNG BETRAG DE00000000000000000000 03.06.2024 1.287,40 EUR AbbVie Inc. Registered Shares DL -,01 in Girosammelverwahrung in Deutschland. Diese Abrechnung wird maschinell erstellt und daher nicht unterschrieben. Sofern keine Umsatzsteuer ausgewiesen ist, handelt es sich gem. § 4 Nr. 8 UStG um eine umsatzsteuerfreie Leistung. ÜBERSICHT Market-Order Verkauf am 30.05.2024, um 09:28 Uhr (Europe/Berlin). Der Kontrahent der Transaktion ist Lang & Schwarz TradeCenter AG & Co. KG. POSITION ANZAHL PREIS BETRAG AbbVie Inc. Registered Shares DL -,01 ISIN: US00287Y1091 9 Stk. 142,76 EUR 1.284,84 EUR GESAMT 1.284,84 EUR";

const SELL_NOTAX =
  "TRADE REPUBLIC BANK GMBH BRUNNENSTRASSE 19-21 10119 BERLIN SEITE 1 von 1 DATUM 05.03.2024 ORDER 4833-046b AUSFÜHRUNG 3fc5-6b6c DEPOT 1234567890 Max Mustermann Musterstr. 1 12345 Musterstadt Trade Republic Bank GmbH Brunnenstraße 19-21 10119 Berlin www.traderepublic.com service@traderepublic.com Sitz der Gesellschaft: Berlin AG Charlottenburg HRB 244347 B USt-ID DE307510626 Geschäftsführer Andreas Torner Gernot Mittendorfer ABRE / 05.03.2024 / 26433052 / 9fec-3cb2 WERTPAPIERABRECHNUNG ABRECHNUNG POSITION BETRAG Fremdkostenzuschlag -1,00 EUR GESAMT 422,46 EUR BUCHUNG VERRECHNUNGSKONTO WERTSTELLUNG BETRAG DE00000000000000000000 07.03.2024 422,46 EUR iShs Core S&P 500 UC.ETF USDD Registered Shares USD (Dist)oN in Wertpapierrechnung in Deutschland. Lagerland: Vereinigtes Königreich Diese Abrechnung wird maschinell erstellt und daher nicht unterschrieben. Sofern keine Umsatzsteuer ausgewiesen ist, handelt es sich gem. § 4 Nr. 8 UStG um eine umsatzsteuerfreie Leistung. ÜBERSICHT Market-Order Verkauf am 05.03.2024, um 09:25 Uhr (Europe/Berlin). Der Kontrahent der Transaktion ist Lang & Schwarz TradeCenter AG & Co. KG. POSITION ANZAHL PREIS BETRAG iShs Core S&P 500 UC.ETF USDD Registered Shares USD (Dist)oN ISIN: IE0031442068 9 Stk. 47,051 EUR 423,46 EUR GESAMT 423,46 EUR";

const DIVIDEND_USD =
  "Trade Republic Bank GmbH Brunnenstraße 19-21 10119 Berlin www.traderepublic.com Sitz der Gesellschaft: Berlin AG Charlottenburg HRB 244347 B Umsatzsteuer-ID DE307510626 Geschäftsführer Andreas Torner Gernot Mittendorfer Christian Hecker Thomas Pischke TRADE REPUBLIC BANK GMBH BRUNNENSTRASSE 19-21 10119 BERLIN SEITE 1 von 2 DATUM 16.06.2026 DEPOT 1234567890 DIVIDENDE ÜBERSICHT Dividende mit Ex-Datum 08.06.2026. POSITION ANZAHL ERTRAG BETRAG Main Street Capital US56035L1044 28.876429 Stücke 0.26 USD 7.51 USD GESAMT 7.51 USD ABRECHNUNG POSITION BETRAG Quellensteuer für US-Emittenten -1.13 USD Zwischensumme 6.38 USD Zwischensumme 1.1567 USD/EUR 5.51 EUR GESAMT 5.51 EUR BUCHUNG VERRECHNUNGSKONTO DATUM DER ZAHLUNG BETRAG DE00000000000000000000 15.06.2026 5.51 EUR US56035L1044 im Girosammelverwahrung in Deutschland Diese Abrechnung wird maschinell erstellt und daher nicht unterschrieben. Wird keine Umsatzsteuer ausgewiesen, handelt es sich um eine umsatzsteuerfreie Leistung gemäß § 4 Nr. 8 UStG Max Mustermann Musterstr. 1 12345 Musterstadt Trade Republic Bank GmbH Brunnenstraße 19-21 10119 Berlin www.traderepublic.com Sitz der Gesellschaft: Berlin AG Charlottenburg HRB 244347 B Umsatzsteuer-ID DE307510626 Geschäftsführer Andreas Torner Gernot Mittendorfer Christian Hecker Thomas Pischke TRADE REPUBLIC BANK GMBH BRUNNENSTRASSE 19-21 10119 BERLIN SEITE 2 von 2 DATUM 16.06.2026 DEPOT 1234567890 STEUERLICHE BEHANDLUNG BERECHNUNG DER STEUERBEMESSUNGSGRUNDLAGE BETRAG Kapitalertrag 7,51 USD Zwischensumme 1.1567 EUR/USD 6,49 EUR Freistellungsauftrag -6,49 EUR STEUERBEMESSUNGSGRUNDLAGE 0,00 EUR BERECHNUNG DER STEUERN BETRAG Kapitalertrag 7,51 USD Quellensteuer für US-Emittenten -1,13 USD Steuerbemessungsgrundlage 0,00 EUR Kapitalertragsteuer 0,00 EUR Solidaritätszuschlag 0,00 EUR GESAMTE STEUERN 0,98 EUR VERRECHNUNGSTÖPFE VERRECHNUNGSTÖPFE VORHER VERÄNDERUNG NACHHER Verlustverrechnungstopf Aktien 0,00 EUR 0,00 EUR 0,00 EUR Verlustverrechnungstopf Allgemein 0,00 EUR 0,00 EUR 0,00 EUR Freistellungsauftrag 399,22 EUR -6,49 EUR 392,73 EUR Quellensteuertopf 32,03 EUR 0,98 EUR 33,01 EUR Max Mustermann Musterstr. 1 12345 Musterstadt";

const INTEREST =
  "TRADE REPUBLIC BANK GMBH KÖPENICKER STRASSE 40C 10179 BERLIN Max Mustermann Musterstr. 1 12345 Musterstadt SEITE 1 von 1 DATUM 01.05.2023 VERRECHNUNGSKONTO 1234567890 STEUER-ID 00000000000 Trade Republic Bank GmbH Köpenicker Straße 40c 10179 Berlin www.traderepublic.com service@traderepublic.com Sitz der Gesellschaft: Berlin AG Charlottenburg HRB 244347 B USt-ID DE307510626 Geschäftsführer Andreas Torner Gernot Mittendorfer ABRECHNUNG ZINSEN zum 30.04.2023 ÜBERSICHT VERMÖGENSWERT EINKOMMENSART ZINSEN GESAMT Cash Zinsen 2,00% 5,44 EUR ABRECHNUNG POSITION BETRAG Besteuerungsgrundlage 5,44 EUR Kapitalertragssteuer 0,00 EUR Solidaritätszuschlag 0,00 EUR Gesamt 5,44 EUR BUCHUNG IBAN BUCHUNGSDATUM GUTSCHRIFT NACH STEUERN DE00000000000000000000 01.05.2023 5,44 EUR";

const TAXOPT_REFUND =
  "Trade Republic Bank GmbH Brunnenstraße 19-21 10119 Berlin www.traderepublic.com service@traderepublic.com Sitz der Gesellschaft: Berlin AG Charlottenburg HRB 244347 B Umsatzsteuer-ID DE307510626 Direktoren Andreas Torner Gernot Mittendorfer Christian Hecker Thomas Pischke TRADE REPUBLIC BANK GMBH BRUNNENSTRASSE 19-21 10119 BERLIN SEITE 1 von 1 DATUM 19.12.2024 DEPOT 1234567890 STEUERLICHE OPTIMIERUNG ÜBERSICHT Steuerliche Optimierung am 19.12.2024 ABRECHNUNG POSITION BETRAG Kapitalertragssteuer 1.57 EUR Solidaritätszuschlag 0.10 EUR GESAMT 1.67 EUR BUCHUNG VERRECHNUNGSKONTO DATUM DER ZAHLUNG BETRAG DE00000000000000000000 19.12.2024 1.67 EUR Diese Abrechnung wird maschinell erstellt und daher nicht unterschrieben. Max Mustermann Musterstr. 1 12345 Musterstadt";

const TAXOPT_CHARGE =
  "Trade Republic Bank GmbH Brunnenstraße 19-21 10119 Berlin www.traderepublic.com Sitz der Gesellschaft: Berlin AG Charlottenburg HRB 244347 B Umsatzsteuer-ID DE307510626 Direktoren Andreas Torner Gernot Mittendorfer Christian Hecker Thomas Pischke TRADE REPUBLIC BANK GMBH BRUNNENSTRASSE 19-21 10119 BERLIN SEITE 1 von 1 DATUM 24.04.2025 DEPOT 1234567890 STEUERLICHE OPTIMIERUNG ÜBERSICHT Steuerliche Optimierung am 24.04.2025 ABRECHNUNG POSITION BETRAG Kapitalertragssteuer -1.68 EUR Solidaritätszuschlag -0.09 EUR GESAMT -1.77 EUR BUCHUNG VERRECHNUNGSKONTO DATUM DER ZAHLUNG BETRAG DE00000000000000000000 24.04.2025 -1.77 EUR Diese Abrechnung wird maschinell erstellt und daher nicht unterschrieben. Max Mustermann Musterstr. 1 12345 Musterstadt";

// --- Format-A dividend fixtures (pre-2024Q3: German locale/comma decimal, `Stk.`
// abbreviation, labeled ISIN) — a second, older TR dividend PDF template that coexists with
// the (newer, above) Stücke/US-locale one across the account's history. Real sanitised text.

// Real Rio Tinto payment, no UK withholding shown (no Quellensteuer line at all) but German
// Kapitalertragsteuer/Solidaritätszuschlag charged directly on the EUR gross.
const DIVIDEND_GBP_FORMAT_A =
  "TRADE REPUBLIC BANK GMBH BRUNNENSTRASSE 19-21 10119 BERLIN SEITE 1 von 1 DATUM 17.04.2024 DEPOT 1234567890 Max Mustermann Musterstr. 1 12345 Musterstadt Trade Republic Bank GmbH Brunnenstraße 19-21 10119 Berlin www.traderepublic.com service@traderepublic.com Sitz der Gesellschaft: Berlin AG Charlottenburg HRB 244347 B USt-ID DE307510626 Geschäftsführer Andreas Torner Gernot Mittendorfer ABRE / 18.04.2024 / 29730825 / 87fe-5278 DIVIDENDE ABRECHNUNG POSITION BETRAG Zwischensumme 54,03 GBP Zwischensumme 0,855 EUR/GBP 63,19 EUR Kapitalertragsteuer -15,79 EUR Solidaritätszuschlag -0,87 EUR GESAMT 46,53 EUR BUCHUNG VERRECHNUNGSKONTO WERTSTELLUNG BETRAG DE00000000000000000000 18.04.2024 46,53 EUR Rio Tinto PLC Registered Shares LS -,10 in Wertpapierrechnung in Deutschland. Lagerland: Vereinigtes Königreich Diese Abrechnung wird maschinell erstellt und daher nicht unterschrieben. Sofern keine Umsatzsteuer ausgewiesen ist, handelt es sich gem. § 4 Nr. 8 UStG um eine umsatzsteuerfreie Leistung. ÜBERSICHT Dividende mit dem Ex-Tag 07.03.2024. POSITION ANZAHL ERTRAG BETRAG Rio Tinto PLC Registered Shares LS -,10 ISIN: GB0007188757 26,513245 Stk. 2,0377 GBP 54,03 GBP GESAMT 54,03 GBP";

// Real PepsiCo payment, POSITION-table-first-then-ABRECHNUNG (the reverse section order
// from the fixture above — the parser must not depend on ordering), singular "US-Emittent"
// issuer label (vs. the newer template's plural "US-Emittenten").
const DIVIDEND_USD_FORMAT_A =
  "TRADE REPUBLIC BANK GMBH KÖPENICKER STRASSE 40C 10179 BERLIN Max Mustermann Musterstr. 1 12345 Musterstadt SEITE 1 von 1 DATUM 01.04.2023 DEPOT 1234567890 Trade Republic Bank GmbH Köpenicker Straße 40c 10179 Berlin www.traderepublic.com service@traderepublic.com Sitz der Gesellschaft: Berlin AG Charlottenburg HRB 244347 B USt-ID DE307510626 Geschäftsführer Andreas Torner Gernot Mittendorfer ABRE / 01.04.2023 / 48202683 / b068-08ed DIVIDENDE ÜBERSICHT Dividende mit dem Ex-Tag 02.03.2023. POSITION ANZAHL Ertrag BETRAG PepsiCo Inc. Registered Shares DL -,0166 ISIN: US7134481081 0,479969 Stk. 1,15 USD 0,55 USD GESAMT 0,55 USD ABRECHNUNG POSITION BETRAG Quellensteuer für US-Emittent -0,08 USD Zwischensumme 0,47 USD Zwischensumme 1,08403 EUR/USD 0,44 EUR GESAMT 0,44 EUR BUCHUNG VERRECHNUNGSKONTO WERTSTELLUNG BETRAG DE00000000000000000000 31.03.2023 0,44 EUR PepsiCo Inc. Registered Shares DL -,0166 in Girosammelverwahrung in Deutschland. Diese Abrechnung wird maschinell erstellt und daher nicht unterschrieben. Sofern keine Umsatzsteuer ausgewiesen ist, handelt es sich gem. § 4 Nr. 8 UStG um eine umsatzsteuerfreie Leistung.";

// Real iShares fund-distribution payment — carries no "DIVIDENDE" keyword at all
// (AUSSCHÜTTUNG instead) and no tax lines whatsoever (fully tax-free distribution).
const AUSSCHUETTUNG_FORMAT_A =
  "TRADE REPUBLIC BANK GMBH KÖPENICKER STRASSE 40C 10179 BERLIN SEITE 1 von 1 DATUM 27.09.2023 DEPOT 1234567890 Max Mustermann Musterstr. 1 12345 Musterstadt Trade Republic Bank GmbH Köpenicker Straße 40c 10179 Berlin www.traderepublic.com service@traderepublic.com Sitz der Gesellschaft: Berlin AG Charlottenburg HRB 244347 B USt-ID DE307510626 Geschäftsführer Andreas Torner Gernot Mittendorfer ABRE / 28.09.2023 / 83161424 / 4102-32c8 AUSSCHÜTTUNG ABRECHNUNG POSITION BETRAG Zwischensumme 0,88 USD Zwischensumme 1,0587 EUR/USD 0,83 EUR GESAMT 0,83 EUR BUCHUNG VERRECHNUNGSKONTO WERTSTELLUNG BETRAG DE00000000000000000000 27.09.2023 0,83 EUR iShs Core S&P 500 UC.ETF USDD Registered Shares USD (Dist)oN in Wertpapierrechnung in Deutschland. Lagerland: Vereinigtes Königreich Diese Abrechnung wird maschinell erstellt und daher nicht unterschrieben. Sofern keine Umsatzsteuer ausgewiesen ist, handelt es sich gem. § 4 Nr. 8 UStG um eine umsatzsteuerfreie Leistung. ÜBERSICHT Ausschüttung mit dem Ex-Tag 14.09.2023. POSITION ANZAHL ERTRAG BETRAG iShs Core S&P 500 UC.ETF USDD Registered Shares USD (Dist)oN ISIN: IE0031442068 5,98573 Stk. 0,1462 USD 0,88 USD GESAMT 0,88 USD";

// Real Realty Income dividend CANCELLATION — reverses an earlier payment (negative
// POSITION/BUCHUNG amounts). Must be rejected outright: `parseTrDividend` isn't sign-aware
// (it strips a leading "-" before parsing), so if this were accepted a -6.68 EUR reversal
// would be recorded as a +6.68 EUR credit.
const DIVIDEND_STORNIERUNG =
  "TRADE REPUBLIC BANK GMBH BRUNNENSTRASSE 19-21 10119 BERLIN SEITE 1 von 1 DATUM 25.03.2025 DEPOT 1234567890 STORNIERUNG DER DIVIDENDE ÜBERSICHT Dividende mit Ex-Datum31.01.2024. POSITION ANZAHL ERTRAG BETRAG Realty Income US7561091049 37.78361 Stücke -0.26 USD -9.69 USD GESAMT -9.69 USD ABRECHNUNG POSITION BETRAG Quellensteuer für US-Emittenten 1.45 USD Zwischensumme -8.24 USD Zwischensumme 1.0787 EUR/USD -7.64 EUR Kapitalertragssteuer 1.0787 EUR/USD 0.90 EUR Solidaritätszuschlag 1.0787 EUR/USD 0.06 EUR GESAMT -6.68 EUR BUCHUNG VERRECHNUNGSKONTO DATUM DER ZAHLUNG BETRAG DE00000000000000000000 15.02.2024 -6.68 EUR Diese Abrechnung wird maschinell erstellt und daher nicht unterschrieben. Wird keine Umsatzsteuer ausgewiesen, handelt es sich um eine umsatzsteuerfreie Leistung gemäß § 4 Nr. 8 UStG Max Mustermann Musterstr. 1 12345 Musterstadt";

// Real Realty Income US-REIT tax RECLASSIFICATION of an earlier distribution — not a fresh
// payment either, and (per the live account) several of these can be linked to a single
// transaction, so there's no reliable single per-share/native/fx to attach even if the
// wording were otherwise treated as a plain dividend.
const DIVIDEND_REKLASSIFIZIERUNG =
  "TRADE REPUBLIC BANK GMBH BRUNNENSTRASSE 19-21 10119 BERLIN SEITE 1 von 1 DATUM 25.03.2025 DEPOT 1234567890 REKLASSIFIZIERUNG US-AUSSCHÜTTUNGEN ÜBERSICHT Du hast eine neu klassifizierte Barausschüttung für ein in den USA notiertes Wertpapier in deinem Konto erhalten. Dies ist keine neue Dividendenzahlung, sondern eine steuerliche Neuklassifizierung einer früheren Ausschüttung mit Ex-Tag am 31.01.2024. POSITION ANZAHL ERTRAG BETRAG Realty Income US7561091049 37.78361 Stücke 0.18 USD 6.75 USD GESAMT 6.75 USD ABRECHNUNG POSITION BETRAG Quellensteuer für US-Emittenten -1.45 USD Zwischensumme 5.30 USD Zwischensumme 1.0787 EUR/USD 4.92 EUR GESAMT 4.92 EUR BUCHUNG VERRECHNUNGSKONTO DATUM DER ZAHLUNG BETRAG DE00000000000000000000 27.02.2025 4.92 EUR Diese Abrechnung wird maschinell erstellt und daher nicht unterschrieben. Wird keine Umsatzsteuer ausgewiesen, handelt es sich um eine umsatzsteuerfreie Leistung gemäß § 4 Nr. 8 UStG Max Mustermann Musterstr. 1 12345 Musterstadt";

// A cash-transfer confirmation (ÜBERWEISUNGSBESTÄTIGUNG) — amount only, no securities or
// tax. Must NOT be detected as a settlement (it's mapped to deposit/withdrawal already).
const TRANSFER_REJECT =
  "Trade Republic Bank GmbH Brunnenstraße 19-21 10119 Berlin TRADE REPUBLIC BANK GMBH BRUNNENSTRASSE 19-21 10119 BERLIN SEITE 1 von 1 DATUM 02.09.2024 IBAN DE00000000000000000000 BIC TRBKDEBBXXX ÜBERWEISUNGSBESTÄTIGUNG ÜBERWEISUNGSDETAILS BETRAG STATUS ÜBERWEISUNGSDATUM TYP REFERENZ 200,00 € Ausgeführt 02.09.2024 SEPA Max Mustermann";

// ---------------------------------------------------------------------------

describe("detectTrPdf", () => {
  it("accepts trade, dividend, interest and tax-optimisation abrechnungen", () => {
    expect(detectTrPdf(BUY_ROUNDUP)).toBe(true);
    expect(detectTrPdf(SELL_TAX)).toBe(true);
    expect(detectTrPdf(DIVIDEND_USD)).toBe(true);
    expect(detectTrPdf(INTEREST)).toBe(true);
    expect(detectTrPdf(TAXOPT_REFUND)).toBe(true);
  });

  it("accepts Format-A (pre-2024Q3, German-locale/Stk.) dividends, incl. AUSSCHÜTTUNG", () => {
    expect(detectTrPdf(DIVIDEND_GBP_FORMAT_A)).toBe(true);
    expect(detectTrPdf(DIVIDEND_USD_FORMAT_A)).toBe(true);
    expect(detectTrPdf(AUSSCHUETTUNG_FORMAT_A)).toBe(true);
  });

  it("rejects a dividend cancellation (STORNIERUNG) and a US-REIT reclassification (REKLASSIFIZIERUNG)", () => {
    // Both carry "DIVIDENDE"/"AUSSCHÜTTUNG" + a quantity marker and would otherwise match —
    // they must be excluded specifically, not just happen to fail some other check.
    expect(detectTrPdf(DIVIDEND_STORNIERUNG)).toBe(false);
    expect(detectTrPdf(DIVIDEND_REKLASSIFIZIERUNG)).toBe(false);
  });

  it("rejects a cash-transfer confirmation (no securities/tax to mine)", () => {
    expect(detectTrPdf(TRANSFER_REJECT)).toBe(false);
  });

  it("rejects non-Trade-Republic text", () => {
    expect(detectTrPdf("Some DKB Dividendengutschrift WERTPAPIERABRECHNUNG")).toBe(false);
  });
});

describe("parseTrPdf — trade settlement", () => {
  it("parses a round-up buy with executedPrice and no tax", () => {
    const { drafts } = parseTrPdf(BUY_ROUNDUP);
    expect(drafts).toHaveLength(1);
    const d = drafts[0];
    expect(d.action).toBe("buy");
    expect(d.kind).toBe("roundup");
    expect(d.isin).toBe("IE00B5BMR087");
    expect(d.name).toBe("Core S&P 500 USD (Acc)");
    expect(d.quantity).toBe("0.001425");
    expect(d.price).toBe("701.38");
    // RC#3: executedPrice now populated from the PREIS/DURCHSCHNITTSKURS column.
    expect(d.executedPrice).toBe("701.38");
    expect(d.fees).toBe("0");
    expect(d.tax ?? null).toBeNull();
  });

  it("parses a sell, capturing Steueroptimierung tax (signed) and a clean name", () => {
    const { drafts } = parseTrPdf(SELL_TAX);
    expect(drafts).toHaveLength(1);
    const d = drafts[0];
    expect(d.action).toBe("sell");
    expect(d.isin).toBe("US00287Y1091");
    // RC#5: name no longer swallows the ABRECHNUNG block.
    expect(d.name).toBe("AbbVie Inc. Registered Shares DL -,01");
    expect(d.price).toBe("142.76");
    expect(d.executedPrice).toBe("142.76");
    expect(d.fees).toBe("1.00");
    // Optimierung refund (net 1287.40 > gross 1284.84 − 1.00 fee) → negative realised tax.
    expect(d.tax).toBe("-3.56");
    expect(d.taxComponents?.kapitalertragsteuer).toBe("-3.38");
    expect(d.taxComponents?.solidaritaetszuschlag).toBe("-0.18");
  });

  it("parses a loss/FSA sell as genuinely tax-free (no tax line in the PDF)", () => {
    const { drafts } = parseTrPdf(SELL_NOTAX);
    expect(drafts).toHaveLength(1);
    const d = drafts[0];
    expect(d.action).toBe("sell");
    expect(d.isin).toBe("IE0031442068");
    expect(d.price).toBe("47.051");
    expect(d.tax ?? null).toBeNull();
    expect(d.taxComponents ?? null).toBeNull();
  });
});

describe("parseTrPdf — dividend", () => {
  it("parses a USD dividend with withholding tax and FX (previously returned [])", () => {
    const { drafts, errors } = parseTrPdf(DIVIDEND_USD);
    expect(errors).toEqual([]);
    expect(drafts).toHaveLength(1);
    const d = drafts[0];
    expect(d.action).toBe("dividend");
    expect(d.isin).toBe("US56035L1044");
    // RC#2: net EUR now resolves from the BETRAG <IBAN> <DD.MM.YYYY> <amount> layout.
    expect(d.price).toBe("5.51");
    // fxRate is now EUR-per-USD (5.51 net EUR ÷ 6.38 net USD), derived from the two
    // Zwischensumme AMOUNTS — not the printed "1.1567 USD/EUR" ratio/label (that direction
    // was the opposite of every other import path's convention; see tr-pdf.ts comment).
    expect(d.fxRate).toBe("0.863636");
    expect(d.tax).toBe("0.98");
    expect(d.taxComponents?.quellensteuer).toBe("0.98");
    expect(d.total).toBe("6.49");
    // New informational fields (per-share display), from "28.876429 Stücke 0.26 USD 7.51 USD".
    expect(d.shares).toBe("28.876429");
    expect(d.perShare).toBe("0.26");
    expect(d.nativeCurrency).toBe("USD");
    expect(d.grossNative).toBe("7.51");
  });

  it("parses a GBP dividend with no US withholding (currency generalized beyond USD)", () => {
    const gbpDividend =
      "Trade Republic Bank GmbH Brunnenstraße 19-21 10119 Berlin www.traderepublic.com Sitz der Gesellschaft: Berlin AG Charlottenburg HRB 244347 B Umsatzsteuer-ID DE307510626 Geschäftsführer Andreas Torner Gernot Mittendorfer Christian Hecker Thomas Pischke TRADE REPUBLIC BANK GMBH BRUNNENSTRASSE 19-21 10119 BERLIN SEITE 1 von 1 DATUM 26.09.2025 DEPOT 1234567890 DIVIDENDE ÜBERSICHT Dividende mit Ex-Datum 14.08.2025. POSITION ANZAHL ERTRAG BETRAG Rio Tinto GB0007188757 27.526515 Stücke 1.08580023 GBP 29.89 GBP GESAMT 29.89 GBP ABRECHNUNG POSITION BETRAG Zwischensumme 29.89 GBP Zwischensumme 0.8731 GBP/EUR 34.23 EUR GESAMT 34.23 EUR BUCHUNG VERRECHNUNGSKONTO DATUM DER ZAHLUNG BETRAG DE00000000000000000000 25.09.2025 34.23 EUR GB0007188757 in Wertpapierrechnung Diese Abrechnung wird maschinell erstellt und daher nicht unterschrieben. Wird keine Umsatzsteuer ausgewiesen, handelt es sich um eine umsatzsteuerfreie Leistung gemäß § 4 Nr. 8 UStG Max Mustermann Musterstr. 1 12345 Musterstadt";
    expect(detectTrPdf(gbpDividend)).toBe(true);
    const { drafts, errors } = parseTrPdf(gbpDividend);
    expect(errors).toEqual([]);
    expect(drafts).toHaveLength(1);
    const d = drafts[0];
    expect(d.action).toBe("dividend");
    expect(d.isin).toBe("GB0007188757");
    expect(d.currency).toBe("EUR");
    expect(d.price).toBe("34.23");
    expect(d.tax ?? null).toBeNull(); // no UK withholding, no German tax line in this doc
    expect(d.nativeCurrency).toBe("GBP");
    expect(d.grossNative).toBe("29.89");
    expect(d.shares).toBe("27.526515");
    expect(d.perShare).toBe("1.08580023");
    // 34.23 EUR ÷ 29.89 GBP.
    expect(d.fxRate).toBe("1.145199");
  });

  it("detects a WAHLDIVIDENDE (cash-elected scrip dividend) — same structure as a plain dividend", () => {
    const wahldividende =
      "Trade Republic Bank GmbH Brunnenstraße 19-21 10119 Berlin www.traderepublic.com service@traderepublic.com Sitz der Gesellschaft: Berlin AG Charlottenburg HRB 244347 B Umsatzsteuer-ID DE307510626 Direktoren Andreas Torner Gernot Mittendorfer TRADE REPUBLIC BANK GMBH BRUNNENSTRASSE 19-21 10119 BERLIN SEITE 1 von 1 DATUM 02.07.2024 DEPOT 1234567890 WAHLDIVIDENDE ÜBERSICHT Wahldividende mit Ex-Datum 21.06.2024. POSITION ANZAHL ERTRAG BETRAG Main Street Capital US56035L1044 28.151896 Stücke 0.3 USD 8.45 USD GESAMT 8.45 USD ABRECHNUNG POSITION BETRAG Quellensteuer für US-Emittenten -1.27 USD Zwischensumme 7.18 USD Zwischensumme 1.0689 USD/EUR 6.72 EUR Kapitalertragssteuer 1.0689 USD/EUR -0.78 EUR Solidaritätszuschlag 1.0689 USD/EUR -0.04 EUR GESAMT 5.90 EUR BUCHUNG VERRECHNUNGSKONTO DATUM DER ZAHLUNG BETRAG DE00000000000000000000 27.06.2024 5.90 EUR US56035L1044 in Wertpapierrechnung Diese Abrechnung wird maschinell erstellt und daher nicht unterschrieben. Wird keine Umsatzsteuer ausgewiesen, handelt es sich um eine umsatzsteuerfreie Leistung gemäß § 4 Nr. 8 UStG Max Mustermann Musterstr. 1 12345 Musterstadt";
    // Previously false: `\bDIVIDENDE\b` never matched inside the unbroken "WAHLDIVIDENDE" token.
    expect(detectTrPdf(wahldividende)).toBe(true);
    const { drafts, errors } = parseTrPdf(wahldividende);
    expect(errors).toEqual([]);
    expect(drafts).toHaveLength(1);
    const d = drafts[0];
    expect(d.action).toBe("dividend");
    expect(d.price).toBe("5.9");
    expect(d.nativeCurrency).toBe("USD");
    expect(d.grossNative).toBe("8.45");
    // Previously omitted entirely: Solidaritätszuschlag was never summed into dividend tax.
    expect(d.taxComponents?.solidaritaetszuschlag).toBe("0.04");
    expect(d.taxComponents?.kapitalertragsteuer).toBe("0.78");
    expect(d.tax).toBe("2.01"); // quellensteuer(≈1.19) + kapst(0.78) + soli(0.04)
  });

  it("parses a Format-A (German-locale/Stk.) GBP dividend with no source-country withholding", () => {
    const { drafts, errors } = parseTrPdf(DIVIDEND_GBP_FORMAT_A);
    expect(errors).toEqual([]);
    expect(drafts).toHaveLength(1);
    const d = drafts[0];
    expect(d.action).toBe("dividend");
    expect(d.isin).toBe("GB0007188757");
    expect(d.name).toBe("Rio Tinto PLC Registered Shares LS -,10");
    // BUCHUNG amount is German-locale ("46,53 EUR") — must NOT go through the US-locale
    // parser (which would strip the comma and yield "4653").
    expect(d.price).toBe("46.53");
    expect(d.shares).toBe("26.513245");
    expect(d.perShare).toBe("2.0377");
    expect(d.nativeCurrency).toBe("GBP");
    expect(d.grossNative).toBe("54.03");
    // No "Quellensteuer" line in this document (UK dividends carry no source withholding) —
    // only German Kapitalertragsteuer/Solidaritätszuschlag on the EUR gross.
    expect(d.taxComponents?.quellensteuer).toBeUndefined();
    expect(d.taxComponents?.kapitalertragsteuer).toBe("15.79");
    expect(d.taxComponents?.solidaritaetszuschlag).toBe("0.87");
    expect(d.tax).toBe("16.66");
    // total (63.19) reconciles exactly against the printed EUR Zwischensumme — net (46.53) +
    // tax (16.66).
    expect(d.total).toBe("63.19");
    expect(d.fxRate).toBe("1.169535"); // 63.19 EUR ÷ 54.03 GBP
  });

  it("parses a Format-A USD dividend, POSITION-table-first, singular Quellensteuer label", () => {
    const { drafts, errors } = parseTrPdf(DIVIDEND_USD_FORMAT_A);
    expect(errors).toEqual([]);
    expect(drafts).toHaveLength(1);
    const d = drafts[0];
    expect(d.action).toBe("dividend");
    expect(d.isin).toBe("US7134481081");
    // ISIN is labeled ("ISIN: <code>") in this era — the name must not swallow "ISIN:".
    expect(d.name).toBe("PepsiCo Inc. Registered Shares DL -,0166");
    expect(d.price).toBe("0.44");
    expect(d.shares).toBe("0.479969");
    expect(d.perShare).toBe("1.15");
    expect(d.nativeCurrency).toBe("USD");
    expect(d.grossNative).toBe("0.55");
    // "Quellensteuer für US-Emittent" (singular) — the newer template says "US-Emittenten".
    expect(d.taxComponents?.quellensteuer).toBe("0.07");
    expect(d.tax).toBe("0.07");
    expect(d.total).toBe("0.51");
  });

  it("parses an AUSSCHÜTTUNG (fund distribution, no DIVIDENDE keyword) as tax-free income", () => {
    expect(detectTrPdf(AUSSCHUETTUNG_FORMAT_A)).toBe(true);
    const { drafts, errors } = parseTrPdf(AUSSCHUETTUNG_FORMAT_A);
    expect(errors).toEqual([]);
    expect(drafts).toHaveLength(1);
    const d = drafts[0];
    expect(d.action).toBe("dividend");
    expect(d.isin).toBe("IE0031442068");
    expect(d.name).toBe("iShs Core S&P 500 UC.ETF USDD Registered Shares USD (Dist)oN");
    expect(d.price).toBe("0.83");
    expect(d.shares).toBe("5.98573");
    expect(d.perShare).toBe("0.1462");
    expect(d.nativeCurrency).toBe("USD");
    expect(d.grossNative).toBe("0.88");
    expect(d.tax ?? null).toBeNull();
    expect(d.taxComponents ?? null).toBeNull();
    expect(d.total).toBe("0.83");
  });
});

describe("parseTrPdf — interest (new branch)", () => {
  it("parses a Cash-Zinsen payout (gross, net, zero tax)", () => {
    const { drafts } = parseTrPdf(INTEREST);
    expect(drafts).toHaveLength(1);
    const d = drafts[0];
    expect(d.action).toBe("interest");
    expect(d.price).toBe("5.44");
    expect(d.total).toBe("5.44");
    expect(d.tax ?? null).toBeNull();
  });
});

describe("parseTrPdf — tax optimisation (new branch)", () => {
  it("parses a KapSt/Soli refund as a deposit with negative tax", () => {
    const { drafts } = parseTrPdf(TAXOPT_REFUND);
    expect(drafts).toHaveLength(1);
    const d = drafts[0];
    expect(d.action).toBe("deposit");
    // Cash credited (refund) → tax paid is negative (reduces the year's withheld tax).
    expect(d.tax).toBe("-1.67");
    expect(d.taxComponents?.kapitalertragsteuer).toBe("-1.57");
    expect(d.taxComponents?.solidaritaetszuschlag).toBe("-0.10");
  });

  it("parses a KapSt/Soli charge as a withdrawal with positive tax", () => {
    const { drafts } = parseTrPdf(TAXOPT_CHARGE);
    expect(drafts).toHaveLength(1);
    const d = drafts[0];
    expect(d.action).toBe("withdrawal");
    expect(d.tax).toBe("1.77");
    expect(d.taxComponents?.kapitalertragsteuer).toBe("1.68");
    expect(d.taxComponents?.solidaritaetszuschlag).toBe("0.09");
  });
});
