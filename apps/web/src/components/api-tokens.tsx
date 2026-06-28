"use client";

import type { ApiToken } from "@portfolio/api-client";
import { ApiTokensManager } from "@/components/api-tokens-manager";
import { useApiClient } from "@/lib/api";

/** Client wrapper: binds the session-aware api-client to the token manager. */
export function ApiTokens({ initialTokens }: { initialTokens: ApiToken[] }) {
  const api = useApiClient();
  return <ApiTokensManager client={api} initialTokens={initialTokens} />;
}
