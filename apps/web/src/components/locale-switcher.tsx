"use client";

import { useLocale } from "next-intl";
import { usePathname, useRouter } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";

export function LocaleSwitcher() {
  const locale = useLocale();
  const pathname = usePathname();
  const router = useRouter();
  const next = locale === "en" ? "id" : "en";

  return (
    <Button
      variant="ghost"
      size="sm"
      aria-label="Switch language"
      onClick={() => router.replace(pathname, { locale: next })}
    >
      {locale.toUpperCase()}
    </Button>
  );
}
