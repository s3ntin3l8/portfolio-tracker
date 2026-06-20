"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Plus, PenLine, FileUp, GitBranch, GitMerge } from "lucide-react";
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
import { Link, useRouter, usePathname } from "@/i18n/navigation";
import { useApiClient } from "@/lib/api";
import type { ImportTargetPortfolio } from "@/components/import-flow";

/**
 * The unified add-entry menu (Manual / Import / Corporate action). Rendered globally in
 * the app-shell header (so it's reachable from every screen) and also inline in some
 * empty states.
 *
 * `autoOpenFromParams` must be set on exactly ONE rendered instance per page — the global
 * shell instance. It owns the `?shared=1` / `?import=1` auto-open (PWA share-target and
 * shortcut). If two instances auto-opened, their `ImportFlowClient` mounts would race to
 * consume and clear the cached screenshot, so every inline instance leaves it `false`.
 */
export function AddTransactionMenu({
  autoOpenFromParams = false,
}: {
  autoOpenFromParams?: boolean;
} = {}) {
  const tm = useTranslations("Manage");
  const ti = useTranslations("Import");
  const tca = useTranslations("CorpAction");
  const tmg = useTranslations("Merger");
  const api = useApiClient();
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const [importOpen, setImportOpen] = useState(false);
  const [portfolios, setPortfolios] = useState<ImportTargetPortfolio[] | null>(null);
  const [defaultPortfolioId, setDefaultPortfolioId] = useState("");

  // A screenshot shared into the app lands on /transactions?shared=1 (see sw.ts); the
  // "Import screenshot" PWA shortcut lands on ?import=1. Either auto-opens the import sheet
  // — but only on the single instance that owns this (see the prop doc above).
  useEffect(() => {
    if (!autoOpenFromParams) return;
    const shared = searchParams.get("shared") === "1";
    const importFlag = searchParams.get("import") === "1";
    if (shared || importFlag) void openImport();
    // `shared` is consumed + cleared by ImportFlowClient once it mounts (it needs the
    // param to fetch the cached image first); clear the bare `import` flag here so a
    // refresh doesn't re-open the sheet.
    if (importFlag && !shared) router.replace(pathname);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function openImport() {
    if (portfolios === null) {
      const fetched = await api.listPortfolios();
      const mapped = fetched.map((p) => ({
        id: p.id,
        name: p.name,
        brokerage: p.brokerage,
        accountHolder: p.accountHolder,
      }));
      setPortfolios(mapped);
      setDefaultPortfolioId(mapped[0]?.id ?? "");
    }
    setImportOpen(true);
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button aria-label={tm("addTransaction")}>
            <Plus className="size-4" />
            <span className="hidden sm:inline">{tm("addTransaction")}</span>
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
          <DropdownMenuItem asChild>
            <Link
              href={{
                pathname: "/transactions/new",
                query: { kind: "corporate-action" },
              }}
            >
              <GitBranch className="size-4" />
              {tca("link")}
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link
              href={{
                pathname: "/transactions/new",
                query: { kind: "merger" },
              }}
            >
              <GitMerge className="size-4" />
              {tmg("link")}
            </Link>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Sheet open={importOpen} onOpenChange={setImportOpen}>
        <SheetContent
          className="p-0"
          side="bottom"
          onInteractOutside={(e) => e.preventDefault()}
          onPointerDownOutside={(e) => e.preventDefault()}
        >
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
