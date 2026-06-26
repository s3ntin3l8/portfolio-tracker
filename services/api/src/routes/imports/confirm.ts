import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import {
  loans,
  screenshotImports,
  transactions,
  transactionSources,
  trResolvedEvents,
} from "@portfolio/db";
import {
  parsedGoldContractSchema,
  parsedTransactionSchema,
  type AssetClass,
} from "@portfolio/schema";
import { requireUser } from "../../plugins/auth.js";
import { accountMismatchVerdict, ownedPortfolio } from "./helpers.js";
import {
  buildContractLegs,
  goldInstrumentForContract,
} from "../../services/parsers/gold-contract.js";
import { isCashMovementAction } from "../../services/pytr/mapper.js";
import {
  enrichTransactionFromDrafts,
  enrichTransactionsFromStoredDocuments,
} from "../../services/enrichment.js";
import { findCrossSourceDuplicates, classifyMatch } from "../../services/parsers/dedup.js";
import {
  findOrCreateInstrument,
  marketForAssetClass,
  marketForEuInstrument,
} from "../../services/instruments.js";
import { getMarketData } from "../../services/market-data.js";
import { resolveCryptoIsin, PRICEABLE_FOREIGN_MARKETS, isIdxEtfSymbol } from "@portfolio/market-data";
import {
  finalizeReceipts,
  linkTrReceiptsToTransactions,
  retainDocumentForTransaction,
  getStagedDocumentId,
  getDocumentForImport,
} from "../../storage/receipts.js";

const confirmBodySchema = z.object({
  // Target portfolio — required when the import was uploaded without one (upload-first
  // flow). Falls back to `imp.portfolioId` for pytr and legacy uploads that stored one.
  portfolioId: z.string().uuid().optional(),
  // At least one of `transactions` / `contracts` must be present.
  transactions: z.array(parsedTransactionSchema).default([]),
  // Financed gold-purchase contracts (Pegadaian/Galeri24 cicilan). Each becomes a
  // loan row plus its derived legs.
  contracts: z.array(parsedGoldContractSchema).default([]),
  // Set true to proceed past an account-number mismatch (the file looks like it belongs
  // to a different portfolio). The server otherwise refuses with 409 (#197).
  acknowledgeAccountMismatch: z.boolean().default(false),
  // Set true to proceed past cross-source economic duplicates (the same trade was already
  // imported from another format). The server otherwise refuses with 409 (#217).
  acknowledgeDuplicates: z.boolean().default(false),
});

/** Registers POST /imports/:importId/confirm — write the (possibly edited) drafts as
 *  transactions. Extracted from imports.ts (the ~730-line two-pass confirm transaction). */
export function registerConfirmImportRoute(app: FastifyInstance) {
  app.post<{ Params: { importId: string } }>(
    "/imports/:importId/confirm",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = requireUser(request);
      const [imp] = await app.db
        .select()
        .from(screenshotImports)
        .where(
          and(
            eq(screenshotImports.id, request.params.importId),
            eq(screenshotImports.userId, id),
          ),
        )
        .limit(1);
      if (!imp) {
        return reply.code(404).send({ error: "import_not_found" });
      }
      if (imp.status === "confirmed") {
        return reply.code(409).send({ error: "already_confirmed" });
      }

      const confirmBody = confirmBodySchema.parse(request.body);
      const {
        contracts,
        portfolioId: bodyPortfolioId,
        acknowledgeAccountMismatch,
        acknowledgeDuplicates,
      } = confirmBody;
      // `drafts` is `let` because a cash-outside portfolio drops cash-movement rows below.
      let drafts = confirmBody.transactions;
      if (drafts.length === 0 && contracts.length === 0) {
        return reply.code(400).send({ error: "nothing_to_confirm" });
      }
      // Resolve the target portfolio: prefer the request body, fall back to what was
      // stored on the import (pytr always has one; legacy uploads may too). New-style
      // uploads have no stored portfolio so body is required.
      const targetPortfolioId = bodyPortfolioId ?? imp.portfolioId;
      if (!targetPortfolioId) {
        return reply.code(400).send({ error: "portfolio_required" });
      }
      const targetPortfolio = await ownedPortfolio(app, id, targetPortfolioId);
      if (!targetPortfolio) {
        return reply.code(404).send({ error: "portfolio_not_found" });
      }

      // Account-mismatch guard (#197, defense-in-depth): if the file's account number looks
      // like it belongs to a different portfolio than the chosen one, refuse until the
      // caller explicitly acknowledges. The web flow surfaces this as a banner + "Import
      // anyway". pytr is exempt — it's always bound to its connection's portfolio.
      const importedAccountNumber = (imp.parsedJson as { accountNumber?: string | null } | null)
        ?.accountNumber;
      if (!acknowledgeAccountMismatch && imp.parser !== "pytr") {
        const mismatch = await accountMismatchVerdict(app, id, importedAccountNumber, targetPortfolioId);
        if (mismatch) {
          request.log.info({ importId: imp.id, kind: mismatch.kind }, "confirm blocked: account mismatch");
          return reply.code(409).send({ error: "account_mismatch", ...mismatch });
        }
      }
      const isDkb = imp.parser === "dkb";
      const isPytr = imp.parser === "pytr";
      // The Trade Republic CSV export is an offline ingestion of the same TR account: it
      // resolves ISINs like the pytr path, but is a connectionless one-shot import, so it
      // stays `source="csv"` (not the pytr collector / resolved-events branch).
      const isTrCsv = imp.parser === "tr-csv";
      // Deterministic PDF parsers tag the import with "dkb-pdf" / "tr-pdf" at upload time
      // so we can route them to source="pdf" and preserve EU/ISIN instrument resolution.
      const isDkbPdf = imp.parser === "dkb-pdf";
      const isTrPdf = imp.parser === "tr-pdf";
      // IBKR Activity Flex XML: its own source tag so dedup, enrichment, and the rank
      // rollup treat it correctly. ISIN resolution uses the same EU/OpenFIGI path since
      // IBKR carries ISINs in the Flex data (global, not EU-only, but the code path works).
      const isIbkr = imp.parser === "ibkr";
      // pytr is its own source; DKB/TR PDFs get the new "pdf" source; IBKR gets "ibkr";
      // DKB-CSV and TR-CSV exports are CSV; everything else (LLM vision) is screenshot.
      const source = isPytr
        ? "pytr"
        : isIbkr
          ? "ibkr"
          : (isDkbPdf || isTrPdf)
            ? "pdf"
            : imp.parser === "csv" || isDkb || isTrCsv
              ? "csv"
              : "screenshot";
      // DKB, Trade Republic, and IBKR all carry ISINs in their exports — use the
      // OpenFIGI ISIN-resolution path for all of them.
      const isEu = isDkb || isPytr || isTrCsv || isDkbPdf || isTrPdf || isIbkr;

      // Cash-boundary filter (issue #326): a cash-outside (invest-only) portfolio excludes
      // genuine cash movements (deposits/withdrawals) so they don't manufacture phantom flows
      // against a value boundary that excludes cash. The pytr *sync* path already gates these
      // at staging; the deterministic TR PDF path only learns its target portfolio here at
      // confirm time, so it filters here instead. The only cash-movement rows a TR PDF emits
      // are tax-optimization deposit/withdrawal true-ups. Surfaced (logged + returned), never
      // silently dropped. Generalizes to any cash-outside import if we choose to widen `isTrPdf`.
      let excludedCashMovements = 0;
      if (isTrPdf && !targetPortfolio.cashCounted) {
        const before = drafts.length;
        drafts = drafts.filter((d) => !isCashMovementAction(d.action));
        excludedCashMovements = before - drafts.length;
        if (excludedCashMovements > 0) {
          request.log.info(
            { importId: imp.id, excludedCashMovements, portfolioId: targetPortfolioId },
            "confirm: excluded cash movements (cash-outside portfolio)",
          );
        }
      }

      request.log.info(
        { importId: imp.id, parser: imp.parser, source, txDrafts: drafts.length, contracts: contracts.length },
        "confirm started",
      );

      // Resolve EU broker (DKB/Trade Republic) ISINs to a ticker/market/currency once
      // each (best-effort, cached). OpenFIGI is keyless; failures and unknown ISINs fall
      // back to Xetra/ISIN/EUR.
      const isinCache = new Map<
        string,
        { symbol: string; market: string; currency: string; assetClass: AssetClass } | null
      >();
      async function resolveEuIsin(isin: string) {
        if (isinCache.has(isin)) {
          request.log.debug({ isin }, "isin cache hit");
          return isinCache.get(isin)!;
        }
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
          request.log.debug({ isin, via: "openfigi" }, "isin lookup");
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
            // best-effort; never block a confirm on discovery
            request.log.warn({ isin, err }, "isin resolve failed");
          }
        }
        if (resolved) {
          request.log.debug(
            { isin, symbol: resolved.symbol, market: resolved.market, assetClass: resolved.assetClass },
            "isin resolved",
          );
        }
        isinCache.set(isin, resolved);
        return resolved;
      }

      // Pass 1 — resolve each draft's instrument (best-effort, may hit the network). Done
      // OUTSIDE the transaction so a slow OpenFIGI/provider lookup never holds a DB tx open.
      const resolved: { draft: (typeof drafts)[number]; instrumentId: string | null }[] = [];
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

          // IDX KIK ETFs read "Reksa Dana" in screenshots so the parser tags them
          // mutual_fund. Their ticker reveals the truth — reclassify so they group under
          // ETFs, not reksa dana. Gated on !isEu + market === "IDX" so EU mutual funds
          // whose symbols might match the pattern are never touched. (#120)
          if (!isEu && assetClass === "mutual_fund" && market === "IDX" && isIdxEtfSymbol(symbol))
            assetClass = "etf";

          if (isEu && d.isin) {
            const r = await resolveEuIsin(d.isin);
            if (r) {
              // Always adopt the resolved ticker and asset class. Adopt the venue + currency
              // only when resolution lands on a market our providers price directly that
              // differs from the broker's Xetra/EUR default — US stocks (USD via Twelve Data)
              // and crypto (EUR via CoinGecko). Otherwise keep the Xetra/EUR pin: DKB/Trade
              // Republic execute on Xetra, and OpenFIGI's first listing for a EUR fund is
              // often another venue that no provider covers / defaults to USD (PR #130).
              symbol = r.symbol;
              assetClass = r.assetClass;
              // Adopt the resolved venue/currency only for markets that differ from the
              // broker's Xetra/EUR default AND make sense for the ISIN's domicile country.
              // For US listings: only allow the US market when the ISIN is itself
              // US-domiciled — a non-US ISIN (IE…, DE…, GB…) that resolves to a US ticker
              // is a cross-listing collision (e.g. CSSPX = iShares on Xetra vs Cohen &
              // Steers on NYSE). Crypto (CRYPTO_MARKET) is unaffected by the ISIN check.
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
            app.db,
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
            // Delegate to the cached resolveEuIsin so any future path that produces an
            // unknown market benefits from the same OpenFIGI correction without a second
            // round-trip. On the current EU/IDX/gold paths market is always known at this
            // point, so the guard inside findOrCreateInstrument never fires — this is
            // defensive / future-proofing only.
            {
              resolveMarket: async (isin) => {
                const r = await resolveEuIsin(isin);
                return r ? { market: r.market, currency: r.currency } : null;
              },
            },
          );
          instrumentId = instrument.id;
          request.log.debug({ symbol, market, instrumentId }, "instrument resolved");
        }
        resolved.push({ draft: d, instrumentId });
      }

      // Cross-source duplicate check (#196, hardened to a real backstop in #217, enrichment
      // classification added in #259): now that instruments are resolved, find drafts that
      // economically match a transaction already committed to the target portfolio. Matches
      // are classified into:
      //   • "enrichment" — different source + import carries a document or taxComponents.
      //     Auto-applied in pass 2 (links PDF, folds in tax/fees) with no blocking 409.
      //   • "duplicate" — same source or no new value. Blocks with a 409 unless acknowledged.
      //
      // Invariant: confirm owns routing. The advisory upload-time badges are best-effort
      // (keyed on ISIN/WKN rather than resolved instrumentId); this pass re-classifies
      // independently and is authoritative.
      //
      // KNOWN RACE (4.3): this SELECT runs outside the write transaction below. Two concurrent
      // confirms of overlapping sources can both clear the 409 and both write. The practical
      // risk is low (same user, two concurrent confirms in sub-second window), and the fallback
      // is the same-source `(portfolioId, source, externalId)` unique index which absorbs true
      // re-imports silently. A future hardening pass can re-run this check inside the transaction.
      let likelyDuplicates = 0;
      // Enrichment matches resolved here, applied in pass 2 BEFORE finalizeReceipts.
      const enrichmentMatches: Array<{ draftIndex: number; matchedTransactionId: string }> = [];
      const enrichmentDraftIndices = new Set<number>();
      duplicateCheck: {
        const committed = await app.db
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

        // Same-source re-imports (e.g. overlapping monthly CSV exports) are already absorbed
        // silently by the `(portfolioId, source, externalId)` unique index + onConflictDoNothing
        // on insert. Excluding those from the 409 set keeps that flow quiet and reserves the
        // block for genuine *cross-source* / divergent duplicates — the bug this targets.
        const committedExtKeys = new Set(
          committed
            .filter((r) => r.externalId)
            .map((r) => `${r.source}|${r.externalId}`),
        );

        const committedCandidates = committed.map((r) => ({
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
            // Skip economic matches that are also a guaranteed no-op write (same source +
            // same content externalId already present) — those need no surfacing.
            const d = resolved[draftIndex].draft;
            const prospectiveExtId = d.externalId ?? `import:${imp.id}:${draftIndex}`;
            return !committedExtKeys.has(`${source}|${prospectiveExtId}`);
          },
        );
        if (allMatches.length === 0) break duplicateCheck;

        // Check whether this import has a staged document (signals enrichment value).
        const hasStagedDoc = !!(await getStagedDocumentId(app, imp.id));

        // Classify each match. Enrichments are removed from the insert set and applied in
        // pass 2; plain duplicates block with a 409 (unless already acknowledged).
        const plainDuplicates: typeof allMatches = [];
        for (const match of allMatches) {
          const d = resolved[match.draftIndex].draft;
          const hasTaxComponents = d.taxComponents && Object.keys(d.taxComponents).length > 0;
          const draftHasEnrichment = hasStagedDoc || !!hasTaxComponents;
          const kind = classifyMatch(source, match.matched.source ?? "csv", draftHasEnrichment);
          if (kind === "enrichment") {
            enrichmentMatches.push({ draftIndex: match.draftIndex, matchedTransactionId: match.matched.id });
            enrichmentDraftIndices.add(match.draftIndex);
          } else {
            plainDuplicates.push(match);
          }
        }

        likelyDuplicates = plainDuplicates.length;
        if (likelyDuplicates === 0) break duplicateCheck;

        request.log.info(
          { importId: imp.id, likelyDuplicates, enrichments: enrichmentMatches.length, acknowledged: acknowledgeDuplicates },
          "confirm: cross-source duplicates among selected drafts",
        );
        if (!acknowledgeDuplicates) {
          const isoDay = (v: Date | string) =>
            (v instanceof Date ? v.toISOString() : new Date(v).toISOString()).slice(0, 10);
          return reply.code(409).send({
            error: "duplicate_transactions",
            count: likelyDuplicates,
            duplicates: plainDuplicates.map(({ draftIndex, matched }) => {
              const d = resolved[draftIndex].draft;
              return {
                draftIndex,
                matchedTransactionId: matched.id,
                name: d.name ?? d.isin ?? d.ticker ?? null,
                action: d.action,
                quantity: d.quantity,
                executedAt: isoDay(d.executedAt),
                matchedSource: matched.source,
                matchedExecutedAt: isoDay(matched.executedAt),
              };
            }),
          });
        }
      }

      // Pass 2 — write the transactions and reconcile the import atomically.
      const parsed = (imp.parsedJson ?? {}) as {
        drafts?: { externalId?: string | null }[];
        errors?: { eventId?: string; severity?: string }[];
        seenEventIds?: string[];
      };
      let attempted = 0;
      let skipped = 0;
      let finalStatus: "draft" | "confirmed" = "draft";
      const created = await app.db.transaction(async (tx) => {
        const written: (typeof transactions.$inferSelect)[] = [];
        for (let i = 0; i < resolved.length; i++) {
          // Skip drafts that matched an existing transaction as enrichments — they are applied
          // below (after the transaction) rather than inserted as new rows.
          if (enrichmentDraftIndices.has(i)) continue;

          const { draft: d, instrumentId } = resolved[i];
          attempted++;
          const externalId = d.externalId ?? `import:${imp.id}:${i}`;
          const [row] = await tx
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
              // The cash leg is always in the transaction's own currency (EUR for DKB),
              // independent of where the instrument is listed/priced.
              currency: d.currency,
              executedAt: d.executedAt,
              source,
              importId: imp.id,
              externalId,
              savingsPlanId: d.savingsPlanId ?? null,
            })
            .onConflictDoNothing()
            .returning();
          if (row) {
            written.push(row);
            // Write the first-import source row for provenance + enrichment rollup.
            // sourceType: draft with taxComponents = pdf (e.g. TR/DKB PDF); else mapped from source.
            const hasTaxComponents = d.taxComponents && Object.keys(d.taxComponents).length > 0;
            const srcType = (
              hasTaxComponents ? "pdf"
              : source === "pytr" ? "pytr"
              : source === "screenshot" ? "screenshot"
              : source === "pdf" ? "pdf"
              : "csv"
            ) as "pdf" | "pytr" | "screenshot" | "csv" | "manual";
            await tx
              .insert(transactionSources)
              .values({
                transactionId: row.id,
                sourceType: srcType,
                importId: imp.id,
                externalId: d.externalId ?? null,
                orderRef: d.orderRef ?? null,
                tax: d.tax ?? null,
                fees: d.fees ?? null,
                executedPrice: d.executedPrice ?? null,
                fxRate: d.fxRate ?? null,
                venue: d.venue ?? null,
                taxComponents: hasTaxComponents ? (d.taxComponents as Record<string, unknown>) : null,
              })
              .onConflictDoNothing();
          } else {
            skipped++;
            request.log.debug({ externalId }, "duplicate skipped");
          }
        }

        // Financed gold contracts: create the gold instrument + loan, then insert
        // the derived legs (buy, drawdown, admin/discount fees, due installments),
        // all linked by loanId so the outstanding balance derives in @portfolio/core.
        const now = new Date();
        for (let ci = 0; ci < contracts.length; ci++) {
          const c = contracts[ci];
          const gold = goldInstrumentForContract(c);
          const instrument = await findOrCreateInstrument(tx, {
            symbol: gold.symbol,
            market: gold.market,
            assetClass: "gold",
            unit: "grams",
            currency: c.currency,
            name: gold.name,
            isin: null,
          });
          const [loan] = await tx
            .insert(loans)
            .values({
              portfolioId: targetPortfolioId,
              instrumentId: instrument.id,
              importId: imp.id,
              contractNo: c.contractNo ?? null,
              provider: c.provider ?? "GALERI24",
              purchasePrice: c.purchasePrice,
              downPayment: c.downPayment,
              adminFee: c.adminFee,
              discount: c.discount,
              principal: c.principal,
              marginTotal: c.marginTotal,
              tenorMonths: c.tenorMonths,
              monthlyInstallment: c.monthlyInstallment,
              startDate: c.startDate.toISOString().slice(0, 10),
              schedule: c.schedule.map((r) => ({
                n: r.n,
                dueDate: r.dueDate.toISOString().slice(0, 10),
                pokok: r.pokok,
                sewaModal: r.sewaModal,
                angsuran: r.angsuran,
                sisaPokok: r.sisaPokok,
              })),
              costBasisMode: c.costBasisMode,
              currency: c.currency,
            })
            .returning();

          const legs = buildContractLegs(c, now);
          for (let li = 0; li < legs.length; li++) {
            const leg = legs[li];
            attempted++;
            const externalId = `import:${imp.id}:loan:${ci}:${li}`;
            const [row] = await tx
              .insert(transactions)
              .values({
                portfolioId: targetPortfolioId,
                instrumentId: leg.role === "gold_buy" ? instrument.id : null,
                type: leg.type,
                quantity: leg.quantity,
                price: leg.price,
                fees: leg.fees,
                currency: leg.currency,
                executedAt: leg.executedAt,
                source,
                importId: imp.id,
                loanId: loan.id,
                externalId,
              })
              .onConflictDoNothing()
              .returning();
            if (row) written.push(row);
            else request.log.debug({ externalId }, "duplicate skipped");
          }
        }

        const staged = Array.isArray(parsed.drafts) ? parsed.drafts : [];
        const errors = Array.isArray(parsed.errors) ? parsed.errors : [];
        const confirmedExtIds = new Set(
          drafts.map((d) => d.externalId).filter((x): x is string => Boolean(x)),
        );

        const isSyncImport = imp.parser === "pytr" || imp.parser === "ibkr";
        if (isSyncImport) {
          const resolvedSource = imp.parser as "pytr" | "ibkr";
          // Record confirmed events durably so a later manual deletion doesn't resurface them.
          if (confirmedExtIds.size) {
            await tx
              .insert(trResolvedEvents)
              .values(
                [...confirmedExtIds].map((eventId) => ({
                  portfolioId: targetPortfolioId,
                  source: resolvedSource,
                  eventId,
                  resolution: "confirmed",
                })),
              )
              .onConflictDoNothing();
          }
          // Pass-based confirm: keep the import open while drafts or *actionable* issues
          // remain (ignorable `info` issues don't hold it open); close it otherwise.
          const remaining = staged.filter(
            (d) => !(d.externalId && confirmedExtIds.has(d.externalId)),
          );
          const remainingErrors = errors.filter(
            (e) => !(e.eventId && confirmedExtIds.has(e.eventId)),
          );
          const remainingAttention = remainingErrors.filter((e) => e.severity === "attention");

          if (remaining.length > 0 || remainingAttention.length > 0) {
            await tx
              .update(screenshotImports)
              .set({ portfolioId: targetPortfolioId, parsedJson: { ...parsed, drafts: remaining, errors: remainingErrors } })
              .where(eq(screenshotImports.id, imp.id));
            finalStatus = "draft";
          } else {
            // Closing: record any leftover (ignorable) issues as resolved so the next sync
            // doesn't re-surface them.
            const leftover = remainingErrors
              .map((e) => e.eventId)
              .filter((x): x is string => Boolean(x));
            if (leftover.length) {
              await tx
                .insert(trResolvedEvents)
                .values(
                  leftover.map((eventId) => ({
                    portfolioId: targetPortfolioId,
                    source: resolvedSource,
                    eventId,
                    resolution: "discarded",
                  })),
                )
                .onConflictDoNothing();
            }
            await tx
              .update(screenshotImports)
              .set({ portfolioId: targetPortfolioId, status: "confirmed" })
              .where(eq(screenshotImports.id, imp.id));
            finalStatus = "confirmed";
          }
        } else {
          // Other importers (CSV/screenshot/DKB): pass-based prune when drafts carry stable
          // ids, else all-or-nothing — unchanged behaviour, no durable ledger.
          const everyHasId = staged.length > 0 && staged.every((d) => Boolean(d.externalId));
          const remaining = everyHasId
            ? staged.filter((d) => !(d.externalId && confirmedExtIds.has(d.externalId)))
            : [];
          if (everyHasId && remaining.length > 0) {
            await tx
              .update(screenshotImports)
              .set({ portfolioId: targetPortfolioId, parsedJson: { ...parsed, drafts: remaining } })
              .where(eq(screenshotImports.id, imp.id));
            finalStatus = "draft";
          } else {
            await tx
              .update(screenshotImports)
              .set({ portfolioId: targetPortfolioId, status: "confirmed" })
              .where(eq(screenshotImports.id, imp.id));
            finalStatus = "confirmed";
          }
        }
        return written;
      });

      // For TR imports: link each staged document to its confirmed transaction so that
      // `GET .../document-url` works by transactionId (not just importId).
      // Must run BEFORE finalizeReceipts (which flips status staged→retained or deletes).
      if (isPytr && created.length > 0) {
        const links = created
          .filter((r): r is typeof r & { externalId: string } => Boolean(r.externalId))
          .map((r) => ({ sourceEventId: r.externalId, transactionId: r.id }));
        if (links.length > 0) {
          await linkTrReceiptsToTransactions(app, { importId: imp.id, links });
        }
        // Auto-enrich: fold settlement-PDF tax/fee detail into the newly-confirmed
        // transactions. Must run BEFORE finalizeReceipts (which may delete the staged
        // bytes that enrichment reads). Best-effort: swallow errors so enrichment failure
        // never blocks the confirm response.
        try {
          await enrichTransactionsFromStoredDocuments(app, created.map((r) => r.id));
        } catch (err) {
          request.log.warn({ err }, "auto TR enrichment failed (non-fatal)");
        }
      }

      // Finalize receipt storage: keep if the portfolio has documentRetention=true,
      // else delete the staged bytes (privacy-by-default). Best-effort (#231).
      const portfolio = await ownedPortfolio(app, id, targetPortfolioId);
      const retain = portfolio?.documentRetention ?? false;

      // Auto-enrich: for each draft classified as "enrichment" in duplicateCheck, fold its
      // fields into the matched existing transaction and link/retain the staged PDF.
      // Must run BEFORE finalizeReceipts so the staged bytes are still available.
      // Best-effort: a failure here never blocks the confirm response.
      let enriched = 0;
      if (enrichmentMatches.length > 0) {
        try {
          for (const { draftIndex, matchedTransactionId } of enrichmentMatches) {
            const { draft: d } = resolved[draftIndex];
            await enrichTransactionFromDrafts(
              matchedTransactionId,
              app.db,
              [d],
              { importId: imp.id, importSource: source },
            );
            if (retain) {
              // Link and retain the staged PDF to the target transaction so it surfaces
              // in the transaction-detail view (#259 orphan fix). The 1:1 case: single
              // PDF upload → single matched tx → set documents.transactionId.
              await retainDocumentForTransaction(app, {
                importId: imp.id,
                transactionId: matchedTransactionId,
                portfolioId: targetPortfolioId,
              });
            }
            enriched++;
          }
          request.log.info(
            { importId: imp.id, enriched },
            "confirm: auto-enrichment applied",
          );
        } catch (err) {
          request.log.warn({ err }, "confirm: auto-enrichment failed (non-fatal)");
        }
      }

      await finalizeReceipts(app, {
        importId: imp.id,
        portfolioId: targetPortfolioId,
        retain,
      });

      // For DKB/TR-PDF imports: link every source row to the retained document so the
      // per-source download button works (both new transactions and enrichment matches).
      // The document is always a single file per import (one PDF → many source rows),
      // so we map importId → retained doc id and batch-update in one query.
      if ((isDkbPdf || isTrPdf) && retain) {
        try {
          const retainedDoc = await getDocumentForImport(app, imp.id);
          if (retainedDoc) {
            await app.db
              .update(transactionSources)
              .set({ documentId: retainedDoc.id })
              .where(
                and(
                  eq(transactionSources.importId, imp.id),
                  isNull(transactionSources.documentId),
                ),
              );
            request.log.debug(
              { importId: imp.id, docId: retainedDoc.id },
              "confirm: linked PDF source rows to retained document",
            );
          }
        } catch (err) {
          request.log.warn({ err }, "confirm: failed to link PDF source rows to document (non-fatal)");
        }
      }

      request.log.info(
        {
          importId: imp.id,
          attempted,
          written: created.length,
          enriched,
          skipped,
          skippedDuplicates: attempted - created.length,
          excludedCashMovements,
          finalStatus,
        },
        "confirm complete",
      );
      reply.code(201);
      return {
        confirmed: created.length,
        transactions: created,
        likelyDuplicates,
        enriched,
        skipped,
        excludedCashMovements,
      };
    },
  );
}
