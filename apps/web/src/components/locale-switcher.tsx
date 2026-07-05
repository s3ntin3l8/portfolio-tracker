"use client";

import { useLocale, useTranslations } from "next-intl";
import { usePathname, useRouter } from "@/i18n/navigation";
import { cn } from "@/lib/utils";

const LOCALES = ["en", "id"] as const;

/** Two-option pill pair — same visual pattern as `PreferenceChips` (Tax regime/cost-basis
 *  toggles), showing both languages at once rather than a single "tap to flip" button. */
export function LocaleSwitcher() {
  const locale = useLocale();
  const pathname = usePathname();
  const router = useRouter();
  const t = useTranslations("Settings");

  return (
    <div className="flex w-full gap-[7px]">
      {LOCALES.map((l) => (
        <button
          key={l}
          type="button"
          onClick={() => router.replace(pathname, { locale: l })}
          aria-pressed={locale === l}
          className={cn(
            "flex-1 rounded-[11px] py-[9px] text-center text-[13px] transition-colors",
            locale === l
              ? "bg-pill font-bold text-white"
              : "bg-background font-semibold text-foreground",
          )}
        >
          {t(`languageOptions.${l}`)}
        </button>
      ))}
    </div>
  );
}
