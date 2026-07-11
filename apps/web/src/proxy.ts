import createMiddleware from "next-intl/middleware";
import { NextResponse, type NextRequest } from "next/server";
import { routing } from "./i18n/routing";

const intlMiddleware = createMiddleware(routing);

function splitCsv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function hostName(value: string): string | null {
  try {
    const url = value.includes("://") ? new URL(value) : new URL(`http://${value}`);
    return url.hostname.toLowerCase();
  } catch {
    return null;
  }
}

function configuredAllowedHosts(): Set<string> {
  const hosts = new Set<string>();
  for (const entry of splitCsv(process.env.WEB_ALLOWED_HOSTS)) {
    const host = hostName(entry);
    if (host) hosts.add(host);
  }
  const authHost = process.env.AUTH_URL ? hostName(process.env.AUTH_URL) : null;
  if (authHost) hosts.add(authHost);
  return hosts;
}

function isLocalHost(host: string): boolean {
  return (
    host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "::1"
  );
}

export function isAllowedHost(hostHeader: string | null): boolean {
  const host = hostHeader ? hostName(hostHeader) : null;
  if (!host) return false;
  if (configuredAllowedHosts().has(host)) return true;
  return process.env.NODE_ENV !== "production" && isLocalHost(host);
}

export function bypassI18n(pathname: string): boolean {
  return pathname === "/api/auth" || pathname.startsWith("/api/auth/");
}

export default function proxy(request: NextRequest) {
  if (!isAllowedHost(request.headers.get("host"))) {
    return new NextResponse("Misdirected Request", { status: 421 });
  }
  if (bypassI18n(request.nextUrl.pathname)) {
    return NextResponse.next();
  }
  return intlMiddleware(request);
}

export const config = {
  // Match app pathnames plus Auth.js API routes so the host guard covers callbacks.
  matcher: ["/api/auth/:path*", "/((?!api|_next|_vercel|.*\\..*).*)"],
};
