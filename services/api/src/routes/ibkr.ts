import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq, lt, or } from "drizzle-orm";
import {
  ibkrConnections,
  portfolios,
  screenshotImports,
  transactions,
  trResolvedEvents,
} from "@portfolio/db";
import { requireUser } from "../plugins/auth.js";
import { IbkrFlexError } from "../services/ibkr/flex-client.js";
import { syncIbkrConnection } from "../services/ibkr/sync.js";
import { enqueueIbkrSync, SYNC_CLAIM_LEASE_MS } from "../services/scheduler.js";

const connectBodySchema = z.object({
  // The Flex API token from the IBKR portal.
  token: z.string().min(1),
  // The Activity Flex Report query ID.
  queryId: z.string().min(1),
  // The portfolio to land confirmed IBKR transactions in.
  portfolioId: z.guid(),
});

type IbkrConnectionRow = typeof ibkrConnections.$inferSelect;

function serialize(conn: IbkrConnectionRow | null) {
  return {
    status: conn?.status ?? "disconnected",
    portfolioId: conn?.portfolioId ?? null,
    flexAccountId: conn?.flexAccountId ?? null,
    lastSyncAt: conn?.lastSyncAt ?? null,
    lastError: conn?.lastError ?? null,
    lastReconciliation: conn?.lastReconciliation ?? null,
    syncing: conn?.syncing ?? false,
  };
}

export async function ibkrRoute(app: FastifyInstance) {
  async function getConnection(userId: string): Promise<IbkrConnectionRow | null> {
    const [conn] = await app.db
      .select()
      .from(ibkrConnections)
      .where(eq(ibkrConnections.userId, userId))
      .limit(1);
    return conn ?? null;
  }

  // Current connection state (no secrets).
  app.get("/ibkr/connection", { preHandler: app.authenticate }, async (request) => {
    const { id } = requireUser(request);
    return serialize(await getConnection(id));
  });

  // Connect: store encrypted token + queryId. Optionally runs a test-fetch to validate
  // the token before persisting, surfacing expired/invalid errors immediately.
  app.post("/ibkr/connection", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = requireUser(request);
    if (!app.encryption.isEnabled) {
      return reply.code(503).send({ error: "encryption_required" });
    }
    const body = connectBodySchema.parse(request.body);

    // Verify the portfolio belongs to this user.
    const [portfolio] = await app.db
      .select({ id: portfolios.id })
      .from(portfolios)
      .where(and(eq(portfolios.id, body.portfolioId), eq(portfolios.userId, id)))
      .limit(1);
    if (!portfolio) return reply.code(404).send({ error: "portfolio_not_found" });

    // Optional test-fetch: validate the token by firing a real Flex request.
    // If the token is invalid/expired we get an IbkrFlexError back immediately.
    try {
      await app.ibkrFlex.fetchFlexStatement(body.token, body.queryId);
    } catch (err) {
      if (err instanceof IbkrFlexError) {
        return reply
          .code(422)
          .send({ error: err.code === "expired" ? "token_expired" : "token_invalid", detail: err.message });
      }
      // Network / unexpected error — don't block the connection, just log it.
      request.log.warn({ err }, "ibkr test-fetch failed (non-fatal)");
    }

    const tokenEnc = app.encryption.encryptString(body.token);
    await app.db
      .insert(ibkrConnections)
      .values({
        userId: id,
        portfolioId: body.portfolioId,
        tokenEnc,
        queryId: body.queryId,
        status: "connected",
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: ibkrConnections.userId,
        set: {
          portfolioId: body.portfolioId,
          tokenEnc,
          queryId: body.queryId,
          status: "connected",
          lastError: null,
          updatedAt: new Date(),
        },
      });

    request.log.info({ userId: id, portfolioId: body.portfolioId }, "ibkr connected");
    return { status: "connected" };
  });

  // Disconnect: wipe the connection row.
  app.delete("/ibkr/connection", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = requireUser(request);
    await app.db.delete(ibkrConnections).where(eq(ibkrConnections.userId, id));
    reply.code(204);
    return null;
  });

  // Sync now: enqueue a background pg-boss job, with inline fallback.
  app.post(
    "/ibkr/connection/sync",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = requireUser(request);
      const conn = await getConnection(id);
      if (!conn || conn.status !== "connected") {
        return reply.code(409).send({ error: "not_connected" });
      }
      // Atomically claim the sync: flip `syncing` false→true in a single statement so two
      // concurrent requests can't both pass the check (mirrors routes/tr.ts). A claim older
      // than the lease can always be re-taken — it means a prior worker was killed
      // (process restart mid-sync) and left the flag set with no writer left to clear it;
      // the scheduler's startup reaper handles the common case, this is the backstop.
      const [claimed] = await app.db
        .update(ibkrConnections)
        .set({ syncing: true, updatedAt: new Date() })
        .where(
          and(
            eq(ibkrConnections.id, conn.id),
            or(eq(ibkrConnections.syncing, false), lt(ibkrConnections.updatedAt, new Date(Date.now() - SYNC_CLAIM_LEASE_MS))),
          ),
        )
        .returning({ id: ibkrConnections.id });
      if (!claimed) {
        return reply.code(409).send({ error: "sync_in_progress" });
      }
      const releaseClaim = () =>
        app.db
          .update(ibkrConnections)
          .set({ syncing: false, updatedAt: new Date() })
          .where(eq(ibkrConnections.id, conn.id));

      let queued: boolean;
      try {
        ({ queued } = await enqueueIbkrSync(conn.id));
      } catch (err) {
        await releaseClaim();
        request.log.error({ err }, "ibkr sync enqueue failed");
        return reply.code(502).send({ error: "ibkr_sync_failed" });
      }
      if (queued) {
        // The worker clears `syncing` when it finishes; the poller already sees it set.
        reply.code(202);
        return { queued: true };
      }
      // pg-boss unavailable (PGlite / tests) — fall back to inline sync.
      try {
        const result = await syncIbkrConnection(
          app.db, app.encryption, app.ibkrFlex, conn, request.log,
        );
        request.log.info(
          { userId: id, status: result.status, importId: result.importId, drafts: result.drafts },
          "ibkr manual sync done",
        );
        return result;
      } catch (err) {
        // syncIbkrConnection clears `syncing` on most failure paths, but a later throw would
        // leave our claim set — release it so the next sync isn't blocked.
        await releaseClaim();
        request.log.error({ err }, "ibkr sync failed");
        return reply.code(502).send({ error: "ibkr_sync_failed" });
      }
    },
  );

  // Re-import: wipe ibkr transactions, clear the ibkr resolved-events ledger, discard draft.
  app.post("/ibkr/connection/reimport", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = requireUser(request);
    const conn = await getConnection(id);
    if (!conn || !conn.portfolioId) {
      return reply.code(409).send({ error: "not_connected" });
    }
    const portfolioId = conn.portfolioId;
    return app.db.transaction(async (tx) => {
      const removed = await tx
        .delete(transactions)
        .where(and(eq(transactions.portfolioId, portfolioId), eq(transactions.source, "ibkr")))
        .returning({ id: transactions.id });
      await tx
        .delete(trResolvedEvents)
        .where(
          and(
            eq(trResolvedEvents.portfolioId, portfolioId),
            eq(trResolvedEvents.source, "ibkr"),
          ),
        );
      await tx
        .update(screenshotImports)
        .set({ status: "discarded" })
        .where(
          and(
            eq(screenshotImports.userId, id),
            eq(screenshotImports.portfolioId, portfolioId),
            eq(screenshotImports.parser, "ibkr"),
            eq(screenshotImports.status, "draft"),
          ),
        );
      request.log.info({ userId: id, portfolioId, removed: removed.length }, "ibkr reimport");
      return { removed: removed.length };
    });
  });
}
