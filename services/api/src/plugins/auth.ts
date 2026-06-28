import { createHash } from "node:crypto";
import fp from "fastify-plugin";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { jwtVerify, createRemoteJWKSet } from "jose";
import type { JWTVerifyGetKey, JWTVerifyOptions } from "jose";
import { eq } from "drizzle-orm";
import { users, apiTokens } from "@portfolio/db";

// A key (local public key for tests) or a JWKS resolver function (remote, prod).
export type AuthKey = CryptoKey | Uint8Array | JWTVerifyGetKey;

/** Prefix that marks a personal access token, distinguishing it from a JWT (`eyJ…`). */
export const PAT_PREFIX = "pt_";

/** SHA-256 (hex) of a secret — what we store and look PATs up by; never the secret. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// Methods a read-scoped PAT may not use. GET/HEAD/OPTIONS are always allowed.
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

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
  // Derived from the Authentik `groups` claim each request — not stored on the row.
  isAdmin: boolean;
  // How this request authenticated: an interactive Authentik session ("jwt") or a
  // personal access token ("pat"). Minting a new PAT requires "jwt".
  authMethod: "jwt" | "pat";
  // "write" for interactive sessions; a PAT carries its own (read-only by default).
  scope: "read" | "write";
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
  const usingInjectedKey = opts.authKey != null;
  const keyResolver: AuthKey | null =
    opts.authKey ??
    (app.config.AUTHENTIK_JWKS_URL
      ? createRemoteJWKSet(new URL(app.config.AUTHENTIK_JWKS_URL))
      : app.config.AUTHENTIK_ISSUER
        ? createIssuerJwks(app.config.AUTHENTIK_ISSUER)
        : null);

  // Fail closed: a real deployment (no injected test key) must bind every token to THIS
  // service via both issuer and audience. With either unset, `verifyOpts` passes
  // `undefined` and jose validates the signature only — so a token Authentik minted for a
  // *different* client (different audience) would authenticate here. Refuse to boot rather
  // than silently run signature-only. Injected-key tests are exempt (they opt in explicitly).
  if (keyResolver && !usingInjectedKey) {
    const missing = [
      !app.config.AUTHENTIK_ISSUER && "AUTHENTIK_ISSUER",
      !app.config.AUTHENTIK_AUDIENCE && "AUTHENTIK_AUDIENCE",
    ].filter((x): x is string => Boolean(x));
    if (missing.length > 0) {
      throw new Error(
        `Authentication is configured but ${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} not set — ` +
          `refusing to start with signature-only token validation`,
      );
    }
  }

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
      const token = header.slice(7);

      // Personal access token: our own long-lived credential, looked up by hash on a
      // unique index (no timing-unsafe secret comparison). PATs never grant admin and
      // carry their own scope; the secret is never logged.
      if (token.startsWith(PAT_PREFIX)) {
        const [row] = await app.db
          .select()
          .from(apiTokens)
          .where(eq(apiTokens.tokenHash, hashToken(token)))
          .limit(1);
        if (!row || (row.expiresAt && row.expiresAt.getTime() <= Date.now())) {
          return reply.code(401).send({ error: "invalid_token" });
        }
        const [u] = await app.db
          .select()
          .from(users)
          .where(eq(users.id, row.userId))
          .limit(1);
        if (!u) return reply.code(401).send({ error: "invalid_token" });
        // Stamp last-used (one indexed UPDATE) so the token list shows activity.
        await app.db
          .update(apiTokens)
          .set({ lastUsedAt: new Date() })
          .where(eq(apiTokens.id, row.id));
        const scope = row.scope === "write" ? "write" : "read";
        if (scope === "read" && MUTATING_METHODS.has(request.method)) {
          return reply.code(403).send({ error: "read_only_token" });
        }
        request.user = {
          id: u.id,
          authSub: u.authSub,
          isAdmin: false,
          authMethod: "pat",
          scope,
        };
        return;
      }

      let sub: string;
      let email: string;
      let isAdmin: boolean;
      try {
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
        // Admin = membership in the configured Authentik group (empty config ⇒ no admins).
        const groups = Array.isArray(payload.groups) ? payload.groups : [];
        const adminGroup = app.config.AUTHENTIK_ADMIN_GROUP;
        isAdmin = adminGroup !== "" && groups.includes(adminGroup);
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
      request.user = {
        id: user.id,
        authSub: user.authSub,
        isAdmin,
        authMethod: "jwt",
        scope: "write",
      };
    },
  );

  // Admin-only guard: authenticate, then require the Authentik admin group. Used by
  // /admin routes that mutate server-wide config (data-provider settings).
  app.decorate(
    "requireAdmin",
    async (request: FastifyRequest, reply: FastifyReply) => {
      await app.authenticate(request, reply);
      // authenticate already sent an error response (401/503) — don't continue.
      if (reply.sent) return reply;
      if (!request.user?.isAdmin) {
        return reply.code(403).send({ error: "forbidden" });
      }
    },
  );
});

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (
      request: FastifyRequest,
      reply: FastifyReply,
    ) => Promise<unknown>;
    requireAdmin: (
      request: FastifyRequest,
      reply: FastifyReply,
    ) => Promise<unknown>;
  }
  interface FastifyRequest {
    user?: AuthedUser;
  }
}
