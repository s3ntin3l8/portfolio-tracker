"use client";

import { useEffect, useMemo, useRef } from "react";
import { useSession } from "next-auth/react";
import { createApiClient, type ApiClient } from "@portfolio/api-client";

/** API base URL — config-driven so the web app can move to Vercel without a rewrite. */
export const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL ?? "";

/**
 * A typed api-client bound to the current session — forwards the Authentik access
 * token as a Bearer to the Fastify API.
 *
 * `getToken` reads the *freshest* rotated token at request time via a ref, NOT a render-time
 * snapshot. This matters for long-lived work: a multi-file import's background materialize loop
 * (and its Retry action) can outlive the ~5-min access-token lifetime. The 60s SessionProvider
 * poll rotates `accessToken` via the refresh grant, and reading `tokenRef.current` at call time
 * picks up that rotation — whereas capturing `token` in the closure would pin the stale value and
 * 401 mid-batch (the bug that made long batch imports fail with an un-retryable "Import failed").
 */
export function useApiClient(): ApiClient {
  const { data: session } = useSession();
  const token = session?.accessToken;
  // "Latest ref" pattern: the ref is initialised with the current token and kept in sync via an
  // effect, so `getToken` (called long after render, at fetch time) always sees the freshest
  // rotated token rather than a render-time snapshot.
  const tokenRef = useRef<string | undefined>(token);
  useEffect(() => {
    tokenRef.current = token;
  }, [token]);
  return useMemo(() => {
    // eslint-disable-next-line react-hooks/refs -- intentional: getToken reads the ref at call time (post-render), never during render
    return createApiClient({
      baseUrl: apiBaseUrl,
      getToken: () => tokenRef.current,
    });
    // Stable client: the token is read live from the ref, so it never needs re-creating.
  }, []);
}
