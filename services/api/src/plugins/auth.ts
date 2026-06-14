import fp from "fastify-plugin";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { jwtVerify, createRemoteJWKSet } from "jose";
import type { JWTVerifyGetKey, JWTVerifyOptions, KeyLike } from "jose";
import { eq } from "drizzle-orm";
import { users } from "@portfolio/db";

// A key (local public key for tests) or a JWKS resolver function (remote, prod).
export type AuthKey = KeyLike | Uint8Array | JWTVerifyGetKey;

/**
 * A lazy JWKS resolver that discovers the signing keys from the issuer via OIDC
 * discovery (`<issuer>/.well-known/openid-configuration` → `jwks_uri`). Lets the API
 * be configured with only AUTHENTIK_ISSUER — no separate AUTHENTIK_JWKS_URL. Discovery
 * runs once, on the first token verification, then the JWKS is cached (and refreshed
 * by `createRemoteJWKSet` as needed). Injectable fetch keeps it unit-testable.
 */
export function createIssuerJwks(
  issuer: string,
  fetchImpl: typeof fetch = fetch,
  // The JWKS builder is a seam so tests can avoid a real network fetch.
  buildJwks: (jwksUri: URL) => JWTVerifyGetKey = createRemoteJWKSet,
): JWTVerifyGetKey {
  let jwks: JWTVerifyGetKey | null = null;
  const base = issuer.endsWith("/") ? issuer : `${issuer}/`;
  return async (protectedHeader, token) => {
    if (!jwks) {
      const res = await fetchImpl(
        new URL(".well-known/openid-configuration", base),
      );
      if (!res.ok) throw new Error(`oidc_discovery_failed_${res.status}`);
      const doc = (await res.json()) as { jwks_uri?: string };
      if (!doc.jwks_uri) throw new Error("oidc_no_jwks_uri");
      jwks = buildJwks(new URL(doc.jwks_uri));
    }
    return jwks(protectedHeader, token);
  };
}

export interface AuthPluginOptions {
  authKey?: AuthKey;
}

export interface AuthedUser {
  id: string;
  authSub: string;
}

/** Returns the authenticated user or throws — use inside `authenticate`d handlers. */
export function requireUser(request: FastifyRequest): AuthedUser {
  if (!request.user) throw new Error("unauthenticated");
  return request.user;
}

/**
 * Authentik OIDC auth. Verifies a Bearer JWT (remote JWKS in prod, an injected key
 * in tests), then upserts the user by `sub` and sets `request.user`. The actual
 * per-route guard is the decorated `app.authenticate` preHandler.
 */
export const authPlugin = fp<AuthPluginOptions>(async (app: FastifyInstance, opts) => {
  // Prefer an injected key (tests); else an explicit JWKS URL; else derive the JWKS
  // from the issuer via OIDC discovery so AUTHENTIK_JWKS_URL is optional.
  const keyResolver: AuthKey | null =
    opts.authKey ??
    (app.config.AUTHENTIK_JWKS_URL
      ? createRemoteJWKSet(new URL(app.config.AUTHENTIK_JWKS_URL))
      : app.config.AUTHENTIK_ISSUER
        ? createIssuerJwks(app.config.AUTHENTIK_ISSUER)
        : null);

  app.decorate(
    "authenticate",
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!keyResolver) {
        return reply.code(503).send({ error: "auth_not_configured" });
      }

      const header = request.headers.authorization;
      if (!header?.startsWith("Bearer ")) {
        return reply.code(401).send({ error: "missing_token" });
      }

      let sub: string;
      let email: string;
      try {
        const token = header.slice(7);
        const verifyOpts: JWTVerifyOptions = {
          issuer: app.config.AUTHENTIK_ISSUER || undefined,
          audience: app.config.AUTHENTIK_AUDIENCE || undefined,
        };
        // Narrow the union so the right jwtVerify overload is selected.
        const { payload } =
          typeof keyResolver === "function"
            ? await jwtVerify(token, keyResolver, verifyOpts)
            : await jwtVerify(token, keyResolver, verifyOpts);
        if (!payload.sub) throw new Error("missing sub");
        sub = payload.sub;
        email =
          typeof payload.email === "string"
            ? payload.email
            : `${sub}@users.noreply`;
      } catch {
        return reply.code(401).send({ error: "invalid_token" });
      }

      const found = await app.db
        .select()
        .from(users)
        .where(eq(users.authSub, sub))
        .limit(1);
      let user = found[0];
      if (!user) {
        const [created] = await app.db
          .insert(users)
          .values({ authSub: sub, email })
          .returning();
        user = created;
      }
      request.user = { id: user.id, authSub: user.authSub };
    },
  );
});

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (
      request: FastifyRequest,
      reply: FastifyReply,
    ) => Promise<unknown>;
  }
  interface FastifyRequest {
    user?: AuthedUser;
  }
}
