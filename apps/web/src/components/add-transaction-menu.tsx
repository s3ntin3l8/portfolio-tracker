"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Plus, PenLine, FileSpreadsheet, Camera, ChevronLeft } from "lucide-react";
import { useTranslations } from "next-intl";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ImportFlowClient } from "@/components/import-flow-client";
import { NewEntryTabs } from "@/components/new-entry-tabs";
import { useRouter, usePathname } from "@/i18n/navigation";
import { useApiClient } from "@/lib/api";
import type { ImportTargetPortfolio } from "@/components/import-flow";

/**
 * The unified add-entry launcher, transcribed from `Pocket Prototype.dc.html`'s
 * ADD / IMPORT bottom sheet: step 1 offers "Snap a screenshot" / "Import a CSV" /
 * "Add manually" method cards; "Add manually" swaps the sheet content (with a back
 * button) to the Transaction / Corporate action / Merger entry tabs. Screenshot and
 * CSV both feed the same unified import flow.
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
  const api = useApiClient();
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const [addOpen, setAddOpen] = useState(false);
  const [step, setStep] = useState<"choose" | "manual" | "import">("choose");
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

  async function loadPortfolios() {
    if (portfolios !== null) return portfolios;
    const fetched = await api.listPortfolios();
    const mapped = fetched.map((p) => ({
      id: p.id,
      name: p.name,
      brokerage: p.brokerage,
      accountHolder: p.accountHolder,
    }));
    setPortfolios(mapped);
    setDefaultPortfolioId(mapped[0]?.id ?? "");
    return mapped;
  }

  async function openImport() {
    await loadPortfolios();
    setAddOpen(true);
    setStep("import");
  }

  async function openManual() {
    await loadPortfolios();
    setStep("manual");
  }

  function onAddOpenChange(open: boolean) {
    setAddOpen(open);
    if (open) {
      setStep("choose");
      void loadPortfolios();
    }
  }

  return (
    <>
      <Button aria-label={tm("addTransaction")} onClick={() => onAddOpenChange(true)}>
        <Plus className="size-4" />
        <span className="hidden sm:inline">{tm("addMenu.add")}</span>
      </Button>

      {/* One sheet, three steps (choose/manual/import) swapped via `step` — swapping content
          in place (rather than closing this sheet and opening a second `Drawer.Root`) avoids
          a vaul body-scroll-lock race that left the import step unopenable (#471). Not
          drag/outside/blur-dismissible while importing: a mid-import swipe must not discard
          the flow. `handleOnly`: the manual step's form scrolls, so drag-to-close is
          restricted to the handle rather than the whole content surface fighting the
          form's own scroll (#472). */}
      <Sheet
        open={addOpen}
        onOpenChange={onAddOpenChange}
        dismissible={step !== "import"}
        handleOnly
      >
        <SheetContent className={step === "import" ? "max-w-3xl" : undefined}>
          <SheetHeader className="sticky top-0 z-[2] flex-row items-center gap-2.5 bg-background px-5 pb-3 pt-3">
            {step !== "choose" && (
              <button
                type="button"
                onClick={() => setStep("choose")}
                aria-label={tm("back")}
                className="flex size-[34px] shrink-0 items-center justify-center rounded-[11px] bg-card text-foreground shadow-[0_1px_2px_rgba(15,27,20,.08)]"
              >
                <ChevronLeft className="size-[18px]" strokeWidth={2.2} />
              </button>
            )}
            <SheetTitle className="flex-1">
              {step === "import" ? ti("title") : tm("addMenu.title")}
            </SheetTitle>
            {/* spacer so the title clears the built-in close button */}
            <span className="w-[34px] shrink-0" aria-hidden />
          </SheetHeader>

          {step === "choose" ? (
            <div className="px-5 pb-7 pt-1.5">
              <p className="mx-0.5 mb-3.5 text-[13px] font-medium text-text-2">
                {tm("addMenu.subtitle")}
              </p>
              <div className="flex flex-col gap-3">
                <MethodCard
                  icon={Camera}
                  title={tm("addMenu.screenshot")}
                  description={tm("addMenu.screenshotDesc")}
                  tone="green"
                  tag={tm("addMenu.recommended")}
                  onClick={() => void openImport()}
                />
                <MethodCard
                  icon={FileSpreadsheet}
                  title={tm("addMenu.csv")}
                  description={tm("addMenu.csvDesc")}
                  tone="violet"
                  onClick={() => void openImport()}
                />
                <MethodCard
                  icon={PenLine}
                  title={tm("addMenu.manual")}
                  description={tm("addMenu.manualDesc")}
                  tone="gold"
                  onClick={() => void openManual()}
                />
              </div>
            </div>
          ) : step === "manual" ? (
            <div className="px-5 pb-7 pt-1.5">
              {portfolios && (
                <NewEntryTabs
                  portfolios={portfolios}
                  initialPortfolioId={defaultPortfolioId}
                  stickyFooter
                />
              )}
            </div>
          ) : (
            <div className="overflow-y-auto px-5 pb-7 pt-1.5">
              {portfolios && (
                <ImportFlowClient
                  portfolios={portfolios}
                  defaultPortfolioId={defaultPortfolioId}
                  onClose={() => onAddOpenChange(false)}
                />
              )}
            </div>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}

// Reference `methodCards` tones: screenshot green, CSV violet, manual gold.
const TONES = {
  green: { bg: "rgba(16,163,114,.14)", fg: "#0E9F6E" },
  violet: { bg: "rgba(124,92,252,.16)", fg: "#7C5CFC" },
  gold: { bg: "rgba(224,165,58,.16)", fg: "var(--gold-fg)" },
} as const;

/** One step-1 method card — icon chip 46px r14, title 700 15px, desc 500 12px,
 *  optional 700 9px "Recommended" tag; card r18 p16 bg-card + border. */
function MethodCard({
  icon: Icon,
  title,
  description,
  tone,
  tag,
  onClick,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  tone: keyof typeof TONES;
  tag?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-3.5 rounded-[18px] border border-border bg-card p-4 text-left shadow-[0_1px_2px_rgba(15,27,20,.04)] transition-transform active:scale-[.97]"
    >
      <span
        className="flex size-[46px] shrink-0 items-center justify-center rounded-[14px]"
        style={{ background: TONES[tone].bg, color: TONES[tone].fg }}
      >
        <Icon className="size-[23px]" strokeWidth={1.9} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] font-bold">{title}</span>
        <span className="mt-[3px] block text-xs font-medium leading-[1.4] text-text-2">
          {description}
        </span>
      </span>
      {tag && (
        <span className="shrink-0 rounded-[7px] bg-[rgba(16,163,114,.14)] px-2 py-1 text-[9px] font-bold text-[#0E9F6E]">
          {tag}
        </span>
      )}
    </button>
  );
}
