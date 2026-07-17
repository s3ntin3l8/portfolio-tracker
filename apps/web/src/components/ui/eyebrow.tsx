import { cn } from "@/lib/utils";

export function Eyebrow({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <p
      className={cn(
        "px-0.5 text-[11px] font-bold uppercase tracking-[0.06em] text-text-3",
        className,
      )}
    >
      {children}
    </p>
  );
}
