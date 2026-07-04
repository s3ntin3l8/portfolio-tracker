import { ChevronLeft } from "lucide-react";
import { Link } from "@/i18n/navigation";

/**
 * Section title used by every Settings/Admin sub-route's content. On mobile it's a
 * back-arrow + title row (the rail is hidden there, so this is the only way back to the
 * section's landing menu); on desktop the rail is always visible so just the plain title
 * is shown, with no back-link. Shared by `/settings/*` and `/admin/*` (see
 * `SettingsShell`) so every section reads consistently regardless of which tree it's in.
 */
export function SectionHeader({ title, backHref }: { title: string; backHref: string }) {
  return (
    <div className="mb-4">
      <div className="flex items-center gap-3 md:hidden">
        <Link
          href={backHref}
          aria-label="Back"
          className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-border bg-card text-foreground shadow-sm"
        >
          <ChevronLeft className="size-[18px]" />
        </Link>
        <h1 className="text-xl font-extrabold tracking-tight">{title}</h1>
      </div>
      <h1 className="hidden text-2xl font-extrabold tracking-tight md:block">{title}</h1>
    </div>
  );
}
