import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import { portfolios, screenshotImports, transactionSources } from "@portfolio/db";
import type { ParsedTransaction } from "@portfolio/schema";
import { parsedTransactionSchema } from "@portfolio/schema";
import { parserToTxSource, isEuParser } from "../../services/parsers/dedup.js";
import { materializeDrafts } from "../../services/materialize-drafts.js";
import { isCashMovementAction } from "../../services/pytr/mapper.js";
import {
  finalizeReceipts,
  retainDocumentForTransaction,
  getDocumentForImport,
} from "../../storage/receipts.js";
import { accountMismatchVerdict } from "./helpers.js";
import { ownedPortfolio } from "../helpers.js";

const materializeBodySchema = z.object({
  portfolioId: z.string().uuid(),
  acknowledgeAccountMismatch: z.boolean().default(false),
});

const accountCheckBodySchema = z.object({
  units: z.array(z.object({ importId: z.string().uuid(), portfolioId: z.string().uuid() })).max(50),
});

export function registerMaterializeRoutes(app: FastifyInstance) {
  async function materializeResolvedDrafts(opts: {
    imp: { id: string };
    drafts: ParsedTransaction[];
    parserTag: string;
    targetPortfolioId: string;
  }): Promise<{ materialized: number; excludedCashMovements: number; enriched: number }> {
    const { imp, drafts, parserTag, targetPortfolioId } = opts;
    const [pf] = await app.db
      .select({
        cashCounted: portfolios.cashCounted,
        documentRetention: portfolios.documentRetention,
      })
      .from(portfolios)
      .where(eq(portfolios.id, targetPortfolioId))
      .limit(1);

    let toWrite = drafts;
    let excludedCashMovements = 0;
    if (parserTag === "tr-pdf" && pf && !pf.cashCounted) {
      const before = toWrite.length;
      toWrite = toWrite.filter((d) => !isCashMovementAction(d.action));
      excludedCashMovements = before - toWrite.length;
    }

    const res = await materializeDrafts(app, {
      drafts: toWrite,
      targetPortfolioId,
      source: parserToTxSource(parserTag) as "csv" | "pdf" | "ibkr" | "screenshot",
      importId: imp.id,
      status: "draft",
      isEu: isEuParser(parserTag),
    });

    await app.db
      .update(screenshotImports)
      .set({ portfolioId: targetPortfolioId, status: "confirmed" })
      .where(eq(screenshotImports.id, imp.id));

    const retain = pf?.documentRetention ?? false;

    if (retain && res.matchedTransactionIds.length > 0) {
      for (const matchedTransactionId of res.matchedTransactionIds) {
        try {
          await retainDocumentForTransaction(app, {
            importId: imp.id,
            transactionId: matchedTransactionId,
            portfolioId: targetPortfolioId,
          });
        } catch (err) {
          app.log.warn(
            { err, importId: imp.id, matchedTransactionId },
            "retainDocumentForTransaction failed after materialize (non-fatal)",
          );
        }
      }
    }

    try {
      await finalizeReceipts(app, {
        importId: imp.id,
        portfolioId: targetPortfolioId,
        retain,
      });
    } catch (err) {
      app.log.warn(
        { err, importId: imp.id },
        "finalizeReceipts failed after materialize (non-fatal) — import stays confirmed",
      );
    }

    if ((parserTag === "dkb-pdf" || parserTag === "tr-pdf") && retain) {
      try {
        const retainedDoc = await getDocumentForImport(app, imp.id);
        if (retainedDoc) {
          await app.db
            .update(transactionSources)
            .set({ documentId: retainedDoc.id })
            .where(
              and(eq(transactionSources.importId, imp.id), isNull(transactionSources.documentId)),
            );
        }
      } catch (err) {
        app.log.warn(
          { err, importId: imp.id },
          "materialize: failed to link PDF source rows to document (non-fatal)",
        );
      }
    }

    return { materialized: res.written.length, excludedCashMovements, enriched: res.enriched };
  }

  app.post<{ Params: { importId: string } }>(
    "/imports/:importId/materialize",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const id = request.userId;
      const { portfolioId, acknowledgeAccountMismatch } = materializeBodySchema.parse(request.body);

      const [imp] = await app.db
        .select()
        .from(screenshotImports)
        .where(
          and(eq(screenshotImports.id, request.params.importId), eq(screenshotImports.userId, id)),
        )
        .limit(1);
      if (!imp) return reply.code(404).send({ error: "import_not_found" });
      if (imp.status === "confirmed") {
        return reply.code(409).send({ error: "already_confirmed" });
      }

      const parsed = (imp.parsedJson ?? {}) as {
        drafts?: unknown[];
        contracts?: unknown[];
        accountNumber?: string | null;
      };
      const drafts = z
        .array(parsedTransactionSchema)
        .parse(Array.isArray(parsed.drafts) ? parsed.drafts : []);
      const contracts = Array.isArray(parsed.contracts) ? parsed.contracts : [];
      if (contracts.length > 0) {
        return reply.code(400).send({ error: "use_confirm_for_contracts" });
      }
      if (drafts.length === 0) {
        return reply.code(400).send({ error: "nothing_to_materialize" });
      }

      const targetPortfolio = await ownedPortfolio(app, id, portfolioId);
      if (!targetPortfolio) return reply.code(404).send({ error: "portfolio_not_found" });

      if (!acknowledgeAccountMismatch && imp.parser !== "pytr") {
        const mismatch = await accountMismatchVerdict(app, id, parsed.accountNumber, portfolioId);
        if (mismatch) {
          request.log.info(
            { importId: imp.id, kind: mismatch.kind },
            "materialize blocked: account mismatch",
          );
          return reply.code(409).send({ error: "account_mismatch", ...mismatch });
        }
      }

      const mat = await materializeResolvedDrafts({
        imp,
        drafts,
        parserTag: imp.parser ?? "csv",
        targetPortfolioId: portfolioId,
      });
      request.log.info(
        { importId: imp.id, materialized: mat.materialized, portfolioId },
        "import materialized as drafts",
      );
      reply.code(201);
      return {
        importId: imp.id,
        materialized: true,
        portfolioId,
        materializedCount: mat.materialized,
        excludedCashMovements: mat.excludedCashMovements,
        enrichedCount: mat.enriched,
      };
    },
  );

  app.post("/imports/account-check", { preHandler: app.authenticate }, async (request) => {
    const id = request.userId;
    const { units } = accountCheckBodySchema.parse(request.body);

    const mismatches: Array<
      { importId: string } & NonNullable<Awaited<ReturnType<typeof accountMismatchVerdict>>>
    > = [];

    for (const unit of units) {
      const [imp] = await app.db
        .select()
        .from(screenshotImports)
        .where(and(eq(screenshotImports.id, unit.importId), eq(screenshotImports.userId, id)))
        .limit(1);
      if (!imp || imp.status === "confirmed" || imp.parser === "pytr") continue;

      const parsed = (imp.parsedJson ?? {}) as { accountNumber?: string | null };
      const verdict = await accountMismatchVerdict(app, id, parsed.accountNumber, unit.portfolioId);
      if (verdict) mismatches.push({ importId: imp.id, ...verdict });
    }

    return { mismatches };
  });
}
