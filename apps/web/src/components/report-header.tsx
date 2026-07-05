import { ChevronLeft } from "lucide-react";
import { Link } from "@/i18n/navigation";

/**
 * Report-screen header (reference: Realized P&L / Income / Savings / Tax). A back chevron —
 * a 36px card-surface button — sits to the LEFT of the title on both mobile and desktop,
 * with the title (700/24) over an optional muted subtitle, and an optional right-aligned
 * action (e.g. Export). The report screens are reached from the `/reports` hub, so back
 * returns there by default.
 */
export function ReportHeader({
  title,
  subtitle,
  backHref = "/reports",
  action,
}: {
  title: string;
  subtitle?: string;
  backHref?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex items-center gap-3">
      <Link
        href={backHref}
        aria-label="Back"
        className="flex size-9 shrink-0 items-center justify-center rounded-[11px] bg-card text-foreground shadow-[0_1px_2px_rgba(15,27,20,.08)] transition-transform active:scale-95"
      >
        <ChevronLeft className="size-[19px]" strokeWidth={2.2} />
      </Link>
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-2xl font-bold">{title}</h1>
        {subtitle && <p className="truncate text-sm text-text-2">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}
