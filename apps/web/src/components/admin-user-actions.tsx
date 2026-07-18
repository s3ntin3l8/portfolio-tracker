"use client";

import { useRouter } from "@/i18n/navigation";
import { useApiClient } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { ConfirmActionDialog } from "@/components/confirm-action-dialog";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

export function AdminUserActions({
  userId,
  email,
  onboardingCompleted = true,
}: {
  userId: string;
  email: string;
  /** Only offer the reset when onboarding has actually been completed/skipped. */
  onboardingCompleted?: boolean;
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
          const { revoked } = await api.adminRevokeUserTokens(userId);
          toast.success(t("revokeTokensDone", { count: revoked }));
          router.refresh();
        }}
      />
      {onboardingCompleted && (
        <ConfirmActionDialog
          trigger={
            <Button variant="outline" size="sm">
              {t("resetOnboarding")}
            </Button>
          }
          title={t("resetOnboarding")}
          description={t("resetOnboardingConfirm", { email })}
          entityLabel={email}
          confirmLabel={t("resetOnboarding")}
          confirmVariant="default"
          requiresTyping={false}
          onConfirm={async () => {
            await api.adminResetUserOnboarding(userId);
            toast.success(t("resetOnboardingDone"));
            router.refresh();
          }}
        />
      )}
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
          toast.success(t("deleteUserDone"));
          router.refresh();
        }}
      />
    </div>
  );
}
