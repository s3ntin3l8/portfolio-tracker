import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { transactions, dismissedAnomalies, trConnections } from "@portfolio/db";
import { toCoreTxns } from "../../services/tx-core.js";
import { netManualAdjustments } from "../../services/pytr/reconcile.js";
import { loadSparklines } from "../../services/sparklines.js";
import type { InstrumentMeta } from "../../services/valuation.js";
import { needsSectorEnrichment, needsNameEnrichment } from "../../services/instrument-metadata.js";
import { enqueueInstrumentMetadata } from "../../services/scheduler.js";
import {
  computeHoldings,
  detectAnomalies,
  allocationBreakdown,
  type CoreTransaction,
  type PortfolioSummary,
  type ReconciliationGap,
} from "@portfolio/core";

import type { PortfolioParams } from "./shared.js";
import {
  corporateActionsFor,
  loadValuation,
  loadDrift,
  computePortfolioAnomalies,
  costBasisFromQuery,
} from "./shared.js";

export function registerHoldingsRoutes(app: FastifyInstance) {
  app.get<{ Params: PortfolioParams }>(
    "/portfolios/:portfolioId/holdings",
    { preHandler: [app.authenticate, app.requirePortfolio] },
    async (request) => {
      const { portfolioId } = request.params;
      const portfolio = request.portfolio;
      const [rows, trConn, dismissed] = await Promise.all([
        app.db.select().from(transactions).where(eq(transactions.portfolioId, portfolioId)),
        app.db
          .select({ lastReconciliation: trConnections.lastReconciliation })
          .from(trConnections)
          .where(eq(trConnections.portfolioId, portfolioId))
          .limit(1)
          .then((r) => r[0] ?? null),
        app.db
          .select({
            transactionId: dismissedAnomalies.transactionId,
            code: dismissedAnomalies.code,
          })
          .from(dismissedAnomalies)
          .where(eq(dismissedAnomalies.portfolioId, portfolioId)),
      ]);
      const coreTxns: CoreTransaction[] = toCoreTxns(rows);
      const cas = await corporateActionsFor(
        app,
        rows.map((r) => r.instrumentId),
      );
      const holdings = computeHoldings(coreTxns, cas);
      const rawReconciliation = trConn?.lastReconciliation as ReconciliationGap | null | undefined;
      const reconciliation = rawReconciliation
        ? netManualAdjustments(rawReconciliation, coreTxns)
        : rawReconciliation;
      const anomalies = detectAnomalies(coreTxns, cas, {
        cashCounted: portfolio.cashCounted,
        allowNegativeCash: portfolio.allowNegativeCash,
        reconciliationGap: reconciliation ?? null,
      });
      const dismissedSet = new Set(dismissed.map((d) => `${d.transactionId}:${d.code}`));
      const filtered = anomalies.filter(
        (a) => !(a.transactionId && dismissedSet.has(`${a.transactionId}:${a.code}`)),
      );
      request.timingName = "GET /portfolios/:id/holdings";
      request.timingMeta = {
        portfolioId,
        holdingCount: holdings.length,
        anomalyCount: filtered.length,
      };
      return { holdings, anomalies: filtered };
    },
  );

  app.get<{ Params: PortfolioParams }>(
    "/portfolios/:portfolioId/anomalies",
    { preHandler: [app.authenticate, app.requirePortfolio] },
    async (request) => {
      const { portfolioId } = request.params;
      const portfolio = request.portfolio;
      const filtered = await computePortfolioAnomalies(app, portfolio);
      request.timingName = "GET /portfolios/:id/anomalies";
      request.timingMeta = { portfolioId, anomalyCount: filtered.length };
      return { anomalies: filtered };
    },
  );

  app.get<{ Params: PortfolioParams; Querystring: { costBasis?: string } }>(
    "/portfolios/:portfolioId/summary",
    { preHandler: [app.authenticate, app.requirePortfolio] },
    async (request) => {
      const id = request.userId;
      const { portfolioId } = request.params;
      const portfolio = request.portfolio;
      const { summary, metaById } = (await loadValuation(
        app,
        portfolioId,
        portfolio.baseCurrency,
        costBasisFromQuery(request.query),
        portfolio.cashCounted,
        request.log,
      )) as unknown as { summary: PortfolioSummary; metaById: Map<string, InstrumentMeta> };
      if (
        needsSectorEnrichment([...metaById.values()]) ||
        needsNameEnrichment([...metaById.values()])
      ) {
        void enqueueInstrumentMetadata();
      }
      const allocation = allocationBreakdown(summary, metaById);
      const drift = await loadDrift(app, id, portfolioId, allocation);
      const spark = await loadSparklines(
        app.db,
        summary.holdings.map((h) => h.instrumentId),
      );
      request.timingName = "GET /portfolios/:id/summary";
      request.timingMeta = { portfolioId, holdingCount: summary.holdings.length };
      return {
        ...summary,
        holdings: summary.holdings.map((h) => ({
          ...h,
          instrument: metaById.get(h.instrumentId) ?? null,
          sparkline: spark.get(h.instrumentId),
        })),
        allocation,
        ...(Object.keys(drift).length > 0 ? { drift } : {}),
      };
    },
  );
}
