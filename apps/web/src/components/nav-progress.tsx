"use client";

import { createContext, useContext, useEffect, useMemo, useState, useCallback } from "react";
import { useLinkStatus } from "next/link";
import { cn } from "@/lib/utils";

type NavProgressContextValue = {
  /** Report a link's pending state, keyed by a caller-chosen id (so multiple links can be
   * in flight — e.g. rapid tab switching — without clobbering each other). */
  setPending: (id: string, pending: boolean) => void;
};

const NavProgressContext = createContext<NavProgressContextValue | null>(null);

/**
 * Tracks whether any tracked navigation `<Link>` is currently pending (via `useLinkStatus`)
 * and renders a thin top progress bar while one is. Mount once near the shell root;
 * `<LinkPendingSignal>` reports into it from inside each nav `<Link>`.
 */
export function NavProgressProvider({ children }: { children: React.ReactNode }) {
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());

  const setPending = useCallback((id: string, pending: boolean) => {
    setPendingIds((prev) => {
      const next = new Set(prev);
      if (pending) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const value = useMemo(() => ({ setPending }), [setPending]);
  const isPending = pendingIds.size > 0;

  return (
    <NavProgressContext.Provider value={value}>
      <div
        aria-hidden
        className={cn(
          "fixed inset-x-0 top-0 z-40 h-0.5 bg-primary transition-opacity duration-150",
          isPending ? "opacity-100" : "opacity-0",
        )}
      />
      {children}
    </NavProgressContext.Provider>
  );
}

/** Render as a child of a nav `<Link>` to feed its pending state into the progress bar —
 * `useLinkStatus` only works nested under the `Link` whose status it reports. */
export function LinkPendingSignal({ id }: { id: string }) {
  const ctx = useContext(NavProgressContext);
  const { pending } = useLinkStatus();

  useEffect(() => {
    ctx?.setPending(id, pending);
    // Clear on unmount so a link that disappears mid-navigation (e.g. active tab swap)
    // can't leave the bar stuck on.
    return () => ctx?.setPending(id, false);
  }, [ctx, id, pending]);

  return null;
}
