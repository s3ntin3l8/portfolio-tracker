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
    <div className="inline-flex items-center gap-1 rounded-[12px] border border-border bg-card p-[3px] shadow-card">
      {LOCALES.map((l) => (
        <button
          key={l}
          type="button"
          onClick={() => router.replace(pathname, { locale: l })}
          aria-pressed={locale === l}
          className={cn(
            "rounded-[9px] px-3.5 py-1.5 text-xs font-bold transition-colors",
            locale === l
              ? "bg-foreground text-background"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {t(`languageOptions.${l}`)}
        </button>
      ))}
    </div>
  );
}
