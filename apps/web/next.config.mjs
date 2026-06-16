import { randomUUID } from "node:crypto";
import createNextIntlPlugin from "next-intl/plugin";
import withSerwistInit from "@serwist/next";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

// Service worker: precaches the Next app shell so the PWA is installable + offline-
// capable. Disabled in dev so `next dev` hot-reload isn't fighting a cache. The
// generated public/sw.js is a build artifact (gitignored). Registration is auto-injected.
// `@serwist/next` precaches build assets but not App Router page HTML, so the offline
// fallback page (referenced in src/app/sw.ts) is added explicitly; the per-build
// revision busts its cache on every deploy.
const withSerwist = withSerwistInit({
  swSrc: "src/app/sw.ts",
  swDest: "public/sw.js",
  disable: process.env.NODE_ENV !== "production",
  additionalPrecacheEntries: [{ url: "/en/offline", revision: randomUUID() }],
});

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Allow the LAN host used for dev (matches the IP in .env.local) to fetch /_next/*
  // cross-origin without the Next.js dev warning. Hostname only — no protocol/port.
  allowedDevOrigins: ["192.168.2.152"],
  // Allow importing workspace TS packages directly.
  transpilePackages: [
    "@portfolio/schema",
    "@portfolio/core",
    "@portfolio/market-data",
    "@portfolio/api-client",
  ],
};

export default withNextIntl(withSerwist(nextConfig));
