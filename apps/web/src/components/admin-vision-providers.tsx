"use client";

import type { AdminVisionProvider } from "@portfolio/api-client";
import { AdminVisionProvidersForm } from "@/components/admin-vision-providers-form";
import { useApiClient } from "@/lib/api";
import { useRouter } from "@/i18n/navigation";

/** Real-client wrapper: saves vision-provider config, then refreshes server data. */
export function AdminVisionProviders({
  initialProviders,
  encryptionEnabled,
}: {
  initialProviders: AdminVisionProvider[];
  encryptionEnabled: boolean;
}) {
  const api = useApiClient();
  const router = useRouter();
  return (
    <AdminVisionProvidersForm
      client={api}
      initialProviders={initialProviders}
      encryptionEnabled={encryptionEnabled}
      onSuccess={() => router.refresh()}
    />
  );
}
