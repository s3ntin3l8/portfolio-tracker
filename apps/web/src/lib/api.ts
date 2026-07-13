"use client";

import { useMemo } from "react";
import { signIn } from "next-auth/react";
import { createApiClient, type ApiClient } from "@portfolio/api-client";

/**
 * Same-origin proxy path (see app/api/backend/[...path]/route.ts) — the browser never
 * holds the Authentik access token itself. The proxy resolves the token server-side from
 * the httpOnly session cookie on every request, which also solves for free what a client-
 * held token couldn't: a multi-file import's background materialize loop (and its Retry
 * action) can outlive the ~5-min access-token lifetime, but the proxy always re-reads a
 * fresh one — no stale-token 401 mid-batch, no client-side rotation/ref-tracking needed.
 */
export const apiBaseUrl = "/api/backend";

/** A typed api-client bound to the same-origin proxy. No client-held token: the proxy
 *  attaches the current session's Authentik access token server-side (see apiBaseUrl). */
export function useApiClient(): ApiClient {
  return useMemo(() => {
    return createApiClient({
      baseUrl: apiBaseUrl,
      fetch: async (input, init) => {
        const res = await fetch(input, init);
        if (res.status === 401) {
          void signIn("authentik");
        }
        return res;
      },
    });
  }, []);
}
