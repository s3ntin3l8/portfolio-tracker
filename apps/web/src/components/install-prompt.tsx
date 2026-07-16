"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Download, Share, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePwaInstall } from "@/lib/use-pwa-install";

const DISMISS_KEY = "pwa-install-dismissed";

/**
 * A dismissible "install this PWA" hint shown in-browser (not when already installed).
 * Android/desktop Chromium get a one-tap install button via `beforeinstallprompt`; iOS
 * Safari (which has no such event) gets the manual Add-to-Home-Screen instruction.
 */
export function InstallPrompt() {
  const t = useTranslations("Install");
  const { deferred, eligible, install: doInstall, isStandalone } = usePwaInstall();
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (localStorage.getItem(DISMISS_KEY) === "1")
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDismissed(true);
  }, []);

  function dismiss() {
    setDismissed(true);
    localStorage.setItem(DISMISS_KEY, "1");
  }

  async function handleInstall() {
    await doInstall();
    dismiss();
  }

  if (dismissed || isStandalone || !eligible) return null;

  const showIos = eligible.ios && !deferred;
  if (!deferred && !showIos) return null;

  return (
    <div
      role="region"
      aria-label={t("title")}
      className="mb-4 flex items-center gap-3 rounded-lg border border-border bg-card/60 px-4 py-3 text-sm"
    >
      <Download className="size-5 shrink-0 text-primary" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{t("title")}</p>
        {showIos && (
          <p className="mt-0.5 flex items-center gap-1 text-muted-foreground">
            <Share className="inline size-3.5 shrink-0" />
            {t("iosHint")}
          </p>
        )}
      </div>
      {deferred && (
        <Button size="sm" onClick={handleInstall}>
          {t("cta")}
        </Button>
      )}
      <Button variant="ghost" size="icon" aria-label={t("dismiss")} onClick={dismiss}>
        <X className="size-4" />
      </Button>
    </div>
  );
}
