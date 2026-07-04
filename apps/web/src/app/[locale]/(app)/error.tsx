"use client";

import { useEffect } from "react";
import { useTranslations } from "next-intl";
import { AlertTriangle } from "lucide-react";
import { ErrorState } from "@/components/error-state";
import { Button } from "@/components/ui/button";

/**
 * Error boundary for the authenticated app. Rendered inside (app)/layout, so the shell
 * (sidebar + header) stays mounted and the next-intl provider from [locale]/layout is in
 * scope — useTranslations works. `reset()` retries the failed segment render. The digest is
 * surfaced as a copyable reference chip so a user can quote it in a support request.
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
    <ErrorState
      icon={AlertTriangle}
      tone="warn"
      eyebrow="500"
      title={t("title")}
      body={t("body")}
      code={error.digest ? `REF · ${error.digest}` : undefined}
      primary={<Button onClick={reset}>{t("retry")}</Button>}
    />
  );
}
