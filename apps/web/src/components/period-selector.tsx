"use client";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

const PERIODS = ["ytd", "1y", "5y", "max"] as const;
type Period = (typeof PERIODS)[number];

interface PeriodSelectorProps {
  /** The currently active period (one of ytd / 1y / 5y / max). */
  current: string;
}

export function PeriodSelector({ current }: PeriodSelectorProps) {
  const t = useTranslations("PeriodSelector");
  const router = useRouter();
  const searchParams = useSearchParams();
  const pathname = usePathname();

  const handleSelect = (period: Period) => {
    const params = new URLSearchParams(searchParams.toString());
    if (period === "max") {
      params.delete("period");
    } else {
      params.set("period", period);
    }
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  };

  return (
    <div className="flex gap-1">
      {PERIODS.map((p) => (
        <button
          key={p}
          onClick={() => handleSelect(p)}
          className={cn(
            "px-3 py-1 rounded text-sm font-medium transition-colors",
            current === p
              ? "bg-primary text-primary-foreground"
              : "bg-muted text-muted-foreground hover:bg-muted/80",
          )}
        >
          {t(p)}
        </button>
      ))}
    </div>
  );
}
