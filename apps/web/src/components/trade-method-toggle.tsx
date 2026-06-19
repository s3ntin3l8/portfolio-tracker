"use client";

import { useSearchParams } from "next/navigation";
import { Link, usePathname } from "@/i18n/navigation";
import { cn } from "@/lib/utils";

interface Props {
  current: "average" | "fifo";
  labelAverage: string;
  labelFifo: string;
}

/** Average ↔ FIFO cost-basis toggle, driven by the `?method=` search param (server re-render). */
export function TradeMethodToggle({ current, labelAverage, labelFifo }: Props) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const href = (value: string) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("method", value);
    return `${pathname}?${params.toString()}`;
  };

  const active = "bg-background text-foreground shadow-sm";
  const inactive = "text-muted-foreground hover:text-foreground";

  return (
    <div className="inline-flex items-center rounded-lg border border-border bg-muted p-1 text-sm font-medium">
      <Link
        href={href("average")}
        className={cn("rounded-md px-3 py-1 transition-colors", current === "average" ? active : inactive)}
      >
        {labelAverage}
      </Link>
      <Link
        href={href("fifo")}
        className={cn("rounded-md px-3 py-1 transition-colors", current === "fifo" ? active : inactive)}
      >
        {labelFifo}
      </Link>
    </div>
  );
}
