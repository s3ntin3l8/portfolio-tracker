"use client";

import { useEffect, useRef } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Serwist } from "@serwist/window";

const TOAST_ID = "pwa-update-available";

/**
 * Registers the service worker (see `register: false` in next.config.mjs) and prompts a
 * reload when a new one is ready. The SW itself parks a fresh install in "waiting" instead
 * of activating immediately (`skipWaiting: false` in src/app/sw.ts) specifically so this
 * component gets a chance to ask first — without that, updates would apply silently and a
 * user could land mid-session on a half-old, half-new build.
 */
export function PwaUpdater() {
  const t = useTranslations("Install");
  const tRef = useRef(t);

  useEffect(() => {
    tRef.current = t;
  }, [t]);

  useEffect(() => {
    // Serwist is disabled outside production (see next.config.mjs), so there's no
    // /sw.js to register in dev — nothing to do.
    if (process.env.NODE_ENV !== "production") return;
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;

    const serwist = new Serwist("/sw.js", { scope: "/" });

    serwist.addEventListener("waiting", () => {
      toast.info(tRef.current("updateAvailable"), {
        id: TOAST_ID,
        duration: Infinity,
        action: {
          label: tRef.current("reload"),
          onClick: () => {
            serwist.addEventListener("controlling", () => window.location.reload());
            void serwist.messageSkipWaiting();
          },
        },
      });
    });

    void serwist.register();
  }, []);

  return null;
}
