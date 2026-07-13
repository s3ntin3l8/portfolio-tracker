import NextAuth, { type NextAuthConfig } from "next-auth";
import Authentik from "next-auth/providers/authentik";

/**
 * Auth.js (NextAuth v5) wired to Authentik via OIDC (Authorization Code + PKCE).
 * The Authentik access token is persisted on the `jwt` token ONLY (never copied onto the
 * client-visible session, see the `session` callback below) so it stays inside the
 * httpOnly session cookie. Server code reads it via next-auth/jwt's getToken(): the
 * same-origin proxy (app/api/backend/[...path]/route.ts) for client-side reads, and
 * lib/server-api.ts directly for RSC reads. The Fastify API validates it against
 * Authentik's JWKS either way. Config is env-driven (AUTHENTIK_CLIENT_ID/SECRET/ISSUER,
 * AUTH_SECRET).
 *
 * Authentik access tokens are short-lived (~5 min), so we request `offline_access`
 * to get a refresh token and silently rotate the access token in the `jwt` callback
 * before it expires — otherwise API reads start 401-ing a few minutes after login.
 */

// The OIDC token endpoint, discovered once from the issuer and cached. Authentik's
// token endpoint lives at <.../application/o/token/> — not under the app slug — so we
// read it from discovery rather than deriving it from the issuer URL.
let tokenEndpointPromise: Promise<string> | null = null;
function tokenEndpoint(): Promise<string> {
  if (!tokenEndpointPromise) {
    const issuer = process.env.AUTHENTIK_ISSUER ?? "";
    const base = issuer.endsWith("/") ? issuer : `${issuer}/`;
    tokenEndpointPromise = fetch(
      new URL(".well-known/openid-configuration", base),
    )
      .then((r) => r.json() as Promise<{ token_endpoint: string }>)
      .then((d) => d.token_endpoint);
  }
  return tokenEndpointPromise;
}

export const authConfig: NextAuthConfig = {
  // Self-hosted behind a reverse proxy (Proxmox / same origin as Authentik): trust
  // the forwarded host so Auth.js derives the right callback origin and cookie
  // security under `next start`. Without this, production throws `UntrustedHost`
  // and dev↔prod proto mismatches corrupt the PKCE cookie. Honors AUTH_TRUST_HOST too.
  trustHost: true,
  // Send auth failures (notably a failed OAuth callback: a stale/replayed single-use
  // `code` or a PKCE-verifier mismatch from overlapping login tabs) to our own page,
  // which restarts a fresh sign-in instead of dead-ending on Auth.js's generic 500.
  // next-intl localizes the path (→ /<locale>/auth-error). See auth-error-recovery.tsx.
  pages: { error: "/auth-error" },
  providers: [
    Authentik({
      clientId: process.env.AUTHENTIK_CLIENT_ID,
      clientSecret: process.env.AUTHENTIK_CLIENT_SECRET,
      issuer: process.env.AUTHENTIK_ISSUER,
      // `offline_access` makes Authentik issue a refresh token we can rotate with.
      authorization: { params: { scope: "openid profile email offline_access" } },
    }),
  ],
  callbacks: {
    async jwt({ token, account }) {
      // Initial sign-in: stash the access + refresh tokens and the absolute expiry.
      if (account) {
        token.accessToken = account.access_token;
        token.refreshToken = account.refresh_token;
        token.expiresAt = account.expires_at; // unix seconds
        delete token.error;
        // Diagnostic (no secrets): a refresh token only arrives if Authentik's
        // provider grants `offline_access`. Without one the session can't outlive the
        // ~5-min access token, no matter what the client does — flag it loudly.
        if (!account.refresh_token) {
          console.warn(
            "[auth] sign-in returned NO refresh_token — the Authentik provider is " +
              "likely missing the `offline_access` scope; the session will die at " +
              "access-token expiry (~5 min).",
          );
        }
        return token;
      }

      // Still comfortably valid — reuse as-is. The 90s skew is wider than the client's
      // 60s session poll (session-provider.tsx) so a poll reliably fires the refresh
      // *before* expiry rather than at the knife-edge, and persists the rotated token.
      const expiresAt = token.expiresAt as number | undefined;
      if (expiresAt && Date.now() < expiresAt * 1000 - 90_000) {
        return token;
      }

      // Expired and unrefreshable — surface an error so the UI can prompt re-login.
      const refreshToken = token.refreshToken as string | undefined;
      if (!refreshToken) {
        token.error = "RefreshTokenMissing";
        console.warn(
          "[auth] access token expired with no refresh token — re-login required.",
        );
        return token;
      }

      // Expired: rotate the access token using the refresh token.
      try {
        let res: Response;
        try {
          res = await fetch(await tokenEndpoint(), {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "refresh_token",
              refresh_token: refreshToken,
              client_id: process.env.AUTHENTIK_CLIENT_ID ?? "",
              client_secret: process.env.AUTHENTIK_CLIENT_SECRET ?? "",
            }),
          });
        } catch (err) {
          // Network offline / DNS / connection failure is transient
          console.warn("[auth] refresh failed due to network error:", err);
          token.error = "RefreshTransientError";
          return token;
        }

        const refreshed = (await res.json()) as {
          access_token?: string;
          expires_in?: number;
          refresh_token?: string;
          error?: string;
        };
        if (!res.ok || !refreshed.access_token) {
          // No secrets — just the HTTP status and Authentik's error code so the dev
          // log distinguishes a rotation failure (`invalid_grant`) from other causes.
          console.warn(
            `[auth] refresh failed: ${res.status} ${refreshed.error ?? "unknown_error"}`,
          );
          if (res.status >= 500) {
            token.error = "RefreshTransientError";
          } else {
            token.error = "RefreshAccessTokenError";
          }
          return token;
        }

        token.accessToken = refreshed.access_token;
        token.expiresAt =
          Math.floor(Date.now() / 1000) + (refreshed.expires_in ?? 0);
        // Authentik rotates refresh tokens — keep the new one when provided.
        if (refreshed.refresh_token) token.refreshToken = refreshed.refresh_token;
        delete token.error;
      } catch (err) {
        console.error("[auth] unexpected error during token refresh:", err);
        token.error = "RefreshAccessTokenError";
      }
      return token;
    },
    session({ session, token }) {
      // The access token stays on the JWT only — never copied onto the client-visible
      // session. The browser reaches the API through the same-origin proxy
      // (app/api/backend/[...path]/route.ts), which reads the token server-side via
      // next-auth/jwt's getToken(); RSC reads do the same in lib/server-api.ts.
      session.error = token.error as string | undefined;
      return session;
    },
  },
};

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);
