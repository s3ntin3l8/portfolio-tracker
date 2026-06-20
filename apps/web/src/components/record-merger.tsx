"use client";

import { RecordMergerForm } from "@/components/record-merger-form";
import { useApiClient } from "@/lib/api";
import { useRouter } from "@/i18n/navigation";

/** Real-client wrapper: records the merger, then returns to holdings. */
export function RecordMerger({ portfolioId }: { portfolioId: string }) {
  const api = useApiClient();
  const router = useRouter();
  return (
    <RecordMergerForm
      client={api}
      portfolioId={portfolioId}
      onSuccess={() => {
        router.push("/holdings");
        router.refresh();
      }}
    />
  );
}
