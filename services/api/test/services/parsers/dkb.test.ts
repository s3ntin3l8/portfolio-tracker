import { describe, it, expect } from "vitest";
import { parseDkb } from "../../../src/services/parsers/dkb.js";

// DKB Girokonto Umsatzliste header (mirrors the route fixtures).
const HEADER = [
  '"Girokonto";"DE78120300001066505387"',
  '"Zeitraum:";"01.01.2026 - 15.06.2026"',
  '""',
  '"Buchungsdatum";"Wertstellung";"Status";"Zahlungspflichtige*r";"Zahlungsempfänger*in";"Verwendungszweck";"Umsatztyp";"IBAN";"Betrag (€)";"Gläubiger-ID";"Mandatsreferenz";"Kundenreferenz"',
];

describe("parseDkb — Decimal price back-out (no Preis token)", () => {
  it("backs the per-share price out of the settlement amount with Decimal precision", () => {
    // A one-off market buy: Stück present, NO "Preis" token, settlement Betrag -100.
    // 100 / 3 is a repeating decimal — Decimal rounds it cleanly to 8 dp, and the fee
    // collapses to 0 (price·qty reconstructs the settlement amount).
    const row =
      '"08.06.26";"09.06.26";"Gebucht";"Max Mustermann";"DKB AG";"Depot 0506740786 Wertp.Abrechn. 05.06.2026 000006520078300 WKN A2H9Q0 Gesch.Art KV TESTFUND ISIN LU1737652583 Stück           3";"Ausgang";"0000000000";"-100";"";"";""';
    const { drafts, errors } = parseDkb([...HEADER, row].join("\n"));
    expect(errors).toEqual([]);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      action: "buy",
      quantity: "3",
      price: "33.33333333",
      fees: "0",
    });
  });
});
