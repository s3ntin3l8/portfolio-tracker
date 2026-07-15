"use client";

import { useState } from "react";
import { useRouter } from "@/i18n/navigation";
import { useApiClient } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { useTranslations } from "next-intl";

export function AdminUserActions({
  userId,
  email,
}: {
  userId: string;
  email: string;
}) {
  const t = useTranslations("Admin");
  const router = useRouter();
  const api = useApiClient();
  const [revokePending, setRevokePending] = useState(false);
  const [deletePending, setDeletePending] = useState(false);

  async function handleRevokeTokens() {
    if (!window.confirm(t("revokeTokensConfirm", { email }))) return;
    setRevokePending(true);
    try {
      const { revoked } = await api.adminRevokeUserTokens(userId);
      alert(t("revokeTokensDone", { count: revoked }));
      router.refresh();
    } catch {
      alert(t("updateError"));
    } finally {
      setRevokePending(false);
    }
  }

  async function handleDeleteUser() {
    if (!window.confirm(t("deleteUserConfirm", { email }))) return;
    setDeletePending(true);
    try {
      await api.adminDeleteUser(userId);
      alert(t("deleteUserDone"));
      router.refresh();
    } catch {
      alert(t("updateError"));
    } finally {
      setDeletePending(false);
    }
  }

  return (
    <div className="flex items-center justify-end gap-1.5">
      <Button
        variant="outline"
        size="sm"
        onClick={handleRevokeTokens}
        disabled={revokePending}
      >
        {revokePending ? "…" : t("revokeTokens")}
      </Button>
      <Button
        variant="destructive"
        size="sm"
        onClick={handleDeleteUser}
        disabled={deletePending}
      >
        {deletePending ? "…" : t("deleteUser")}
      </Button>
    </div>
  );
}
