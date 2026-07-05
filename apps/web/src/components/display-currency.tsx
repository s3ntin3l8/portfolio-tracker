"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useApiClient } from "@/lib/api";
import { useRouter } from "@/i18n/navigation";
import { cn } from "@/lib/utils";

const CURRENCIES = ["IDR", "USD", "EUR", "SGD"];

/**
 * Standalone "Display currency" control — a full-width segmented chip group that persists
 * the choice immediately (like the language and tax-regime toggles), rather than being
 * bundled into the name form's explicit Save. Every total in the app is rendered through
 * this currency, so flipping it re-derives the server data via `router.refresh()`.
 */
export function DisplayCurrency({ current }: { current: string }) {
  const t = useTranslations("Settings");
  const api = useApiClient();
  const router = useRouter();
  const [value, setValue] = useState(current);
  const [pending, setPending] = useState<string | null>(null);

  async function select(ccy: string) {
    if (ccy === value || pending) return;
    setPending(ccy);
    try {
      await api.updateMe({ displayCurrency: ccy });
      setValue(ccy);
      router.refresh();
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="space-y-1.5">
      <div role="group" aria-label={t("displayCurrency")} className="flex w-full gap-[7px]">
        {CURRENCIES.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => select(c)}
            disabled={pending !== null}
            aria-pressed={value === c}
            className={cn(
              "flex-1 rounded-[11px] py-[9px] text-center text-[13px] transition-colors disabled:opacity-60",
              value === c
                ? "bg-pill font-bold text-white"
                : "bg-background font-semibold text-foreground",
            )}
          >
            {c}
          </button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">{t("displayCurrencyHint")}</p>
    </div>
  );
}
