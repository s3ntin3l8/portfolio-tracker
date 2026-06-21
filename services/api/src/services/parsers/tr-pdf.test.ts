/**
 * Tests for services/api/src/services/parsers/tr-pdf.ts.
 *
 * Fixtures are synthetic text strings that drive the parser's regexes — NOT real PDFs
 * or screenshots; no personal data (DEPOT number, name, signed URLs) is included.
 * Each fixture is minimal: it includes only the lines that the parser actually reads.
 */
import { describe, expect, it } from "vitest";
import { detectTrPdf, parseTrPdf } from "./tr-pdf.js";

// ---------------------------------------------------------------------------
// Minimal fixture builders
// ---------------------------------------------------------------------------

/** Build a minimal TR trade settlement (Wertpapierabrechnung) text. */
function trTradeFixture(overrides: {
  action?: "buy" | "sell" | "savings_plan" | "saveback" | "roundup";
  isin?: string;
  name?: string;
  qty?: string;
  price?: string;
  total?: string;
  fees?: string;
  kapst?: string;
  solz?: string;
  kirche?: string;
  settlement?: string;
  auftrag?: string;
  ausfuehrung?: string;
  depot?: string;
} = {}): string {
  const {
    action = "buy",
    isin = "IE00B5BMR087",
    name = "iShares Core MSCI World UCITS ETF",
    qty = "10",
    price = "100,00",
    total = "999,00",
    fees = action === "buy" ? "-1,00" : "0,00",
    kapst = "0,00",
    solz = "0,00",
    kirche,
    settlement = "2025-02-25",
    auftrag = "abc1-2345",
    ausfuehrung = "def6-7890",
    depot = "1234567890",
  } = overrides;

  const actionLine =
    action === "savings_plan"
      ? "ÜBERSICHT Sparplanausführung an der Tradegate Exchange"
      : action === "saveback"
        ? "ÜBERSICHT Saveback an der Lang und Schwarz Exchange"
        : action === "roundup"
          ? "ÜBERSICHT Round-up an der Lang und Schwarz Exchange"
          : action === "sell"
            ? "ÜBERSICHT SELL an der Tradegate Exchange"
            : "ÜBERSICHT Kauf an der Tradegate Exchange";

  const kircheLine = kirche ? `Kirchensteuer ${kirche} EUR` : "";

  return [
    "Trade Republic Bank GmbH",
    `DATUM 25.02.2025 AUFTRAG ${auftrag} AUSFÜHRUNG ${ausfuehrung} DEPOT ${depot}`,
    "WERTPAPIERABRECHNUNG",
    actionLine,
    `POSITION ANZAHL PREIS BETRAG`,
    `BETRAG ${name} ISIN: ${isin} ${qty} Stk. ${price} EUR ${total} EUR`,
    "ABRECHNUNG",
    `Fremdkostenzuschlag ${fees} EUR`,
    `Kapitalertragsteuer ${kapst} EUR`,
    `Solidaritätszuschlag ${solz} EUR`,
    kircheLine,
    "BUCHUNG",
    `WERTSTELLUNG ${settlement} ${total} EUR`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Build a minimal TR dividend (DIVIDENDE) text. */
function trDividendFixture(overrides: {
  isin?: string;
  name?: string;
  qty?: string;
  fxRate?: string;
  quellenUsd?: string;
  kapstEur?: string;
  netEur?: string;
  payDate?: string;
  depot?: string;
} = {}): string {
  const {
    isin = "US0378331005",
    name = "Apple Inc.",
    qty = "0.459173",
    fxRate = "1.1567",
    quellenUsd = "0.02",
    kapstEur = "0.01",
    netEur = "0.04",
    payDate = "2025-02-25",
    depot = "1234567890",
  } = overrides;

  return [
    "Trade Republic Bank GmbH",
    `DATUM 25.02.2025 DEPOT ${depot}`,
    "DIVIDENDE",
    `POSITION ANZAHL ERTRAG BETRAG`,
    `BETRAG ${name} ${isin} ${qty} Stücke`,
    `Quellensteuer für US-Emittenten -${quellenUsd} USD`,
    `Zwischensumme ${fxRate} USD/EUR`,
    `Kapitalertragsteuer ${fxRate} USD/EUR -${kapstEur} EUR`,
    "BUCHUNG",
    `DATUM DER ZAHLUNG ${payDate} ${netEur} EUR`,
  ].join("\n");
}

/** A minimal cost-information doc (should NOT trigger detectTrPdf). */
const COST_INFO_TEXT = [
  "Trade Republic Bank GmbH",
  "DATUM 25.02.2025",
  "Kosteninformation",
  "Gesamtkosten",
].join("\n");

/** A minimal order-confirmation doc (should NOT trigger detectTrPdf). */
const ORDER_CONFIRM_TEXT = [
  "Trade Republic Bank GmbH",
  "DATUM 25.02.2025",
  "Auftragsbestätigung",
  "Kauf von Aktien",
].join("\n");

// ---------------------------------------------------------------------------
// detectTrPdf
// ---------------------------------------------------------------------------

describe("detectTrPdf", () => {
  it("returns true for a trade settlement (Wertpapierabrechnung)", () => {
    expect(detectTrPdf(trTradeFixture())).toBe(true);
  });

  it("returns true for a sell confirmation", () => {
    expect(detectTrPdf(trTradeFixture({ action: "sell" }))).toBe(true);
  });

  it("returns true for a savings-plan execution (Sparplanausführung)", () => {
    expect(detectTrPdf(trTradeFixture({ action: "savings_plan" }))).toBe(true);
  });

  it("returns true for a dividend income doc", () => {
    expect(detectTrPdf(trDividendFixture())).toBe(true);
  });

  it("returns false for a cost-information document", () => {
    expect(detectTrPdf(COST_INFO_TEXT)).toBe(false);
  });

  it("returns false for an order-confirmation document", () => {
    expect(detectTrPdf(ORDER_CONFIRM_TEXT)).toBe(false);
  });

  it("returns false for an unrelated string", () => {
    expect(detectTrPdf("This is a DKB PDF with completely different text")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseTrPdf — trade settlements
// ---------------------------------------------------------------------------

describe("parseTrPdf — trade buy", () => {
  const text = trTradeFixture({
    qty: "10",
    price: "100,00",
    total: "999,00",
    fees: "-1,00",
    kapst: "3,75",
    solz: "0,21",
    auftrag: "abc1-2345",
    ausfuehrung: "def6-7890",
    settlement: "2025-02-25",
  });

  it("produces exactly one draft", () => {
    const { drafts, errors } = parseTrPdf(text);
    expect(errors).toHaveLength(0);
    expect(drafts).toHaveLength(1);
  });

  it("parses action, ISIN, quantity, price", () => {
    const [d] = parseTrPdf(text).drafts;
    expect(d.action).toBe("buy");
    expect(d.isin).toBe("IE00B5BMR087");
    expect(Number(d.quantity)).toBeCloseTo(10, 2);
    expect(Number(d.price)).toBeCloseTo(100, 1);
  });

  it("captures AUFTRAG as orderRef and AUSFÜHRUNG as externalId", () => {
    const [d] = parseTrPdf(text).drafts;
    expect(d.orderRef).toBe("abc1-2345");
    expect(d.externalId).toBe("tr:exec:def6-7890");
  });

  it("captures fees from Fremdkostenzuschlag (leading-minus)", () => {
    const [d] = parseTrPdf(text).drafts;
    expect(Number(d.fees)).toBeCloseTo(1.0, 2);
  });

  it("sums tax from KapSt + SolZ and exposes taxComponents", () => {
    const [d] = parseTrPdf(text).drafts;
    // tax == kapst + solz = 3.75 + 0.21 = 3.96
    expect(Number(d.tax)).toBeCloseTo(3.96, 2);
    expect(Number(d.taxComponents?.kapitalertragsteuer)).toBeCloseTo(3.75, 2);
    expect(Number(d.taxComponents?.solidaritaetszuschlag)).toBeCloseTo(0.21, 2);
  });

  it("tax rollup equals sum of taxComponents", () => {
    const [d] = parseTrPdf(text).drafts;
    const tc = d.taxComponents!;
    const componentSum =
      Number(tc.kapitalertragsteuer ?? 0) +
      Number(tc.solidaritaetszuschlag ?? 0) +
      Number(tc.kirchensteuer ?? 0);
    expect(Number(d.tax)).toBeCloseTo(componentSum, 5);
  });

  it("parses settlement date from WERTSTELLUNG", () => {
    const [d] = parseTrPdf(text).drafts;
    const day = (d.executedAt instanceof Date ? d.executedAt : new Date(d.executedAt))
      .toISOString()
      .slice(0, 10);
    expect(day).toBe("2025-02-25");
  });
});

describe("parseTrPdf — sell with all three German tax components", () => {
  const text = trTradeFixture({
    action: "sell",
    qty: "5",
    price: "200,00",
    fees: "-1,00",
    kapst: "5,00",
    solz: "0,27",
    kirche: "0,45",
    ausfuehrung: "aaa1-bbbb",
    settlement: "2025-03-01",
  });

  it("action is sell", () => {
    const [d] = parseTrPdf(text).drafts;
    expect(d.action).toBe("sell");
  });

  it("includes Kirchensteuer in taxComponents and tax rollup", () => {
    const [d] = parseTrPdf(text).drafts;
    const tc = d.taxComponents!;
    expect(Number(tc.kapitalertragsteuer)).toBeCloseTo(5.0, 2);
    expect(Number(tc.solidaritaetszuschlag)).toBeCloseTo(0.27, 2);
    expect(Number(tc.kirchensteuer)).toBeCloseTo(0.45, 2);
    // Rollup = 5.00 + 0.27 + 0.45 = 5.72
    expect(Number(d.tax)).toBeCloseTo(5.72, 2);
  });

  it("tax rollup equals sum of all three tax components", () => {
    const [d] = parseTrPdf(text).drafts;
    const tc = d.taxComponents!;
    const componentSum =
      Number(tc.kapitalertragsteuer ?? 0) +
      Number(tc.solidaritaetszuschlag ?? 0) +
      Number(tc.kirchensteuer ?? 0);
    expect(Number(d.tax)).toBeCloseTo(componentSum, 5);
  });
});

describe("parseTrPdf — savings plan (Sparplanausführung)", () => {
  const text = trTradeFixture({
    action: "savings_plan",
    qty: "1,3358",
    price: "72,614",
    total: "97,00",
    fees: "0,00",
    kapst: "0,00",
    solz: "0,00",
    auftrag: "spar-0001",
    ausfuehrung: "spar-exec-0001",
  });

  it("action is savings_plan", () => {
    const [d] = parseTrPdf(text).drafts;
    expect(d.action).toBe("savings_plan");
  });

  it("parses German comma-decimal quantity", () => {
    const [d] = parseTrPdf(text).drafts;
    expect(Number(d.quantity)).toBeCloseTo(1.3358, 4);
  });
});

describe("parseTrPdf — split order (two legs, same AUFTRAG)", () => {
  // Real TR AUFTRAG IDs are lowercase hex with hyphens (e.g. "18c9-92a6").
  const legA = trTradeFixture({
    qty: "27",
    price: "130,50",
    fees: "-1,00",
    kapst: "0,00",
    solz: "0,00",
    auftrag: "18c9-92a6",
    ausfuehrung: "aaaa-1111",
  });
  const legB = trTradeFixture({
    qty: "0,526515",
    price: "130,50",
    fees: "0,00",
    kapst: "0,00",
    solz: "0,00",
    auftrag: "18c9-92a6",
    ausfuehrung: "bbbb-2222",
  });

  it("leg A has the correct orderRef and externalId", () => {
    const [d] = parseTrPdf(legA).drafts;
    expect(d.orderRef).toBe("18c9-92a6");
    expect(d.externalId).toBe("tr:exec:aaaa-1111");
  });

  it("leg B has the same orderRef but different externalId", () => {
    const [d] = parseTrPdf(legB).drafts;
    expect(d.orderRef).toBe("18c9-92a6");
    expect(d.externalId).toBe("tr:exec:bbbb-2222");
  });

  it("both legs use the stated PREIS (not recomputed)", () => {
    const [dA] = parseTrPdf(legA).drafts;
    const [dB] = parseTrPdf(legB).drafts;
    expect(Number(dA.price)).toBeCloseTo(130.5, 1);
    expect(Number(dB.price)).toBeCloseTo(130.5, 1);
  });
});

// ---------------------------------------------------------------------------
// parseTrPdf — dividend income (US decimal locale)
// ---------------------------------------------------------------------------

describe("parseTrPdf — USD dividend", () => {
  const text = trDividendFixture({
    isin: "US0378331005",
    qty: "0.459173",
    fxRate: "1.1567",
    quellenUsd: "0.02",
    kapstEur: "0.01",
    netEur: "0.04",
    payDate: "2025-02-25",
    depot: "9876543210",
  });

  it("produces one dividend draft", () => {
    const { drafts, errors } = parseTrPdf(text);
    expect(errors).toHaveLength(0);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].action).toBe("dividend");
  });

  it("parses US decimal quantity", () => {
    const [d] = parseTrPdf(text).drafts;
    expect(Number(d.quantity)).toBe(0);
  });

  it("captures the FX rate", () => {
    const [d] = parseTrPdf(text).drafts;
    expect(Number(d.fxRate)).toBeCloseTo(1.1567, 4);
  });

  it("converts Quellensteuer from USD to EUR via the FX rate", () => {
    const [d] = parseTrPdf(text).drafts;
    const tc = d.taxComponents!;
    // quellenUsd=0.02, fxRate=1.1567 → quellenEur=0.02/1.1567≈0.017
    expect(Number(tc.quellensteuer)).toBeCloseTo(0.02 / 1.1567, 2);
  });

  it("tax rollup is quellensteuer + kapst (in EUR)", () => {
    const [d] = parseTrPdf(text).drafts;
    const tc = d.taxComponents!;
    const componentSum = Number(tc.quellensteuer ?? 0) + Number(tc.kapitalertragsteuer ?? 0);
    expect(Number(d.tax)).toBeCloseTo(componentSum, 5);
  });

  it("generates a stable externalId from depot+isin+paydate", () => {
    const [d] = parseTrPdf(text).drafts;
    expect(d.externalId).toBe("tr:div:9876543210:US0378331005:2025-02-25");
  });
});
