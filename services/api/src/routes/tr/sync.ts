import type { FastifyInstance } from "fastify";
import { and, eq, inArray, lt, or } from "drizzle-orm";
import {
  documents,
  screenshotImports,
  transactions,
  trConnections,
  trResolvedEvents,
} from "@portfolio/db";
import { syncTrConnection } from "../../services/pytr/sync.js";
import { enqueueTrSync, SYNC_CLAIM_LEASE_MS } from "../../services/scheduler.js";
import { deleteStorageObjectsByKey } from "../../storage/receipts.js";
import { getConnection } from "./_shared.js";

export function registerSyncRoutes(app: FastifyInstance) {
  app.post("/tr/connection/sync", { preHandler: app.authenticate }, async (request, reply) => {
    const id = request.userId;
    const conn = await getConnection(app, id);
    if (!conn || conn.status !== "connected") {
      return reply.code(409).send({ error: "not_connected" });
    }

    const [claimed] = await app.db
      .update(trConnections)
      .set({ syncing: true, updatedAt: new Date() })
      .where(
        and(
          eq(trConnections.id, conn.id),
          or(
            eq(trConnections.syncing, false),
            lt(trConnections.updatedAt, new Date(Date.now() - SYNC_CLAIM_LEASE_MS)),
          ),
        ),
      )
      .returning({ id: trConnections.id });
    if (!claimed) {
      return reply.code(409).send({ error: "sync_in_progress" });
    }
    const releaseClaim = () =>
      app.db
        .update(trConnections)
        .set({ syncing: false, updatedAt: new Date() })
        .where(eq(trConnections.id, conn.id));

    let queued: boolean;
    try {
      ({ queued } = await enqueueTrSync(conn.id));
    } catch (err) {
      await releaseClaim();
      request.log.error({ err }, "tr sync enqueue failed");
      return reply.code(502).send({ error: "tr_sync_failed" });
    }
    if (queued) {
      reply.code(202);
      return { queued: true };
    }
    try {
      const result = await syncTrConnection(
        app.db,
        app.encryption,
        app.pytr,
        conn,
        request.log,
        app.storage,
      );
      request.log.info(
        {
          userId: id,
          status: result.status,
          importId: result.importId,
          drafts: result.drafts,
          errors: result.errors,
          cancelled: result.cancelled,
        },
        "tr manual sync done",
      );
      return result;
    } catch (err) {
      await releaseClaim();
      request.log.error({ err }, "tr sync failed");
      return reply.code(502).send({ error: "tr_sync_failed" });
    }
  });

  app.post("/tr/connection/reimport", { preHandler: app.authenticate }, async (request, reply) => {
    const id = request.userId;
    const conn = await getConnection(app, id);
    if (!conn || !conn.portfolioId) {
      return reply.code(409).send({ error: "not_connected" });
    }
    const portfolioId = conn.portfolioId;

    const toRemoveIds = await app.db
      .select({ id: transactions.id })
      .from(transactions)
      .where(and(eq(transactions.portfolioId, portfolioId), eq(transactions.source, "pytr")));
    const txIds = toRemoveIds.map((t) => t.id);
    const docsToClean =
      txIds.length > 0
        ? await app.db
            .select({ id: documents.id, storageKey: documents.storageKey })
            .from(documents)
            .where(inArray(documents.transactionId, txIds))
        : [];

    const { removed } = await app.db.transaction(async (tx) => {
      const removedRows = await tx
        .delete(transactions)
        .where(and(eq(transactions.portfolioId, portfolioId), eq(transactions.source, "pytr")))
        .returning({ id: transactions.id });
      await tx
        .delete(trResolvedEvents)
        .where(
          and(eq(trResolvedEvents.portfolioId, portfolioId), eq(trResolvedEvents.source, "pytr")),
        );
      await tx
        .update(screenshotImports)
        .set({ status: "discarded" })
        .where(
          and(
            eq(screenshotImports.userId, id),
            eq(screenshotImports.portfolioId, portfolioId),
            eq(screenshotImports.parser, "pytr"),
            eq(screenshotImports.status, "draft"),
          ),
        );
      return { removed: removedRows.length };
    });

    if (docsToClean.length > 0) {
      await deleteStorageObjectsByKey(app, docsToClean, `tr reimport portfolioId=${portfolioId}`);
    }

    request.log.info(
      { userId: id, portfolioId, removed, documentsCleaned: docsToClean.length },
      "tr reimport",
    );
    return { removed };
  });
}
