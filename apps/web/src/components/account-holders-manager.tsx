"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2, Plus, Trash2, UserRound } from "lucide-react";
import type { AccountHolder, AccountHolderType } from "@portfolio/api-client";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useApiClient } from "@/lib/api";
import { useRouter } from "@/i18n/navigation";

const HOLDER_TYPES: AccountHolderType[] = ["self", "child", "other"];

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
    <Card>
      <CardContent className="space-y-4 p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-medium">{t("title")}</h2>
            <p className="text-xs text-muted-foreground">{t("subtitle")}</p>
          </div>
          <HolderFormDialog
            mode="create"
            trigger={
              <Button size="sm" variant="outline">
                <Plus className="size-4" />
                {t("add")}
              </Button>
            }
          />
        </div>

        {holders.length > 0 ? (
          <ul className="divide-y divide-border/60">
            {holders.map((h) => (
              <li key={h.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="flex min-w-0 items-center gap-2.5">
                  <UserRound className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{h.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {tf(`holderType${capitalize(h.type)}`)}
                      {h.birthYear != null ? ` · ${h.birthYear}` : ""}
                    </p>
                  </div>
                </div>
                <HolderFormDialog
                  mode="edit"
                  holder={h}
                  trigger={
                    <Button size="sm" variant="ghost">
                      {tf("edit")}
                    </Button>
                  }
                />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        )}
      </CardContent>
    </Card>
  );
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Create or edit a single holder. Edit mode also exposes a two-step delete. */
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

  async function onDelete() {
    if (!holder) return;
    setBusy(true);
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{mode === "edit" ? t("editTitle") : t("createTitle")}</DialogTitle>
          <DialogDescription>{t("subtitle")}</DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-4">
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
            <Label htmlFor="holder-type">{tf("holderType")}</Label>
            <Select
              id="holder-type"
              value={type}
              onChange={(e) => setType(e.target.value as AccountHolderType)}
            >
              {HOLDER_TYPES.map((tp) => (
                <option key={tp} value={tp}>
                  {tf(`holderType${capitalize(tp)}`)}
                </option>
              ))}
            </Select>
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

          <DialogFooter className="pt-2">
            {mode === "edit" &&
              (confirmDelete ? (
                <div className="mr-auto flex flex-col gap-2 sm:flex-row sm:items-center">
                  <p className="text-xs text-muted-foreground">{t("deleteWarning")}</p>
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    onClick={onDelete}
                    disabled={busy}
                  >
                    {busy && <Loader2 className="size-3.5 animate-spin" />}
                    {t("confirmDelete")}
                  </Button>
                </div>
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  className="mr-auto text-destructive hover:text-destructive"
                  onClick={() => setConfirmDelete(true)}
                  disabled={busy}
                >
                  <Trash2 className="size-4" />
                  {t("delete")}
                </Button>
              ))}
            <Button type="submit" disabled={busy || !name.trim()}>
              {busy && <Loader2 className="size-4 animate-spin" />}
              {mode === "edit" ? tf("save") : t("add")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
