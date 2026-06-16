import { getTranslations, setRequestLocale } from "next-intl/server";
import { Plus, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ImportFlowClient } from "@/components/import-flow-client";
import { ImportHistory } from "@/components/import-history";
import { PortfolioFormDialog } from "@/components/portfolio-form-dialog";
import { EmptyState } from "@/components/empty-state";
import { resolveSelection, loadImports } from "@/lib/server-api";

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
  const tf = await getTranslations("PortfolioForm");

  const selection = await resolveSelection();
  const isEmpty =
    selection.status === "ok" && selection.portfolios.length === 0;
  const imports = isEmpty ? [] : await loadImports();

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
        <PortfolioFormDialog
          mode="create"
          trigger={
            <Button>
              <Plus className="size-4" />
              {tf("new")}
            </Button>
          }
        />
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

      {imports.length > 0 && <ImportHistory items={imports} />}
    </div>
  );
}
