"use client";

import { useEffect } from "react";
import { signIn, useSession } from "next-auth/react";

/** Session errors that mean the access token is dead and cannot be silently rotated. */
const UNRECOVERABLE = new Set(["RefreshAccessTokenError", "RefreshTokenMissing"]);

/**
 * Watches the session for an unrecoverable auth error — the refresh failed, or no
 * refresh token was ever issued — and bounces the user through a fresh Authentik
 * sign-in. Without it an expired-and-unrefreshable session just renders the generic
 * "Can't reach the API" state on every screen forever (the API 401s, and
 * `server-api.ts` folds that into `unavailable`). Renders nothing.
 */
export function SessionErrorGuard() {
  const { data: session } = useSession();
  const error = session?.error;

  useEffect(() => {
    if (error && UNRECOVERABLE.has(error)) {
      void signIn("authentik");
    }
  }, [error]);

  return null;
}
