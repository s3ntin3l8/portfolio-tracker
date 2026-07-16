import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import createNextIntlPlugin from "next-intl/plugin";
import withSerwistInit from "@serwist/next";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

// The app's version label reads the *root* package.json (what Release Please bumps and
// what the `v*` release tag matches) — not this workspace's own package.json, which isn't
// tracked by Release Please and only coincidentally carries the same number.
const rootPkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));

// Service worker: precaches the Next app shell so the PWA is installable + offline-
// capable. Disabled in dev so `next dev` hot-reload isn't fighting a cache. The
// generated public/sw.js is a build artifact (gitignored). `@serwist/next` precaches
// build assets but not App Router page HTML, so the offline fallback page (referenced in
// src/app/sw.ts) is added explicitly; the per-build revision busts its cache on every
// deploy. Registration is manual (`register: false`) — see PwaUpdater — so we can hold a
// new worker in "waiting" and prompt the user to reload instead of updating silently.
const withSerwist = withSerwistInit({
  swSrc: "src/app/sw.ts",
  swDest: "public/sw.js",
  disable: process.env.NODE_ENV !== "production",
  register: false,
  additionalPrecacheEntries: [{ url: "/en/offline", revision: randomUUID() }],
});

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Standalone build for Docker (apps/web/Dockerfile): emits .next/standalone with a
  // minimal, self-contained server.js + only the node_modules actually reachable from
  // this app's trace, instead of shipping the whole workspace node_modules.
  output: "standalone",
  // REQUIRED in this npm-workspaces monorepo: without an explicit root, Next's file
  // tracing can't correctly resolve the workspace `@portfolio/*` packages (consumed via
  // node_modules symlinks back into packages/*/dist) and the standalone output silently
  // ends up missing files. Must point at the actual monorepo root (two levels up from
  // this config file), not `process.cwd()` (which varies depending on how the build is
  // invoked — directly here vs. via `turbo run build` from the repo root).
  outputFileTracingRoot: fileURLToPath(new URL("../../", import.meta.url)),
  // Allow the LAN host used for dev (matches the IP in .env.local) to fetch /_next/*
  // cross-origin without the Next.js dev warning. Hostname only — no protocol/port.
  allowedDevOrigins: ["192.168.2.152"],
  // Inlined at build time (dev and prod) so the running app can display its own version —
  // non-secret, just the release number. Read from the root package.json; see rootPkg above.
  env: { NEXT_PUBLIC_APP_VERSION: rootPkg.version },
  // Allow importing workspace TS packages directly.
  transpilePackages: [
    "@portfolio/schema",
    "@portfolio/core",
    "@portfolio/market-data",
    "@portfolio/api-client",
  ],
  // Baseline security headers (pre-internet-exposure hardening).
  async headers() {
    // Report-only for now, deliberately: a strict CSP on Next + next-intl + serwist can
    // break real functionality (next-themes' inline FOUC-prevention <script>, Radix UI's
    // inline style attrs) without nonce wiring. This surfaces violations in the browser
    // console/devtools Reports tab without blocking anything — exercise every screen
    // (login, PWA install, share-target, charts) against it, tune, THEN promote to an
    // enforcing `Content-Security-Policy` header in a follow-up change.
    //
    // `connect-src 'self'` is only viable now that the browser talks to the API through
    // the same-origin proxy (app/api/backend/[...path]/route.ts) instead of a separate
    // NEXT_PUBLIC_API_URL origin — see the security-hardening plan's Part B.
    const csp = [
      "default-src 'self'",
      // 'unsafe-inline' on script-src is the known gap here: next-themes' FOUC-prevention
      // script (see CLAUDE.md) is a genuine inline <script>, not a hydration data blob.
      // Tighten this to a nonce once the report-only period confirms nothing else needs it.
      "script-src 'self' 'unsafe-inline'",
      // Tailwind/shadcn + Radix UI both rely on inline style attributes at runtime.
      "style-src 'self' 'unsafe-inline'",
      // data:/blob: for uploaded-screenshot previews and canvas-rendered chart exports;
      // img.logo.dev for hotlinked company/crypto logos (instrument-logo.tsx).
      "img-src 'self' data: blob: https://img.logo.dev",
      "font-src 'self' data:",
      "connect-src 'self'",
      "worker-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join("; ");

    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          // Also covered by the CSP's frame-ancestors (once enforced); kept here as its
          // own backstop since it's supported more broadly (older/non-CSP clients) and is
          // actively enforced today, unlike the report-only CSP above.
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // 2 years, subdomains included — long-lived HSTS is only safe to set once TLS is
          // confirmed working everywhere this host (and its subdomains) is ever served from.
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains",
          },
          { key: "Content-Security-Policy-Report-Only", value: csp },
        ],
      },
    ];
  },
};

export default withNextIntl(withSerwist(nextConfig));
