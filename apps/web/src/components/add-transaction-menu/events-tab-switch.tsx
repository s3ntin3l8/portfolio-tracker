"use client";

import { cn } from "@/lib/utils";
import type { NewEntryTab } from "@/components/new-entry-tabs";

const TABS: Extract<NewEntryTab, "corporate-action" | "merger">[] = ["corporate-action", "merger"];

/**
 * The "Instrument event" destination's own 2-way switch (Corp. action / Merger),
 * matching the v2 design's `eventsTabs` — a flat flex row where the active tab gets a
 * card background + shadow (no sliding pill, unlike `BucketSwitcher`). Replaces
 * `NewEntryTabs`' own `TabsList` there (`hideTabList`), which otherwise left no way to
 * switch between the two once `visibleTabs` narrowed it to both — the desktop rail's
 * "Instrument event" destination previously had no way to change tabs at all.
 */
export function EventsTabSwitch({
  value,
  onChange,
  labels,
}: {
  value: (typeof TABS)[number];
  onChange: (tab: (typeof TABS)[number]) => void;
  labels: { corporateAction: string; merger: string };
}) {
  return (
    <div className="mb-5 flex gap-1 rounded-[13px] border border-border bg-card-2 p-1">
      {TABS.map((tab) => (
        <button
          key={tab}
          type="button"
          onClick={() => onChange(tab)}
          aria-pressed={value === tab}
          className={cn(
            "flex-1 rounded-[10px] px-1 py-2.5 text-xs whitespace-nowrap transition-colors",
            value === tab
              ? "bg-card font-bold text-foreground shadow-[0_1px_2px_rgba(15,27,20,.08)]"
              : "font-semibold text-text-2",
          )}
        >
          {tab === "corporate-action" ? labels.corporateAction : labels.merger}
        </button>
      ))}
    </div>
  );
}
