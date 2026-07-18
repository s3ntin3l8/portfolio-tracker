"use client";

import { RecordMergerForm } from "@/components/record-merger-form";
import { useApiClient } from "@/lib/api";
import { useRouter } from "@/i18n/navigation";

/** Real-client wrapper: records the merger, then returns to holdings. */
export function RecordMerger({
  portfolioId,
  stickyFooter = false,
  isDesktop = false,
}: {
  portfolioId: string;
  /** See `AddTransactionForm` — sheet contexts only. */
  stickyFooter?: boolean;
  isDesktop?: boolean;
}) {
  const api = useApiClient();
  const router = useRouter();
  return (
    <RecordMergerForm
      client={api}
      portfolioId={portfolioId}
      stickyFooter={stickyFooter}
      isDesktop={isDesktop}
      onSuccess={() => {
        router.push("/holdings");
        router.refresh();
      }}
    />
  );
}
