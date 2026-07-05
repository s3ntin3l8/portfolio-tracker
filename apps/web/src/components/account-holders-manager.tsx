"use client";

import { useState, useId } from "react";
import { useTranslations } from "next-intl";
import { Loader2, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import type { AccountHolder, AccountHolderType } from "@portfolio/api-client";
import { Button } from "@/components/ui/button";
import { MonogramBadge } from "@/components/monogram-badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { HolderTypeChips } from "@/components/holder-type-chips";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DeleteHolderDialog } from "@/components/delete-holder-dialog";
import { useApiClient } from "@/lib/api";
import { useRouter } from "@/i18n/navigation";

/**
 * Manage the people an investment account can belong to (the user, a child, …).
 * Holders are defined once and linked from portfolios, so birth year + child status
 * live in one place (issue #207). Deleting a holder unassigns it from any portfolios
 * (they revert to "standard"), it never deletes the portfolios.
 */
export function AccountHoldersManager({ holders }: { holders: AccountHolder[] }) {
  const t = useTranslations("AccountHolders");
  const tf = useTranslations("PortfolioForm");

  return (
    <div className="rounded-[18px] bg-card p-[18px] shadow-card">
      <div className="mb-3 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-[15px] font-bold">{t("title")}</h2>
          <p className="mt-0.5 text-xs font-medium text-text-2">{t("subtitle")}</p>
        </div>
        <HolderFormDialog
          mode="create"
          trigger={
            // Reference: soft-green pill; icon-only on mobile, icon+label on desktop.
            <button
              type="button"
              aria-label={t("add")}
              className="flex shrink-0 items-center gap-1.5 rounded-[9px] bg-primary/10 px-[11px] py-[7px] text-xs font-semibold text-primary transition-colors hover:bg-primary/15"
            >
              <Plus className="size-[15px]" strokeWidth={2.4} />
              <span className="hidden sm:inline">{t("add")}</span>
            </button>
          }
        />
      </div>

      {holders.length > 0 ? (
        <div className="flex flex-col gap-2">
          {holders.map((h) => (
            <div
              key={h.id}
              className="flex items-center gap-3 rounded-[12px] bg-card-2 px-[13px] py-[11px]"
            >
              <MonogramBadge label={h.name} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-bold">{h.name}</p>
                <p className="truncate text-xs font-medium text-text-2">
                  {tf(`holderType${capitalize(h.type)}`)}
                  {h.birthYear != null ? ` · ${h.birthYear}` : ""}
                </p>
              </div>
              <HolderRowMenu holder={h} />
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-text-2">{t("empty")}</p>
      )}
    </div>
  );
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The ⋯ overflow menu on a holder row: Edit (form dialog) + Delete (confirm modal) —
 *  mirrors the portfolio card menu. */
function HolderRowMenu({ holder }: { holder: AccountHolder }) {
  const t = useTranslations("AccountHolders");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon" variant="ghost" aria-label="More options">
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <HolderFormDialog
          mode="edit"
          holder={holder}
          trigger={
            <DropdownMenuItem onSelect={(e) => e.preventDefault()}>
              <Pencil className="size-4" />
              {t("edit")}
            </DropdownMenuItem>
          }
        />
        <DropdownMenuSeparator />
        <DeleteHolderDialog
          holder={holder}
          trigger={
            <DropdownMenuItem
              onSelect={(e) => e.preventDefault()}
              className="text-destructive focus:text-destructive"
            >
              <Trash2 className="size-4" />
              {t("delete")}
            </DropdownMenuItem>
          }
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Create or edit a single holder. Delete lives in the row's ⋯ menu (a confirm modal). */
function HolderFormDialog({
  mode,
  holder,
  trigger,
}: {
  mode: "create" | "edit";
  holder?: AccountHolder;
  trigger: React.ReactNode;
}) {
  const t = useTranslations("AccountHolders");
  const tf = useTranslations("PortfolioForm");
  const api = useApiClient();
  const router = useRouter();
  const subtitleId = useId();

  const [open, setOpen] = useState(false);
  const [name, setName] = useState(holder?.name ?? "");
  const [type, setType] = useState<AccountHolderType>(holder?.type ?? "self");
  const [birthYear, setBirthYear] = useState(
    holder?.birthYear != null ? String(holder.birthYear) : "",
  );
  // German tax profile fields.
  const [taxAllowance, setTaxAllowance] = useState(holder?.taxAllowanceAnnual ?? "");
  const [taxRate, setTaxRate] = useState(holder?.capitalGainsTaxRate ?? "");
  const [churchTax, setChurchTax] = useState(holder?.churchTax ?? false);
  const [taxResidence, setTaxResidence] = useState(holder?.taxResidence ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  function onOpenChange(next: boolean) {
    if (next) {
      setName(holder?.name ?? "");
      setType(holder?.type ?? "self");
      setBirthYear(holder?.birthYear != null ? String(holder.birthYear) : "");
      setTaxAllowance(holder?.taxAllowanceAnnual ?? "");
      setTaxRate(holder?.capitalGainsTaxRate ?? "");
      setChurchTax(holder?.churchTax ?? false);
      setTaxResidence(holder?.taxResidence ?? "");
      setError(false);
      setConfirmDelete(false);
    }
    setOpen(next);
  }

  async function onDelete() {
    if (!holder) return;
    setBusy(true);
    setError(false);
    try {
      await api.deleteAccountHolder(holder.id);
      router.refresh();
      setOpen(false);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(false);
    const by = type === "child" && birthYear.trim() !== "" ? Number(birthYear) : null;
    const input = {
      name: trimmed,
      type,
      birthYear: by,
      taxAllowanceAnnual: taxAllowance.trim() !== "" ? taxAllowance.trim() : null,
      capitalGainsTaxRate: taxRate.trim() !== "" ? taxRate.trim() : null,
      churchTax: churchTax,
      taxResidence: taxResidence.trim().toUpperCase() || null,
    };
    try {
      if (mode === "edit" && holder) {
        await api.updateAccountHolder(holder.id, input);
      } else {
        await api.createAccountHolder(input);
      }
      router.refresh();
      setOpen(false);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetTrigger asChild>{trigger}</SheetTrigger>
      <SheetContent aria-describedby={subtitleId}>
        <SheetHeader className="pb-0">
          <SheetTitle>{mode === "edit" ? t("editTitle") : t("createTitle")}</SheetTitle>
          <p id={subtitleId} className="text-xs font-medium text-text-2">
            {t("subtitle")}
          </p>
        </SheetHeader>

        <form onSubmit={submit} className="space-y-4 p-6 pt-4">
          {error && (
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
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={tf("accountHolderPlaceholder")}
              required
            />
          </div>

          <div className="space-y-1.5">
            <Label id="holder-type-label">{tf("holderType")}</Label>
            <HolderTypeChips value={type} onChange={setType} labelledBy="holder-type-label" />
          </div>

          {type === "child" && (
            <div className="space-y-1.5">
              <Label htmlFor="holder-birth-year">{tf("birthYear")}</Label>
              <Input
                id="holder-birth-year"
                type="number"
                inputMode="numeric"
                placeholder={tf("birthYearPlaceholder")}
                value={birthYear}
                onChange={(e) => setBirthYear(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">{tf("birthYearHint")}</p>
            </div>
          )}

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
                  value={taxResidence}
                  onChange={(e) => setTaxResidence(e.target.value.toUpperCase())}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="holder-tax-allowance">{t("taxAllowance")}</Label>
                <Input
                  id="holder-tax-allowance"
                  type="number"
                  inputMode="decimal"
                  placeholder="1000"
                  value={taxAllowance}
                  onChange={(e) => setTaxAllowance(e.target.value)}
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
                  value={taxRate}
                  onChange={(e) => setTaxRate(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">{t("capitalGainsTaxRateHint")}</p>
              </div>
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={churchTax}
                  onChange={(e) => setChurchTax(e.target.checked)}
                  className="size-4"
                />
                {t("churchTax")}
              </label>
            </div>
          </details>

          <div className="pt-2">
            <Button
              type="submit"
              disabled={busy || !name.trim()}
              className="h-auto w-full rounded-[15px] py-[15px] text-[15px] font-bold"
            >
              {busy && <Loader2 className="size-4 animate-spin" />}
              {mode === "edit" ? tf("save") : t("add")}
            </Button>

            {/* Edit mode: full-width red delete text → two-step confirm (solid red + caption),
                mirroring the portfolio edit sheet and the reference's remove-holder action. */}
            {mode === "edit" &&
              (confirmDelete ? (
                <>
                  <Button
                    type="button"
                    onClick={onDelete}
                    disabled={busy}
                    className="mt-2.5 h-auto w-full rounded-[15px] bg-[#E5484D] py-[15px] text-[15px] font-bold text-white hover:bg-[#E5484D]/90"
                  >
                    {busy && <Loader2 className="size-4 animate-spin" />}
                    {t("confirmDelete")}
                  </Button>
                  <p className="mt-1.5 text-center text-[11px] font-medium text-text-3">
                    {t("deleteWarning")}
                  </p>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmDelete(true)}
                  disabled={busy}
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
