"use client";

import { useEffect } from "react";
import { signIn, useSession } from "next-auth/react";
import { useRouter } from "@/i18n/navigation";

/** Session errors that mean the access token is dead and cannot be silently rotated. */
const UNRECOVERABLE = new Set(["RefreshAccessTokenError", "RefreshTokenMissing"]);

/**
 * Watches the session for an unrecoverable auth error — the refresh failed, or no
 * refresh token was ever issued — and bounces the user through a fresh Authentik
 * sign-in. Without it an expired-and-unrefreshable session just renders the generic
 * "Can't reach the API" state on every screen forever (the API 401s, and
 * `server-api.ts` folds that into `unavailable`). Renders nothing.
 */
export function SessionErrorGuard({ serverSessionExpired }: { serverSessionExpired?: boolean }) {
  const { data: session, status } = useSession();
  const error = session?.error;
  const router = useRouter();

  useEffect(() => {
    if (error && UNRECOVERABLE.has(error)) {
      void signIn("authentik");
    }
  }, [error]);

  useEffect(() => {
    if (serverSessionExpired && status === "authenticated") {
      router.refresh();
    }
  }, [serverSessionExpired, status, router]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    let lastVisibleTime = Date.now();

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        const elapsed = Date.now() - lastVisibleTime;
        // If the app was backgrounded for more than 2 minutes,
        // trigger router.refresh() to pull fresh data and background-rotate tokens.
        if (elapsed > 120_000) {
          router.refresh();
        }
      } else {
        lastVisibleTime = Date.now();
      }
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [router]);

  return null;
}
