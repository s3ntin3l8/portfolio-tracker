import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { accountHolders } from "@portfolio/db";
import { accountHolderInputSchema, accountHolderPatchSchema } from "@portfolio/schema";
import { requireUser } from "../plugins/auth.js";

// People an investment account can belong to (the user, a child, a spouse, …).
// Defined once per user and linked from any number of portfolios so birth year and
// child-ness live in one place. See issue #207.
export async function accountHoldersRoute(app: FastifyInstance) {
  // List the authenticated user's holders.
  app.get("/account-holders", { preHandler: app.authenticate }, async (request) => {
    const { id } = requireUser(request);
    return app.db
      .select()
      .from(accountHolders)
      .where(eq(accountHolders.userId, id));
  });

  // Create a holder for the authenticated user.
  app.post("/account-holders", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = requireUser(request);
    const input = accountHolderInputSchema.parse(request.body);
    const [created] = await app.db
      .insert(accountHolders)
      .values({
        userId: id,
        name: input.name,
        type: input.type,
        birthYear: input.birthYear ?? null,
      })
      .returning();
    reply.code(201);
    return created;
  });

  // Update a holder (owner only). Empty body is a no-op update.
  app.patch<{ Params: { holderId: string } }>(
    "/account-holders/:holderId",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = requireUser(request);
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
      const { id } = requireUser(request);
      const { holderId } = request.params;
      const [deleted] = await app.db
        .delete(accountHolders)
        .where(and(eq(accountHolders.id, holderId), eq(accountHolders.userId, id)))
        .returning();
      if (!deleted) {
        return reply.code(404).send({ error: "account_holder_not_found" });
      }
      return reply.code(204).send();
    },
  );
}
