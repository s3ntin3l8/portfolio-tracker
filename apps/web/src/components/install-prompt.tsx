"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Download, Share, X } from "lucide-react";
import { Button } from "@/components/ui/button";

// The `beforeinstallprompt` event isn't in the DOM lib types yet.
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const DISMISS_KEY = "pwa-install-dismissed";

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    // iOS Safari exposes standalone here rather than via display-mode.
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function isIos(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

/**
 * A dismissible "install this PWA" hint shown in-browser (not when already installed).
 * Android/desktop Chromium get a one-tap install button via `beforeinstallprompt`; iOS
 * Safari (which has no such event) gets the manual Add-to-Home-Screen instruction.
 */
export function InstallPrompt() {
  const t = useTranslations("Install");
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [dismissed, setDismissed] = useState(false);
  // Resolved once on mount from external signals (display-mode, localStorage, UA):
  // null until then (so SSR/first render shows nothing), `{ ios }` when eligible.
  const [eligible, setEligible] = useState<{ ios: boolean } | null>(null);

  useEffect(() => {
    if (isStandalone()) return; // already installed
    if (localStorage.getItem(DISMISS_KEY) === "1") return; // user dismissed before

    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);

    // Single intentional mount-time resolution (iOS has no beforeinstallprompt).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setEligible({ ios: isIos() });

    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, []);

  function dismiss() {
    setDismissed(true);
    localStorage.setItem(DISMISS_KEY, "1");
  }

  async function install() {
    if (!deferred) return;
    await deferred.prompt();
    await deferred.userChoice;
    setDeferred(null);
    dismiss();
  }

  // Nothing to offer until a native prompt is captured (Android/desktop) or we know
  // it's iOS (manual instruction). Hidden when dismissed or already installed.
  const showIos = Boolean(eligible?.ios) && !deferred;
  if (dismissed || !eligible || (!deferred && !showIos)) return null;

  return (
    <div
      role="region"
      aria-label={t("title")}
      className="mb-4 flex items-center gap-3 rounded-lg border border-border bg-card/60 px-4 py-3 text-sm"
    >
      <Download className="size-5 shrink-0 text-primary" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{t("title")}</p>
        {showIos && !deferred && (
          <p className="mt-0.5 flex items-center gap-1 text-muted-foreground">
            <Share className="inline size-3.5 shrink-0" />
            {t("iosHint")}
          </p>
        )}
      </div>
      {deferred && (
        <Button size="sm" onClick={install}>
          {t("cta")}
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon"
        aria-label={t("dismiss")}
        onClick={dismiss}
      >
        <X className="size-4" />
      </Button>
    </div>
  );
}
