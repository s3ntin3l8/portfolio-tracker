"use client";

import { UpdateProfileForm } from "@/components/update-profile-form";
import { useApiClient } from "@/lib/api";
import { useRouter } from "@/i18n/navigation";

/** Real-client wrapper: saves the profile, then refreshes server data. */
export function UpdateProfile({
  initialName,
  initialCurrency,
}: {
  initialName: string;
  initialCurrency: string;
}) {
  const api = useApiClient();
  const router = useRouter();
  return (
    <UpdateProfileForm
      client={api}
      initialName={initialName}
      initialCurrency={initialCurrency}
      onSuccess={() => router.refresh()}
    />
  );
}
