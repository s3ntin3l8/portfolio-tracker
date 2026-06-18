"use client";

import { useState } from "react";
import { Plus, PenLine, FileUp } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ImportFlowClient } from "@/components/import-flow-client";
import { Link } from "@/i18n/navigation";
import { useApiClient } from "@/lib/api";
import type { ImportTargetPortfolio } from "@/components/import-flow";

export function AddTransactionMenu() {
  const tm = useTranslations("Manage");
  const ti = useTranslations("Import");
  const api = useApiClient();

  const [importOpen, setImportOpen] = useState(false);
  const [portfolios, setPortfolios] = useState<ImportTargetPortfolio[] | null>(null);
  const [defaultPortfolioId, setDefaultPortfolioId] = useState("");

  async function openImport() {
    if (portfolios === null) {
      const fetched = await api.listPortfolios();
      const mapped = fetched.map((p) => ({ id: p.id, name: p.name }));
      setPortfolios(mapped);
      setDefaultPortfolioId(mapped[0]?.id ?? "");
    }
    setImportOpen(true);
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button>
            <Plus className="size-4" />
            {tm("addTransaction")}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem asChild>
            <Link href="/transactions/new">
              <PenLine className="size-4" />
              {ti("menu.manual")}
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void openImport()}>
            <FileUp className="size-4" />
            {ti("menu.import")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Sheet open={importOpen} onOpenChange={setImportOpen}>
        <SheetContent className="p-0" side="bottom">
          <SheetHeader className="px-6 pt-6">
            <SheetTitle>{ti("title")}</SheetTitle>
          </SheetHeader>
          <div className="overflow-y-auto px-6 pb-6 pt-4">
            {portfolios && (
              <ImportFlowClient
                portfolios={portfolios}
                defaultPortfolioId={defaultPortfolioId}
              />
            )}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
