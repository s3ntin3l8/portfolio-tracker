import { getTranslations, setRequestLocale } from "next-intl/server";
import { ArrowLeft } from "lucide-react";
import { Link, redirect } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { DraftReviewClient } from "@/components/draft-review-client";
import type { ImportDraft, ImportTargetPortfolio } from "@/components/import-flow/types";
import { loadImport, loadPortfolioList } from "@/lib/server-api";

export default async function ImportReviewPage({
  params,
}: {
  params: Promise<{ locale: string; importId: string }>;
}) {
  const { locale, importId } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("ImportHistory");

  const [detail, rawPortfolios] = await Promise.all([loadImport(importId), loadPortfolioList()]);
  // Only draft imports are reviewable; anything else (missing, confirmed, discarded)
  // goes back to the transactions page, where the import history lives.
  if (!detail || detail.status !== "draft") {
    redirect({ href: "/transactions", locale });
    return null;
  }

  const portfolios: ImportTargetPortfolio[] = rawPortfolios.map((p) => ({
    id: p.id,
    name: p.name,
    brokerage: p.brokerage,
    accountHolder: p.accountHolder,
  }));

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button
          variant="outline"
          size="icon"
          asChild
          aria-label={t("title")}
          className="rounded-xl bg-card shadow-card"
        >
          <Link href="/transactions">
            <ArrowLeft className="size-4" />
          </Link>
        </Button>
        <div>
          <h1 className="text-2xl font-bold">{t("reviewTitle")}</h1>
          <p className="text-sm text-muted-foreground">{t("reviewSubtitle")}</p>
        </div>
      </div>

      <DraftReviewClient
        importId={importId}
        initialPortfolioId={detail.portfolioId}
        drafts={detail.drafts as unknown as ImportDraft[]}
        issues={detail.errors}
        portfolios={portfolios}
      />
    </div>
  );
}
