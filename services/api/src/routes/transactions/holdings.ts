import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { transactions, dismissedAnomalies, trConnections } from "@portfolio/db";
import { requireUser } from "../../plugins/auth.js";
import { toCoreTxns } from "../../services/tx-core.js";
import { netManualAdjustments } from "../../services/pytr/reconcile.js";
import { loadSparklines } from "../../services/sparklines.js";
import type { InstrumentMeta } from "../../services/valuation.js";
import { needsSectorEnrichment, needsNameEnrichment } from "../../services/instrument-metadata.js";
import { enqueueInstrumentMetadata } from "../../services/scheduler.js";
import { withDerivationCache } from "../../lib/derivation-cache.js";
import { logTiming } from "../../lib/timing.js";
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
  ownedPortfolio,
  corporateActionsFor,
  loadValuation,
  loadDrift,
  anomaliesCache,
  costBasisFromQuery,
} from "./shared.js";

export function registerHoldingsRoutes(app: FastifyInstance) {
  app.get<{ Params: PortfolioParams }>(
    "/portfolios/:portfolioId/holdings",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const t0 = performance.now();
      const { id } = requireUser(request);
      const { portfolioId } = request.params;
      const portfolio = await ownedPortfolio(app, id, portfolioId);
      if (!portfolio) {
        return reply.code(404).send({ error: "portfolio_not_found" });
      }
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
      const durationMs = performance.now() - t0;
      logTiming(request, "GET /portfolios/:id/holdings", durationMs, {
        portfolioId,
        holdingCount: holdings.length,
        anomalyCount: filtered.length,
      });
      return { holdings, anomalies: filtered };
    },
  );

  app.get<{ Params: PortfolioParams }>(
    "/portfolios/:portfolioId/anomalies",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const t0 = performance.now();
      const { id } = requireUser(request);
      const { portfolioId } = request.params;
      const portfolio = await ownedPortfolio(app, id, portfolioId);
      if (!portfolio) {
        return reply.code(404).send({ error: "portfolio_not_found" });
      }
      const { filtered } = await withDerivationCache(anomaliesCache, portfolioId, async () => {
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
        const rawReconciliation = trConn?.lastReconciliation as
          ReconciliationGap | null | undefined;
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
        return { filtered };
      });
      const durationMs = performance.now() - t0;
      logTiming(request, "GET /portfolios/:id/anomalies", durationMs, {
        portfolioId,
        anomalyCount: filtered.length,
      });
      return { anomalies: filtered };
    },
  );

  app.get<{ Params: PortfolioParams; Querystring: { costBasis?: string } }>(
    "/portfolios/:portfolioId/summary",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const t0 = performance.now();
      const { id } = requireUser(request);
      const { portfolioId } = request.params;
      const portfolio = await ownedPortfolio(app, id, portfolioId);
      if (!portfolio) {
        return reply.code(404).send({ error: "portfolio_not_found" });
      }
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
      const durationMs = performance.now() - t0;
      logTiming(request, "GET /portfolios/:id/summary", durationMs, {
        portfolioId,
        holdingCount: summary.holdings.length,
      });
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
