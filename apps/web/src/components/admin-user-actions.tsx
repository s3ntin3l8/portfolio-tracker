"use client";

import { useRouter } from "@/i18n/navigation";
import { useApiClient } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { ConfirmActionDialog } from "@/components/confirm-action-dialog";
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

  return (
    <div className="flex items-center justify-end gap-1.5">
      <ConfirmActionDialog
        trigger={
          <Button variant="outline" size="sm">
            {t("revokeTokens")}
          </Button>
        }
        title={t("revokeTokens")}
        description={t("revokeTokensConfirm", { email })}
        entityLabel={email}
        confirmLabel={t("revokeTokens")}
        confirmVariant="default"
        requiresTyping={false}
        onConfirm={async () => {
          await api.adminRevokeUserTokens(userId);
          router.refresh();
        }}
      />
      <ConfirmActionDialog
        trigger={
          <Button variant="destructive" size="sm">
            {t("deleteUser")}
          </Button>
        }
        title={t("deleteUser")}
        description={t("deleteUserConfirm", { email })}
        entityLabel={email}
        confirmLabel={t("deleteUser")}
        confirmVariant="destructive"
        requiresTyping={true}
        onConfirm={async () => {
          await api.adminDeleteUser(userId);
          router.refresh();
        }}
      />
    </div>
  );
}
