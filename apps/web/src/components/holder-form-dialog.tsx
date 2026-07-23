"use client";

import { useId } from "react";
import { useTranslations } from "next-intl";
import { Spinner } from "@/components/ui/spinner";
import type { AccountHolder } from "@portfolio/api-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { HolderTypeChips } from "@/components/holder-type-chips";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useHolderForm } from "./holder-form-dialog/hooks";

/** Create or edit a single holder. Delete lives in the row's ⋯ menu (a confirm modal). */
export function HolderFormDialog({
  mode,
  holder,
  trigger,
  onSuccess,
}: {
  mode: "create" | "edit";
  holder?: AccountHolder;
  trigger: React.ReactNode;
  onSuccess?: () => void;
}) {
  const t = useTranslations("AccountHolders");
  const tf = useTranslations("PortfolioForm");
  const subtitleId = useId();
  const f = useHolderForm(mode, holder, onSuccess);

  return (
    <Sheet open={f.open} onOpenChange={f.onOpenChange} handleOnly>
      <SheetTrigger asChild>{trigger}</SheetTrigger>
      <SheetContent aria-describedby={subtitleId}>
        <SheetHeader className="pb-0">
          <SheetTitle>{mode === "edit" ? t("editTitle") : t("createTitle")}</SheetTitle>
          <p id={subtitleId} className="text-xs font-medium text-text-2">
            {t("subtitle")}
          </p>
        </SheetHeader>

        <form onSubmit={f.submit} className="space-y-4 p-6 pt-4">
          {f.error && (
            <p
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {t("error")}
            </p>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="holder-name">{tf("holderName")}</Label>
            <Input
              id="holder-name"
              value={f.name}
              onChange={(e) => f.setName(e.target.value)}
              placeholder={tf("accountHolderPlaceholder")}
              required
            />
          </div>

          <div className="space-y-1.5">
            <Label id="holder-type-label">{tf("holderType")}</Label>
            <HolderTypeChips value={f.type} onChange={f.setType} labelledBy="holder-type-label" />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="holder-birth-year">{tf("birthYear")}</Label>
            <Input
              id="holder-birth-year"
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
                <Label htmlFor="holder-tax-residence">{t("taxResidence")}</Label>
                <Input
                  id="holder-tax-residence"
                  maxLength={2}
                  placeholder="DE"
                  value={f.taxResidence}
                  onChange={(e) => f.setTaxResidence(e.target.value.toUpperCase())}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="holder-tax-allowance">{t("taxAllowance")}</Label>
                <Input
                  id="holder-tax-allowance"
                  type="number"
                  inputMode="decimal"
                  placeholder="1000"
                  value={f.taxAllowance}
                  onChange={(e) => f.setTaxAllowance(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">{t("taxAllowanceHint")}</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="holder-tax-rate">{t("capitalGainsTaxRate")}</Label>
                <Input
                  id="holder-tax-rate"
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

          <div className="sticky bottom-0 -mx-6 bg-background border-t border-border px-6 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))] z-[2]">
            <Button
              type="submit"
              disabled={f.busy || !f.name.trim()}
              className="h-auto w-full rounded-[15px] py-[15px] text-[15px] font-bold"
            >
              {f.busy && <Spinner size="sm" />}
              {mode === "edit" ? tf("save") : t("add")}
            </Button>

            {/* Edit mode: full-width red delete text → two-step confirm (solid red + caption),
                mirroring the portfolio edit sheet and the reference's remove-holder action. */}
            {mode === "edit" &&
              (f.confirmDelete ? (
                <>
                  <Button
                    type="button"
                    onClick={f.onDelete}
                    disabled={f.busy}
                    className="mt-2.5 h-auto w-full rounded-[15px] bg-[#E5484D] py-[15px] text-[15px] font-bold text-white hover:bg-[#E5484D]/90"
                  >
                    {f.busy && <Spinner size="sm" />}
                    {t("confirmDelete")}
                  </Button>
                  <p className="mt-1.5 text-center text-[11px] font-medium text-text-3">
                    {t("deleteWarning")}
                  </p>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => f.setConfirmDelete(true)}
                  disabled={f.busy}
                  className="mt-2.5 w-full py-3 text-sm font-bold text-[#E5484D]"
                >
                  {t("delete")}
                </button>
              ))}
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}
