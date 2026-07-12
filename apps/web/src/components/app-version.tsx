import { APP_VERSION, releaseUrl } from "@/lib/version";

/**
 * Small muted "vX.Y.Z" label linking out to the GitHub release for the running build.
 * No hooks/state, so it renders fine from either a server or a client component — callers
 * supply the (already-translated) `ariaLabel` since they own their own next-intl namespace.
 * Falls back to plain, unlinked text when no version was injected at build time (local dev
 * without the env var, or a build that skipped `NEXT_PUBLIC_APP_VERSION`).
 */
export function AppVersion({
  ariaLabel,
  className = "text-xs text-muted-foreground",
}: {
  ariaLabel: string;
  className?: string;
}) {
  if (APP_VERSION === "dev") {
    return <span className={className}>v{APP_VERSION}</span>;
  }

  return (
    <a
      href={releaseUrl(APP_VERSION)}
      target="_blank"
      rel="noreferrer"
      aria-label={ariaLabel}
      className={className}
    >
      v{APP_VERSION} ↗
    </a>
  );
}
