"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { AlertCircle } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Eyebrow } from "@/components/ui/eyebrow";
import { ToggleRow } from "@/components/ui/toggle-row";
import { KNOWN_BROKERAGES } from "@/lib/brokerages";
import { BrokerageIcon } from "@/components/brokerage-icon";
import { useRouter } from "@/i18n/navigation";
import { OwnershipSection } from "@/components/portfolio-form-dialog/sections/ownership-section";
import { AccountSection } from "@/components/portfolio-form-dialog/sections/account-section";
import {
  TrConnectionSection,
  IbkrConnectionSection,
} from "@/components/portfolio-form-dialog/sections/connection-section";
import { usePortfolioForm } from "@/components/portfolio-form-dialog/hooks";
import type { EditablePortfolio } from "@/components/portfolio-form-dialog/constants";

const CARD_CLASS = "space-y-3.5 rounded-[16px] border border-border bg-card p-4 shadow-card";

/**
 * The design's inline "Edit portfolio" / "New portfolio" page (`Portfolios.dc.html`,
 * three cards: BASICS / ACCOUNT DETAILS / ACCOUNTING OPTIONS) — reached by tapping a
 * portfolio card in Settings → Portfolios & holders, replacing the old `⋯` menu → Sheet
 * flow (see `settings/portfolios/[portfolioId]/page.tsx`).
 *
 * This is the same form as `PortfolioFormDialog`, un-Sheeted: same `usePortfolioForm`
 * hook (submit/validation/TR-IBKR-connect logic untouched) and the same field-group
 * components (`OwnershipSection`/`AccountSection`), just re-boxed into the design's
 * cards with an inline (not Sheet-portaled) footer. `PortfolioFormBody` (used by the
 * desktop Add Transaction shell) is a different re-host of this same hook for a
 * different chrome — not reused here, since it renders into `useSheetFooter()`'s portal,
 * which this page doesn't have.
 */
export function PortfolioEditForm({
  mode,
  portfolio,
}: {
  mode: "create" | "edit";
  portfolio?: EditablePortfolio;
}) {
  const t = useTranslations("PortfolioForm");
  const router = useRouter();
  const f = usePortfolioForm(
    mode,
    portfolio,
    mode === "edit" ? () => router.push("/settings/portfolios") : undefined,
  );
  // Edit's `onSuccess` always navigates away (the hook itself always closes on a
  // successful edit-save). Create instead waits for the "Done" button below — a
  // successful create may still need to show the TR/IBKR connect step first.
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    f.onOpenChange(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // `deletePortfolioWithCleanup` (inside `f.onDelete`) doesn't navigate on its own — only
  // cleans up the selection cookie and refreshes. Navigate once the delete request we
  // kicked off resolves without error. Deliberately doesn't reset `deleting` back to
  // `false` (no setState in this effect, only navigation): if the delete instead failed,
  // `deleting` staying `true` is harmless — a retry's `busy` still cycles false→true→false
  // and re-triggers this effect correctly either way.
  useEffect(() => {
    if (deleting && !f.busy && !f.error) router.push("/settings/portfolios");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deleting, f.busy, f.error]);

  function handleDelete() {
    setDeleting(true);
    f.onDelete();
  }

  return (
    <div className="max-w-xl space-y-3.5">
      {f.error && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          <AlertCircle className="size-4 shrink-0" />
          {t("error")}
        </div>
      )}

      <form onSubmit={f.submit} className="space-y-3.5">
        <div className={CARD_CLASS}>
          <Eyebrow>{t("sectionBasics")}</Eyebrow>

          <div className="space-y-1.5">
            <Label htmlFor="portfolio-brokerage">{t("brokerage")}</Label>
            <div className="flex items-center gap-2">
              <BrokerageIcon brokerage={f.brokerage} />
              <Input
                id="portfolio-brokerage"
                value={f.brokerage}
                onChange={(e) => f.setBrokerage(e.target.value)}
                placeholder={t("brokeragePlaceholder")}
                list="pf-edit-brokerages"
                autoComplete="off"
              />
            </div>
            <datalist id="pf-edit-brokerages">
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

          <div className="space-y-1.5">
            <Label htmlFor="portfolio-name">{t("name")}</Label>
            <Input
              id="portfolio-name"
              value={f.name}
              onChange={(e) => f.setName(e.target.value)}
              placeholder={t("namePlaceholder")}
              required
            />
          </div>

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
        </div>

        <div className={CARD_CLASS}>
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
        </div>

        <div className={CARD_CLASS}>
          <Eyebrow>{t("sectionAccounting")}</Eyebrow>
          <div className="space-y-3">
            <ToggleRow
              id="pf-cashCounted"
              label={t("cashCounted")}
              hint={t("cashCountedHint")}
              checked={f.cashCounted}
              onCheckedChange={f.setCashCounted}
            />
            {f.cashCounted && (
              <ToggleRow
                id="pf-allowNegativeCash"
                label={t("allowNegativeCash")}
                hint={t("allowNegativeCashHint")}
                checked={f.allowNegativeCash}
                onCheckedChange={f.setAllowNegativeCash}
              />
            )}
            <ToggleRow
              id="pf-documentRetention"
              label={t("documentRetention")}
              hint={t("documentRetentionHint")}
              checked={f.documentRetention}
              onCheckedChange={f.setDocumentRetention}
            />
            <ToggleRow
              id="pf-includeInAggregate"
              label={t("includeInAggregate")}
              hint={t("includeInAggregateHint")}
              checked={f.includeInAggregate}
              onCheckedChange={f.setIncludeInAggregate}
            />
          </div>
        </div>

        <div className="flex flex-col-reverse gap-2.5 pt-1 sm:flex-row sm:items-center sm:justify-end">
          {mode === "edit" &&
            (f.confirmDelete ? (
              <div className="flex flex-col gap-1.5 sm:mr-auto">
                <Button
                  type="button"
                  onClick={handleDelete}
                  disabled={f.busy}
                  className="h-auto w-full rounded-[11px] bg-[#E5484D] px-4 py-2.5 text-[13px] font-bold text-white hover:bg-[#E5484D]/90 sm:w-auto"
                >
                  {f.busy && <Spinner size="sm" />}
                  {t("confirmDelete")}
                </Button>
                <p className="text-[11px] font-medium text-text-3">
                  {t("deleteWarning", { count: portfolio?.transactionCount ?? 0 })}{" "}
                  {t("deleteRelatedNote")}
                </p>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => f.setConfirmDelete(true)}
                disabled={f.busy}
                className="text-sm font-bold text-[#E5484D] sm:mr-auto"
              >
                {t("delete")}
              </button>
            ))}

          {mode === "create" && f.createdPortfolio ? (
            <Button
              type="button"
              onClick={() => router.push("/settings/portfolios")}
              className="h-auto w-full rounded-[15px] py-[15px] text-[15px] font-bold sm:w-auto sm:rounded-[11px] sm:px-[22px] sm:py-[11px]"
            >
              {t("done")}
            </Button>
          ) : (
            <Button
              type="submit"
              disabled={f.busy || !f.name.trim()}
              className="h-auto w-full rounded-[15px] py-[15px] text-[15px] font-bold sm:w-auto sm:rounded-[11px] sm:px-[22px] sm:py-[11px]"
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
          )}
        </div>
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
    </div>
  );
}
