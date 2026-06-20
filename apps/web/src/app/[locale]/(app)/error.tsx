"use client";

import { useEffect } from "react";
import { useTranslations } from "next-intl";
import { AlertCircle } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";

/**
 * Error boundary for the authenticated app. Rendered inside (app)/layout, so the shell
 * (sidebar + header) stays mounted and the next-intl provider from [locale]/layout is in
 * scope — useTranslations works. `reset()` retries the failed segment render.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations("Error");

  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <EmptyState
      icon={AlertCircle}
      title={t("title")}
      description={t("body")}
      action={<Button onClick={reset}>{t("retry")}</Button>}
    />
  );
}
