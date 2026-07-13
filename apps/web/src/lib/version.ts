// App version, inlined at build time from the repo root `package.json` (see
// `NEXT_PUBLIC_APP_VERSION` in next.config.mjs). That's the version Release Please bumps
// and the one the `v*` release tag matches — NOT the (unrelated, untracked) version field
// in this workspace's own package.json.
export const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? "dev";

export function releaseUrl(version: string): string {
  return `https://github.com/s3ntin3l8/pocket-portfolio-tracker/releases/tag/v${version}`;
}
