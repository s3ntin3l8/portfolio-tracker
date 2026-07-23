"use client";

import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/**
 * The bucket-scoped sub-type chip row (Action/Type/Direction/Category, per
 * `BUCKET_SUBTYPE_LABEL_KEY`) — sits directly below `BucketSwitcher`. Not rendered when
 * the current type maps to no bucket (an existing legacy share-receipt transaction being
 * edited — see `bucketForType`).
 */
export function SubTypeToggle({
  type,
  subTypes,
  labelKey,
  onSelect,
  t,
  tt,
}: {
  type: string;
  subTypes: readonly string[];
  labelKey: string;
  onSelect: (ty: string) => void;
  t: (key: string) => string;
  tt: (key: string) => string;
}) {
  if (subTypes.length === 0) return null;

  return (
    <div className="space-y-1.5">
      <Label>{t(labelKey)}</Label>
      <div className="flex flex-wrap gap-2">
        {subTypes.map((ty) => (
          <button
            key={ty}
            type="button"
            onClick={() => onSelect(ty)}
            className={cn(
              "rounded-[10px] px-[13px] py-[9px] text-xs transition-colors",
              ty === type
                ? "bg-primary font-bold text-primary-foreground"
                : "border border-border bg-card-2 font-semibold text-foreground hover:bg-secondary",
            )}
          >
            {tt(ty)}
          </button>
        ))}
      </div>
    </div>
  );
}
