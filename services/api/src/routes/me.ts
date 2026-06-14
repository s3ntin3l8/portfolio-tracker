import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { users } from "@portfolio/db";
import { requireUser } from "../plugins/auth.js";

export async function meRoute(app: FastifyInstance) {
  // The authenticated user's profile (created on first login).
  app.get("/me", { preHandler: app.authenticate }, async (request) => {
    const { id } = requireUser(request);
    const [row] = await app.db.select().from(users).where(eq(users.id, id)).limit(1);
    return row;
  });
}
