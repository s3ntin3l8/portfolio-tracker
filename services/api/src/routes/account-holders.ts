import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { accountHolders, lossCarryforward } from "@portfolio/db";
import { createAndReturn, deleteOwnedOr404 } from "./helpers.js";
import {
  accountHolderInputSchema,
  accountHolderPatchSchema,
  lossCarryforwardSetSchema,
} from "@portfolio/schema";

// People an investment account can belong to (the user, a child, a spouse, …).
// Defined once per user and linked from any number of portfolios so birth year and
// child-ness live in one place. See issue #207.
export async function accountHoldersRoute(app: FastifyInstance) {
  // List the authenticated user's holders.
  app.get("/account-holders", { preHandler: app.authenticate }, async (request) => {
    const id = request.userId;
    return app.db.select().from(accountHolders).where(eq(accountHolders.userId, id));
  });

  // Create a holder for the authenticated user.
  app.post("/account-holders", { preHandler: app.authenticate }, async (request, reply) => {
    const id = request.userId;
    const input = accountHolderInputSchema.parse(request.body);
    return createAndReturn(app.db, reply, accountHolders, {
      userId: id,
      name: input.name,
      type: input.type,
      birthYear: input.birthYear ?? null,
      taxAllowanceAnnual: input.taxAllowanceAnnual ?? null,
      capitalGainsTaxRate: input.capitalGainsTaxRate ?? null,
      churchTax: input.churchTax ?? false,
      taxResidence: input.taxResidence ?? null,
    });
  });

  // Update a holder (owner only). Empty body is a no-op update.
  app.patch<{ Params: { holderId: string } }>(
    "/account-holders/:holderId",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const id = request.userId;
      const { holderId } = request.params;
      const input = accountHolderPatchSchema.parse(request.body);
      const [updated] = await app.db
        .update(accountHolders)
        .set(input)
        .where(and(eq(accountHolders.id, holderId), eq(accountHolders.userId, id)))
        .returning();
      if (!updated) {
        return reply.code(404).send({ error: "account_holder_not_found" });
      }
      return updated;
    },
  );

  // Delete a holder (owner only). Any portfolios linked to it have their
  // account_holder_id set null (FK ON DELETE SET NULL) and revert to "standard".
  app.delete<{ Params: { holderId: string } }>(
    "/account-holders/:holderId",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { holderId } = request.params;
      return deleteOwnedOr404(
        reply,
        app.db,
        accountHolders,
        and(eq(accountHolders.id, holderId), eq(accountHolders.userId, request.userId)),
        "account_holder_not_found",
      );
    },
  );

  /** Confirm a holder exists and belongs to the requesting user. */
  async function ownedHolder(userId: string, holderId: string): Promise<boolean> {
    const [row] = await app.db
      .select({ id: accountHolders.id })
      .from(accountHolders)
      .where(and(eq(accountHolders.id, holderId), eq(accountHolders.userId, userId)))
      .limit(1);
    return Boolean(row);
  }

  function toCarryforwardEntries(rows: (typeof lossCarryforward.$inferSelect)[]) {
    return rows.map((r) => ({ pot: r.pot, amount: r.amount }));
  }

  // Loss carry-forward (Verlustverrechnungstopf) — settled €-figures from the holder's
  // prior-year tax certificate, seeded manually (TR exposes no API for this — see
  // packages/core/src/tax.ts's two-pot netting, which consumes these). Dedicated
  // endpoints (not folded into the general PATCH above) since this is a distinct
  // per-year, atomic-replace-a-set concern, not a scalar profile field — mirrors
  // targets.ts's GET/PUT allocation-target-set pattern.
  app.get<{ Params: { holderId: string }; Querystring: { taxYear?: string } }>(
    "/account-holders/:holderId/loss-carryforward",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const id = request.userId;
      const { holderId } = request.params;
      const taxYear = request.query.taxYear ? parseInt(request.query.taxYear, 10) : undefined;
      if (!taxYear || !Number.isFinite(taxYear)) {
        return reply.code(400).send({ error: "tax_year_required" });
      }
      if (!(await ownedHolder(id, holderId))) {
        return reply.code(404).send({ error: "account_holder_not_found" });
      }
      const rows = await app.db
        .select()
        .from(lossCarryforward)
        .where(and(eq(lossCarryforward.holderId, holderId), eq(lossCarryforward.taxYear, taxYear)));
      return { taxYear, entries: toCarryforwardEntries(rows) };
    },
  );

  app.put<{ Params: { holderId: string } }>(
    "/account-holders/:holderId/loss-carryforward",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const id = request.userId;
      const { holderId } = request.params;
      if (!(await ownedHolder(id, holderId))) {
        return reply.code(404).send({ error: "account_holder_not_found" });
      }
      const parsed = lossCarryforwardSetSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_input", issues: parsed.error.issues });
      }
      const { taxYear, entries } = parsed.data;

      await app.db.transaction(async (tx) => {
        await tx
          .delete(lossCarryforward)
          .where(
            and(eq(lossCarryforward.holderId, holderId), eq(lossCarryforward.taxYear, taxYear)),
          );
        if (entries.length > 0) {
          await tx.insert(lossCarryforward).values(
            entries.map((e) => ({
              holderId,
              taxYear,
              pot: e.pot,
              amount: e.amount,
              source: "manual" as const,
            })),
          );
        }
      });

      const rows = await app.db
        .select()
        .from(lossCarryforward)
        .where(and(eq(lossCarryforward.holderId, holderId), eq(lossCarryforward.taxYear, taxYear)));
      return { taxYear, entries: toCarryforwardEntries(rows) };
    },
  );
}
