"use client";

import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Download } from "lucide-react";
import { cn } from "@/lib/utils";
import { usePwaInstall } from "@/lib/use-pwa-install";

const ICON_BG = "rgba(59,130,246,.16)";
const ICON_COLOR = "#3B82F6";

/**
 * The "Install app" settings-menu row — a direct action, not a link to a sub-page.
 * Unlike every other settings section, install has no content of its own: clicking it
 * fires the native `beforeinstallprompt` prompt (Chromium) or surfaces the manual
 * Add-to-Home-Screen hint (iOS, which has no such event) via toast.
 *
 * Renders nothing once the app is already installed, or on browsers that support
 * neither path (e.g. desktop Safari, Firefox) — a button that can't do anything is
 * worse than no button. Rendered twice by `SettingsLayout` (`variant="rail"` for the
 * desktop nav, `variant="landing"` for the mobile menu) via `SettingsShell`'s
 * `railExtra`/`landingExtra` slots, always placed after the Admin entry.
 */
export function SettingsInstallItem({ variant }: { variant: "rail" | "landing" }) {
  const t = useTranslations("Settings");
  const { deferred, eligible, install, isStandalone } = usePwaInstall();

  if (isStandalone || !eligible) return null;
  if (!deferred && !eligible.ios) return null;

  async function handleClick() {
    if (deferred) {
      await install();
    } else if (eligible?.ios) {
      toast.info(t("installAppIosTitle"), { description: t("installAppIosHint") });
    }
  }

  const icon = (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center",
        variant === "rail"
          ? "size-[30px] rounded-[9px] [&>svg]:size-4"
          : "size-9 rounded-xl [&>svg]:size-[18px]",
      )}
      style={{ background: ICON_BG, color: ICON_COLOR }}
    >
      <Download />
    </span>
  );

  if (variant === "rail") {
    return (
      <button
        type="button"
        onClick={handleClick}
        className="my-0.5 flex w-full items-center gap-2.5 rounded-[12px] px-2.5 py-2.5 text-[13px] font-bold transition-colors hover:bg-background/60"
      >
        {icon}
        <span className="min-w-0 flex-1 truncate text-left">{t("navInstall")}</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-muted/50"
    >
      {icon}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-bold">{t("navInstall")}</div>
        <div className="truncate text-xs text-muted-foreground">{t("navInstallSub")}</div>
      </div>
    </button>
  );
}
