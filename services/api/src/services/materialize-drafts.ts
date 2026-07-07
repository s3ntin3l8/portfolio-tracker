/**
 * Shared "materialize parsed drafts into transaction rows" pipeline (issue: unify imports
 * into draft transactions).
 *
 * Turns `ParsedTransaction[]` drafts into real `transactions` rows — instrument resolution
 * (EU/ISIN via OpenFIGI), cross-source dedup/enrichment classification, the insert with
 * `onConflictDoNothing` on the externalId unique index, and the `transaction_sources`
 * provenance/rollup rows. It is the single place this happens, called by both the
 * import-confirm route (writing `status:'normal'`) and the TR/IBKR sync path (writing
 * `status:'draft'`).
 *
 * The pieces are split so the confirm route can keep its 409-duplicate gate + import
 * state-machine + receipt finalization between them:
 *   1. {@link resolveDraftInstruments} — Pass 1, network-bound, runs OUTSIDE any DB tx.
 *   2. {@link classifyDraftDuplicates} — cross-source match → enrichment vs plain-duplicate.
 *   3. {@link writeResolvedDrafts} — Pass 2 insert, parameterized by `status`. Accepts a
 *      transaction handle so the caller controls atomicity.
 * {@link materializeDrafts} composes all three (resolve → classify → write + apply
 * enrichment) for callers that don't need the interactive 409 gate (sync).
 */
import type { FastifyBaseLogger } from "fastify";
import { eq } from "drizzle-orm";
import { transactions, transactionSources } from "@portfolio/db";
import type { ParsedTransaction, AssetClass } from "@portfolio/schema";
import type { DB } from "../db/client.js";
import {
  findOrCreateInstrument,
  marketForAssetClass,
  marketForEuInstrument,
} from "./instruments.js";
import { getMarketData } from "./market-data.js";
import { resolveCryptoIsin, PRICEABLE_FOREIGN_MARKETS, isIdxEtfSymbol } from "@portfolio/market-data";
import { findCrossSourceDuplicates, classifyMatch } from "./parsers/dedup.js";
import { enrichTransactionFromDrafts } from "./enrichment.js";
import { getStagedDocumentId } from "../storage/receipts.js";

/** Either the base db or an open transaction handle — both expose the query builder. */
type DbOrTx = DB | Parameters<Parameters<DB["transaction"]>[0]>[0];
/** Minimal context: works with a FastifyInstance (routes) or a `{ db, log }` (sync). */
type Ctx = { db: DB; log?: FastifyBaseLogger };
type TxRow = typeof transactions.$inferSelect;
type TxSource = NonNullable<(typeof transactions.$inferInsert)["source"]>;
type TxStatus = NonNullable<(typeof transactions.$inferInsert)["status"]>;

export type ResolvedDraft = { draft: ParsedTransaction; instrumentId: string | null };

/**
 * Pass 1 — resolve each draft's instrument (best-effort, may hit the network). Cash
 * movements have no instrument. EU brokers (DKB/TR/IBKR) resolve ISIN → ticker/market/
 * currency via OpenFIGI (cached). Runs OUTSIDE any DB transaction so a slow lookup never
 * holds one open.
 */
export async function resolveDraftInstruments(
  ctx: Ctx,
  drafts: ParsedTransaction[],
  opts: { isEu: boolean },
): Promise<ResolvedDraft[]> {
  const { isEu } = opts;
  const log = ctx.log;

  // Resolve EU broker ISINs to a ticker/market/currency once each (best-effort, cached).
  const isinCache = new Map<
    string,
    { symbol: string; market: string; currency: string; assetClass: AssetClass } | null
  >();
  async function resolveEuIsin(isin: string) {
    if (isinCache.has(isin)) return isinCache.get(isin)!;
    let resolved: {
      symbol: string;
      market: string;
      currency: string;
      assetClass: AssetClass;
    } | null = null;
    // Trade Republic books crypto under synthetic `XF…` ISINs that OpenFIGI can't resolve;
    // recognise those first and route them to CoinGecko (priced in the broker's EUR).
    const crypto = resolveCryptoIsin(isin);
    if (crypto) {
      resolved = { ...crypto, currency: "EUR" };
    } else {
      try {
        const md = await getMarketData();
        const [hit] = await md.search(isin);
        if (hit) {
          resolved = {
            symbol: hit.symbol,
            market: hit.market,
            currency: hit.currency,
            assetClass: hit.assetClass,
          };
        }
      } catch (err) {
        // best-effort; never block on discovery
        log?.warn({ isin, err }, "isin resolve failed");
      }
    }
    isinCache.set(isin, resolved);
    return resolved;
  }

  const resolved: ResolvedDraft[] = [];
  for (const d of drafts) {
    // Cash movements (deposit/withdrawal/interest/bonus_cash) have no instrument.
    const isCash =
      d.action === "deposit" ||
      d.action === "withdrawal" ||
      d.action === "interest" ||
      d.action === "bonus_cash";
    let instrumentId: string | null = null;

    if (!isCash) {
      let symbol = d.ticker ?? d.isin ?? d.name ?? "UNKNOWN";
      let market = isEu
        ? marketForEuInstrument(d.assetClass)
        : marketForAssetClass(d.assetClass ?? "equity");
      let instrumentCurrency = d.currency;
      let assetClass = d.assetClass ?? "equity";

      // IDX KIK ETFs read "Reksa Dana" in screenshots so the parser tags them mutual_fund.
      // Their ticker reveals the truth — reclassify so they group under ETFs, not reksa
      // dana. Gated on !isEu + market === "IDX" so EU mutual funds are never touched. (#120)
      if (!isEu && assetClass === "mutual_fund" && market === "IDX" && isIdxEtfSymbol(symbol))
        assetClass = "etf";

      if (isEu && d.isin) {
        const r = await resolveEuIsin(d.isin);
        if (r) {
          // Always adopt the resolved ticker and asset class. Adopt the venue + currency
          // only when resolution lands on a market our providers price directly that differs
          // from the broker's Xetra/EUR default — US stocks (USD via Twelve Data) and crypto
          // (EUR via CoinGecko). Otherwise keep the Xetra/EUR pin: DKB/Trade Republic execute
          // on Xetra, and OpenFIGI's first listing for a EUR fund is often another venue that
          // no provider covers / defaults to USD (PR #130).
          symbol = r.symbol;
          assetClass = r.assetClass;
          // Adopt the resolved venue/currency only for markets that differ from the broker's
          // Xetra/EUR default AND make sense for the ISIN's domicile country. For US listings:
          // only allow the US market when the ISIN is itself US-domiciled — a non-US ISIN that
          // resolves to a US ticker is a cross-listing collision (e.g. CSSPX = iShares on Xetra
          // vs Cohen & Steers on NYSE). Crypto (CRYPTO_MARKET) is unaffected by the ISIN check.
          if (
            PRICEABLE_FOREIGN_MARKETS.has(r.market) &&
            (r.market !== "US" || (d.isin ?? "").toUpperCase().startsWith("US"))
          ) {
            market = r.market;
            instrumentCurrency = r.currency;
          }
        }
      }

      const instrument = await findOrCreateInstrument(
        ctx.db,
        {
          symbol,
          market,
          assetClass,
          unit: d.unit ?? "shares",
          currency: instrumentCurrency,
          name: d.name ?? symbol,
          isin: d.isin ?? null,
          wkn: d.wkn ?? null,
        },
        // Delegate to the cached resolveEuIsin so any future path that produces an unknown
        // market benefits from the same OpenFIGI correction without a second round-trip.
        {
          resolveMarket: async (isin) => {
            const r = await resolveEuIsin(isin);
            return r ? { market: r.market, currency: r.currency } : null;
          },
        },
      );
      instrumentId = instrument.id;
    }
    resolved.push({ draft: d, instrumentId });
  }
  return resolved;
}

export type CommittedCandidate = {
  id: string;
  key: string | null;
  action: string;
  quantity: string;
  price: string;
  executedAt: Date;
  source: string | null;
};

export type DuplicateClassification = {
  enrichmentMatches: Array<{ draftIndex: number; matchedTransactionId: string }>;
  enrichmentDraftIndices: Set<number>;
  plainDuplicates: Array<{ draftIndex: number; matched: CommittedCandidate }>;
};

/**
 * Cross-source duplicate classification (#196/#217/#259). Given resolved drafts, find those
 * that economically match a transaction already in the target portfolio and split them into
 * **enrichment** (different source carrying a document/taxComponents → fold into the existing
 * row) vs **plain duplicate** (same source / no new value → the caller decides: 409 at
 * confirm, or skip at sync). Same-source exact re-imports are excluded (the unique index +
 * onConflictDoNothing absorbs them silently on insert).
 */
export async function classifyDraftDuplicates(
  ctx: Ctx,
  args: {
    resolved: ResolvedDraft[];
    targetPortfolioId: string;
    source: TxSource;
    importId: string;
  },
): Promise<DuplicateClassification> {
  const { resolved, targetPortfolioId, source, importId } = args;
  const enrichmentMatches: Array<{ draftIndex: number; matchedTransactionId: string }> = [];
  const enrichmentDraftIndices = new Set<number>();
  const plainDuplicates: Array<{ draftIndex: number; matched: CommittedCandidate }> = [];

  const committed = await ctx.db
    .select({
      id: transactions.id,
      instrumentId: transactions.instrumentId,
      type: transactions.type,
      executedAt: transactions.executedAt,
      quantity: transactions.quantity,
      price: transactions.price,
      source: transactions.source,
      externalId: transactions.externalId,
    })
    .from(transactions)
    .where(eq(transactions.portfolioId, targetPortfolioId));

  // Same-source re-imports are absorbed silently by the unique index on insert; exclude
  // them from the surfaced set and reserve it for genuine cross-source duplicates.
  const committedExtKeys = new Set(
    committed.filter((r) => r.externalId).map((r) => `${r.source}|${r.externalId}`),
  );

  const committedCandidates: CommittedCandidate[] = committed.map((r) => ({
    id: r.id,
    key: r.instrumentId,
    action: r.type,
    quantity: r.quantity,
    price: r.price,
    executedAt: r.executedAt,
    source: r.source,
  }));
  const draftCandidates = resolved.map(({ draft: d, instrumentId }) => ({
    key: instrumentId,
    action: d.action,
    quantity: d.quantity,
    price: d.price,
    executedAt: d.executedAt,
  }));

  const allMatches = findCrossSourceDuplicates(draftCandidates, committedCandidates).filter(
    ({ draftIndex }) => {
      const d = resolved[draftIndex].draft;
      const prospectiveExtId = d.externalId ?? `import:${importId}:${draftIndex}`;
      return !committedExtKeys.has(`${source}|${prospectiveExtId}`);
    },
  );
  if (allMatches.length === 0) {
    return { enrichmentMatches, enrichmentDraftIndices, plainDuplicates };
  }

  // A staged document on this import signals enrichment value.
  const hasStagedDoc = !!(await getStagedDocumentId(ctx, importId));
  for (const match of allMatches) {
    const d = resolved[match.draftIndex].draft;
    const hasTaxComponents = d.taxComponents && Object.keys(d.taxComponents).length > 0;
    const draftHasEnrichment = hasStagedDoc || !!hasTaxComponents;
    const kind = classifyMatch(source, match.matched.source ?? "csv", draftHasEnrichment);
    if (kind === "enrichment") {
      enrichmentMatches.push({ draftIndex: match.draftIndex, matchedTransactionId: match.matched.id });
      enrichmentDraftIndices.add(match.draftIndex);
    } else {
      plainDuplicates.push({ draftIndex: match.draftIndex, matched: match.matched });
    }
  }
  return { enrichmentMatches, enrichmentDraftIndices, plainDuplicates };
}

/**
 * Map a resolved draft + import source to the `transaction_sources.sourceType` value.
 * Keep this in sync with `draftSourceType` in `enrichment.ts` — the two must agree, or a
 * source's provenance rows flip labels depending which path materialized them.
 */
function sourceTypeForDraft(d: ParsedTransaction, source: TxSource) {
  const hasTaxComponents = d.taxComponents && Object.keys(d.taxComponents).length > 0;
  return (
    hasTaxComponents ? "pdf"
    : source === "pytr" ? "pytr"
    : source === "ibkr" ? "ibkr"
    : source === "screenshot" ? "screenshot"
    : source === "pdf" ? "pdf"
    : "csv"
  ) as "pdf" | "pytr" | "ibkr" | "screenshot" | "csv" | "manual";
}

/**
 * Pass 2 — insert the resolved drafts as `transactions` rows (with the given `status`) plus
 * their `transaction_sources` provenance/rollup rows. Enrichment matches are skipped here
 * (the caller folds them into the existing row instead). Idempotent: the externalId unique
 * index + `onConflictDoNothing` absorbs same-source re-imports. Accepts a transaction handle
 * so the caller owns atomicity.
 */
export async function writeResolvedDrafts(
  db: DbOrTx,
  args: {
    resolved: ResolvedDraft[];
    skipDraftIndices: Set<number>;
    targetPortfolioId: string;
    source: TxSource;
    importId: string;
    status: TxStatus;
  },
): Promise<{ written: TxRow[]; attempted: number; skipped: number }> {
  const { resolved, skipDraftIndices, targetPortfolioId, source, importId, status } = args;
  const written: TxRow[] = [];
  let attempted = 0;
  let skipped = 0;

  for (let i = 0; i < resolved.length; i++) {
    // Cross-source matches (enrichment + plain duplicate) are collapsed into an existing
    // row by the caller, never inserted as a second row.
    if (skipDraftIndices.has(i)) continue;

    const { draft: d, instrumentId } = resolved[i];
    attempted++;
    const externalId = d.externalId ?? `import:${importId}:${i}`;
    const [row] = await db
      .insert(transactions)
      .values({
        portfolioId: targetPortfolioId,
        instrumentId,
        type: d.action,
        quantity: d.quantity,
        price: d.price,
        fees: d.fees,
        tax: d.tax ?? null,
        executedPrice: d.executedPrice ?? null,
        fxRate: d.fxRate ?? null,
        venue: d.venue ?? null,
        documentRefs: d.documentRefs ?? null,
        kind: d.kind ?? null,
        description: d.description ?? null,
        // The cash leg is always in the transaction's own currency, independent of where
        // the instrument is listed/priced.
        currency: d.currency,
        executedAt: d.executedAt,
        source,
        status,
        importId,
        externalId,
        savingsPlanId: d.savingsPlanId ?? null,
      })
      .onConflictDoNothing()
      .returning();
    if (row) {
      written.push(row);
      await db
        .insert(transactionSources)
        .values({
          transactionId: row.id,
          sourceType: sourceTypeForDraft(d, source),
          importId,
          externalId: d.externalId ?? null,
          orderRef: d.orderRef ?? null,
          tax: d.tax ?? null,
          fees: d.fees ?? null,
          executedPrice: d.executedPrice ?? null,
          fxRate: d.fxRate ?? null,
          venue: d.venue ?? null,
          taxComponents: d.taxComponents
            ? (d.taxComponents as Record<string, unknown>)
            : null,
          confidence: String(d.confidence),
        })
        .onConflictDoNothing();
      // Extra source events folded into this one transaction (e.g. a TR perk cash credit
      // collapsed into the buy it funds). Each is its own provenance row — same sourceType,
      // distinct externalId — so re-imports and the resolved-events ledger dedup correctly.
      for (const extra of d.extraSources ?? []) {
        await db
          .insert(transactionSources)
          .values({
            transactionId: row.id,
            sourceType: sourceTypeForDraft(d, source),
            importId,
            externalId: extra.externalId,
            confidence: String(d.confidence),
            rawData: (extra.raw ?? null) as Record<string, unknown> | null,
          })
          .onConflictDoNothing();
      }
    } else {
      skipped++;
    }
  }
  return { written, attempted, skipped };
}

/**
 * High-level composer used by the sync path: resolve instruments → classify cross-source
 * matches → write the genuinely-new drafts (with `status`) and **collapse** every match
 * (enrichment AND plain duplicate) into the existing row, so the same trade arriving from
 * two sources (e.g. a TR PDF then a TR sync) becomes ONE most-complete row — never two.
 *
 * There is no interactive 409 here (that's a confirm-path concern). `collapsed` returns the
 * externalIds of incoming drafts that matched an existing row, so the caller can record them
 * in its durable ledger and not re-process them every sync.
 */
export async function materializeDrafts(
  ctx: Ctx,
  args: {
    drafts: ParsedTransaction[];
    targetPortfolioId: string;
    source: TxSource;
    importId: string;
    status: TxStatus;
    isEu: boolean;
  },
): Promise<{
  written: TxRow[];
  attempted: number;
  skipped: number;
  enriched: number;
  collapsed: string[];
  matchedTransactionIds: string[];
}> {
  const { drafts, targetPortfolioId, source, importId, status, isEu } = args;
  if (drafts.length === 0)
    return {
      written: [],
      attempted: 0,
      skipped: 0,
      enriched: 0,
      collapsed: [],
      matchedTransactionIds: [],
    };

  const resolved = await resolveDraftInstruments(ctx, drafts, { isEu });
  const { enrichmentMatches, plainDuplicates } = await classifyDraftDuplicates(ctx, {
    resolved,
    targetPortfolioId,
    source,
    importId,
  });

  // Every cross-source match collapses into the existing row — never a second insert.
  const allMatches = [
    ...enrichmentMatches,
    ...plainDuplicates.map((p) => ({
      draftIndex: p.draftIndex,
      matchedTransactionId: p.matched.id,
    })),
  ];
  const skipDraftIndices = new Set(allMatches.map((m) => m.draftIndex));

  const { written, attempted, skipped } = await ctx.db.transaction((tx) =>
    writeResolvedDrafts(tx, {
      resolved,
      skipDraftIndices,
      targetPortfolioId,
      source,
      importId,
      status,
    }),
  );

  // Fold each matched draft into its existing row: attaches a source row + re-rolls the
  // tax/fees/price rollup (an enrichment adds new detail; a plain duplicate just records
  // provenance). Best-effort — never fail the sync. Collect the externalIds so the caller
  // can mark them resolved and not re-process them next sync.
  let enriched = 0;
  const collapsed: string[] = [];
  const matchedTransactionIds = new Set<string>();
  for (const { draftIndex, matchedTransactionId } of allMatches) {
    const draft = resolved[draftIndex].draft;
    try {
      await enrichTransactionFromDrafts(matchedTransactionId, ctx.db, [draft], {
        importId,
        importSource: source,
      });
      enriched++;
      matchedTransactionIds.add(matchedTransactionId);
    } catch (err) {
      ctx.log?.warn({ err, matchedTransactionId }, "materializeDrafts: enrichment failed (non-fatal)");
    }
    if (draft.externalId) collapsed.push(draft.externalId);
  }

  return {
    written,
    attempted,
    skipped,
    enriched,
    collapsed,
    matchedTransactionIds: [...matchedTransactionIds],
  };
}
