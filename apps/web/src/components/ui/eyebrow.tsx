import { cn } from "@/lib/utils";

export function Eyebrow({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span className={cn("text-xs uppercase tracking-wider text-muted-foreground", className)}>
      {children}
    </span>
  );
}
