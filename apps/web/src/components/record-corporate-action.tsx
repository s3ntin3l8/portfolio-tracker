"use client";

import { RecordCorporateActionForm } from "@/components/record-corporate-action-form";
import { useApiClient } from "@/lib/api";
import { useRouter } from "@/i18n/navigation";

/** Real-client wrapper: records the action, then returns to holdings. */
export function RecordCorporateAction() {
  const api = useApiClient();
  const router = useRouter();
  return (
    <RecordCorporateActionForm
      client={api}
      onSuccess={() => {
        router.push("/holdings");
        router.refresh();
      }}
    />
  );
}
