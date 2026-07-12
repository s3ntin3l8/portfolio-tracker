import type { LucideIcon } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { Card } from "@/components/ui/card";
import { TrendChip, type TrendTone } from "@/components/reports/trend-chip";
import { MiniSplitBar } from "@/components/reports/mini-split-bar";
import { TwoStatFooter } from "@/components/reports/two-stat-footer";

/**
 * A statement card for the Reports hub: icon chip + title + trend chip, a big headline
 * value + caption, an optional two-segment split bar, and a footer of up to two metrics
 * plus an "Open ›" affordance. Server-renderable — the whole card is a `<Link>` rather
 * than taking an `onOpen` closure (the design's `r.on`), since this composes inside a
 * server component page and a function prop can't cross that boundary.
 */
export function ReportCard({
  icon: Icon,
  iconBg,
  iconFg,
  title,
  trend,
  value,
  caption,
  splitBar,
  metrics,
  href,
  openLabel,
}: {
  icon: LucideIcon;
  iconBg: string;
  iconFg: string;
  title: string;
  trend?: { label: string; tone: TrendTone; arrow?: boolean };
  value: string;
  caption: string;
  splitBar?: Array<{ pct: number; color: string }>;
  metrics: Array<{ label: string; value: string; color?: string }>;
  href: string;
  openLabel: string;
}) {
  // Layout transcribed from the reference's desktop `reports` cards: 44px icon chip +
  // 700 16px title + delta pill in ONE header row, 800 30px value, 500 13px caption,
  // 7px split bar, and a bordered footer pinned to the card bottom.
  return (
    <Link href={href} className="group block h-full">
      <Card className="flex h-full min-w-0 flex-col rounded-[18px] px-[22px] py-5 transition-colors group-hover:border-primary/40">
        <div className="flex w-full items-center gap-3">
          <span
            className="flex size-11 shrink-0 items-center justify-center rounded-[14px]"
            style={{ background: iconBg, color: iconFg }}
          >
            <Icon className="size-[22px]" strokeWidth={1.9} />
          </span>
          <span className="min-w-0 flex-1 text-base font-bold">{title}</span>
          {trend && <TrendChip label={trend.label} tone={trend.tone} arrow={trend.arrow} />}
        </div>

        <p className="tabular mt-4 truncate text-[30px] font-extrabold">{value}</p>
        <p className="mt-[3px] truncate text-[13px] font-medium text-text-2">{caption}</p>

        {splitBar && splitBar.length > 0 && (
          <div className="mt-4">
            <MiniSplitBar segments={splitBar} />
          </div>
        )}

        <TwoStatFooter metrics={metrics} openLabel={openLabel} accentColor={iconFg} />
      </Card>
    </Link>
  );
}
