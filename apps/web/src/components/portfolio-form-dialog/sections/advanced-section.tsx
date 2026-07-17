"use client";

import { useTranslations } from "next-intl";
import { ChevronDown } from "lucide-react";
import { ToggleRow } from "@/components/ui/toggle-row";

export function AdvancedSection({
  cashCounted,
  allowNegativeCash,
  documentRetention,
  includeInAggregate,
  onCashCountedChange,
  onAllowNegativeCashChange,
  onDocumentRetentionChange,
  onIncludeInAggregateChange,
}: {
  cashCounted: boolean;
  allowNegativeCash: boolean;
  documentRetention: boolean;
  includeInAggregate: boolean;
  onCashCountedChange: (v: boolean) => void;
  onAllowNegativeCashChange: (v: boolean) => void;
  onDocumentRetentionChange: (v: boolean) => void;
  onIncludeInAggregateChange: (v: boolean) => void;
}) {
  const t = useTranslations("PortfolioForm");

  return (
    <details className="group">
      <summary className="flex cursor-pointer list-none items-center justify-between px-0.5 py-1 [&::-webkit-details-marker]:hidden">
        <span className="text-[11px] font-bold uppercase tracking-[0.06em] text-text-3">
          {t("sectionAccounting")}
        </span>
        <ChevronDown className="size-4 shrink-0 text-text-3 transition-transform group-open:rotate-180" />
      </summary>
      <div className="mt-1">
        <ToggleRow
          id="cashCounted"
          label={t("cashCounted")}
          hint={t("cashCountedHint")}
          checked={cashCounted}
          onCheckedChange={onCashCountedChange}
        />
        {cashCounted && (
          <ToggleRow
            id="allowNegativeCash"
            label={t("allowNegativeCash")}
            hint={t("allowNegativeCashHint")}
            checked={allowNegativeCash}
            onCheckedChange={onAllowNegativeCashChange}
          />
        )}
        <ToggleRow
          id="documentRetention"
          label={t("documentRetention")}
          hint={t("documentRetentionHint")}
          checked={documentRetention}
          onCheckedChange={onDocumentRetentionChange}
        />
        <ToggleRow
          id="includeInAggregate"
          label={t("includeInAggregate")}
          hint={t("includeInAggregateHint")}
          checked={includeInAggregate}
          onCheckedChange={onIncludeInAggregateChange}
        />
      </div>
    </details>
  );
}
