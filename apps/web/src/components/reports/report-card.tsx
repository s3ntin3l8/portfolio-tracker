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
  return (
    <Link href={href} className="group block">
      <Card className="p-5 transition-colors group-hover:border-primary/40">
        <div className="flex items-start justify-between gap-2">
          <span
            className="flex size-9 shrink-0 items-center justify-center rounded-xl"
            style={{ background: iconBg, color: iconFg }}
          >
            <Icon className="size-4.5" />
          </span>
          {trend && <TrendChip label={trend.label} tone={trend.tone} arrow={trend.arrow} />}
        </div>

        <p className="mt-3 text-sm font-semibold text-muted-foreground">{title}</p>
        <p className="tabular mt-1 text-2xl font-extrabold tracking-tight sm:text-[30px]">
          {value}
        </p>
        <p className="text-xs text-muted-foreground">{caption}</p>

        {splitBar && splitBar.length > 0 && (
          <div className="mt-3">
            <MiniSplitBar segments={splitBar} />
          </div>
        )}

        <TwoStatFooter metrics={metrics} openLabel={openLabel} accentColor={iconFg} />
      </Card>
    </Link>
  );
}
