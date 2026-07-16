import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { users, apiTokens } from "@portfolio/db";
import { userUpdateSchema, apiTokenCreateSchema } from "@portfolio/schema";
import { requireUser, PAT_PREFIX, hashToken } from "../plugins/auth.js";
import { deleteOwnedOr404 } from "./helpers.js";

// Columns safe to return to the client — never the hash.
const tokenColumns = {
  id: apiTokens.id,
  name: apiTokens.name,
  tokenPrefix: apiTokens.tokenPrefix,
  scope: apiTokens.scope,
  lastUsedAt: apiTokens.lastUsedAt,
  expiresAt: apiTokens.expiresAt,
  createdAt: apiTokens.createdAt,
};

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
    const id = request.userId;
    const input = userUpdateSchema.parse(request.body);
    // An empty patch is a no-op (Drizzle rejects an empty SET) — just echo the row.
    if (Object.keys(input).length === 0) {
      const [row] = await app.db.select().from(users).where(eq(users.id, id)).limit(1);
      return row;
    }
    const [row] = await app.db.update(users).set(input).where(eq(users.id, id)).returning();
    return row;
  });

  // List the caller's personal access tokens (metadata only — the secret is shown
  // exactly once, at creation).
  app.get("/me/tokens", { preHandler: app.authenticate }, async (request) => {
    const id = request.userId;
    return app.db
      .select(tokenColumns)
      .from(apiTokens)
      .where(eq(apiTokens.userId, id))
      .orderBy(desc(apiTokens.createdAt));
  });

  // Mint a new personal access token. Only from an interactive Authentik session —
  // you can't mint a PAT with a PAT (no credential self-perpetuation). Returns the
  // plaintext token ONCE; only its hash is stored.
  app.post("/me/tokens", { preHandler: app.authenticate }, async (request, reply) => {
    const { id, authMethod } = requireUser(request);
    if (authMethod !== "jwt") {
      return reply.code(403).send({ error: "interactive_session_required" });
    }
    const { name, scope, expiresInDays } = apiTokenCreateSchema.parse(request.body);
    // pt_ + 43 url-safe chars (32 bytes) → ~256 bits of entropy.
    const secret = `${PAT_PREFIX}${randomBytes(32).toString("base64url")}`;
    const expiresAt = expiresInDays ? new Date(Date.now() + expiresInDays * 86_400_000) : null;
    const [row] = await app.db
      .insert(apiTokens)
      .values({
        userId: id,
        name,
        scope,
        tokenHash: hashToken(secret),
        tokenPrefix: secret.slice(0, 12),
        expiresAt,
      })
      .returning(tokenColumns);
    // The only response that ever carries the secret.
    return reply.code(201).send({ ...row, token: secret });
  });

  // Revoke a token. Scoped to the caller so one user can't delete another's.
  app.delete<{ Params: { id: string } }>(
    "/me/tokens/:id",
    { preHandler: app.authenticate },
    async (request, reply) => {
      return deleteOwnedOr404(
        reply,
        app.db,
        apiTokens,
        and(eq(apiTokens.id, request.params.id), eq(apiTokens.userId, request.userId)),
        "not_found",
      );
    },
  );
}
