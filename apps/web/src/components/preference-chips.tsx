"use client";

import { useState } from "react";
import { useRouter } from "@/i18n/navigation";
import { useApiClient } from "@/lib/api";
import { cn } from "@/lib/utils";

interface ChipOption {
  value: string;
  label: string;
}

interface Props {
  /**
   * Which global user-preference field this chip group writes. Kept generic so the
   * same component backs both the Settings → Investing "Tax code"/"Cost basis" chips
   * AND the Tax page's DE/ID regime toggle — all three write the SAME underlying
   * `taxRegime`/`costBasisMode` preference via `putPreferences`, so whichever surface
   * the user touches, the other stays in sync on next render (`router.refresh()`).
   */
  prefKey: "taxRegime" | "costBasisMode";
  current: string;
  options: ChipOption[];
  /** Extra classes for the wrapping pill. */
  className?: string;
}

/** A small segmented control that persists its selection as a global user preference
 *  and refreshes the current route so every consumer picks up the new value. */
export function PreferenceChips({ prefKey, current, options, className }: Props) {
  const router = useRouter();
  const api = useApiClient();
  const [pending, setPending] = useState<string | null>(null);

  async function select(value: string) {
    if (value === current || pending) return;
    setPending(value);
    try {
      if (prefKey === "taxRegime") {
        await api.putPreferences({ taxRegime: value as "DE" | "ID" });
      } else {
        await api.putPreferences({ costBasisMode: value as "purchase_price" | "total_paid" });
      }
      router.refresh();
    } finally {
      setPending(null);
    }
  }

  return (
    <div
      className={cn(
        "inline-flex items-center gap-1 rounded-xl border border-border bg-card p-1 shadow-sm",
        className,
      )}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => select(o.value)}
          disabled={pending !== null}
          aria-pressed={current === o.value}
          className={cn(
            "rounded-lg px-3.5 py-1.5 text-xs font-bold transition-colors disabled:opacity-60",
            current === o.value
              ? "bg-foreground text-background"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
