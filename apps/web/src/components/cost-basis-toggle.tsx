"use client";

import { useSearchParams } from "next/navigation";
import { Link, usePathname } from "@/i18n/navigation";
import { cn } from "@/lib/utils";

interface Props {
  current: "purchase_price" | "total_paid";
  labelPurchase: string;
  labelTotal: string;
}

export function CostBasisToggle({ current, labelPurchase, labelTotal }: Props) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const href = (value: string) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("costBasis", value);
    return `${pathname}?${params.toString()}`;
  };

  const active = "bg-background text-foreground shadow-sm";
  const inactive = "text-muted-foreground hover:text-foreground";

  return (
    <div className="inline-flex items-center rounded-lg border border-border bg-muted p-1 text-sm font-medium">
      <Link
        href={href("purchase_price")}
        className={cn("rounded-md px-3 py-1 transition-colors", current === "purchase_price" ? active : inactive)}
      >
        {labelPurchase}
      </Link>
      <Link
        href={href("total_paid")}
        className={cn("rounded-md px-3 py-1 transition-colors", current === "total_paid" ? active : inactive)}
      >
        {labelTotal}
      </Link>
    </div>
  );
}
