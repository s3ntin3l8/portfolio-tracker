"use client";

import { cn } from "@/lib/utils";
import { BUCKETS, type Bucket } from "./constants";

/**
 * The v2 design's 4-way "intent bucket" switcher (Trade / Income / Transfer / Cash) —
 * a sliding-pill segmented control that replaces the old flat type-chip dropdown.
 * Selecting a bucket resets the transaction `type` to that bucket's default; the
 * sub-type chip row below it (`sub-type-toggle.tsx`) offers the bucket's own types.
 */
export function BucketSwitcher({
  bucket,
  onSelect,
  t,
}: {
  bucket: Bucket | null;
  onSelect: (b: Bucket) => void;
  t: (key: string) => string;
}) {
  const activeIndex = bucket ? BUCKETS.indexOf(bucket) : -1;

  return (
    <div className="relative flex rounded-[13px] border border-border bg-card-2 p-1">
      {activeIndex >= 0 && (
        <div
          aria-hidden
          className="absolute top-1 z-0 h-[calc(100%-8px)] rounded-[10px] bg-card shadow-[0_1px_2px_rgba(15,27,20,.08)] transition-[left] duration-300 ease-[cubic-bezier(.4,0,.2,1)]"
          style={{
            width: `calc((100% - 8px) / ${BUCKETS.length})`,
            left: `calc(4px + ${activeIndex} * ((100% - 8px) / ${BUCKETS.length}))`,
          }}
        />
      )}
      {BUCKETS.map((b) => (
        <button
          key={b}
          type="button"
          onClick={() => onSelect(b)}
          aria-pressed={bucket === b}
          className={cn(
            "relative z-10 flex-1 rounded-[10px] px-1 py-2.5 text-xs transition-colors",
            bucket === b ? "font-bold text-foreground" : "font-semibold text-text-2",
          )}
        >
          {t(`bucket${b.charAt(0).toUpperCase()}${b.slice(1)}`)}
        </button>
      ))}
    </div>
  );
}
