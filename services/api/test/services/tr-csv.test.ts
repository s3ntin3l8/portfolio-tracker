import { describe, it, expect } from "vitest";
import { parseTrCsv } from "../../src/services/parsers/tr-csv.js";
import { detectCsvFormat } from "../../src/services/parsers/detect.js";

// Sanitised rows modelled on a real Trade Republic "Transaction export" (names →
// Max Mustermann, IBANs/UUIDs zeroed — detect-secrets runs in pre-commit). The figures are
// the ones that exercise the mapping rules: net-vs-gross dividends, fee-separate trades,
// FX, crypto, cashback, share-in corporate actions and the unmappable tax adjustments.
const COLS = [
  "datetime", "date", "account_type", "category", "type", "asset_class", "name", "symbol",
  "shares", "price", "amount", "fee", "tax", "currency", "original_amount",
  "original_currency", "fx_rate", "description", "transaction_id", "counterparty_name",
  "counterparty_iban", "payment_reference", "mcc_code",
];
const HEADER = COLS.join(",");
const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
function row(f: Record<string, string>): string {
  return COLS.map((c) => `"${(f[c] ?? "").replace(/"/g, '""')}"`).join(",");
}
function csv(rows: Record<string, string>[]): string {
  return [HEADER, ...rows.map(row)].join("\n");
}

const ROWS: Record<string, string>[] = [
  // deposit (note the embedded comma — must survive quote-aware splitting)
  { datetime: "2023-01-31T22:20:28.617262Z", category: "CASH", type: "CUSTOMER_INPAYMENT",
    amount: "500.000000", currency: "EUR", description: "Customer inpayment, net 500", transaction_id: id(1) },
  // stock buy: |amount| = shares*price, fee separate
  { datetime: "2022-08-18T19:17:06.465Z", category: "TRADING", type: "BUY", asset_class: "STOCK",
    name: "Alphabet (C)", symbol: "US02079K1079", shares: "2.0000000000", price: "120.260000",
    amount: "-240.52", fee: "-1.00", currency: "EUR", transaction_id: id(2) },
  // crypto buy: ticker, units
  { datetime: "2021-07-25T06:58:14.412Z", category: "TRADING", type: "BUY", asset_class: "CRYPTO",
    name: "Ethereum", symbol: "ETH", shares: "0.1200000000", price: "1859.500000",
    amount: "-223.14", fee: "-1.00", currency: "EUR", transaction_id: id(3) },
  // sell: negative shares → positive quantity, positive amount
  { datetime: "2024-03-22T15:57:31.844Z", category: "TRADING", type: "SELL", asset_class: "STOCK",
    name: "E.ON", symbol: "DE000ENAG999", shares: "-42.0000000000", price: "12.440000",
    amount: "522.48", fee: "-1.00", currency: "EUR", transaction_id: id(4) },
  // USD dividend with withholding tax + FX: price = NET (gross − tax), total = gross
  { datetime: "2025-05-09T01:10:00.000000Z", category: "CASH", type: "DIVIDEND", asset_class: "STOCK",
    name: "Altria Group", symbol: "US02209S1033", shares: "11.0000000000", amount: "3.940000",
    tax: "-0.59", currency: "EUR", original_amount: "3.57", original_currency: "USD",
    fx_rate: "1.103400", transaction_id: id(5) },
  // fund distribution, no tax, HTML-escaped name
  { datetime: "2024-01-02T23:05:45.497301Z", category: "CASH", type: "DISTRIBUTION", asset_class: "FUND",
    name: "Core S&amp;P 500 USD (Dist)", symbol: "IE0031442068", shares: "5.9857000000",
    amount: "0.790000", currency: "EUR", original_amount: "0.71", original_currency: "USD",
    fx_rate: "1.106930", transaction_id: id(6) },
  // interest, tax explicitly "0.00" (→ no tax)
  { datetime: "2023-03-01T10:29:28.417746Z", category: "CASH", type: "INTEREST_PAYMENT",
    amount: "1.740000", tax: "0.00", currency: "EUR", description: "Interest payment Booking", transaction_id: id(7) },
  // domestic card spend → withdrawal
  { datetime: "2024-11-24T09:16:54.048610Z", category: "CASH", type: "CARD_TRANSACTION",
    name: "Some Merchant", amount: "-34.810000", currency: "EUR", description: "TR Card Transaction",
    transaction_id: id(8), mcc_code: "5712" },
  // international card spend → withdrawal, carries fx_rate
  { datetime: "2024-11-24T13:19:11.897913Z", category: "CASH", type: "CARD_TRANSACTION_INTERNATIONAL",
    name: "Foreign Merchant", amount: "-231.690000", currency: "EUR", original_amount: "-5866.19",
    original_currency: "CZK", fx_rate: "0.039496", description: "TR Card Transaction",
    transaction_id: id(9), mcc_code: "5309" },
  // card ordering fee: amount 0, the charge lives in `fee`
  { datetime: "2024-05-06T11:47:18.865042Z", category: "CASH", type: "CARD_ORDERING_FEE",
    amount: "0.000000", fee: "-5.00", currency: "EUR", description: "Trade Republic Card", transaction_id: id(10) },
  // saveback cashback: reward credit → bonus_cash (collapses into its funding buy when one
  // exists; none in this fixture, so it stays a standalone bonus_cash income row). Name kept.
  { datetime: "2025-02-03T15:59:12.456716Z", category: "CASH", type: "BENEFITS_SAVEBACK", asset_class: "FUND",
    name: "Core S&amp;P 500 USD (Acc)", symbol: "IE00B5BMR087", amount: "0.550000", currency: "EUR",
    description: "Your Saveback payment", transaction_id: id(11) },
  // promo bonus: deposit + kind
  { datetime: "2025-12-11T16:59:40.549057Z", category: "CASH", type: "BONUS",
    amount: "22.860000", currency: "EUR", description: "Crypto bonus", transaction_id: id(12) },
  // free receipt (gifted shares): bonus, currency column blank → EUR default
  { datetime: "2022-09-16T20:41:14.655Z", category: "DELIVERY", type: "FREE_RECEIPT", asset_class: "STOCK",
    name: "Rio Tinto", symbol: "GB0007188757", shares: "21.0000000000", description: "FREE_RECEIPT", transaction_id: id(13) },
  // dividend reinvestment: bonus (shares in, no cash)
  { datetime: "2025-05-02T09:48:13.603Z", category: "CORPORATE_ACTION", type: "DIVIDEND_REINVESTMENT", asset_class: "STOCK",
    name: "Rio Tinto", symbol: "GB0007188757", shares: "1.0132700000", description: "DIVIDEND_REINVESTMENT", transaction_id: id(14) },
  // instant transfer out → withdrawal
  { datetime: "2024-12-28T08:45:09.549709Z", category: "CASH", type: "TRANSFER_INSTANT_OUTBOUND",
    amount: "-1100.000000", currency: "EUR", description: "Outgoing transfer", transaction_id: id(15) },
  // incoming cash transfer (parent funding a JUNIOR depot) → deposit
  { datetime: "2025-08-18T08:15:36.694729Z", category: "CASH", type: "TRANSFER_IN",
    amount: "100.000000", currency: "EUR", description: "Incoming transfer from Björn", transaction_id: id(20) },
  // Kindergeld promo bonus → bonus_cash + kind "bonus", tiny positive cash credit
  { datetime: "2025-09-02T14:49:49.518403Z", category: "CASH", type: "KINDERGELD_BONUS",
    amount: "0.010000", currency: "EUR", description: "Your Kindergeld bonus", transaction_id: id(21) },
  // stock perk credited as cash (instrument present but NO shares) → bonus_cash + kind "bonus"
  { datetime: "2025-08-26T14:01:55.126058Z", category: "CASH", type: "STOCKPERK", asset_class: "FUND",
    name: "Lifestrategy 80% Equity EUR (Acc)", symbol: "IE00BMVB5R75", amount: "101.190000",
    currency: "EUR", description: "Stockperk", transaction_id: id(22) },
  // dividend reversal (TR correction): amount negative, tax positive → negative net + negative tax
  { datetime: "2025-11-15T10:00:00.000000Z", category: "CASH", type: "DIVIDEND", asset_class: "STOCK",
    name: "Altria Group", symbol: "US02209S1033", shares: "11.0000000000", amount: "-0.10",
    tax: "0.03", currency: "EUR", transaction_id: id(24) },
  // Vorabpauschale (advance fund tax): gross 0, only tax withheld → negative-cash income leg
  { datetime: "2026-01-28T07:42:17.274554Z", category: "CASH", type: "EARNINGS", asset_class: "FUND",
    name: "FTSE All-World USD (Acc)", symbol: "IE00BK5BQT80", amount: "0.000000", tax: "-0.06",
    currency: "EUR", description: "Vorabpauschale for ISIN IE00BK5BQT80", transaction_id: id(23) },
  // FREE_RECEIPT WITH a price = crypto grant (income at market basis, NOT a transfer)
  { datetime: "2021-07-01T00:00:00.000Z", category: "DELIVERY", type: "FREE_RECEIPT", asset_class: "CRYPTO",
    name: "Bitcoin", symbol: "BTC", shares: "0.001", price: "32000.00",
    currency: "EUR", transaction_id: id(25) },
  // sell WITH withholding tax: amount=net cash, fee separate, tax separate
  // gross 500, fee 1, tax 2 → net amount = 500 − 1 − 2 = 497; price column = 100 (per share)
  { datetime: "2024-06-10T10:00:00.000Z", category: "TRADING", type: "SELL", asset_class: "STOCK",
    name: "Siemens", symbol: "DE0007236101", shares: "-5.0000000000", price: "100.000000",
    amount: "497.00", fee: "-1.00", tax: "-2.00", currency: "EUR", transaction_id: id(26) },
  // interest WITH withholding tax: amount=gross, tax=negative withholding → price=net
  { datetime: "2024-08-01T00:00:00.000Z", category: "CASH", type: "INTEREST_PAYMENT",
    amount: "10.00", tax: "-1.50", currency: "EUR", transaction_id: id(27) },
  // --- unmappable: surfaced as errors, never silently dropped ---
  { datetime: "2025-04-24T13:03:27.956868Z", category: "CASH", type: "TAX_OPTIMIZATION",
    amount: "0.000000", tax: "-1.77", currency: "EUR", description: "Tax Optimisation", transaction_id: id(16) },
  { datetime: "2024-05-30T07:56:47.847459Z", category: "CASH", type: "SEC_ACCOUNT", asset_class: "STOCK",
    name: "AbbVie", symbol: "US00287Y1091", amount: "0.000000", tax: "1.50", currency: "EUR", transaction_id: id(17) },
  { datetime: "2024-08-28T14:00:43.775Z", category: "CORPORATE_ACTION", type: "DIVIDEND_OPTION_CANCELLED", asset_class: "STOCK",
    name: "Main Street Capital", symbol: "US56035L1044", shares: "-0.1423570000", transaction_id: id(18) },
  { datetime: "2026-01-01T00:00:00.000000Z", category: "CASH", type: "MYSTERY_EVENT",
    amount: "1.000000", currency: "EUR", transaction_id: id(19) },
];

const TR_CSV = csv(ROWS);

describe("parseTrCsv", () => {
  const { drafts, errors } = parseTrCsv(TR_CSV);
  const byId = new Map(drafts.map((d) => [d.externalId, d]));
  const draft = (n: number) => byId.get(`tr-csv:${id(n)}`);

  it("maps 23 representable rows to drafts and surfaces 4 unmappable rows as issues", () => {
    expect(drafts).toHaveLength(23);
    expect(errors).toHaveLength(4);
    expect(errors.map((e) => e.message)).toEqual([
      expect.stringContaining("TAX_OPTIMIZATION"),
      expect.stringContaining("SEC_ACCOUNT"),
      expect.stringContaining("DIVIDEND_OPTION_CANCELLED"),
      expect.stringContaining("unsupported Trade Republic type: MYSTERY_EVENT"),
    ]);
  });

  it("surfaces an unrecognised type as a MAPPABLE attention issue, not a dead error", () => {
    // The three recognised-but-unmappable rows stay as ignorable notes (no eventId);
    // the unknown MYSTERY_EVENT becomes an attention issue the user can map to a draft.
    const mystery = errors.find((e) => e.eventType === "MYSTERY_EVENT");
    expect(mystery).toMatchObject({
      severity: "attention",
      eventId: `tr-csv:${id(19)}`, // mirrors the externalId convention so a mapped row dedups
      eventType: "MYSTERY_EVENT",
    });
    // Carries the source fields so the map editor can seed a draft.
    expect(mystery?.raw).toMatchObject({ currency: "EUR", amount: 1 });
    // The recognised-but-unmappable rows are NOT promoted to mappable.
    expect(errors.filter((e) => e.severity === "attention")).toHaveLength(1);
  });

  it("maps a cash deposit (quote-aware splitting survives the comma in description)", () => {
    expect(draft(1)).toMatchObject({ action: "deposit", quantity: "0", price: "500", currency: "EUR" });
  });

  it("maps a stock buy: |amount| = shares × price, fee carried separately", () => {
    expect(draft(2)).toMatchObject({
      action: "buy", assetClass: "equity", isin: "US02079K1079", ticker: undefined,
      quantity: "2", unit: "shares", price: "120.26", fees: "1", total: "241.52", currency: "EUR",
    });
  });

  it("maps a crypto buy with a ticker symbol and units", () => {
    expect(draft(3)).toMatchObject({
      action: "buy", assetClass: "crypto", ticker: "ETH", isin: undefined, unit: "units", quantity: "0.12",
    });
  });

  it("maps a sell: negative shares → positive quantity", () => {
    expect(draft(4)).toMatchObject({ action: "sell", quantity: "42", price: "12.44", fees: "1" });
  });

  it("maps a foreign dividend to NET price, GROSS total, and absolute tax + FX", () => {
    expect(draft(5)).toMatchObject({
      action: "dividend", isin: "US02209S1033", quantity: "0",
      price: "3.35", // 3.94 gross − 0.59 tax = net cash credited (drives cashFlow/XIRR)
      total: "3.94", tax: "0.59", fxRate: "1.103400", currency: "EUR",
    });
  });

  it("maps a fund distribution with no tax and decodes the HTML-escaped name", () => {
    expect(draft(6)).toMatchObject({
      action: "dividend", assetClass: "equity", name: "Core S&P 500 USD (Dist)", price: "0.79", total: "0.79",
    });
    expect(draft(6)?.tax).toBeUndefined();
  });

  it("maps interest with a zero tax field to no tax", () => {
    expect(draft(7)).toMatchObject({ action: "interest", quantity: "0", price: "1.74" });
    expect(draft(7)?.tax).toBeUndefined();
  });

  it("records card spending as a withdrawal (domestic and international + FX)", () => {
    expect(draft(8)).toMatchObject({ action: "withdrawal", price: "34.81" });
    expect(draft(9)).toMatchObject({ action: "withdrawal", price: "231.69", fxRate: "0.039496" });
  });

  it("takes the card ordering fee from the fee column", () => {
    expect(draft(10)).toMatchObject({ action: "withdrawal", price: "5" });
  });

  it("maps saveback cashback and broker cash bonuses to bonus_cash (collapse-eligible)", () => {
    // BENEFITS_SAVEBACK is a reward-funded buy → bonus_cash; collapsePerkFundedAcquisitions
    // folds it into its funding buy when one exists (none in this fixture → stays bonus_cash).
    expect(draft(11)).toMatchObject({ action: "bonus_cash", kind: "bonus", price: "0.55", name: "Core S&P 500 USD (Acc)" });
    expect(draft(11)?.isin).toBeUndefined();
    // BONUS/KINDERGELD_BONUS/STOCKPERK → bonus_cash so they show as "Bonus" (not "Interest").
    expect(draft(12)).toMatchObject({ action: "bonus_cash", kind: "bonus", price: "22.86" });
  });

  it("maps FREE_RECEIPT (no price) to transfer_in at confidence 0.5, with EUR default", () => {
    // A depot-to-depot share transfer: no price column → action:transfer_in, confidence 0.5.
    // NOT also an attention error (drafts and attention are mutually exclusive per row).
    expect(draft(13)).toMatchObject({
      action: "transfer_in", isin: "GB0007188757", quantity: "21",
      price: "0", currency: "EUR", confidence: 0.5,
    });
    // The low-confidence draft must NOT generate a duplicate attention issue.
    const attentionForId13 = errors.find((e) => e.eventId?.includes(id(13)));
    expect(attentionForId13).toBeUndefined();
  });

  it("maps DIVIDEND_REINVESTMENT to a zero-price bonus (reinvested income, not a transfer)", () => {
    expect(draft(14)).toMatchObject({ action: "bonus", quantity: "1.01327", price: "0" });
  });

  it("maps an instant transfer out to a withdrawal", () => {
    expect(draft(15)).toMatchObject({ action: "withdrawal", price: "1100" });
  });

  it("maps an incoming cash transfer (TRANSFER_IN) to a deposit, so it counts as a contribution", () => {
    expect(draft(20)).toMatchObject({ action: "deposit", quantity: "0", price: "100", currency: "EUR" });
  });

  it("maps Kindergeld and stock-perk credits to bonus_cash (kind bonus), dropping the instrument", () => {
    // Both are broker cash bonuses — distinct from `interest` so they show as "Bonus" in the UI.
    expect(draft(21)).toMatchObject({ action: "bonus_cash", kind: "bonus", price: "0.01" });
    // STOCKPERK carries a fund instrument but no shares — it's cash income, so drop the ISIN.
    expect(draft(22)).toMatchObject({ action: "bonus_cash", kind: "bonus", price: "101.19" });
    expect(draft(22)?.isin).toBeUndefined();
    expect(draft(22)?.quantity).toBe("0");
  });

  it("maps a dividend reversal (TR correction) to a negative net price and negative tax", () => {
    // amount=-0.10, tax=+0.03 (CSV: positive=refund) → net=-0.07, stored_tax=-0.03
    // cashFlow for this row is -0.07 (cash deducted), which correctly reduces income totals.
    expect(draft(24)).toMatchObject({
      action: "dividend",
      price: "-0.07", // negative net = cash out (reversal)
      total: "-0.1", // signed gross
      tax: "-0.03", // negative = refund/payback, not a fresh withholding
      fees: "0",
    });
  });

  it("maps EARNINGS (Vorabpauschale) to a standalone `tax` debit: cash & gain drop, not contribution", () => {
    // Gross 0, tax 0.06 withheld → a tax outflow. The magnitude lives in `price`
    // (cashFlow(tax) = −price); the tax FIELD is unused so the display gross isn't doubled.
    expect(draft(23)).toMatchObject({
      action: "tax",
      quantity: "0",
      price: "0.06",
      name: "Vorabpauschale for ISIN IE00BK5BQT80",
    });
    expect(draft(23)?.tax).toBeUndefined();
    expect(draft(23)?.isin).toBeUndefined();
  });

  it("auto-maps every leona.csv type — none fall through to a needs-review issue", () => {
    // The four JUNIOR-depot types are now mapped, so no attention issue is produced for them.
    const attentionTypes = errors.filter((e) => e.severity === "attention").map((e) => e.eventType);
    expect(attentionTypes).not.toContain("KINDERGELD_BONUS");
    expect(attentionTypes).not.toContain("TRANSFER_IN");
    expect(attentionTypes).not.toContain("STOCKPERK");
    expect(attentionTypes).not.toContain("EARNINGS");
  });

  it("maps FREE_RECEIPT WITH a price (crypto grant) to bonus at that price, not a transfer", () => {
    // A TR-issued crypto promo grant: has a price → income at market basis, NOT a transfer.
    expect(draft(25)).toMatchObject({
      action: "bonus",
      assetClass: "crypto",
      ticker: "BTC",
      quantity: "0.001",
      price: "32000",
      fees: "0",
    });
    // Must NOT be a transfer_in — this is income, not contributed capital.
    expect(draft(25)?.action).not.toBe("transfer_in");
    // Confidence 1 (not flagged for review — price is known).
    expect(draft(25)?.confidence).toBe(1);
  });

  it("captures withholding tax on sells so cashFlow = qty×price − fees − tax = net cash", () => {
    // Sell row: price=100 gross, fee=1, tax=2 → amount (net) = 497
    expect(draft(26)).toMatchObject({
      action: "sell", quantity: "5", price: "100", fees: "1", tax: "2",
    });
    // Sanity: no-tax sell (row 4) must not get a tax field
    expect(draft(4)?.tax).toBeUndefined();
  });

  it("nets interest against withholding tax so cashFlow = amount + tax", () => {
    // Interest row: gross 10, tax withheld 1.5 → net price 8.5; stored tax 1.5 (positive=withheld)
    expect(draft(27)).toMatchObject({ action: "interest", price: "8.5", tax: "1.5" });
    // Zero-tax interest row (row 7) must still have no tax field
    expect(draft(7)?.tax).toBeUndefined();
  });

  it("stamps a stable TR event-UUID external id and coerces the datetime", () => {
    expect(draft(1)?.externalId).toBe(`tr-csv:${id(1)}`);
    expect(draft(2)?.executedAt).toEqual(new Date("2022-08-18T19:17:06.465Z"));
  });

  it("returns nothing for a header-only or empty document", () => {
    expect(parseTrCsv(HEADER).drafts).toHaveLength(0);
    expect(parseTrCsv("").drafts).toHaveLength(0);
  });
});

describe("parseTrCsv — perk-funded buys collapse into one bonus row", () => {
  it("STOCKPERK + the same-day buy it funds → a single bonus, perk folded into extraSources", () => {
    // The real JUNIOR-depot shape: a TRADING BUY (cash out) plus a CASH STOCKPERK credit
    // (cash in) that reimburses it. Collapsed, the shares are received free.
    const { drafts } = parseTrCsv(
      csv([
        { datetime: "2025-08-26T14:01:54.463Z", category: "TRADING", type: "BUY", asset_class: "FUND",
          name: "Lifestrategy 80% Equity EUR (Acc)", symbol: "IE00BMVB5R75", shares: "2.7104",
          price: "37.335", amount: "-101.19", currency: "EUR", transaction_id: id(100) },
        { datetime: "2025-08-26T14:01:55.126058Z", category: "CASH", type: "STOCKPERK", asset_class: "FUND",
          name: "Lifestrategy 80% Equity EUR (Acc)", symbol: "IE00BMVB5R75", amount: "101.19",
          currency: "EUR", description: "Stockperk", transaction_id: id(101) },
      ]),
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      action: "bonus",
      kind: "bonus",
      isin: "IE00BMVB5R75",
      quantity: "2.7104",
      price: "37.335",
      externalId: `tr-csv:${id(100)}`, // the buy stays primary
    });
    expect(drafts[0].extraSources).toEqual([
      { externalId: `tr-csv:${id(101)}`, raw: { collapsedFrom: "perk_cash_credit" } },
    ]);
  });

  it("collapses a saveback (BENEFITS_SAVEBACK) into the buy it funds — both description variants", () => {
    // Real main-account shape: a monthly saveback funds a Core S&P 500 buy 1 day later. Works
    // whether the saveback carries the ETF name ("Your Saveback payment") or not ("for reservation").
    const { drafts } = parseTrCsv(
      csv([
        // Named variant → matches the buy on the shared instrument name.
        { datetime: "2026-01-01T00:14:38.919214Z", category: "CASH", type: "BENEFITS_SAVEBACK", asset_class: "FUND",
          name: "Core S&P 500 USD (Acc)", symbol: "IE00B5BMR087", amount: "10.03",
          currency: "EUR", description: "Your Saveback payment", transaction_id: id(120) },
        { datetime: "2026-01-02T14:59:23.431Z", category: "TRADING", type: "BUY", asset_class: "FUND",
          name: "Core S&P 500 USD (Acc)", symbol: "IE00B5BMR087", shares: "0.015935",
          price: "629.4", amount: "-10.03", currency: "EUR", transaction_id: id(121) },
        // Instrument-less variant → matches on amount + window.
        { datetime: "2026-02-01T00:45:23.994476Z", category: "CASH", type: "BENEFITS_SAVEBACK",
          amount: "11.71", currency: "EUR",
          description: "Saveback cash reward 00000000-0000-0000-0000-0000000000aa for reservation: 00000000-0000-0000-0000-0000000000bb",
          transaction_id: id(122) },
        { datetime: "2026-02-02T14:52:08.122Z", category: "TRADING", type: "BUY", asset_class: "FUND",
          name: "Core S&P 500 USD (Acc)", symbol: "IE00B5BMR087", shares: "0.018587",
          price: "630", amount: "-11.71", currency: "EUR", transaction_id: id(123) },
      ]),
    );
    expect(drafts.filter((d) => d.action === "bonus")).toHaveLength(2);
    expect(drafts.filter((d) => d.action === "bonus_cash" || d.action === "interest")).toHaveLength(0);
    expect(drafts.every((d) => d.isin === "IE00B5BMR087")).toBe(true);
  });

  it("collapses KINDERGELD credits with buys that execute a day later (cross-day window)", () => {
    // Real June shape: two KINDERGELD on 06-01, two savings-plan buys on 06-02 (both 0.02).
    const { drafts } = parseTrCsv(
      csv([
        { datetime: "2026-06-01T03:39:52.425210Z", category: "CASH", type: "KINDERGELD_BONUS",
          amount: "0.02", currency: "EUR", description: "Your Kindergeld bonus", transaction_id: id(110) },
        { datetime: "2026-06-01T03:32:21.745383Z", category: "CASH", type: "KINDERGELD_BONUS",
          amount: "0.02", currency: "EUR", description: "Your Kindergeld bonus", transaction_id: id(111) },
        { datetime: "2026-06-02T12:43:21.171Z", category: "TRADING", type: "BUY", asset_class: "FUND",
          name: "Lifestrategy 80% Equity EUR (Acc)", symbol: "IE00BMVB5R75", shares: "0.000461",
          price: "43.38", amount: "-0.02", currency: "EUR", transaction_id: id(112) },
        { datetime: "2026-06-02T18:00:23.194Z", category: "TRADING", type: "BUY", asset_class: "FUND",
          name: "FTSE All-World USD (Acc)", symbol: "IE00BK5BQT80", shares: "0.000121",
          price: "164.7", amount: "-0.02", currency: "EUR", transaction_id: id(113) },
      ]),
    );
    expect(drafts.filter((d) => d.action === "bonus")).toHaveLength(2);
    expect(drafts.filter((d) => d.action === "bonus_cash")).toHaveLength(0);
  });

  it("two KINDERGELD credits + two same-day savings-plan buys → two bonus rows, no bonus_cash", () => {
    const { drafts } = parseTrCsv(
      csv([
        { datetime: "2025-09-02T12:07:49.149Z", category: "TRADING", type: "BUY", asset_class: "FUND",
          name: "Lifestrategy 80% Equity EUR (Acc)", symbol: "IE00BMVB5R75", shares: "0.000269",
          price: "37.07", amount: "-0.01", currency: "EUR", transaction_id: id(102) },
        { datetime: "2025-09-02T14:49:49.518403Z", category: "CASH", type: "KINDERGELD_BONUS",
          amount: "0.01", currency: "EUR", description: "Your Kindergeld bonus", transaction_id: id(103) },
        { datetime: "2025-09-02T12:08:03.554282Z", category: "CASH", type: "KINDERGELD_BONUS",
          amount: "0.01", currency: "EUR", description: "Your Kindergeld bonus", transaction_id: id(104) },
        { datetime: "2025-09-02T15:21:47.423Z", category: "TRADING", type: "BUY", asset_class: "FUND",
          name: "FTSE All-World USD (Acc)", symbol: "IE00BK5BQT80", shares: "0.000074",
          price: "134.9", amount: "-0.01", currency: "EUR", transaction_id: id(105) },
      ]),
    );
    expect(drafts.filter((d) => d.action === "bonus")).toHaveLength(2);
    expect(drafts.filter((d) => d.action === "bonus_cash")).toHaveLength(0);
    expect(drafts.map((d) => d.isin).sort()).toEqual(["IE00BK5BQT80", "IE00BMVB5R75"]);
  });
});

describe("detectCsvFormat — Trade Republic", () => {
  it("detects the TR export by its transaction_id + mcc_code + counterparty_iban header", () => {
    expect(detectCsvFormat(TR_CSV)).toBe("tr-csv");
  });

  it("does not misclassify a generic CSV as tr-csv", () => {
    expect(detectCsvFormat("date,action,ticker,quantity,price\n2026-01-01,buy,AAPL,1,100")).toBe("generic");
  });
});
