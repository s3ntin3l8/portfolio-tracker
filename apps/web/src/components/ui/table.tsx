import * as React from "react";
import { cn } from "@/lib/utils";

function Table({ className, ...props }: React.ComponentProps<"table">) {
  return (
    <div className="relative w-full overflow-x-auto">
      <table className={cn("w-full caption-bottom text-sm", className)} {...props} />
    </div>
  );
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return <thead className={cn("[&_tr]:border-b", className)} {...props} />;
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return <tbody className={cn("[&_tr:last-child]:border-0", className)} {...props} />;
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      className={cn(
        "border-t-2 border-line bg-card-2 text-sm font-extrabold [&_tr]:border-0",
        className,
      )}
      {...props}
    />
  );
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      className={cn(
        "border-b border-line transition-colors hover:bg-[var(--row-hover)]",
        className,
      )}
      {...props}
    />
  );
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      className={cn(
        "h-11 px-3 text-left align-middle text-[11px] font-bold uppercase tracking-[0.04em] text-text-3 first:pl-[22px] last:pr-[22px] [&:has([role=checkbox])]:pr-0",
        className,
      )}
      {...props}
    />
  );
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      className={cn("px-3 py-3 align-middle first:pl-[22px] last:pr-[22px]", className)}
      {...props}
    />
  );
}

// Shared cell-typography convention (sourced from the Holdings table, the most fully-realized
// instance). Not baked into TableCell itself since weight/role varies by column — compose with
// `cn()` (e.g. `cn(TABLE_VALUE, "text-text-mute")` for a de-emphasized secondary number).
export const TABLE_LABEL = "text-sm font-bold";
export const TABLE_SUBLABEL = "text-xs font-medium text-text-2";
export const TABLE_VALUE = "tabular text-right text-[13px] font-medium";
export const TABLE_VALUE_STRONG = "tabular text-right text-[13px] font-bold";
export const TABLE_SUBVALUE = "text-[11px] font-semibold";

export { Table, TableHeader, TableBody, TableFooter, TableRow, TableHead, TableCell };
