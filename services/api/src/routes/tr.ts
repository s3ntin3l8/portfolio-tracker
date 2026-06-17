import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { portfolios, trConnections } from "@portfolio/db";
import { requireUser } from "../plugins/auth.js";
import { PytrApprovalError, PytrUnavailableError } from "../services/pytr/runner.js";
import { syncTrConnection } from "../services/pytr/sync.js";

const connectBodySchema = z.object({
  phone: z.string().min(3),
  pin: z.string().min(4),
  portfolioId: z.guid(),
  // Break-glass: a manually pasted aws-waf-token, used instead of the solver.
  wafToken: z.string().min(1).optional(),
});

// The DB enum value `awaiting_2fa` denotes the v2 state "push sent, awaiting the user's
// approval in the Trade Republic mobile app" (kept as-is to avoid an enum-rename migration).

type TrConnection = typeof trConnections.$inferSelect;

const IMPORT_CATEGORIES = ["trade", "income", "cashflow", "card"] as const;
const settingsBodySchema = z.object({
  importCategories: z.array(z.enum(IMPORT_CATEGORIES)).min(1),
});

// Never expose the encrypted secrets — only the connection's public state.
function serialize(conn: TrConnection | null) {
  return {
    status: conn?.status ?? "disconnected",
    portfolioId: conn?.portfolioId ?? null,
    lastSyncAt: conn?.lastSyncAt ?? null,
    lastError: conn?.lastError ?? null,
    // Null = the sync default (everything but card spending).
    importCategories: conn?.importCategories ?? null,
  };
}

export async function trRoute(app: FastifyInstance) {
  async function getConnection(userId: string): Promise<TrConnection | null> {
    const [conn] = await app.db
      .select()
      .from(trConnections)
      .where(eq(trConnections.userId, userId))
      .limit(1);
    return conn ?? null;
  }

  async function ownsPortfolio(userId: string, portfolioId: string) {
    const [p] = await app.db
      .select({ id: portfolios.id })
      .from(portfolios)
      .where(and(eq(portfolios.id, portfolioId), eq(portfolios.userId, userId)))
      .limit(1);
    return Boolean(p);
  }

  // Current connection state (no secrets).
  app.get("/tr/connection", { preHandler: app.authenticate }, async (request) => {
    const { id } = requireUser(request);
    return serialize(await getConnection(id));
  });

  // Update which event categories the sync stages (trade/income/cashflow/card).
  app.patch("/tr/connection", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = requireUser(request);
    const conn = await getConnection(id);
    if (!conn) return reply.code(404).send({ error: "not_connected" });
    const { importCategories } = settingsBodySchema.parse(request.body);
    await app.db
      .update(trConnections)
      .set({ importCategories, updatedAt: new Date() })
      .where(eq(trConnections.id, conn.id));
    return serialize({ ...conn, importCategories });
  });

  // Begin pairing: store encrypted creds and kick off the v2 web-login (sends an approval
  // push to the user's Trade Republic mobile app).
  app.post("/tr/connection", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = requireUser(request);
    // Refuse to store Trade Republic credentials without encryption at rest.
    if (!app.encryption.isEnabled) {
      return reply.code(503).send({ error: "encryption_required" });
    }
    const body = connectBodySchema.parse(request.body);
    if (!(await ownsPortfolio(id, body.portfolioId))) {
      return reply.code(404).send({ error: "portfolio_not_found" });
    }

    try {
      await app.pytr.startPairing(id, {
        phone: body.phone,
        pin: body.pin,
        wafToken: body.wafToken,
      });
    } catch (err) {
      if (err instanceof PytrUnavailableError) {
        return reply.code(503).send({ error: "pytr_not_available" });
      }
      request.log.error({ err }, "tr pairing failed to start");
      return reply.code(502).send({ error: "tr_pairing_failed" });
    }

    await app.db
      .insert(trConnections)
      .values({
        userId: id,
        portfolioId: body.portfolioId,
        phoneEnc: app.encryption.encryptString(body.phone),
        pinEnc: app.encryption.encryptString(body.pin),
        status: "awaiting_2fa",
        lastError: null,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: trConnections.userId,
        set: {
          portfolioId: body.portfolioId,
          phoneEnc: app.encryption.encryptString(body.phone),
          pinEnc: app.encryption.encryptString(body.pin),
          sessionEnc: null,
          status: "awaiting_2fa",
          lastError: null,
          updatedAt: new Date(),
        },
      });

    reply.code(202);
    return { status: "awaiting_2fa" };
  });

  // Complete pairing: long-poll until the user approves the push in the TR mobile app,
  // then persist the encrypted session. Takes no body — there is no code in the v2 flow.
  // The request hangs until approval, rejection, or the approval window expires (~180s).
  app.post(
    "/tr/connection/verify",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = requireUser(request);

      const conn = await getConnection(id);
      if (!conn || conn.status !== "awaiting_2fa" || !app.pytr.hasPendingPairing(id)) {
        return reply.code(409).send({ error: "no_pairing_in_progress" });
      }

      let sessionData: string;
      try {
        sessionData = await app.pytr.awaitApproval(id);
      } catch (err) {
        const error = err instanceof Error ? err.message : "approval failed";
        await app.db
          .update(trConnections)
          .set({ status: "error", lastError: error, updatedAt: new Date() })
          .where(eq(trConnections.userId, id));
        // A declined/expired push is a user-actionable 400; anything else is a 502.
        if (err instanceof PytrApprovalError) {
          request.log.info({ err }, "tr login not approved");
          return reply.code(400).send({ error: "not_approved" });
        }
        request.log.warn({ err }, "tr approval failed");
        return reply.code(502).send({ error: "tr_approval_failed" });
      }

      await app.db
        .update(trConnections)
        .set({
          sessionEnc: app.encryption.encryptString(sessionData),
          status: "connected",
          lastError: null,
          updatedAt: new Date(),
        })
        .where(eq(trConnections.userId, id));

      return { status: "connected" };
    },
  );

  // Sync now: pull the timeline into a draft import the user then confirms. Runs
  // inline (the same logic the hourly cron uses) so the UI gets an immediate result.
  app.post(
    "/tr/connection/sync",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = requireUser(request);
      const conn = await getConnection(id);
      if (!conn || conn.status !== "connected") {
        return reply.code(409).send({ error: "not_connected" });
      }
      try {
        return await syncTrConnection(app.db, app.encryption, app.pytr, conn);
      } catch (err) {
        request.log.error({ err }, "tr sync failed");
        return reply.code(502).send({ error: "tr_sync_failed" });
      }
    },
  );

  // Disconnect: wipe the stored connection (and any pending pairing).
  app.delete(
    "/tr/connection",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = requireUser(request);
      app.pytr.cancelPairing(id);
      await app.db.delete(trConnections).where(eq(trConnections.userId, id));
      reply.code(204);
      return null;
    },
  );
}
