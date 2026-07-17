"use client";

import { toast } from "sonner";
import { classifyImportError, importErrorDetail } from "@/lib/import-errors";
import type { GroupMap } from "../types";

type TFunction = (key: string, params?: Record<string, string | number>) => string;

export function errorMessage(err: unknown, t: TFunction): string {
  const info = classifyImportError(err);
  const detail = info.reason === "generic" ? importErrorDetail(info) : null;
  return detail
    ? t("errors.genericDetailed", { detail })
    : t(`errors.${info.reason}`, { provider: info.provider ?? "" });
}

export function taskLabel(groups: GroupMap, t: TFunction): string {
  const names = Array.from(groups.values());
  if (names.length === 1) return names[0] ?? "";
  return t("toast.filesLabel", { count: names.length });
}

export function notifyMaterialized(
  count: number,
  router: { refresh: () => void; push: (href: string) => void },
  t: TFunction,
) {
  router.refresh();
  toast.success(t("toast.success", { count }), {
    action: {
      label: t("toast.viewTransactions"),
      onClick: () => router.push("/transactions"),
    },
  });
}
