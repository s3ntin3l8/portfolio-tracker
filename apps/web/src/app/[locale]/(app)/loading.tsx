import { Skeleton } from "@/components/ui/skeleton";

/** Skeleton shown while an (app) route segment streams in; keeps the shell mounted. */
export default function Loading() {
  return (
    <div className="space-y-6" aria-hidden>
      <Skeleton className="h-8 w-48" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-28 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-64 rounded-xl" />
    </div>
  );
}
