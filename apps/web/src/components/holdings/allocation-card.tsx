import { AllocationDonut, type DonutSlice } from "@/components/charts/allocation-donut";
import { cn } from "@/lib/utils";

/** Direction of a gain figure — drives the value colour (green up / red down / neutral). */
export type Tone = "up" | "down" | "flat";

const toneClass = (tone: Tone) =>
  tone === "up" ? "text-success" : tone === "down" ? "text-destructive" : "";

/** One stat column: a small label over a primary figure, optionally a secondary figure
 *  below it (used to stack the EUR amount over its % on the performance columns). */
function Stat({
  label,
  primary,
  secondary,
  tone = "flat",
  primaryClass = "text-[18px]",
}: {
  label: string;
  primary: string;
  secondary?: string | null;
  tone?: Tone;
  primaryClass?: string;
}) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] font-semibold text-text-3">{label}</p>
      <p className={cn("tabular mt-0.5 font-extrabold", primaryClass, toneClass(tone))}>
        {primary}
      </p>
      {secondary != null && (
        <p className={cn("tabular mt-0.5 text-[13px] font-bold", toneClass(tone))}>{secondary}</p>
      )}
    </div>
  );
}

/**
 * The Holdings "Allocation" card: the class-donut (reused wholesale, incl. its own
 * legend) plus, on desktop only, a stats strip that fills the width the donut used to
 * leave empty — the total value alongside two performance columns (all-time, today),
 * each showing its EUR amount over its % gain. No card title — the reference shows the
 * donut directly (its own center label already reads "Assets"), and no tab switcher
 * either — unlike `AllocationTabs` (Class|Currency|Region|Sector), the design shows only
 * the class breakdown on this screen; Region/Currency get their own card below (see
 * `RegionCurrencyCard`), and Sector isn't shown on Holdings at all.
 */
export function AllocationCard({
  slices,
  currency,
  total,
  totalLabel,
  totalValueFormatted,
  allTimeLabel,
  allTimeAmount,
  allTimePct,
  allTimeTone = "flat",
  todayLabel,
  todayAmount,
  todayPct,
  todayTone = "flat",
}: {
  slices: DonutSlice[];
  currency: string;
  /** Sum of `slices` — passed straight through to `AllocationDonut` for its center label. */
  total: number;
  totalLabel: string;
  /** Pre-formatted (locale-aware) total value for the desktop-only stats strip. */
  totalValueFormatted: string;
  allTimeLabel: string;
  /** All-time unrealized P&L as a signed money string (EUR amount). */
  allTimeAmount: string;
  /** All-time gain as a percent string, or null when cost basis is unknown. */
  allTimePct: string | null;
  allTimeTone?: Tone;
  todayLabel: string;
  /** Today's change as a signed money string (EUR amount). */
  todayAmount: string;
  /** Today's change as a percent string, or null when a prior base is unavailable. */
  todayPct: string | null;
  todayTone?: Tone;
}) {
  // Transcribed from `Pocket Prototype.dc.html`: padding 20px 24px; the donut keeps a
  // bounded width on desktop so the stats no longer sit against the far edge across a
  // wide empty gap — instead they spread as three columns over the reclaimed space,
  // separated by the --line border. Labels 600 11px text-3, total 800 22px, all-time/
  // today amounts 800 18px over a 700 13px % line.
  return (
    <div className="rounded-[18px] bg-card px-6 py-5 shadow-card">
      <div className="flex flex-col gap-7 lg:flex-row lg:items-center lg:gap-8">
        <div className="lg:w-[400px] lg:shrink-0">
          <AllocationDonut data={slices} currency={currency} total={total} />
        </div>
        <div className="hidden lg:grid lg:flex-1 lg:grid-cols-3 lg:items-center lg:gap-6 lg:border-l lg:border-line lg:pl-8">
          <Stat label={totalLabel} primary={totalValueFormatted} primaryClass="text-[22px]" />
          <Stat
            label={allTimeLabel}
            primary={allTimeAmount}
            secondary={allTimePct}
            tone={allTimeTone}
          />
          <Stat label={todayLabel} primary={todayAmount} secondary={todayPct} tone={todayTone} />
        </div>
      </div>
    </div>
  );
}
