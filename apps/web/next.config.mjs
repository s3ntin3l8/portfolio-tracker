import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Allow importing workspace TS packages directly.
  transpilePackages: [
    "@portfolio/schema",
    "@portfolio/core",
    "@portfolio/market-data",
    "@portfolio/api-client",
  ],
};

export default withNextIntl(nextConfig);
