import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    accessToken?: string;
    /** Set when token refresh fails — the UI should prompt a fresh sign-in. */
    error?: string;
    user: DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    accessToken?: string;
    refreshToken?: string;
    /** Absolute access-token expiry, unix seconds. */
    expiresAt?: number;
    error?: string;
  }
}
