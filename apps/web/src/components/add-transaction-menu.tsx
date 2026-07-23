"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useSearchParams } from "next/navigation";
import {
  Plus,
  PenLine,
  FileSpreadsheet,
  Camera,
  ChevronLeft,
  Briefcase,
  UserPlus,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ImportFlowClient } from "@/components/import-flow-client";
import { NewEntryTabs, type NewEntryTab } from "@/components/new-entry-tabs";
import type { AddTransactionInitial } from "@/components/add-transaction-form";
import { useRouter, usePathname } from "@/i18n/navigation";
import { useApiClient } from "@/lib/api";
import { useMediaQuery } from "@/lib/use-media-query";
import type { ImportTargetPortfolio } from "@/components/import-flow/types";
import { PortfolioFormDialog } from "@/components/portfolio-form-dialog";
import { HolderFormDialog } from "@/components/holder-form-dialog";
import { PortfolioFormBody } from "@/components/portfolio-form-dialog/body";
import { HolderFormBody } from "@/components/holder-form-dialog/body";
import { MethodCard } from "@/components/add-transaction-menu/method-card";
import { loadHarvestPrefill } from "@/components/add-transaction-menu/helpers";
import { DesktopShell, type DesktopStep } from "@/components/add-transaction-menu/desktop-shell";
import { EventsTabSwitch } from "@/components/add-transaction-menu/events-tab-switch";

type EventsTab = "corporate-action" | "merger";

/** Mobile's step model plus the desktop-only rail destinations ("events" hosts the
 *  corporate-action/merger 2-way switch; "portfolio"/"holder" are the inline create
 *  forms). Mobile only ever sets the first three — see `AddTransactionMenu`. */
type Step = "choose" | "manual" | "import" | "events" | "portfolio" | "holder";

/** Entry-mode-specific dropzone copy for the import flow — see `UseImportFlowProps`. */
type ImportEntryMode = "screenshot" | "csv" | "file";

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
 * It also owns the `?harvestInstrument=`/`?entry=` deep links below, for the same
 * one-instance-reacts reason — `/transactions` and `/holdings` render a second,
 * page-local `AddTransactionMenu` alongside the shell's.
 */
export function AddTransactionMenu({
  autoOpenFromParams = false,
  isAdmin = false,
}: {
  autoOpenFromParams?: boolean;
  isAdmin?: boolean;
} = {}) {
  const tm = useTranslations("Manage");
  const ti = useTranslations("Import");
  const tca = useTranslations("CorpAction");
  const tmg = useTranslations("Merger");
  const api = useApiClient();
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const isDesktop = useMediaQuery("(min-width: 860px)");

  const [addOpen, setAddOpen] = useState(false);
  const [step, setStep] = useState<Step>("choose");
  const [portfolios, setPortfolios] = useState<ImportTargetPortfolio[] | null>(null);
  const [defaultPortfolioId, setDefaultPortfolioId] = useState("");
  const [manualDefaultTab, setManualDefaultTab] = useState<NewEntryTab>("transaction");
  // The desktop rail's "Instrument event" destination hosts its own Corp. action/Merger
  // 2-way switch (`EventsTabSwitch`) instead of `NewEntryTabs`' internal `TabsList`
  // (`hideTabList`) — this is that switch's controlled value.
  const [eventsTab, setEventsTab] = useState<EventsTab>("corporate-action");
  const [importEntryMode, setImportEntryMode] = useState<ImportEntryMode>("file");
  const [initialTransaction, setInitialTransaction] = useState<AddTransactionInitial | undefined>(
    undefined,
  );
  // Forces a fresh `NewEntryTabs` mount whenever a deep link sets a new default tab /
  // prefill: `Tabs`' `defaultValue` and the form's `initial` prop are both lazy
  // (uncontrolled) initializers, so changing them on an already-mounted instance
  // wouldn't otherwise take effect.
  const [entryNonce, setEntryNonce] = useState(0);
  // Whether at least one account holder exists — gates the "Add account holder" card.
  const [hasHolders, setHasHolders] = useState(true);
  // The mobile FAB below is portaled to `document.body` (see its render site) so its
  // `fixed` positioning isn't hijacked by the shell header's `will-change-transform`
  // (that property establishes a containing block for fixed descendants, same as an
  // actual `transform` would — it silently pinned the FAB ~112px above the header's
  // bottom edge, off the top of the viewport, ever since #532 landed). `document` is
  // unavailable during SSR, so the portal only renders once mounted client-side.
  const [mounted, setMounted] = useState(false);
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setMounted(true), []);

  // The rail's "events"/"portfolio"/"holder" destinations only exist on desktop — if the
  // viewport shrinks below 860px while one is open, fall back to the mobile chooser rather
  // than rendering a step the mobile Sheet's own branches don't know about.
  useEffect(() => {
    if (isDesktop) return;
    if (step === "events" || step === "portfolio" || step === "holder") {
      // Deriving `step` from a matchMedia breakpoint crossing, not synchronizing with an
      // external system.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setStep("choose");
    }
  }, [isDesktop, step]);

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

  // Deep links onto the manual-entry tabs: the tax page's "Harvest" CTA
  // (`?harvestInstrument=<id>` — opens a Sell draft prefilled for that instrument) and
  // bookmarked corporate-action/merger links (`?entry=corporate-action|merger`, from the
  // retired `/transactions/new` full page — see its redirect). Unlike the mount-only
  // effect above, this one is reactive to the params themselves (not `[]`): the harvest
  // CTA is a same-page `<Link>` navigation from `/tax`, which re-renders this already-
  // mounted component rather than remounting it. Depending on the extracted primitive
  // values (not the `searchParams` object) keeps this from re-firing on every render —
  // `useSearchParams()` doesn't guarantee a stable object identity across renders.
  const harvestInstrumentParam = searchParams.get("harvestInstrument");
  const entryParam = searchParams.get("entry");
  useEffect(() => {
    if (!autoOpenFromParams) return;
    if (!harvestInstrumentParam && !entryParam) return;

    let cancelled = false;
    void (async () => {
      const loaded = await loadPortfolios();
      if (cancelled) return;
      const targetPortfolioId = loaded[0]?.id ?? "";

      let targetTab: NewEntryTab = "transaction";
      if (harvestInstrumentParam) {
        const prefill = await loadHarvestPrefill(api, harvestInstrumentParam, targetPortfolioId);
        if (cancelled) return;
        setInitialTransaction(prefill ?? undefined);
        setManualDefaultTab("transaction");
      } else {
        targetTab =
          entryParam === "corporate-action" || entryParam === "merger" ? entryParam : "transaction";
        setInitialTransaction(undefined);
        setManualDefaultTab(targetTab);
      }
      setEntryNonce((n) => n + 1);
      setAddOpen(true);
      if (targetTab === "corporate-action" || targetTab === "merger") setEventsTab(targetTab);
      // On desktop, a corporate-action/merger deep link routes to the rail's "Instrument
      // event" destination instead of "Add transaction" (which is transaction-only there —
      // see `NewEntryTabs`' `visibleTabs` wiring below).
      setStep(isDesktop && targetTab !== "transaction" ? "events" : "manual");
      router.replace(pathname);
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [harvestInstrumentParam, entryParam]);

  async function loadPortfolios() {
    if (portfolios !== null) return portfolios;
    const [fetched, holders] = await Promise.all([api.listPortfolios(), api.listAccountHolders()]);
    const mapped = fetched.map((p) => ({
      id: p.id,
      name: p.name,
      brokerage: p.brokerage,
      accountHolder: p.accountHolder,
    }));
    setPortfolios(mapped);
    setDefaultPortfolioId(mapped[0]?.id ?? "");
    setHasHolders(holders.length > 0);
    return mapped;
  }

  async function openImport(entryMode: ImportEntryMode = "file") {
    await loadPortfolios();
    setImportEntryMode(entryMode);
    setAddOpen(true);
    setStep("import");
  }

  async function openManual() {
    await loadPortfolios();
    // Plain manual entry (the "Add manually" card / desktop rail's "Add transaction") always
    // starts a blank Transaction tab — reset any leftover deep-link prefill from a previous
    // open.
    setInitialTransaction(undefined);
    setManualDefaultTab("transaction");
    setEntryNonce((n) => n + 1);
    setStep("manual");
  }

  /** Desktop rail only — "Instrument event" hosts corporate-action/merger. */
  async function openEvents(tab: EventsTab = "corporate-action") {
    await loadPortfolios();
    setEventsTab(tab);
    setStep("events");
  }

  function onAddOpenChange(open: boolean) {
    setAddOpen(open);
    if (open) {
      setStep("choose");
      void loadPortfolios();
    }
  }

  /** Desktop nav-rail click → the corresponding step, reusing the same open/prefill logic
   *  the mobile chooser cards use for "import"/"manual" so behavior stays identical. */
  function onSelectDesktopStep(next: DesktopStep) {
    if (next === "import") void openImport("file");
    else if (next === "manual") void openManual();
    else if (next === "events") void openEvents();
    else setStep(next);
  }

  // Invalidates the local portfolio/holder cache after a dialog creates or edits one,
  // so the next sheet interaction re-fetches fresh data.
  function onDialogSuccess() {
    setPortfolios(null);
    setHasHolders(true);
  }

  // ---- Mobile (<860px): the existing bottom sheet, unchanged ----
  const mobileSheet = (
    <>
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
                  onClick={() => void openImport("screenshot")}
                />
                <MethodCard
                  icon={FileSpreadsheet}
                  title={tm("addMenu.csv")}
                  description={tm("addMenu.csvDesc")}
                  tone="violet"
                  onClick={() => void openImport("csv")}
                />
                <MethodCard
                  icon={PenLine}
                  title={tm("addMenu.manual")}
                  description={tm("addMenu.manualDesc")}
                  tone="gold"
                  onClick={() => void openManual()}
                />
              </div>

              <hr className="my-2 border-border" />

              <div className="flex flex-col gap-3">
                <PortfolioFormDialog
                  mode="create"
                  trigger={
                    <MethodCard
                      icon={Briefcase}
                      title={tm("addMenu.createPortfolio")}
                      description={tm("addMenu.createPortfolioDesc")}
                      tone="blue"
                    />
                  }
                  onSuccess={onDialogSuccess}
                />
                {!hasHolders && (
                  <HolderFormDialog
                    mode="create"
                    trigger={
                      <MethodCard
                        icon={UserPlus}
                        title={tm("addMenu.createAccountHolder")}
                        description={tm("addMenu.createAccountHolderDesc")}
                        tone="orange"
                      />
                    }
                    onSuccess={onDialogSuccess}
                  />
                )}
              </div>
            </div>
          ) : step === "manual" ? (
            <div className="px-5 pb-7 pt-1.5">
              {portfolios && (
                <NewEntryTabs
                  key={entryNonce}
                  portfolios={portfolios}
                  initialPortfolioId={defaultPortfolioId}
                  defaultTab={manualDefaultTab}
                  initialTransaction={initialTransaction}
                  stickyFooter
                  isAdmin={isAdmin}
                />
              )}
            </div>
          ) : (
            // Note: no nested overflow-y-auto — SheetContent is the single scroll
            // container (#472).
            <div className="px-5 pb-7 pt-1.5">
              {portfolios && (
                <ImportFlowClient
                  portfolios={portfolios}
                  defaultPortfolioId={defaultPortfolioId}
                  onClose={() => onAddOpenChange(false)}
                  entryMode={importEntryMode}
                />
              )}
            </div>
          )}
        </SheetContent>
      </Sheet>
    </>
  );

  // ---- Desktop (≥860px): centered modal, left nav rail, no chooser/back-button step ----
  const effStep: DesktopStep = step === "choose" ? "manual" : step;
  const desktopHeaderTitle =
    effStep === "manual"
      ? tm("addMenu.railAddTransaction")
      : effStep === "events"
        ? tm("addMenu.railInstrumentEvent")
        : effStep === "portfolio"
          ? tm("addMenu.createPortfolio")
          : effStep === "holder"
            ? tm("addMenu.createAccountHolder")
            : ti("title");

  const desktopContent =
    effStep === "manual" ? (
      portfolios && (
        <NewEntryTabs
          key={entryNonce}
          portfolios={portfolios}
          initialPortfolioId={defaultPortfolioId}
          defaultTab="transaction"
          initialTransaction={initialTransaction}
          stickyFooter
          isAdmin={isAdmin}
          isDesktop
          hideTabList
          visibleTabs={["transaction"]}
        />
      )
    ) : effStep === "events" ? (
      portfolios && (
        <>
          <EventsTabSwitch
            value={eventsTab}
            onChange={setEventsTab}
            labels={{ corporateAction: tca("link"), merger: tmg("link") }}
          />
          <NewEntryTabs
            key={entryNonce}
            portfolios={portfolios}
            initialPortfolioId={defaultPortfolioId}
            value={eventsTab}
            onValueChange={(tab) => setEventsTab(tab as EventsTab)}
            stickyFooter
            isAdmin={isAdmin}
            isDesktop
            hideTabList
            visibleTabs={["corporate-action", "merger"]}
          />
        </>
      )
    ) : effStep === "portfolio" ? (
      <PortfolioFormBody mode="create" onSuccess={onDialogSuccess} onDone={openManual} />
    ) : effStep === "holder" ? (
      <HolderFormBody
        mode="create"
        onSuccess={() => {
          onDialogSuccess();
          void openManual();
        }}
      />
    ) : (
      portfolios && (
        <ImportFlowClient
          portfolios={portfolios}
          defaultPortfolioId={defaultPortfolioId}
          onClose={() => onAddOpenChange(false)}
          entryMode={importEntryMode}
        />
      )
    );

  const desktopShell = (
    <DesktopShell
      open={addOpen}
      onOpenChange={onAddOpenChange}
      step={effStep}
      onSelectStep={onSelectDesktopStep}
      headerTitle={desktopHeaderTitle}
      centered={effStep !== "manual"}
      dismissible={effStep !== "import"}
      showFooter={effStep !== "import"}
      onCancel={() => onAddOpenChange(false)}
    >
      {desktopContent}
    </DesktopShell>
  );

  return (
    <>
      <Button
        aria-label={tm("addTransaction")}
        onClick={() => onAddOpenChange(true)}
        className={autoOpenFromParams ? "hidden md:inline-flex" : undefined}
      >
        <Plus className="size-4" />
        <span className="hidden sm:inline">{tm("addMenu.add")}</span>
      </Button>
      {autoOpenFromParams &&
        mounted &&
        createPortal(
          <Button
            className="fixed bottom-[calc(5rem+env(safe-area-inset-bottom))] right-6 z-40 size-14 rounded-[18px] shadow-lg md:hidden"
            aria-label={tm("addTransaction")}
            onClick={() => onAddOpenChange(true)}
          >
            <Plus className="size-6" />
          </Button>,
          document.body,
        )}
      {isDesktop ? desktopShell : mobileSheet}
    </>
  );
}
