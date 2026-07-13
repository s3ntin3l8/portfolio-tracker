"use client";

import { RecordCorporateActionForm } from "@/components/record-corporate-action-form";
import { useApiClient } from "@/lib/api";
import { useRouter } from "@/i18n/navigation";

/** Real-client wrapper: records the action, then returns to holdings. */
export function RecordCorporateAction({
  stickyFooter = false,
}: {
  /** See `AddTransactionForm` — sheet contexts only. */
  stickyFooter?: boolean;
} = {}) {
  const api = useApiClient();
  const router = useRouter();
  return (
    <RecordCorporateActionForm
      client={api}
      stickyFooter={stickyFooter}
      onSuccess={() => {
        router.push("/holdings");
        router.refresh();
      }}
    />
  );
}
