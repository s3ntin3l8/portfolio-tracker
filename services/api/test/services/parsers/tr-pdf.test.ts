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
    expect(d.fxRate).toBe("1.1567");
    expect(d.tax).toBe("0.98");
    expect(d.taxComponents?.quellensteuer).toBe("0.98");
    expect(d.total).toBe("6.49");
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
