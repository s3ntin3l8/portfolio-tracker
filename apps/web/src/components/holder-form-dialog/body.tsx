"use client";

import { useEffect, useId } from "react";
import { createPortal } from "react-dom";
import { useTranslations } from "next-intl";
import { Spinner } from "@/components/ui/spinner";
import type { AccountHolder } from "@portfolio/api-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { HolderTypeChips } from "@/components/holder-type-chips";
import { useSheetFooter } from "@/components/ui/sheet";
import { useHolderForm } from "./hooks";

/**
 * The `HolderFormDialog` body, extracted so the desktop Add Transaction shell's
 * "Account holder" rail destination can render it inline in the modal's main column
 * instead of nesting another Sheet (mobile keeps the original Sheet-wrapped dialog
 * unchanged) — see `add-transaction-menu/desktop-shell.tsx`. Submit/validation logic
 * (`useHolderForm`) is untouched; this only changes what wraps it. Desktop-only in
 * practice: the rail always creates (`mode: "create"`).
 *
 * Simulates the Sheet's "open" lifecycle once on mount (see `PortfolioFormBody` for why)
 * so the form's fields reset from `holder` the same way the Sheet trigger would.
 */
export function HolderFormBody({
  mode,
  holder,
  onSuccess,
}: {
  mode: "create" | "edit";
  holder?: AccountHolder;
  onSuccess?: () => void;
}) {
  const t = useTranslations("AccountHolders");
  const tf = useTranslations("PortfolioForm");
  const formId = useId();
  const f = useHolderForm(mode, holder, onSuccess);
  const footerEl = useSheetFooter();

  useEffect(() => {
    f.onOpenChange(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const footerButton = (
    <Button
      type="submit"
      form={formId}
      disabled={f.busy || !f.name.trim()}
      className="h-auto rounded-[13px] px-[26px] py-[13px] text-[14px] font-bold"
    >
      {f.busy && <Spinner size="sm" />}
      {mode === "edit" ? tf("save") : t("add")}
    </Button>
  );

  return (
    <>
      <form id={formId} onSubmit={f.submit} className="flex max-w-[600px] flex-col gap-[13px]">
        {f.error && (
          <p
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {t("error")}
          </p>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="holder-name-desktop">{tf("holderName")}</Label>
          <Input
            id="holder-name-desktop"
            value={f.name}
            onChange={(e) => f.setName(e.target.value)}
            placeholder={tf("accountHolderPlaceholder")}
            required
          />
        </div>

        <div className="space-y-1.5">
          <Label id="holder-type-label-desktop">{tf("holderType")}</Label>
          <HolderTypeChips
            value={f.type}
            onChange={f.setType}
            labelledBy="holder-type-label-desktop"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="holder-birth-year-desktop">{tf("birthYear")}</Label>
          <Input
            id="holder-birth-year-desktop"
            type="number"
            inputMode="numeric"
            placeholder={tf("birthYearPlaceholder")}
            value={f.birthYear}
            onChange={(e) => f.setBirthYear(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">{tf("birthYearHint")}</p>
        </div>

        {/* German tax profile (DE only, optional) */}
        <details className="rounded-md border px-3 py-2 text-sm">
          <summary className="cursor-pointer font-medium text-muted-foreground select-none">
            {t("taxProfileSection")}
          </summary>
          <div className="mt-3 space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="holder-tax-residence-desktop">{t("taxResidence")}</Label>
              <Input
                id="holder-tax-residence-desktop"
                maxLength={2}
                placeholder="DE"
                value={f.taxResidence}
                onChange={(e) => f.setTaxResidence(e.target.value.toUpperCase())}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="holder-tax-allowance-desktop">{t("taxAllowance")}</Label>
              <Input
                id="holder-tax-allowance-desktop"
                type="number"
                inputMode="decimal"
                placeholder="1000"
                value={f.taxAllowance}
                onChange={(e) => f.setTaxAllowance(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">{t("taxAllowanceHint")}</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="holder-tax-rate-desktop">{t("capitalGainsTaxRate")}</Label>
              <Input
                id="holder-tax-rate-desktop"
                type="number"
                inputMode="decimal"
                placeholder="0.25"
                min="0"
                max="1"
                step="0.00001"
                value={f.taxRate}
                onChange={(e) => f.setTaxRate(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">{t("capitalGainsTaxRateHint")}</p>
            </div>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={f.churchTax}
                onChange={(e) => f.setChurchTax(e.target.checked)}
                className="size-4"
              />
              {t("churchTax")}
            </label>
          </div>
        </details>
      </form>

      {footerEl && createPortal(footerButton, footerEl)}
    </>
  );
}
