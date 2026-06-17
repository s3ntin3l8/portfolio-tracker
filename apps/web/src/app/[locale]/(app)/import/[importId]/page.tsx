import { getTranslations, setRequestLocale } from "next-intl/server";
import { ArrowLeft } from "lucide-react";
import { Link, redirect } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { DraftReviewClient } from "@/components/draft-review-client";
import type { ImportDraft } from "@/components/import-flow";
import { loadImport } from "@/lib/server-api";

export default async function ImportReviewPage({
  params,
}: {
  params: Promise<{ locale: string; importId: string }>;
}) {
  const { locale, importId } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("ImportHistory");

  const detail = await loadImport(importId);
  // Only draft imports are reviewable; anything else (missing, confirmed, discarded)
  // goes back to the import history.
  if (!detail || detail.status !== "draft") {
    redirect({ href: "/import", locale });
    return null;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" asChild aria-label={t("title")}>
          <Link href="/import">
            <ArrowLeft className="size-4" />
          </Link>
        </Button>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {t("reviewTitle")}
          </h1>
          <p className="text-sm text-muted-foreground">{t("reviewSubtitle")}</p>
        </div>
      </div>

      <DraftReviewClient
        importId={importId}
        drafts={detail.drafts as unknown as ImportDraft[]}
        issues={detail.errors}
      />
    </div>
  );
}
