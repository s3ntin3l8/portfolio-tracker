import { getTranslations, setRequestLocale } from "next-intl/server";
import { Upload } from "lucide-react";
import { ImportFlowClient } from "@/components/import-flow-client";
import { CreatePortfolio } from "@/components/create-portfolio";
import { EmptyState } from "@/components/empty-state";
import { resolveSelection } from "@/lib/server-api";

export default async function ImportPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("Import");
  const te = await getTranslations("Empty");
  const tm = await getTranslations("Manage");

  const selection = await resolveSelection();
  const isEmpty =
    selection.status === "ok" && selection.portfolios.length === 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">
          {isEmpty ? tm("portfolio.needFirst") : t("subtitle")}
        </p>
      </div>

      {selection.status === "unavailable" ? (
        <EmptyState
          icon={Upload}
          title={te("unavailableTitle")}
          description={te("unavailableBody")}
        />
      ) : isEmpty ? (
        <CreatePortfolio />
      ) : (
        <ImportFlowClient
          portfolios={selection.portfolios.map((p) => ({
            id: p.id,
            name: p.name,
          }))}
          defaultPortfolioId={
            selection.selectedId ?? selection.portfolios[0].id
          }
        />
      )}
    </div>
  );
}
