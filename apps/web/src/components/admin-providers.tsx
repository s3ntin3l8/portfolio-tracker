"use client";

import type { AdminProvider } from "@portfolio/api-client";
import { AdminProvidersForm } from "@/components/admin-providers-form";
import { useApiClient } from "@/lib/api";
import { useRouter } from "@/i18n/navigation";

/** Real-client wrapper: saves provider config, then refreshes server data. */
export function AdminProviders({
  initialProviders,
  encryptionEnabled,
}: {
  initialProviders: AdminProvider[];
  encryptionEnabled: boolean;
}) {
  const api = useApiClient();
  const router = useRouter();
  return (
    <AdminProvidersForm
      client={api}
      initialProviders={initialProviders}
      encryptionEnabled={encryptionEnabled}
      onSuccess={() => router.refresh()}
    />
  );
}
