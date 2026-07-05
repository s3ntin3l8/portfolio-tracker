"use client";

import { useTranslations } from "next-intl";
import type { AccountHolderType } from "@portfolio/api-client";
import { cn } from "@/lib/utils";

const TYPES: AccountHolderType[] = ["self", "child", "other"];

/**
 * Segmented chip control for the account-holder type (reference: Self / Child / Other) —
 * replaces the native `<select>` in both the portfolio and holder create/edit sheets.
 * Exposed as a `radiogroup`; pass `labelledBy` (the id of the field label) for a11y.
 */
export function HolderTypeChips({
  value,
  onChange,
  labelledBy,
}: {
  value: AccountHolderType;
  onChange: (v: AccountHolderType) => void;
  labelledBy?: string;
}) {
  const t = useTranslations("PortfolioForm");
  return (
    <div className="flex gap-2" role="radiogroup" aria-labelledby={labelledBy}>
      {TYPES.map((tp) => {
        const on = value === tp;
        return (
          <button
            key={tp}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(tp)}
            className={cn(
              "flex-1 rounded-[10px] py-2.5 text-[13px] transition-colors",
              on
                ? "bg-primary font-bold text-primary-foreground"
                : "border border-border bg-card font-semibold text-foreground hover:bg-accent/50",
            )}
          >
            {t(`holderType${tp.charAt(0).toUpperCase()}${tp.slice(1)}`)}
          </button>
        );
      })}
    </div>
  );
}
