"use client";

import { useEffect, useId } from "react";
import { createPortal } from "react-dom";
import { useTranslations } from "next-intl";
import { AlertCircle } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Eyebrow } from "@/components/ui/eyebrow";
import { useSheetFooter } from "@/components/ui/sheet";
import { KNOWN_BROKERAGES } from "@/lib/brokerages";
import { BrokerageIcon } from "@/components/brokerage-icon";
import type { EditablePortfolio } from "./constants";
import { OwnershipSection } from "./sections/ownership-section";
import { AccountSection } from "./sections/account-section";
import { AdvancedSection } from "./sections/advanced-section";
import { TrConnectionSection, IbkrConnectionSection } from "./sections/connection-section";
import { usePortfolioForm } from "./hooks";

/**
 * The `PortfolioFormDialog` body, extracted so the desktop Add Transaction shell's
 * "Create portfolio" rail destination can render it inline in the modal's main column
 * instead of nesting another Sheet (mobile keeps the original Sheet-wrapped dialog
 * unchanged) — see `add-transaction-menu/desktop-shell.tsx`. Submit/validation logic
 * (`usePortfolioForm`) is untouched; this only changes what wraps it.
 *
 * Desktop-only in practice: the rail's "Create portfolio" destination is always `mode:
 * "create"` (editing an existing portfolio still goes through `PortfolioFormDialog`
 * elsewhere in the app), so the delete-confirmation UI isn't reproduced here.
 *
 * `usePortfolioForm`'s data-loading effects (holders, sibling portfolios, TR/IBKR
 * connection) are gated on its own `open` state, which normally tracks the Sheet's
 * open/close. There's no such lifecycle here — the body IS "open" for as long as it's
 * mounted — so this simulates it once on mount via the same `onOpenChange(true)` the
 * Sheet trigger would call, which also seeds every field from `portfolio`.
 */
export function PortfolioFormBody({
  mode,
  portfolio,
  onSuccess,
  onDone,
}: {
  mode: "create" | "edit";
  portfolio?: EditablePortfolio;
  onSuccess?: () => void;
  /** Post-create "Done" button (after the optional TR/IBKR connect step) — the desktop
   *  shell uses this to navigate back to "Add transaction". */
  onDone?: () => void;
}) {
  const t = useTranslations("PortfolioForm");
  const subtitleId = useId();
  const formId = useId();
  const f = usePortfolioForm(mode, portfolio, onSuccess);
  const footerEl = useSheetFooter();

  useEffect(() => {
    f.onOpenChange(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const footerButton =
    mode === "create" && f.createdPortfolio ? (
      <Button
        type="button"
        onClick={() => onDone?.()}
        className="h-auto rounded-[13px] px-[26px] py-[13px] text-[14px] font-bold"
      >
        {t("done")}
      </Button>
    ) : (
      <Button
        type="submit"
        form={formId}
        disabled={f.busy || !f.name.trim()}
        className="h-auto rounded-[13px] px-[26px] py-[13px] text-[14px] font-bold"
      >
        {f.busy && <Spinner size="sm" />}
        {f.busy
          ? mode === "edit"
            ? t("saving")
            : t("creating")
          : mode === "edit"
            ? t("save")
            : t("create")}
      </Button>
    );

  return (
    <>
      <form
        id={formId}
        onSubmit={f.submit}
        aria-describedby={subtitleId}
        className="flex max-w-[600px] flex-col gap-[13px]"
      >
        <p id={subtitleId} className="text-xs font-medium text-text-2">
          {t("subtitle")}
        </p>

        {f.error && (
          <div
            role="alert"
            className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            <AlertCircle className="size-4 shrink-0" />
            {t("error")}
          </div>
        )}

        <Eyebrow>{t("sectionBasics")}</Eyebrow>

        <div className="space-y-1.5">
          <Label htmlFor="portfolio-name-desktop">{t("name")}</Label>
          <Input
            id="portfolio-name-desktop"
            value={f.name}
            onChange={(e) => f.setName(e.target.value)}
            placeholder={t("namePlaceholder")}
            required
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="portfolio-brokerage-desktop">{t("brokerage")}</Label>
          <div className="flex items-center gap-2">
            <BrokerageIcon brokerage={f.brokerage} />
            <Input
              id="portfolio-brokerage-desktop"
              value={f.brokerage}
              onChange={(e) => f.setBrokerage(e.target.value)}
              placeholder={t("brokeragePlaceholder")}
              list="brokerage-suggestions-desktop"
              autoComplete="off"
            />
          </div>
          <datalist id="brokerage-suggestions-desktop">
            {KNOWN_BROKERAGES.map((b) => (
              <option key={b} value={b} />
            ))}
          </datalist>
          {f.isTr && !f.effectivePortfolio && !f.showTrChildNote && (
            <p className="text-xs text-muted-foreground">{t("trConnectAfterSave")}</p>
          )}
          {f.showTrChildNote && (
            <p className="text-xs text-muted-foreground">{t("trChildUnsupported")}</p>
          )}
        </div>

        <Eyebrow>{t("sectionOwnership")}</Eyebrow>

        <OwnershipSection
          holders={f.holders}
          accountHolderId={f.accountHolderId}
          newHolderName={f.newHolderName}
          newHolderType={f.newHolderType}
          newHolderBirthYear={f.newHolderBirthYear}
          onAccountHolderChange={f.setAccountHolderId}
          onNewHolderNameChange={f.setNewHolderName}
          onNewHolderTypeChange={f.setNewHolderType}
          onNewHolderBirthYearChange={f.setNewHolderBirthYear}
        />

        <Eyebrow>{t("sectionAccount")}</Eyebrow>

        <AccountSection
          accountNumber={f.accountNumber}
          iban={f.iban}
          currency={f.currency}
          taxAllowanceAnnual={f.taxAllowanceAnnual}
          showFsaHelper={f.showFsaHelper}
          fsaOverAllocated={f.fsaOverAllocated}
          totalAllocated={f.totalAllocated}
          holderAllowanceCap={f.holderAllowanceCap}
          fsaRemainingForHolder={f.fsaRemainingForHolder}
          selectedHolderName={f.selectedHolderObj?.name ?? null}
          onAccountNumberChange={f.setAccountNumber}
          onIbanChange={f.setIban}
          onCurrencyChange={f.setCurrency}
          onTaxAllowanceChange={f.setTaxAllowanceAnnual}
        />

        <AdvancedSection
          cashCounted={f.cashCounted}
          allowNegativeCash={f.allowNegativeCash}
          documentRetention={f.documentRetention}
          includeInAggregate={f.includeInAggregate}
          onCashCountedChange={f.setCashCounted}
          onAllowNegativeCashChange={f.setAllowNegativeCash}
          onDocumentRetentionChange={f.setDocumentRetention}
          onIncludeInAggregateChange={f.setIncludeInAggregate}
        />
      </form>

      {f.showTrSection && (
        <TrConnectionSection
          trConnection={f.trConnection}
          effectivePortfolio={{ id: f.effectivePortfolio!.id }}
          cashCounted={f.cashCounted}
          boundElsewhere={f.boundElsewhere}
          trInitForFlow={f.trInitForFlow}
          client={f.api}
          onRefresh={() => f.router.refresh()}
          onFetchTrigger={() => f.setTrFetchSeq((s) => s + 1)}
        />
      )}

      {f.showIbkrSection && (
        <IbkrConnectionSection
          ibkrConnection={f.ibkrConnection}
          effectivePortfolio={{ id: f.effectivePortfolio!.id }}
          client={f.api}
          onRefresh={() => f.router.refresh()}
          onFetchTrigger={() => f.setIbkrFetchSeq((s) => s + 1)}
        />
      )}

      {footerEl && createPortal(footerButton, footerEl)}
    </>
  );
}
