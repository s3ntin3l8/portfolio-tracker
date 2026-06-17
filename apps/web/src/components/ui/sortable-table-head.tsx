import * as React from "react";
import { ChevronUp, ChevronDown, ChevronsUpDown } from "lucide-react";
import { TableHead } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { SortDir } from "@/lib/table-sort";

export interface SortableTableHeadProps {
  colKey: string;
  sortKey: string | null;
  sortDir: SortDir;
  onToggle: (key: string) => void;
  children: React.ReactNode;
  className?: string;
  align?: "left" | "right";
}

export function SortableTableHead({
  colKey,
  sortKey,
  sortDir,
  onToggle,
  children,
  className,
  align = "left",
}: SortableTableHeadProps) {
  const isActive = colKey === sortKey;
  const ariaSortValue = isActive
    ? sortDir === "asc"
      ? "ascending"
      : "descending"
    : "none";

  return (
    <TableHead
      aria-sort={ariaSortValue}
      className={cn(
        "cursor-pointer select-none",
        align === "right" && "text-right",
        className,
      )}
    >
      <button
        type="button"
        className={cn(
          "flex items-center gap-1 hover:text-foreground",
          align === "right" && "w-full justify-end",
        )}
        onClick={() => onToggle(colKey)}
      >
        {children}
        {isActive ? (
          sortDir === "asc" ? (
            <ChevronUp className="size-3 shrink-0" />
          ) : (
            <ChevronDown className="size-3 shrink-0" />
          )
        ) : (
          <ChevronsUpDown className="size-3 shrink-0" />
        )}
      </button>
    </TableHead>
  );
}
