"use client";

import type { ImportStrategy } from "@portfolio/api-client";
import { AdminImportSettingsForm } from "@/components/admin-import-settings-form";
import { useApiClient } from "@/lib/api";
import { useRouter } from "@/i18n/navigation";

/** Real-client wrapper: saves the import strategy, then refreshes server data. */
export function AdminImportSettings({ initialStrategy }: { initialStrategy: ImportStrategy }) {
  const api = useApiClient();
  const router = useRouter();
  return (
    <AdminImportSettingsForm
      client={api}
      initialStrategy={initialStrategy}
      onSuccess={() => router.refresh()}
    />
  );
}
