import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Pocket edge-state surface — the shared design for 404 / 500 / offline / session-expired /
 * empty / access-denied etc. Calm, honest, non-alarming (it's a money app). Ported from the
 * `PocketErrorFrame` design component. Presentational: callers pass `primary`/`secondary`
 * action nodes (buttons/links) so this stays server-renderable.
 *
 * `tone` tints the icon chip, eyebrow and meta dot:
 *   brand → green · warn → gold/amber · neutral → slate.
 */
export type ErrorTone = "brand" | "warn" | "neutral";

const CHIP: Record<ErrorTone, string> = {
  brand: "bg-primary/10 text-primary",
  warn: "bg-warning/10 text-warning",
  neutral: "bg-muted text-muted-foreground",
};

const FG: Record<ErrorTone, string> = {
  brand: "text-primary",
  warn: "text-warning",
  neutral: "text-muted-foreground",
};

const DOT: Record<ErrorTone, string> = {
  brand: "bg-primary",
  warn: "bg-warning",
  neutral: "bg-muted-foreground",
};

export function ErrorState({
  icon: Icon,
  tone = "brand",
  eyebrow,
  title,
  body,
  code,
  meta,
  primary,
  secondary,
  className,
}: {
  icon: LucideIcon;
  tone?: ErrorTone;
  eyebrow?: string;
  title: string;
  body: string;
  /** Monospace reference/trace chip (e.g. a 500 digest). */
  code?: string;
  /** Muted footnote preceded by a tinted dot (e.g. "Last synced 2 minutes ago"). */
  meta?: string;
  primary?: React.ReactNode;
  secondary?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "mx-auto flex max-w-md flex-col items-center justify-center gap-4 px-6 py-16 text-center",
        className,
      )}
    >
      <span
        className={cn(
          "flex size-16 items-center justify-center rounded-[20px]",
          CHIP[tone],
        )}
      >
        <Icon className="size-7" strokeWidth={1.8} />
      </span>

      {eyebrow && (
        <span
          className={cn(
            "text-[11px] font-extrabold uppercase tracking-[0.16em]",
            FG[tone],
          )}
        >
          {eyebrow}
        </span>
      )}

      <h1 className="text-balance text-2xl font-extrabold tracking-tight">{title}</h1>
      <p className="max-w-sm text-pretty text-sm leading-relaxed text-muted-foreground">
        {body}
      </p>

      {code && (
        <span className="rounded-lg bg-muted px-3 py-1.5 font-mono text-xs text-muted-foreground">
          {code}
        </span>
      )}

      {meta && (
        <span className="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
          <span className={cn("size-1.5 rounded-full opacity-75", DOT[tone])} />
          {meta}
        </span>
      )}

      {(primary || secondary) && (
        <div className="mt-2 flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:justify-center">
          {primary}
          {secondary}
        </div>
      )}
    </div>
  );
}
