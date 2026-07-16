import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import {
  users,
  apiTokens,
  accountHolders,
  portfolios,
  instruments,
  transactions,
  lastPrices,
  fxRates,
  portfolioSnapshots,
  allocationTargets,
} from "@portfolio/db";
import { PAT_PREFIX, hashToken } from "../plugins/auth.js";
import { ensureDb, getDb, closeDb } from "./client.js";

/**
 * Rich demo dataset for the screenshot pipeline (see `scripts/screenshots.mjs` at the
 * repo root, and the plan doc `.claude/plans/can-we-make-some-distributed-seal.md`).
 * Distinct from `seed.ts` (a single near-empty admin user for a fresh dev DB) — this
 * seeds a full portfolio/transaction/price graph spanning every asset class so every
 * hero screen (dashboard, holdings, insights, reports, tax) renders real, non-empty
 * data. Idempotent: re-running deletes the demo user (cascades through every
 * FK-owned row) and rebuilds from scratch, so it's safe to run repeatedly against the
 * same throwaway PGlite dir.
 *
 * Writes the freshly-minted personal-access-token secret to `patOutPath` (never
 * hardcoded — avoids tripping detect-secrets and avoids a stale committed credential).
 * The screenshot driver reads it back to mint a forged Auth.js session cookie
 * (`Authorization: Bearer pt_…`) — see `apps/web/scripts/mint-session.mjs` for why
 * this bypasses Authentik without touching real auth code.
 *
 * Dates are relative to the run date (not hardcoded), so screenshots regenerated
 * later stay looking current rather than visibly stale.
 */

const DEMO_AUTH_SUB = "demo|pocket";

// --- date/number helpers --------------------------------------------------

const NOW = new Date();

/** `n` days before `NOW`, at a fixed intraday hour so ordering is stable. */
function daysAgo(n: number, hour = 10): Date {
  const d = new Date(NOW);
  d.setUTCDate(d.getUTCDate() - n);
  d.setUTCHours(hour, 0, 0, 0);
  return d;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function dec(n: number, digits = 2): string {
  return n.toFixed(digits);
}

/** Deterministic pseudo-random in [0, 1), seeded by index — stable across runs for
 *  the same seed input so re-running produces the same-shaped (not identical-value,
 *  since dates shift) chart without a real RNG dependency. */
function pseudoRandom(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

// --- seed ------------------------------------------------------------------

export async function seedDemo(patOutPath?: string): Promise<void> {
  const db = getDb();

  // Idempotent re-seed: delete the demo user, which cascades (onDelete: "cascade")
  // through account_holders, portfolios, instruments-owned transaction rows,
  // api_tokens, etc. down to every row this script owns. Instruments are global
  // reference data (not user-owned) — cleaned up separately by symbol below so a
  // re-run doesn't violate the (market, symbol) unique index.
  await db.delete(users).where(eq(users.authSub, DEMO_AUTH_SUB));

  const [user] = await db
    .insert(users)
    .values({ authSub: DEMO_AUTH_SUB, email: "demo@pocket.invalid", name: "Demo" })
    .returning();

  // pt_ + 43 url-safe chars (32 bytes) — same shape routes/me.ts mints for a real PAT.
  const secret = `${PAT_PREFIX}${randomBytes(32).toString("base64url")}`;
  await db.insert(apiTokens).values({
    userId: user.id,
    name: "screenshot-pipeline",
    scope: "write",
    tokenHash: hashToken(secret),
    tokenPrefix: secret.slice(0, 12),
  });

  // --- Account holders -----------------------------------------------------

  const [self, child] = await db
    .insert(accountHolders)
    .values([
      {
        userId: user.id,
        // Deliberately generic/fictional — this name renders directly in captured
        // screenshots (e.g. the Tax screen's "{holder} — {year}" header), which land
        // in the README and the PWA manifest. Never a real name (CLAUDE.md: "No
        // personal/account-holder names… in public artifacts").
        name: "Sample Investor",
        type: "self",
        birthYear: NOW.getUTCFullYear() - 34,
        // German tax profile: FSA cap + effective KapSt+Soli rate — powers /tax.
        taxAllowanceAnnual: "1000",
        capitalGainsTaxRate: "0.26375",
        churchTax: false,
        taxResidence: "DE",
      },
      {
        userId: user.id,
        name: "Sample Child",
        type: "child",
        birthYear: NOW.getUTCFullYear() - 9,
      },
    ])
    .returning();

  // --- Portfolios ------------------------------------------------------------

  const [idPortfolio, trPortfolio, goldPortfolio, mfPortfolio, cashPortfolio] = await db
    .insert(portfolios)
    .values([
      {
        userId: user.id,
        name: "Stockbit — IDX Equities",
        baseCurrency: "IDR",
        accountHolderId: self.id,
        brokerage: "Stockbit",
        cashCounted: false,
      },
      {
        userId: user.id,
        name: "Trade Republic",
        baseCurrency: "EUR",
        accountHolderId: self.id,
        brokerage: "Trade Republic",
        cashCounted: false,
        // Per-depot FSA allocation, within the holder's €1,000 cap above.
        taxAllowanceAnnual: "1000",
      },
      {
        userId: user.id,
        name: "Pegadaian Gold",
        baseCurrency: "IDR",
        accountHolderId: self.id,
        brokerage: "Pegadaian",
        cashCounted: false,
      },
      {
        userId: user.id,
        name: "Bibit Reksa Dana",
        baseCurrency: "IDR",
        accountHolderId: child.id,
        brokerage: "Bibit",
        cashCounted: false,
      },
      {
        userId: user.id,
        name: "DKB Tagesgeld",
        baseCurrency: "EUR",
        accountHolderId: self.id,
        brokerage: "DKB",
        // Cash-inside boundary: a savings account, not a mixed checking account.
        cashCounted: true,
      },
    ])
    .returning();

  // --- Instruments (global reference data) ----------------------------------

  // Clean up any prior demo run's instruments by symbol (they're not owned by the
  // demo user, so the cascading delete above doesn't touch them).
  const symbols = [
    "BBCA",
    "BBRI",
    "TLKM",
    "ORI023",
    "VWCE",
    "IWDA",
    "AAPL",
    "MSFT",
    "XAUIDR",
    "RDSAHAM",
  ];
  for (const symbol of symbols) {
    await db.delete(instruments).where(eq(instruments.symbol, symbol));
  }

  const [bbca, bbri, tlkm, ori023, vwce, iwda, aapl, msft, xau, rdSaham] = await db
    .insert(instruments)
    .values([
      {
        symbol: "BBCA",
        market: "IDX",
        assetClass: "equity",
        unit: "shares",
        currency: "IDR",
        name: "PT Bank Central Asia Tbk",
        displayName: "Bank Central Asia",
        sector: "Financials",
      },
      {
        symbol: "BBRI",
        market: "IDX",
        assetClass: "equity",
        unit: "shares",
        currency: "IDR",
        name: "PT Bank Rakyat Indonesia Tbk",
        displayName: "Bank Rakyat Indonesia",
        sector: "Financials",
      },
      {
        symbol: "TLKM",
        market: "IDX",
        assetClass: "equity",
        unit: "shares",
        currency: "IDR",
        name: "PT Telkom Indonesia Tbk",
        displayName: "Telkom Indonesia",
        sector: "Communication Services",
      },
      {
        symbol: "ORI023",
        market: "IDX",
        assetClass: "bond",
        unit: "units",
        currency: "IDR",
        name: "Obligasi Negara Ritel ORI023",
        displayName: "ORI023 Retail Bond",
        faceValue: "1000000",
        couponRate: "0.0575",
        couponSchedule: "monthly",
        maturityDate: isoDate(daysAgo(-540)), // ~18 months in the future
      },
      {
        symbol: "VWCE",
        market: "XETRA",
        assetClass: "etf",
        unit: "shares",
        currency: "EUR",
        name: "Vanguard FTSE All-World UCITS ETF",
        displayName: "Vanguard FTSE All-World",
        partialExemptionRate: "0.30",
      },
      {
        symbol: "IWDA",
        market: "XETRA",
        assetClass: "etf",
        unit: "shares",
        currency: "EUR",
        name: "iShares Core MSCI World UCITS ETF",
        displayName: "iShares Core MSCI World",
        partialExemptionRate: "0.30",
      },
      {
        symbol: "AAPL",
        market: "US",
        assetClass: "equity",
        unit: "shares",
        currency: "USD",
        name: "Apple Inc.",
        displayName: "Apple",
        sector: "Technology",
      },
      {
        symbol: "MSFT",
        market: "US",
        assetClass: "equity",
        unit: "shares",
        currency: "USD",
        name: "Microsoft Corporation",
        displayName: "Microsoft",
        sector: "Technology",
      },
      {
        symbol: "XAUIDR",
        market: "XAU",
        assetClass: "gold",
        unit: "grams",
        currency: "IDR",
        name: "Emas Antam",
        displayName: "Gold (Antam)",
      },
      {
        symbol: "RDSAHAM",
        market: "IDX",
        assetClass: "mutual_fund",
        unit: "units",
        currency: "IDR",
        name: "Reksa Dana Saham Nusantara",
        displayName: "Reksa Dana Saham Nusantara",
      },
    ])
    .returning();

  // --- Transactions ------------------------------------------------------------
  //
  // Spans buy/sell/dividend/coupon/interest/savings_plan/deposit/withdrawal/
  // transfer_in — the types the Hero-5 screens actually render (see the plan doc's
  // per-screen prerequisites table). A few positions are fully or partially closed
  // (BBCA, TLKM, AAPL) so Reports/Trades and Tax have realized round-trips to show;
  // one dividend/coupon/interest row per income instrument lands within the current
  // calendar year so /tax's year-scoped rollup isn't empty.

  const txRows: (typeof transactions.$inferInsert)[] = [];

  // Stockbit — IDX Equities (IDR)
  txRows.push(
    {
      portfolioId: idPortfolio.id,
      instrumentId: bbca.id,
      type: "buy",
      quantity: "500",
      price: "8500",
      fees: "8500",
      currency: "IDR",
      executedAt: daysAgo(700),
    },
    {
      portfolioId: idPortfolio.id,
      instrumentId: bbca.id,
      type: "buy",
      quantity: "300",
      price: "9200",
      fees: "5520",
      currency: "IDR",
      executedAt: daysAgo(400),
    },
    {
      portfolioId: idPortfolio.id,
      instrumentId: bbca.id,
      type: "sell",
      quantity: "200",
      price: "9800",
      fees: "3920",
      currency: "IDR",
      executedAt: daysAgo(60),
    },
    {
      portfolioId: idPortfolio.id,
      instrumentId: bbca.id,
      type: "dividend",
      quantity: "0",
      price: "216000",
      perShare: "360",
      shares: "600",
      currency: "IDR",
      executedAt: daysAgo(160),
    },
    {
      portfolioId: idPortfolio.id,
      instrumentId: bbca.id,
      type: "dividend",
      quantity: "0",
      price: "162000",
      perShare: "270",
      shares: "600",
      currency: "IDR",
      executedAt: daysAgo(45),
    },

    {
      portfolioId: idPortfolio.id,
      instrumentId: bbri.id,
      type: "transfer_in",
      quantity: "1000",
      price: "4200",
      fees: "0",
      currency: "IDR",
      executedAt: daysAgo(500),
    },
    {
      portfolioId: idPortfolio.id,
      instrumentId: bbri.id,
      type: "dividend",
      quantity: "0",
      price: "185000",
      perShare: "185",
      shares: "1000",
      currency: "IDR",
      executedAt: daysAgo(70),
    },

    {
      portfolioId: idPortfolio.id,
      instrumentId: tlkm.id,
      type: "buy",
      quantity: "400",
      price: "3400",
      fees: "5440",
      currency: "IDR",
      executedAt: daysAgo(600),
    },
    {
      portfolioId: idPortfolio.id,
      instrumentId: tlkm.id,
      type: "sell",
      quantity: "400",
      price: "3900",
      fees: "6240",
      currency: "IDR",
      executedAt: daysAgo(30),
    },

    {
      portfolioId: idPortfolio.id,
      instrumentId: ori023.id,
      type: "buy",
      quantity: "50",
      price: "1000000",
      fees: "0",
      currency: "IDR",
      executedAt: daysAgo(500),
    },
    {
      portfolioId: idPortfolio.id,
      instrumentId: ori023.id,
      type: "coupon",
      quantity: "0",
      price: "239583",
      currency: "IDR",
      executedAt: daysAgo(80),
    },
    {
      portfolioId: idPortfolio.id,
      instrumentId: ori023.id,
      type: "coupon",
      quantity: "0",
      price: "239583",
      currency: "IDR",
      executedAt: daysAgo(50),
    },
    {
      portfolioId: idPortfolio.id,
      instrumentId: ori023.id,
      type: "coupon",
      quantity: "0",
      price: "239583",
      currency: "IDR",
      executedAt: daysAgo(20),
    },
  );

  // Trade Republic (EUR) — a VWCE Sparplan + manual ETF/US-equity buys.
  for (let i = 0; i < 20; i++) {
    const monthsAgo = 20 - i;
    txRows.push({
      portfolioId: trPortfolio.id,
      instrumentId: vwce.id,
      type: "savings_plan",
      quantity: dec(0.8 + pseudoRandom(i) * 0.4, 4),
      price: dec(95 + pseudoRandom(i * 7) * 20, 2),
      fees: "0",
      currency: "EUR",
      executedAt: daysAgo(monthsAgo * 30),
      savingsPlanId: "vwce-sparplan",
    });
  }
  txRows.push(
    {
      portfolioId: trPortfolio.id,
      instrumentId: iwda.id,
      type: "buy",
      quantity: "12",
      price: "78.40",
      fees: "1.00",
      currency: "EUR",
      executedAt: daysAgo(450),
    },
    {
      portfolioId: trPortfolio.id,
      instrumentId: iwda.id,
      type: "buy",
      quantity: "8",
      price: "84.10",
      fees: "1.00",
      currency: "EUR",
      executedAt: daysAgo(200),
    },

    {
      portfolioId: trPortfolio.id,
      instrumentId: aapl.id,
      type: "buy",
      quantity: "10",
      price: "150.20",
      fees: "1.00",
      currency: "USD",
      executedAt: daysAgo(500),
    },
    {
      portfolioId: trPortfolio.id,
      instrumentId: aapl.id,
      type: "buy",
      quantity: "5",
      price: "175.60",
      fees: "1.00",
      currency: "USD",
      executedAt: daysAgo(200),
    },
    {
      portfolioId: trPortfolio.id,
      instrumentId: aapl.id,
      type: "sell",
      quantity: "8",
      price: "221.30",
      fees: "1.00",
      currency: "USD",
      executedAt: daysAgo(20),
    },
    {
      portfolioId: trPortfolio.id,
      instrumentId: aapl.id,
      type: "dividend",
      quantity: "0",
      price: "3.92",
      perShare: "0.28",
      shares: "14",
      currency: "USD",
      executedAt: daysAgo(95),
    },
    {
      portfolioId: trPortfolio.id,
      instrumentId: aapl.id,
      type: "dividend",
      quantity: "0",
      price: "1.96",
      perShare: "0.28",
      shares: "7",
      currency: "USD",
      executedAt: daysAgo(40),
    },

    {
      portfolioId: trPortfolio.id,
      instrumentId: msft.id,
      type: "buy",
      quantity: "8",
      price: "280.50",
      fees: "1.00",
      currency: "USD",
      executedAt: daysAgo(350),
    },
    {
      portfolioId: trPortfolio.id,
      instrumentId: msft.id,
      type: "dividend",
      quantity: "0",
      price: "5.52",
      perShare: "0.69",
      shares: "8",
      currency: "USD",
      executedAt: daysAgo(55),
    },
  );

  // Pegadaian Gold (IDR) — long-term accumulation, no sells.
  txRows.push(
    {
      portfolioId: goldPortfolio.id,
      instrumentId: xau.id,
      type: "buy",
      quantity: "10",
      price: "950000",
      fees: "0",
      currency: "IDR",
      executedAt: daysAgo(600),
    },
    {
      portfolioId: goldPortfolio.id,
      instrumentId: xau.id,
      type: "buy",
      quantity: "15",
      price: "1050000",
      fees: "0",
      currency: "IDR",
      executedAt: daysAgo(300),
    },
    {
      portfolioId: goldPortfolio.id,
      instrumentId: xau.id,
      type: "buy",
      quantity: "5",
      price: "1150000",
      fees: "0",
      currency: "IDR",
      executedAt: daysAgo(60),
    },
  );

  // Bibit Reksa Dana (IDR, child holder) — monthly Sparplan-style accumulation.
  for (let i = 0; i < 14; i++) {
    const monthsAgo = 14 - i;
    txRows.push({
      portfolioId: mfPortfolio.id,
      instrumentId: rdSaham.id,
      type: "savings_plan",
      quantity: dec(400 + pseudoRandom(i * 3) * 200, 2),
      price: dec(1450 + pseudoRandom(i * 11) * 150, 2),
      fees: "0",
      currency: "IDR",
      executedAt: daysAgo(monthsAgo * 30),
      savingsPlanId: "rdsaham-sparplan",
    });
  }

  // DKB Tagesgeld (EUR, cash-inside boundary).
  txRows.push(
    {
      portfolioId: cashPortfolio.id,
      instrumentId: null,
      type: "deposit",
      quantity: "0",
      price: "5000",
      currency: "EUR",
      executedAt: daysAgo(500),
    },
    {
      portfolioId: cashPortfolio.id,
      instrumentId: null,
      type: "deposit",
      quantity: "0",
      price: "1000",
      currency: "EUR",
      executedAt: daysAgo(300),
    },
    {
      portfolioId: cashPortfolio.id,
      instrumentId: null,
      type: "deposit",
      quantity: "0",
      price: "1200",
      currency: "EUR",
      executedAt: daysAgo(120),
    },
    {
      portfolioId: cashPortfolio.id,
      instrumentId: null,
      type: "withdrawal",
      quantity: "0",
      price: "800",
      currency: "EUR",
      executedAt: daysAgo(90),
    },
    {
      portfolioId: cashPortfolio.id,
      instrumentId: null,
      type: "interest",
      quantity: "0",
      price: "18.40",
      currency: "EUR",
      executedAt: daysAgo(150),
    },
    {
      portfolioId: cashPortfolio.id,
      instrumentId: null,
      type: "interest",
      quantity: "0",
      price: "21.10",
      currency: "EUR",
      executedAt: daysAgo(60),
    },
    {
      portfolioId: cashPortfolio.id,
      instrumentId: null,
      type: "interest",
      quantity: "0",
      price: "19.75",
      currency: "EUR",
      executedAt: daysAgo(10),
    },
  );

  await db.insert(transactions).values(txRows);

  // --- Last prices (drives live valuation without hitting a market-data provider —
  // see MARKET_DATA_TTL_MS in the orchestrator env) + previous close for day-change. ---

  const asOf = NOW;
  await db.insert(lastPrices).values([
    { instrumentId: bbca.id, price: "10150", previousClose: "10025", currency: "IDR", asOf },
    { instrumentId: bbri.id, price: "4850", previousClose: "4780", currency: "IDR", asOf },
    { instrumentId: tlkm.id, price: "3980", previousClose: "4010", currency: "IDR", asOf },
    { instrumentId: ori023.id, price: "1005000", previousClose: "1004200", currency: "IDR", asOf },
    { instrumentId: vwce.id, price: "118.40", previousClose: "117.10", currency: "EUR", asOf },
    { instrumentId: iwda.id, price: "89.75", previousClose: "89.20", currency: "EUR", asOf },
    { instrumentId: aapl.id, price: "228.90", previousClose: "231.50", currency: "USD", asOf },
    { instrumentId: msft.id, price: "412.30", previousClose: "408.60", currency: "USD", asOf },
    { instrumentId: xau.id, price: "1245000", previousClose: "1238500", currency: "IDR", asOf },
    { instrumentId: rdSaham.id, price: "1685", previousClose: "1679", currency: "IDR", asOf },
  ]);

  // --- FX rates — every currency pair the seeded holdings actually need, dated today.
  // See fx.ts: rows are (base=from, quote=to, date), read for `quote = displayCurrency`.
  // IDR is both the default aggregate display currency (users.displayCurrency) and
  // most portfolios' own baseCurrency; EUR is Trade Republic's own baseCurrency.

  const today = isoDate(NOW);
  await db.insert(fxRates).values([
    { base: "EUR", quote: "IDR", rate: "17450", date: today },
    { base: "USD", quote: "IDR", rate: "16100", date: today },
    { base: "USD", quote: "EUR", rate: "0.923", date: today },
  ]);

  // --- Portfolio snapshots (daily net-worth history → dashboard/savings charts). ---
  // A deterministic upward-drift-plus-noise walk from a small starting value to
  // roughly today's live-valued total, per portfolio — good enough for a chart to
  // look alive without re-deriving exact historical valuations from the transactions
  // above (that's the real backend job's responsibility, not this seed's).

  const portfolioEndValues: {
    portfolio: typeof portfolios.$inferSelect;
    end: number;
    currency: string;
    days: number;
  }[] = [
    { portfolio: idPortfolio, end: 9_800_000, currency: "IDR", days: 700 },
    { portfolio: trPortfolio, end: 6_400, currency: "EUR", days: 500 },
    { portfolio: goldPortfolio, end: 33_000_000, currency: "IDR", days: 600 },
    { portfolio: mfPortfolio, end: 7_800_000, currency: "IDR", days: 420 },
    { portfolio: cashPortfolio, end: 5_439, currency: "EUR", days: 500 },
  ];

  const snapshotRows: (typeof portfolioSnapshots.$inferInsert)[] = [];
  for (const { portfolio, end, currency, days } of portfolioEndValues) {
    const start = end * 0.12;
    for (let d = days; d >= 0; d--) {
      const t = 1 - d / days; // 0 at the start date, 1 at today
      const trend = start + (end - start) * t;
      const noise = 1 + (pseudoRandom(d + portfolio.id.length) - 0.5) * 0.03;
      const netWorth = Math.max(0, trend * noise);
      snapshotRows.push({
        portfolioId: portfolio.id,
        date: isoDate(daysAgo(d)),
        netWorth: dec(netWorth),
        marketValue: dec(netWorth),
        effectiveFlow: "0",
        currency,
      });
    }
  }
  // Chunk the insert — PGlite/postgres both handle a few thousand rows fine in one
  // call, but batching keeps this robust if the portfolio/day count grows later.
  const CHUNK = 500;
  for (let i = 0; i < snapshotRows.length; i += CHUNK) {
    await db.insert(portfolioSnapshots).values(snapshotRows.slice(i, i + CHUNK));
  }

  // --- Allocation targets (aggregate asset-class mix → dashboard drift hint). ---

  await db.insert(allocationTargets).values([
    {
      userId: user.id,
      portfolioId: null,
      dimension: "asset_class",
      targetKey: "equity",
      targetPct: "45",
    },
    {
      userId: user.id,
      portfolioId: null,
      dimension: "asset_class",
      targetKey: "etf",
      targetPct: "20",
    },
    {
      userId: user.id,
      portfolioId: null,
      dimension: "asset_class",
      targetKey: "gold",
      targetPct: "10",
    },
    {
      userId: user.id,
      portfolioId: null,
      dimension: "asset_class",
      targetKey: "bond",
      targetPct: "10",
    },
    {
      userId: user.id,
      portfolioId: null,
      dimension: "asset_class",
      targetKey: "mutual_fund",
      targetPct: "15",
    },
  ]);

  if (patOutPath) {
    await writeFile(patOutPath, secret, "utf8");
  }

  console.log(`Demo data seeded for user ${user.id} (${txRows.length} transactions).`);
}

// Allow running directly: `tsx src/db/seed-demo.ts [patOutPath]`.
const invokedDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  await ensureDb();
  await seedDemo(process.argv[2]);
  await closeDb();
}
