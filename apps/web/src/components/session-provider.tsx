"use client";

import { SessionProvider } from "next-auth/react";

/** Client wrapper so `useSession()` works in client components below the tree. */
export function AuthSessionProvider({ children }: { children: React.ReactNode }) {
  return <SessionProvider>{children}</SessionProvider>;
}
