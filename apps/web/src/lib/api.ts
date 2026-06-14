"use client";

import { useMemo } from "react";
import { useSession } from "next-auth/react";
import { createApiClient, type ApiClient } from "@portfolio/api-client";

/** API base URL — config-driven so the web app can move to Vercel without a rewrite. */
export const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL ?? "";

/**
 * A typed api-client bound to the current session — forwards the Authentik access
 * token as a Bearer to the Fastify API. Re-created only when the token changes.
 */
export function useApiClient(): ApiClient {
  const { data: session } = useSession();
  const token = session?.accessToken;
  return useMemo(
    () =>
      createApiClient({
        baseUrl: apiBaseUrl,
        getToken: () => token,
      }),
    [token],
  );
}
