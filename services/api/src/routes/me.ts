import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { users } from "@portfolio/db";
import { userUpdateSchema } from "@portfolio/schema";
import { requireUser } from "../plugins/auth.js";

export async function meRoute(app: FastifyInstance) {
  // The authenticated user's profile (created on first login).
  app.get("/me", { preHandler: app.authenticate }, async (request) => {
    const { id, isAdmin } = requireUser(request);
    const [row] = await app.db.select().from(users).where(eq(users.id, id)).limit(1);
    // isAdmin is derived from the token's group claim, not a stored column.
    return { ...row, isAdmin };
  });

  // Update the authenticated user's editable profile fields (name, display currency).
  app.patch("/me", { preHandler: app.authenticate }, async (request) => {
    const { id } = requireUser(request);
    const input = userUpdateSchema.parse(request.body);
    // An empty patch is a no-op (Drizzle rejects an empty SET) — just echo the row.
    if (Object.keys(input).length === 0) {
      const [row] = await app.db.select().from(users).where(eq(users.id, id)).limit(1);
      return row;
    }
    const [row] = await app.db
      .update(users)
      .set(input)
      .where(eq(users.id, id))
      .returning();
    return row;
  });
}
