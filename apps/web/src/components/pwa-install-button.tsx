"use client";

import { useTranslations } from "next-intl";
import { CheckCircle2, Download, Share, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePwaInstall } from "@/lib/use-pwa-install";

/**
 * Settings-card PWA install affordance — the fallback for users who dismissed the
 * banner. Renders a one-tap install button (Chromium), iOS instructions (Safari),
 * an "already installed" confirmation (standalone), or a note when the browser
 * doesn't support installation at all.
 */
export function PwaInstallButton() {
  const t = useTranslations("Settings");
  const { deferred, eligible, install, isStandalone } = usePwaInstall();

  if (isStandalone) {
    return (
      <div className="flex items-start gap-3">
        <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-green-600" />
        <p className="text-sm font-medium">{t("installAppInstalled")}</p>
      </div>
    );
  }

  // Not yet resolved — first render / SSR.
  if (!eligible) return null;

  // iOS Safari: manual Add-to-Home-Screen instructions.
  if (eligible.ios && !deferred) {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-start gap-3">
          <Smartphone className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div>
            <p className="text-sm font-medium">{t("installAppIosTitle")}</p>
            <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
              <Share className="inline size-3.5 shrink-0" />
              {t("installAppIosHint")}
            </p>
          </div>
        </div>
      </div>
    );
  }

  // No beforeinstallprompt and not iOS (e.g. Firefox, desktop Safari).
  if (!deferred) {
    return (
      <div className="flex items-start gap-3">
        <Download className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">{t("installAppUnavailable")}</p>
      </div>
    );
  }

  // Chromium: one-tap install.
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <Download className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
        <div className="flex-1">
          <p className="text-sm font-medium">{t("installAppDesc")}</p>
        </div>
      </div>
      <Button onClick={install} className="w-fit">
        <Download className="mr-2 size-4" />
        {t("installAppCta")}
      </Button>
    </div>
  );
}
