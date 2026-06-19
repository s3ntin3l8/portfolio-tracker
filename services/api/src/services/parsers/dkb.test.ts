import { describe, expect, it } from "vitest";
import {
  parseDkb,
  parseDkbDate,
  parseEuroDecimal,
  splitDkbLine,
} from "./dkb.js";

// Real DKB export layouts, with personal names anonymised. Securities data (ISINs,
// amounts, free-text Verwendungszweck) is preserved verbatim.

const DEPOT_CSV = [
  "Datum der Erstellung;Depotnummer;Wertpapierbezeichnung;WKN;ISIN;Einstiegskurs;Bewertungskurs;Stückzahl;Absoluter Gewinn;Relativer Gewinn;Assetklasse",
  '15.06.2026;506740786;"AMAZON.COM INC.    DL-,01";906866;US0231351067;"81,37 €";"210,10 €";5;"643,65 €";158.2%;Aktien',
  '15.06.2026;506740786;"TESLA INC. DL -,001";A1CX3T;US88160R1014;"180,20 €";"353,25 €";2;"346,10 €";96.03%;Aktien',
  "15.06.2026;506740786;AIS-A.CO.MSCI E.M.UETFDRD;A2H9Q0;LU1737652583;\"50,46 €\";\"76,89 €\";\"63,3685\";\"1.674,43 €\";52.36%;ETFs",
  "15.06.2026;506740786;AMUNDI CORE MSCI WLD UE D;A3DH0A;IE000CNSFAR2;\"11,54 €\";\"15,56 €\";\"663,0698\";\"2.663,12 €\";34.8%;ETFs",
  '15.06.2026;506740786;"MICROSOFT    DL-,00000625";870747;US5949181045;"280,55 €";"341,65 €";1;"61,10 €";21.78%;Aktien',
].join("\n");

const GIRO_CSV = [
  '"Girokonto u18";"DE78120300001066505387"',
  '"Zeitraum:";"01.01.2026 - 15.06.2026"',
  '"Kontostand vom 15.06.2026:";"100,67 €"',
  '""',
  '"Buchungsdatum";"Wertstellung";"Status";"Zahlungspflichtige*r";"Zahlungsempfänger*in";"Verwendungszweck";"Umsatztyp";"IBAN";"Betrag (€)";"Gläubiger-ID";"Mandatsreferenz";"Kundenreferenz"',
  '"15.06.26";"12.06.26";"Gebucht";"DKB AG";"Max Mustermann";"Depot 0506740786 Wertpapierertrag 12.06.2026 000066336002660 WKN 870747 MICROSOFT    DL-,00000625 ISIN US5949181045";"Eingang";"0000000000";"0,67";"";"";""',
  '"08.06.26";"09.06.26";"Gebucht";"Max Mustermann";"DKB AG";"Depot 0506740786 Wertp.Abrechn. 05.06.2026 000006520078300 WKN A2H9Q0 Gesch.Art KV AIS-A.CO.MSCI E.M.UETFDRD ISIN LU1737652583 Ihr Wertpapier-Sparplan Preis       74,50600000 EUR Stück           0,3355";"Ausgang";"0000000000";"-25";"";"";""',
  '"10.02.26";"14.02.26";"Gebucht";"Max Mustermann";"DKB AG";"Depot 0506740786 Wertp.Abrechn. 10.02.2026 000004744649900 WKN 870747 Gesch.Art KD MICROSOFT CORP ISIN US5949181045 Preis      270,55000000 EUR Stück           1";"Ausgang";"0000000000";"-280,55";"";"";""',
  '"01.06.26";"01.06.26";"Gebucht";"Erika Mustermann";"FRAU MAX MUSTERMANN";"Sparplan";"Eingang";"DE69120300001053487276";"75";"";"";""',
  '"13.04.26";"11.04.26";"Gebucht";"Max Mustermann";"Erika Mustermann";"Übertrag TR Max für Einmalanlage";"Ausgang";"DE15100123450587698301";"-509,59";"";"";""',
  '"01.04.26";"01.04.26";"Gebucht";"DKB AG";"DKB AG";"Abrechnung 31.03.2026 siehe Anlage Kontostand am 31.03.2026 459,59 +";"Eingang";"1066505387";"0";"";"";""',
].join("\n");

describe("parseEuroDecimal", () => {
  it("handles € suffix, thousands dot and decimal comma", () => {
    expect(parseEuroDecimal("81,37 €")).toBe("81.37");
    expect(parseEuroDecimal("1.674,43 €")).toBe("1674.43");
    expect(parseEuroDecimal("74,50600000")).toBe("74.50600000");
    expect(parseEuroDecimal("63,3685")).toBe("63.3685");
  });

  it("handles bare signed integers and dot-grouped thousands", () => {
    expect(parseEuroDecimal("-25")).toBe("-25");
    expect(parseEuroDecimal("113")).toBe("113");
    expect(parseEuroDecimal("0")).toBe("0");
    expect(parseEuroDecimal("1.674")).toBe("1674");
  });

  it("returns null for empty / unparseable input", () => {
    expect(parseEuroDecimal("")).toBeNull();
    expect(parseEuroDecimal(null)).toBeNull();
    expect(parseEuroDecimal("n/a")).toBeNull();
  });
});

describe("parseDkbDate", () => {
  it("parses 4-digit and 2-digit years", () => {
    expect(parseDkbDate("15.06.2026")?.toISOString()).toBe("2026-06-15T00:00:00.000Z");
    expect(parseDkbDate("08.06.26")?.toISOString()).toBe("2026-06-08T00:00:00.000Z");
  });

  it("returns null for malformed dates", () => {
    expect(parseDkbDate("2026-06-15")).toBeNull();
    expect(parseDkbDate("")).toBeNull();
  });
});

describe("splitDkbLine", () => {
  it("keeps commas and space runs inside quoted fields", () => {
    const cols = splitDkbLine('15.06.2026;"AMAZON.COM INC.    DL-,01";US0231351067');
    expect(cols).toEqual([
      "15.06.2026",
      "AMAZON.COM INC.    DL-,01",
      "US0231351067",
    ]);
  });
});

describe("parseDkb — depot positions snapshot", () => {
  const { drafts, errors, accountNumber } = parseDkb(DEPOT_CSV);

  it("extracts the Depotnummer as the account number", () => {
    expect(accountNumber).toBe("506740786");
  });

  it("turns every position into a buy draft with no errors", () => {
    expect(errors).toEqual([]);
    expect(drafts).toHaveLength(5);
    expect(drafts.every((d) => d.action === "buy")).toBe(true);
    expect(drafts.every((d) => d.currency === "EUR")).toBe(true);
  });

  it("maps Assetklasse and reads entry price + fractional quantity", () => {
    const amazon = drafts[0];
    expect(amazon).toMatchObject({
      assetClass: "equity",
      isin: "US0231351067",
      name: "AMAZON.COM INC. DL-,01",
      quantity: "5",
      price: "81.37",
      unit: "shares",
    });
    expect(amazon.executedAt.toISOString()).toBe("2026-06-15T00:00:00.000Z");

    const emEtf = drafts[2];
    expect(emEtf).toMatchObject({
      assetClass: "etf",
      isin: "LU1737652583",
      quantity: "63.3685",
      price: "50.46",
    });
  });
});

describe("parseDkb — Girokonto Umsatzliste", () => {
  const { drafts, errors, accountNumber } = parseDkb(GIRO_CSV);

  it("extracts the account IBAN from the preamble (not a counterparty IBAN)", () => {
    expect(accountNumber).toBe("DE78120300001066505387");
  });

  it("skips the preamble and the zero-amount Abrechnung row", () => {
    expect(errors).toEqual([]);
    // dividend + savings-plan buy + one-off buy + deposit + withdrawal (Abrechnung Betrag 0 dropped)
    expect(drafts).toHaveLength(5);
  });

  it("extracts a savings-plan buy from the free-text Verwendungszweck", () => {
    const buy = drafts.find((d) => d.action === "savings_plan");
    expect(buy).toMatchObject({
      action: "savings_plan",
      isin: "LU1737652583",
      name: "AIS-A.CO.MSCI E.M.UETFDRD",
      quantity: "0.3355",
      price: "74.50600000",
      currency: "EUR",
      externalId: "dkb:000006520078300",
      // The cash leg is kept as `total`; price·qty rounds to the cash amount → fee-free.
      total: "25",
      fees: "0",
    });
    expect(buy?.executedAt.toISOString()).toBe("2026-06-05T00:00:00.000Z");
  });

  it("keeps the settlement amount as total and backs out the Provision as fees", () => {
    const buy = drafts.find((d) => d.action === "buy");
    expect(buy).toMatchObject({
      action: "buy",
      isin: "US5949181045",
      wkn: "870747",
      name: "MICROSOFT CORP",
      quantity: "1",
      price: "270.55000000",
      // Betrag 280,55 = Kurswert 270,55 + Provision 10,00.
      total: "280.55",
      fees: "10",
      externalId: "dkb:000004744649900",
    });
    expect(buy?.executedAt.toISOString()).toBe("2026-02-10T00:00:00.000Z");
  });

  it("maps Wertpapierertrag to a dividend with the payout in price", () => {
    const div = drafts.find((d) => d.action === "dividend");
    expect(div).toMatchObject({
      action: "dividend",
      isin: "US5949181045",
      name: "MICROSOFT DL-,00000625",
      quantity: "0",
      price: "0.67",
      externalId: "dkb:000066336002660",
    });
    expect(div?.executedAt.toISOString()).toBe("2026-06-12T00:00:00.000Z");
  });

  it("maps incoming cash to a deposit and outgoing to a withdrawal", () => {
    const deposit = drafts.find((d) => d.action === "deposit");
    expect(deposit).toMatchObject({
      action: "deposit",
      quantity: "0",
      price: "75",
      currency: "EUR",
      name: "Erika Mustermann",
    });
    expect(deposit?.isin).toBeFalsy();

    const withdrawal = drafts.find((d) => d.action === "withdrawal");
    expect(withdrawal).toMatchObject({
      action: "withdrawal",
      price: "509.59",
      name: "Erika Mustermann",
    });
    expect(withdrawal?.executedAt.toISOString()).toBe("2026-04-13T00:00:00.000Z");
  });
});

describe("parseDkb — unrecognised format", () => {
  it("reports an error rather than throwing", () => {
    const { drafts, errors } = parseDkb("foo;bar;baz\n1;2;3");
    expect(drafts).toEqual([]);
    expect(errors[0]?.message).toMatch(/unrecognised/);
  });
});
