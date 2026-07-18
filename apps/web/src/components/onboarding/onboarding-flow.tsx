"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useTheme } from "next-themes";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import type { Portfolio } from "@portfolio/api-client";
import { useApiClient } from "@/lib/api";
import { useRouter } from "@/i18n/navigation";
import { Spinner } from "@/components/ui/spinner";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ImportTasksProvider } from "@/components/import-tasks-provider";
import { ImportFlowClient } from "@/components/import-flow-client";
import { NewEntryTabs } from "@/components/new-entry-tabs";
import { Icon, ICONS } from "./icon";
import { resolveTheme } from "./theme";
import { BrandPanel } from "./brand-panel";
import { MobileBackdrop } from "./mobile-backdrop";
import { MobileIntro } from "./mobile-intro";
import { ThemeTogglePill } from "./theme-toggle-pill";
import { WelcomeStep } from "./steps/welcome-step";
import { HolderStep } from "./steps/holder-step";
import { TaxStep } from "./steps/tax-step";
import { PortfolioStep } from "./steps/portfolio-step";
import { AddDataStep, type AddDataCardKey } from "./steps/add-data-step";
import { AddDataTrConnect } from "./steps/add-data-tr";
import { DoneStep } from "./steps/done-step";
import styles from "./onboarding.module.css";

const CURRENT_YEAR = new Date().getFullYear();

type AddDataView = "cards" | "tr";

interface FieldErrors {
  holderName?: string;
  birthYear?: string;
  portfolioName?: string;
}

/** Client-side onboarding flow — ported 1:1 from the `Onboarding.dc.html` design
 *  (see the plan for the full fidelity notes). This component owns the whole
 *  step machine, theme resolution, the mobile intro carousel, and the real API
 *  wiring for holder/portfolio creation and the add-data sub-flows. */
export function OnboardingFlow() {
  const t = useTranslations("Onboarding");
  const api = useApiClient();
  const router = useRouter();
  const { resolvedTheme, setTheme } = useTheme();

  // Mount guard mirrors `theme-toggle.tsx` — avoids an SSR/client theme mismatch;
  // defaults dark (matches the design's own default theme).
  const [mounted, setMounted] = useState(false);
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setMounted(true), []);
  const isDark = mounted ? resolvedTheme === "dark" : true;

  // Desktop/mobile breakpoint (900px), synced on resize — default true (desktop) so
  // server and first client render agree; corrected right after mount, same pattern
  // as the design's own `componentDidMount` resize sync.
  const [isDesktop, setIsDesktop] = useState(true);
  useEffect(() => {
    const sync = () => setIsDesktop(window.innerWidth >= 900);
    sync();
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, []);

  const [step, setStep] = useState(0);
  const [taxRegime, setTaxRegime] = useState<"DE" | "ID">("DE");
  const [currency, setCurrency] = useState("EUR");
  const [cashCounted, setCashCounted] = useState(false);
  const [brokerageValue, setBrokerageValue] = useState("");
  const [brokerageOpen, setBrokerageOpen] = useState(false);
  const [mIntroDone, setMIntroDone] = useState(false);
  const [mSlide, setMSlide] = useState(0);

  const [holderName, setHolderName] = useState("");
  const [birthYear, setBirthYear] = useState("");
  const [portfolioName, setPortfolioName] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});

  const [creating, setCreating] = useState(false);
  const [createdHolderId, setCreatedHolderId] = useState<string | null>(null);
  const [createdPortfolio, setCreatedPortfolio] = useState<Portfolio | null>(null);
  const [addDataView, setAddDataView] = useState<AddDataView>("cards");
  const [importOpen, setImportOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [exiting, setExiting] = useState(false);

  const th = resolveTheme(isDark, isDesktop);
  const isDone = step === 5;
  const showChrome = !isDone;
  const showBack = step > 0 && step < 5 && !(step === 4 && addDataView !== "cards");
  const showPrimaryCta = step < 4;

  const stepMetaByIndex = [
    t("steps.welcome.title"),
    t("steps.holder.title"),
    t("steps.tax.title"),
    t("steps.portfolio.title"),
    t("steps.addData.title"),
    "",
  ];
  const stepKickerByIndex = [
    t("steps.welcome.kicker"),
    t("steps.holder.kicker"),
    t("steps.tax.kicker"),
    t("steps.portfolio.kicker"),
    t("steps.addData.kicker"),
    "",
  ];
  const stepSubByIndex = [
    t("steps.welcome.sub"),
    t("steps.holder.sub"),
    t("steps.tax.sub"),
    t("steps.portfolio.sub"),
    t("steps.addData.sub"),
    "",
  ];

  const brandByIndex = [
    { h: t("brand.welcome.headline"), s: t("brand.welcome.sub") },
    { h: t("brand.holder.headline"), s: t("brand.holder.sub") },
    { h: t("brand.tax.headline"), s: t("brand.tax.sub") },
    { h: t("brand.portfolio.headline"), s: t("brand.portfolio.sub") },
    { h: t("brand.addData.headline"), s: t("brand.addData.sub") },
    { h: t("brand.done.headline"), s: t("brand.done.sub") },
  ];

  const brandBullets = useMemo(() => {
    switch (step) {
      case 0:
        return t.raw("brand.welcome.bullets") as string[];
      case 1:
        return t.raw("brand.holder.bullets") as string[];
      case 2:
        return [
          taxRegime === "DE" ? t("brand.tax.bulletDe") : t("brand.tax.bulletId"),
          t("brand.tax.bulletChange"),
        ];
      case 3:
        return [
          t("brand.portfolio.bulletCurrency"),
          cashCounted ? t("brand.portfolio.bulletCashIn") : t("brand.portfolio.bulletCashOut"),
          t("brand.portfolio.bulletBrokerage"),
        ];
      case 4:
        return t.raw("brand.addData.bullets") as string[];
      case 5:
        return [t("brand.done.bullet")];
      default:
        return [];
    }
  }, [step, taxRegime, cashCounted, t]);

  const primaryCtaLabel = [
    t("primaryCta.getStarted"),
    t("primaryCta.continue"),
    t("primaryCta.continue"),
    t("primaryCta.createPortfolio"),
    "",
    "",
  ][step];

  // The toggle's label is the *action* — the opposite of the current theme.
  const themeToggleLabel = isDark ? t("themeLight") : t("themeDark");

  const stepTitle = stepMetaByIndex[step];
  const brandContent = brandByIndex[step];

  function validateHolderStep(): boolean {
    const errs: FieldErrors = {};
    if (!holderName.trim()) errs.holderName = t("holder.nameRequired");
    if (birthYear.trim()) {
      const y = Number(birthYear);
      if (!Number.isInteger(y) || y < 1900 || y > CURRENT_YEAR) {
        errs.birthYear = t("holder.birthYearInvalid", { min: 1900, max: CURRENT_YEAR });
      }
    }
    setErrors(errs);
    return Object.keys(errs).length === 0;
  }

  function validatePortfolioStep(): boolean {
    const errs: FieldErrors = {};
    if (!portfolioName.trim()) errs.portfolioName = t("portfolio.nameRequired");
    setErrors(errs);
    return Object.keys(errs).length === 0;
  }

  async function commitPortfolio() {
    setCreating(true);
    try {
      let holderId = createdHolderId;
      const holderInput = {
        name: holderName.trim(),
        birthYear: birthYear.trim() ? Number(birthYear) : null,
      };
      if (holderId) {
        await api.updateAccountHolder(holderId, holderInput);
      } else {
        const holder = await api.createAccountHolder({ ...holderInput, type: "self" });
        holderId = holder.id;
        setCreatedHolderId(holder.id);
      }
      await api.putPreferences({ taxRegime });
      const portfolioInput = {
        name: portfolioName.trim(),
        brokerage: brokerageValue.trim() || null,
        baseCurrency: currency,
        cashCounted,
        accountHolderId: holderId,
        includeInAggregate: true,
        allowNegativeCash: false,
        documentRetention: false,
      };
      const portfolio = createdPortfolio
        ? await api.updatePortfolio(createdPortfolio.id, portfolioInput)
        : await api.createPortfolio(portfolioInput);
      setCreatedPortfolio(portfolio);
      setStep(4);
    } catch {
      toast.error(t("portfolio.createError"));
    } finally {
      setCreating(false);
    }
  }

  function handlePrimaryCta() {
    if (creating) return;
    if (step === 1) {
      if (!validateHolderStep()) return;
      setStep(2);
      return;
    }
    if (step === 3) {
      if (!validatePortfolioStep()) return;
      void commitPortfolio();
      return;
    }
    setStep((s) => Math.min(s + 1, 5));
  }

  function handleBack() {
    if (step === 4 && addDataView !== "cards") {
      setAddDataView("cards");
      return;
    }
    setStep((s) => Math.max(s - 1, 0));
  }

  async function completeOnboarding() {
    try {
      await api.completeOnboarding();
    } catch {
      // Best-effort: a failed flag-set just means the user may see onboarding again
      // next login — never block navigation on it.
    }
  }

  async function handleSkipSetup() {
    if (exiting) return;
    setExiting(true);
    await completeOnboarding();
    router.push("/holdings");
  }

  async function handleFinish() {
    if (exiting) return;
    setExiting(true);
    await completeOnboarding();
    router.push("/holdings");
  }

  function handleAddDataSelect(key: AddDataCardKey) {
    if (key === "connect") {
      setAddDataView("tr");
    } else if (key === "import") {
      setImportOpen(true);
    } else if (key === "manual") {
      // AddTransaction's own success handler navigates straight to /transactions,
      // bypassing our Done screen — mark onboarding complete now (a portfolio
      // already exists at this point, step 4) so landing there doesn't bounce back.
      void completeOnboarding();
      setManualOpen(true);
    } else {
      setStep(5);
    }
  }

  function goToSlide(index: number) {
    const n = 4;
    setMSlide(((index % n) + n) % n);
  }

  const isMobileIntro = !isDesktop && !mIntroDone;

  const rootStyle = {
    height: "100dvh",
    width: "100%",
    display: "flex",
    flexDirection: isDesktop ? ("row" as const) : ("column" as const),
    background: th.pageBg,
    position: "relative" as const,
    overflow: "hidden" as const,
  };

  const contentWrap = isDesktop
    ? {
        flex: "1 1 56%",
        minWidth: 0,
        background: th.panelBg,
        display: "flex",
        flexDirection: "column" as const,
        justifyContent: "center",
        padding: "48px 6vw",
        position: "relative" as const,
        overflowY: "auto" as const,
      }
    : {
        flex: 1,
        minWidth: 0,
        background: isDark ? th.brandGrad : th.pageBg,
        display: "flex",
        flexDirection: "column" as const,
        justifyContent: "flex-start",
        padding: "26px 20px 46px",
        position: "relative" as const,
        overflowY: "auto" as const,
      };

  const targetPortfolios = createdPortfolio
    ? [
        {
          id: createdPortfolio.id,
          name: createdPortfolio.name,
          brokerage: createdPortfolio.brokerage,
          accountHolder: createdPortfolio.accountHolder,
        },
      ]
    : [];

  return (
    <ImportTasksProvider>
      <div className="pk" style={rootStyle}>
        {isDesktop && (
          <ThemeTogglePill
            th={th}
            isDark={isDark}
            label={themeToggleLabel}
            onToggle={() => setTheme(isDark ? "light" : "dark")}
            style={{ position: "absolute", top: 22, right: 22, zIndex: 5 }}
          />
        )}

        {isDesktop && (
          <BrandPanel
            th={th}
            step={step}
            stepTitle={stepTitle}
            brandHeadline={brandContent.h}
            brandSub={brandContent.s}
            brandBullets={brandBullets}
          />
        )}

        <div style={contentWrap}>
          {!isDesktop && <MobileBackdrop isDark={isDark} />}

          <div style={{ width: "100%", maxWidth: 420, margin: "0 auto", position: "relative" }}>
            {!isDesktop && (
              <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 22 }}>
                <span
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 10,
                    background: "#0E9F6E",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Icon d={ICONS.wallet} size={17} stroke="#fff" />
                </span>
                <span style={{ font: "800 16px 'Plus Jakarta Sans'", color: th.headColor }}>
                  Pocket
                </span>
                <ThemeTogglePill
                  th={th}
                  isDark={isDark}
                  label={themeToggleLabel}
                  onToggle={() => setTheme(isDark ? "light" : "dark")}
                  style={{ marginLeft: "auto" }}
                />
              </div>
            )}

            {showChrome ? (
              <>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    marginBottom: 18,
                    minHeight: 28,
                  }}
                >
                  {showBack ? (
                    <button
                      type="button"
                      onClick={handleBack}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 5,
                        background: "none",
                        border: "none",
                        padding: 0,
                        cursor: "pointer",
                        font: "700 13px 'Plus Jakarta Sans'",
                        color: th.labelColor,
                      }}
                    >
                      <Icon d={ICONS.back} size={15} strokeWidth={2.2} />
                      {t("back")}
                    </button>
                  ) : (
                    <span />
                  )}
                  <button
                    type="button"
                    onClick={() => void handleSkipSetup()}
                    disabled={exiting}
                    style={{
                      background: "none",
                      border: "none",
                      padding: 0,
                      cursor: "pointer",
                      font: "600 13px 'Plus Jakarta Sans'",
                      color: th.dividerText,
                    }}
                  >
                    {t("skipSetup")}
                  </button>
                </div>

                <div style={{ display: "flex", gap: 6, marginBottom: 24 }}>
                  {[0, 1, 2, 3, 4].map((i) => (
                    <span
                      key={i}
                      style={{
                        width: 22,
                        height: 5,
                        borderRadius: 999,
                        background: i <= step ? th.dotOn : th.dotOff,
                        transition: "background .2s",
                      }}
                    />
                  ))}
                </div>

                <div key={stepTitle} className={styles.stepAnim}>
                  <div
                    style={{
                      font: "700 12px 'Plus Jakarta Sans'",
                      letterSpacing: ".14em",
                      textTransform: "uppercase",
                      color: th.kicker,
                    }}
                  >
                    {stepKickerByIndex[step]}
                  </div>
                  <h2
                    style={{
                      font: "800 26px 'Plus Jakarta Sans'",
                      color: th.headColor,
                      margin: "10px 0 6px",
                      letterSpacing: "-.01em",
                    }}
                  >
                    {stepTitle}
                  </h2>
                  <p
                    style={{
                      font: "500 14px/1.55 'Plus Jakarta Sans'",
                      color: th.subColor,
                      margin: "0 0 26px",
                    }}
                  >
                    {stepSubByIndex[step]}
                  </p>

                  {step === 0 && (
                    <WelcomeStep
                      th={th}
                      copy={{
                        previewLabel: t("welcome.previewLabel"),
                        previewValue: t("welcome.previewValue"),
                        previewPill: t("welcome.previewPill"),
                        previewCaption: t("welcome.previewCaption"),
                        tourSectionLabel: t("welcome.tourSectionLabel"),
                        tourItems: [
                          {
                            label: t("welcome.tour.holdings.label"),
                            desc: t("welcome.tour.holdings.desc"),
                          },
                          {
                            label: t("welcome.tour.activity.label"),
                            desc: t("welcome.tour.activity.desc"),
                          },
                          {
                            label: t("welcome.tour.reports.label"),
                            desc: t("welcome.tour.reports.desc"),
                          },
                          {
                            label: t("welcome.tour.insights.label"),
                            desc: t("welcome.tour.insights.desc"),
                          },
                          {
                            label: t("welcome.tour.profile.label"),
                            desc: t("welcome.tour.profile.desc"),
                          },
                        ],
                      }}
                    />
                  )}

                  {step === 1 && (
                    <HolderStep
                      th={th}
                      copy={{
                        nameLabel: t("holder.nameLabel"),
                        namePlaceholder: t("holder.namePlaceholder"),
                        birthYearLabel: t("holder.birthYearLabel"),
                        birthYearPlaceholder: t("holder.birthYearPlaceholder"),
                        birthYearHelper: t("holder.birthYearHelper"),
                      }}
                      holderName={holderName}
                      birthYear={birthYear}
                      holderNameError={errors.holderName}
                      birthYearError={errors.birthYear}
                      onHolderNameChange={(v) => {
                        setHolderName(v);
                        setErrors((e) => ({ ...e, holderName: undefined }));
                      }}
                      onBirthYearChange={(v) => {
                        setBirthYear(v);
                        setErrors((e) => ({ ...e, birthYear: undefined }));
                      }}
                    />
                  )}

                  {step === 2 && (
                    <TaxStep
                      th={th}
                      options={[
                        { code: "DE", name: t("tax.de.name"), desc: t("tax.de.desc") },
                        { code: "ID", name: t("tax.id.name"), desc: t("tax.id.desc") },
                      ]}
                      taxRegime={taxRegime}
                      onSelect={setTaxRegime}
                    />
                  )}

                  {step === 3 && (
                    <PortfolioStep
                      th={th}
                      isDark={isDark}
                      copy={{
                        nameLabel: t("portfolio.nameLabel"),
                        namePlaceholder: t("portfolio.namePlaceholder"),
                        brokerageLabel: t("portfolio.brokerageLabel"),
                        brokerageOptional: t("portfolio.brokerageOptional"),
                        brokeragePlaceholder: t("portfolio.brokeragePlaceholder"),
                        currencyLabel: t("portfolio.currencyLabel"),
                        cashLabel: t("portfolio.cashLabel"),
                        cashInvestOnly: t("portfolio.cashInvestOnly"),
                        cashInvestOnlyDesc: t("portfolio.cashInvestOnlyDesc"),
                        cashSavings: t("portfolio.cashSavings"),
                        cashSavingsDesc: t("portfolio.cashSavingsDesc"),
                        cashHelper: t("portfolio.cashHelper"),
                      }}
                      portfolioName={portfolioName}
                      portfolioNameError={errors.portfolioName}
                      onPortfolioNameChange={(v) => {
                        setPortfolioName(v);
                        setErrors((e) => ({ ...e, portfolioName: undefined }));
                      }}
                      brokerageValue={brokerageValue}
                      brokerageOpen={brokerageOpen}
                      onBrokerageChange={(v) => {
                        setBrokerageValue(v);
                        setBrokerageOpen(true);
                      }}
                      onBrokerageFocus={() => setBrokerageOpen(true)}
                      onBrokerageToggle={() => setBrokerageOpen((o) => !o)}
                      onBrokerageBlur={() => setTimeout(() => setBrokerageOpen(false), 120)}
                      onSelectBrokerage={(name) => {
                        setBrokerageValue(name);
                        setBrokerageOpen(false);
                      }}
                      currency={currency}
                      onCurrencyChange={setCurrency}
                      cashCounted={cashCounted}
                      onCashCountedChange={setCashCounted}
                    />
                  )}

                  {step === 4 && addDataView === "cards" && (
                    <AddDataStep
                      th={th}
                      copy={{
                        connectTitle: t("addData.connectTitle"),
                        connectDesc: t("addData.connectDesc"),
                        importTitle: t("addData.importTitle"),
                        importDesc: t("addData.importDesc"),
                        manualTitle: t("addData.manualTitle"),
                        manualDesc: t("addData.manualDesc"),
                        skipTitle: t("addData.skipTitle"),
                        skipDesc: t("addData.skipDesc"),
                      }}
                      onSelect={handleAddDataSelect}
                    />
                  )}

                  {step === 4 && addDataView === "tr" && createdPortfolio && (
                    <AddDataTrConnect
                      th={th}
                      api={api}
                      portfolioId={createdPortfolio.id}
                      cashCounted={cashCounted}
                      onConnected={() => setStep(5)}
                      loadingLabel={t("addData.trLoading")}
                      unavailableLabel={t("addData.trUnavailable")}
                    />
                  )}

                  {showPrimaryCta && (
                    <button
                      type="button"
                      onClick={handlePrimaryCta}
                      disabled={creating}
                      style={{
                        width: "100%",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: 7,
                        font: "700 15px 'Plus Jakarta Sans'",
                        color: "#fff",
                        background: "#0E9F6E",
                        border: "none",
                        borderRadius: 13,
                        padding: 15,
                        cursor: creating ? "default" : "pointer",
                        marginTop: 8,
                        boxShadow: "0 8px 20px rgba(14,159,110,.28)",
                        opacity: creating ? 0.7 : 1,
                      }}
                    >
                      {creating ? <Spinner size="sm" /> : primaryCtaLabel}
                      {!creating && <Icon d={ICONS.arrowRight} size={16} strokeWidth={2.2} />}
                    </button>
                  )}
                </div>
              </>
            ) : (
              <DoneStep
                th={th}
                copy={{
                  heading: t("done.heading"),
                  readySub: t("done.readySub"),
                  skippedSub: t("done.skippedSub"),
                  cta: t("done.cta"),
                }}
                portfolioCreated={createdPortfolio !== null}
                onFinish={() => void handleFinish()}
              />
            )}
          </div>
        </div>

        {isMobileIntro && (
          <MobileIntro
            copy={{
              skip: t("mobileIntro.skip"),
              getStarted: t("mobileIntro.getStarted"),
              haveAccount: t("mobileIntro.haveAccount"),
              netWorthLabel: t("mobileIntro.netWorthLabel"),
              netWorthValue: t("mobileIntro.netWorthValue"),
              netWorthPill: t("mobileIntro.netWorthPill"),
              slides: [
                {
                  h: t("mobileIntro.slide1.headline"),
                  s: t("mobileIntro.slide1.sub"),
                  kind: "card",
                  bullets: t.raw("mobileIntro.slide1.bullets") as string[],
                },
                {
                  h: t("mobileIntro.slide2.headline"),
                  s: t("mobileIntro.slide2.sub"),
                  kind: "glyph",
                  bullets: t.raw("mobileIntro.slide2.bullets") as string[],
                },
                {
                  h: t("mobileIntro.slide3.headline"),
                  s: t("mobileIntro.slide3.sub"),
                  kind: "glyph",
                  bullets: t.raw("mobileIntro.slide3.bullets") as string[],
                },
                {
                  h: t("mobileIntro.slide4.headline"),
                  s: t("mobileIntro.slide4.sub"),
                  kind: "glyph",
                  bullets: t.raw("mobileIntro.slide4.bullets") as string[],
                },
              ],
            }}
            slide={mSlide}
            onGoToSlide={goToSlide}
            onEnter={() => setMIntroDone(true)}
          />
        )}
      </div>

      {/* "Import a CSV or screenshot" — reuses the real import flow (same component the
          app-wide Add-transaction sheet uses), scoped to the portfolio just created. */}
      <Sheet open={importOpen} onOpenChange={setImportOpen} dismissible>
        <SheetContent className="max-w-3xl">
          <SheetHeader className="px-5 pb-3 pt-3">
            <SheetTitle>{t("addData.importSheetTitle")}</SheetTitle>
          </SheetHeader>
          <div className="px-5 pb-7 pt-1.5">
            {importOpen && createdPortfolio && (
              <Suspense fallback={null}>
                <ImportFlowClient
                  portfolios={targetPortfolios}
                  defaultPortfolioId={createdPortfolio.id}
                  onClose={() => {
                    setImportOpen(false);
                    setStep(5);
                  }}
                />
              </Suspense>
            )}
          </div>
        </SheetContent>
      </Sheet>

      {/* "Add manually" — reuses the real manual-entry tabs (same component the
          app-wide Add-transaction sheet uses). Onboarding is marked complete the
          moment this opens (see handleAddDataSelect) since a successful save here
          navigates straight to /transactions on its own. */}
      <Sheet open={manualOpen} onOpenChange={setManualOpen}>
        <SheetContent>
          <SheetHeader className="px-5 pb-3 pt-3">
            <SheetTitle>{t("addData.manualSheetTitle")}</SheetTitle>
          </SheetHeader>
          <div className="px-5 pb-7 pt-1.5">
            {manualOpen && createdPortfolio && (
              <NewEntryTabs
                portfolios={targetPortfolios}
                initialPortfolioId={createdPortfolio.id}
                defaultTab="transaction"
                stickyFooter
              />
            )}
          </div>
        </SheetContent>
      </Sheet>
    </ImportTasksProvider>
  );
}
