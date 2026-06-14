import NextAuth from "next-auth";
import Authentik from "next-auth/providers/authentik";

/**
 * Auth.js (NextAuth v5) wired to Authentik via OIDC (Authorization Code + PKCE).
 * The Authentik access token is persisted on the session so the typed api-client can
 * forward it as a Bearer to the Fastify API, which validates it against Authentik's
 * JWKS. Config is env-driven (AUTHENTIK_CLIENT_ID/SECRET/ISSUER, AUTH_SECRET).
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Authentik({
      clientId: process.env.AUTHENTIK_CLIENT_ID,
      clientSecret: process.env.AUTHENTIK_CLIENT_SECRET,
      issuer: process.env.AUTHENTIK_ISSUER,
    }),
  ],
  callbacks: {
    jwt({ token, account }) {
      // On sign-in, stash the access token + its expiry for forwarding to the API.
      if (account?.access_token) {
        token.accessToken = account.access_token;
        token.expiresAt = account.expires_at;
      }
      return token;
    },
    session({ session, token }) {
      session.accessToken = token.accessToken as string | undefined;
      return session;
    },
  },
});
