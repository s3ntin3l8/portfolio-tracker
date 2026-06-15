"use client";

import type { TrConnection } from "@portfolio/api-client";
import { TrConnectFlow } from "@/components/tr-connect-flow";
import { useApiClient } from "@/lib/api";
import { useRouter } from "@/i18n/navigation";

/** Real-client wrapper: drives the pairing flow, then refreshes server data. */
export function TrConnect({
  initial,
  portfolios,
}: {
  initial: TrConnection;
  portfolios: { id: string; name: string }[];
}) {
  const api = useApiClient();
  const router = useRouter();
  return (
    <TrConnectFlow
      client={api}
      initial={initial}
      portfolios={portfolios}
      onChanged={() => router.refresh()}
    />
  );
}
