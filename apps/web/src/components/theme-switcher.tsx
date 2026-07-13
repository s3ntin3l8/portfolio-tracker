"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

const THEMES = ["light", "dark", "system"] as const;

export function ThemeSwitcher() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const t = useTranslations("Settings");

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setMounted(true), []);

  if (!mounted) {
    return (
      <div role="group" aria-label={t("appearance")} className="flex w-full gap-[7px]">
        {THEMES.map((th) => (
          <div
            key={th}
            className="flex-1 rounded-[11px] py-[9px] text-center text-[13px] bg-background font-semibold text-text-3 select-none"
          >
            {t(`appearanceOptions.${th}`)}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div role="group" aria-label={t("appearance")} className="flex w-full gap-[7px]">
      {THEMES.map((th) => (
        <button
          key={th}
          type="button"
          onClick={() => setTheme(th)}
          aria-pressed={theme === th}
          className={cn(
            "flex-1 rounded-[11px] py-[9px] text-center text-[13px] transition-colors",
            theme === th
              ? "bg-pill font-bold text-white"
              : "bg-background font-semibold text-foreground hover:bg-secondary",
          )}
        >
          {t(`appearanceOptions.${th}`)}
        </button>
      ))}
    </div>
  );
}
