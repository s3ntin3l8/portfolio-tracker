"use client";

import { useTranslations } from "next-intl";
import type { AdminProviderUsage } from "@portfolio/api-client";

export function UsageCell({ usage }: { usage: AdminProviderUsage | null | undefined }) {
  const t = useTranslations("Admin");
  if (!usage || usage.used === null) {
    return <span className="text-muted-foreground">—</span>;
  }
  const window = {
    minute: t("usageMinute"),
    day: t("usageDay"),
    month: t("usageMonth"),
  }[usage.window];
  const used = usage.used.toLocaleString();
  const text =
    usage.limit !== null
      ? t("usageUsedOfLimit", { used, limit: usage.limit.toLocaleString(), window })
      : t("usageUsed", { used, window });
  return (
    <span className="text-xs tabular-nums text-muted-foreground">
      {text}
      {usage.source === "local" && ` (${t("usageLocalHint")})`}
    </span>
  );
}
