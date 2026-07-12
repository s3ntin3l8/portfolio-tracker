import { encode } from "next-auth/jwt";

/**
 * Mints a forged Auth.js v5 session cookie carrying a seeded personal-access-token
 * (PAT) secret as its `accessToken`, so the app treats the browser as logged in
 * without a real Authentik round trip. Used only by the screenshot pipeline
 * (`scripts/screenshots.mjs`) against a throwaway demo backend — never for anything
 * touching a real user's data.
 *
 * How this works: both RSC reads (`lib/server-api.ts`) and the same-origin API proxy
 * (`app/api/backend/[...path]/route.ts`) resolve the outgoing bearer token via
 * `next-auth/jwt`'s `getToken()` against the `authjs.session-token` cookie — see
 * `lib/session-token.ts`. `getToken()` is just `decode()` under the hood, so a cookie
 * produced by `encode()` with the same `secret`/`salt` round-trips identically.
 *
 * Two details that silently break this if wrong (validated empirically):
 * - `salt` MUST equal the cookie name Auth.js expects to read: unprefixed
 *   `authjs.session-token` when the app's `AUTH_URL` is http (dev), or
 *   `__Secure-authjs.session-token` when it's https. Wrong salt → `getToken()`
 *   returns null → the `(app)` layout treats the request as signed out.
 * - The token needs a far-future `expiresAt` (unix seconds) and no `refreshToken`/
 *   `error` field, or the `jwt` callback in `src/auth.ts` treats it as expired and
 *   tries to rotate it against a (nonexistent, for the demo) Authentik token endpoint.
 */
export async function mintSessionCookie({ patSecret, authSub, secret, secure = false }) {
  const cookieName = secure ? "__Secure-authjs.session-token" : "authjs.session-token";
  const oneYearSeconds = 365 * 24 * 60 * 60;
  const value = await encode({
    token: {
      sub: authSub,
      accessToken: patSecret,
      // Far enough out that the `jwt` callback's expiry check never trips during a
      // screenshot run.
      expiresAt: Math.floor(Date.now() / 1000) + oneYearSeconds,
    },
    secret,
    salt: cookieName,
    maxAge: oneYearSeconds,
  });
  return { name: cookieName, value };
}

// Allow running directly for a quick manual check:
//   AUTH_SECRET=... PAT=pt_... node apps/web/scripts/mint-session.mjs
const invokedDirectly =
  process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  const cookie = await mintSessionCookie({
    patSecret: process.env.PAT,
    authSub: "demo|pocket",
    secret: process.env.AUTH_SECRET,
  });
  console.log(`${cookie.name}=${cookie.value}`);
}
