"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import type { AccountHolder } from "@portfolio/api-client";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Eyebrow } from "@/components/ui/eyebrow";
import { ToggleRow } from "@/components/ui/toggle-row";
import { HolderTypeChips } from "@/components/holder-type-chips";
import { useRouter } from "@/i18n/navigation";
import { useHolderForm } from "@/components/holder-form-dialog/hooks";

const CARD_CLASS = "space-y-3.5 rounded-[16px] border border-border bg-card p-4 shadow-card";

/**
 * The design's inline "Edit account holder" / "New account holder" page
 * (`ProfileSettings.dc.html`, two cards: DETAILS / GERMAN TAX PROFILE · OPTIONAL) —
 * reached by tapping a holder row in Settings → Portfolios & holders, replacing the old
 * `⋯` menu → Sheet flow (see `settings/portfolios/holder/[holderId]/page.tsx`).
 *
 * Same `useHolderForm` hook as `HolderFormDialog` (submit/validation/delete untouched),
 * un-Sheeted and re-boxed into the design's cards with an inline footer.
 */
export function HolderEditForm({
  mode,
  holder,
}: {
  mode: "create" | "edit";
  holder?: AccountHolder;
}) {
  const t = useTranslations("AccountHolders");
  const tf = useTranslations("PortfolioForm");
  const router = useRouter();
  const f = useHolderForm(mode, holder, () => router.push("/settings/portfolios"));
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    f.onOpenChange(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // `f.onDelete` doesn't navigate on its own — only refreshes. Navigate once the delete
  // request we kicked off resolves without error. Deliberately doesn't reset `deleting`
  // back to `false` (no setState in this effect, only navigation) — see the identical note
  // in `portfolio-edit-form.tsx`.
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
        <p
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {t("error")}
        </p>
      )}

      <form onSubmit={f.submit} className="space-y-3.5">
        <div className={CARD_CLASS}>
          <Eyebrow>{t("detailsSection")}</Eyebrow>

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

          {f.type === "child" && (
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
          )}
        </div>

        <div className={CARD_CLASS}>
          <Eyebrow>{t("taxProfileSection")}</Eyebrow>

          <div className="grid gap-3 sm:grid-cols-2">
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
            <div className="space-y-1.5 sm:col-span-2">
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
          </div>

          <div className="border-t border-line pt-3">
            <ToggleRow
              id="holder-churchTax"
              label={t("churchTax")}
              checked={f.churchTax}
              onCheckedChange={f.setChurchTax}
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
                <p className="text-[11px] font-medium text-text-3">{t("deleteWarning")}</p>
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

          <Button
            type="submit"
            disabled={f.busy || !f.name.trim()}
            className="h-auto w-full rounded-[15px] py-[15px] text-[15px] font-bold sm:w-auto sm:rounded-[11px] sm:px-[22px] sm:py-[11px]"
          >
            {f.busy && <Spinner size="sm" />}
            {mode === "edit" ? tf("save") : t("add")}
          </Button>
        </div>
      </form>
    </div>
  );
}
