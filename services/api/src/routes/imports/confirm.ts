import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { screenshotImports, trResolvedEvents } from "@portfolio/db";
import { parsedGoldContractSchema, parsedTransactionSchema } from "@portfolio/schema";
import { accountMismatchVerdict } from "./helpers.js";
import { ownedPortfolio } from "../helpers.js";
import { isCashMovementAction } from "../../services/pytr/mapper.js";
import {
  resolveDraftInstruments,
  classifyDraftDuplicates,
  writeResolvedDrafts,
} from "../../services/materialize-drafts.js";
import { writeGoldContracts } from "./gold-contracts.js";
import { finalizeConfirmedImport } from "./finalize.js";

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
      const id = request.userId;
      const [imp] = await app.db
        .select()
        .from(screenshotImports)
        .where(
          and(eq(screenshotImports.id, request.params.importId), eq(screenshotImports.userId, id)),
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
        const mismatch = await accountMismatchVerdict(
          app,
          id,
          importedAccountNumber,
          targetPortfolioId,
        );
        if (mismatch) {
          request.log.info(
            { importId: imp.id, kind: mismatch.kind },
            "confirm blocked: account mismatch",
          );
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
          : isDkbPdf || isTrPdf
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
        {
          importId: imp.id,
          parser: imp.parser,
          source,
          txDrafts: drafts.length,
          contracts: contracts.length,
        },
        "confirm started",
      );

      // Pass 1 — resolve each draft's instrument (best-effort, may hit the network). Done
      // OUTSIDE the transaction so a slow OpenFIGI/provider lookup never holds a DB tx open.
      const resolved = await resolveDraftInstruments(app, drafts, { isEu });

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
      // independently and is authoritative. The classifier itself lives in
      // services/materialize-drafts.ts so the sync path reuses it.
      //
      // KNOWN RACE (4.3): this SELECT runs outside the write transaction below. Two concurrent
      // confirms of overlapping sources can both clear the 409 and both write. The practical
      // risk is low (same user, two concurrent confirms in sub-second window), and the fallback
      // is the same-source `(portfolioId, source, externalId)` unique index which absorbs true
      // re-imports silently. A future hardening pass can re-run this check inside the transaction.
      const { enrichmentMatches, enrichmentDraftIndices, plainDuplicates } =
        await classifyDraftDuplicates(app, {
          resolved,
          targetPortfolioId,
          source,
          importId: imp.id,
        });
      const likelyDuplicates = plainDuplicates.length;
      if (likelyDuplicates > 0) {
        request.log.info(
          {
            importId: imp.id,
            likelyDuplicates,
            enrichments: enrichmentMatches.length,
            acknowledged: acknowledgeDuplicates,
          },
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
        // Pass 2 — write the (non-enrichment) drafts as new transactions + source rows.
        // Confirm writes status="normal"; the shared writer is also used by sync with "draft".
        const {
          written: draftRows,
          attempted: draftAttempted,
          skipped: draftSkipped,
        } = await writeResolvedDrafts(tx, {
          resolved,
          // Confirm skips only enrichment matches; acknowledged plain duplicates are still
          // inserted (the user opted in via acknowledgeDuplicates → 409 cleared).
          skipDraftIndices: enrichmentDraftIndices,
          targetPortfolioId,
          source,
          importId: imp.id,
          status: "normal",
        });
        attempted += draftAttempted;
        skipped += draftSkipped;
        const written = [...draftRows];

        // Financed gold contracts: create the gold instrument + loan, then insert
        // the derived legs (buy, drawdown, admin/discount fees, due installments),
        // all linked by loanId so the outstanding balance derives in @portfolio/core.
        if (contracts.length > 0) {
          const goldResult = await writeGoldContracts(tx, {
            contracts,
            targetPortfolioId,
            importId: imp.id,
            source,
          });
          written.push(...goldResult.written);
          attempted += goldResult.attempted;
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
              .set({
                portfolioId: targetPortfolioId,
                parsedJson: { ...parsed, drafts: remaining, errors: remainingErrors },
              })
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

      const { enriched } = await finalizeConfirmedImport(app, {
        importId: imp.id,
        targetPortfolioId,
        created,
        isPytr,
        isDkbPdf,
        isTrPdf,
        source,
        enrichmentMatches,
        resolved,
        userId: id,
        requestLog: request.log,
      });

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
