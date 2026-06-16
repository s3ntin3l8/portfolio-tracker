"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { AlertCircle, Loader2 } from "lucide-react";
import type { Portfolio } from "@portfolio/api-client";
import { Button } from "@/components/ui/button";
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
import { SELECTED_PORTFOLIO_COOKIE } from "@/lib/portfolio-selection";

const CURRENCIES = ["IDR", "USD", "EUR", "SGD"];

/** The portfolio fields the edit form pre-fills. */
export type EditablePortfolio = Pick<
  Portfolio,
  "id" | "name" | "baseCurrency" | "portfolioType" | "birthYear"
>;

/**
 * Create/edit a portfolio in a modal. One form serves both flows: in "create" mode
 * it POSTs a new portfolio, in "edit" mode it PATCHes the given one and also exposes
 * a two-step delete in the footer (the delete cascades to the portfolio's
 * transactions, and resets the global switcher if it pointed at this portfolio).
 *
 * The birth year only applies to "child" portfolios, so its input is shown only when
 * the type is set to child — matching the backend, which clears it otherwise.
 */
export function PortfolioFormDialog({
  mode,
  portfolio,
  trigger,
}: {
  mode: "create" | "edit";
  portfolio?: EditablePortfolio;
  trigger: React.ReactNode;
}) {
  const t = useTranslations("PortfolioForm");
  const api = useApiClient();
  const router = useRouter();

  const [open, setOpen] = useState(false);
  const [name, setName] = useState(portfolio?.name ?? "");
  const [currency, setCurrency] = useState(portfolio?.baseCurrency ?? "IDR");
  const [type, setType] = useState<"standard" | "child">(
    portfolio?.portfolioType ?? "standard",
  );
  const [birthYear, setBirthYear] = useState(
    portfolio?.birthYear != null ? String(portfolio.birthYear) : "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Reset the form to the portfolio's current values whenever the dialog opens, so a
  // cancelled edit never leaks stale drafts into the next open.
  function onOpenChange(next: boolean) {
    if (next) {
      setName(portfolio?.name ?? "");
      setCurrency(portfolio?.baseCurrency ?? "IDR");
      setType(portfolio?.portfolioType ?? "standard");
      setBirthYear(portfolio?.birthYear != null ? String(portfolio.birthYear) : "");
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
    const raw = birthYear.trim();
    const parsedBirthYear = type === "child" && raw !== "" ? Number(raw) : null;
    const input = {
      name: trimmed,
      baseCurrency: currency,
      portfolioType: type,
      birthYear: parsedBirthYear,
    };
    try {
      if (mode === "edit" && portfolio) {
        await api.updatePortfolio(portfolio.id, input);
      } else {
        await api.createPortfolio(input);
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
    if (!portfolio) return;
    setBusy(true);
    try {
      await api.deletePortfolio(portfolio.id);
      // Drop the switcher's selection if it pointed at the now-deleted portfolio.
      if (document.cookie.includes(`${SELECTED_PORTFOLIO_COOKIE}=${portfolio.id}`)) {
        document.cookie = `${SELECTED_PORTFOLIO_COOKIE}=all; path=/; max-age=0; samesite=lax`;
      }
      router.refresh();
      setOpen(false);
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
            <div
              role="alert"
              className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              <AlertCircle className="size-4 shrink-0" />
              {t("error")}
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="portfolio-name">{t("name")}</Label>
            <Input
              id="portfolio-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("namePlaceholder")}
              required
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="portfolio-currency">{t("currency")}</Label>
            <Select
              id="portfolio-currency"
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
            >
              {CURRENCIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="portfolio-type">{t("type")}</Label>
            <Select
              id="portfolio-type"
              value={type}
              onChange={(e) => setType(e.target.value as "standard" | "child")}
            >
              <option value="standard">{t("typeStandard")}</option>
              <option value="child">{t("typeChild")}</option>
            </Select>
          </div>

          {type === "child" && (
            <div className="space-y-1.5">
              <Label htmlFor="portfolio-birth-year">{t("birthYear")}</Label>
              <Input
                id="portfolio-birth-year"
                type="number"
                inputMode="numeric"
                placeholder={t("birthYearPlaceholder")}
                value={birthYear}
                onChange={(e) => setBirthYear(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">{t("birthYearHint")}</p>
            </div>
          )}

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
                  {t("delete")}
                </Button>
              ))}
            <Button type="submit" disabled={busy || !name.trim()}>
              {busy && <Loader2 className="size-4 animate-spin" />}
              {busy
                ? mode === "edit"
                  ? t("saving")
                  : t("creating")
                : mode === "edit"
                  ? t("save")
                  : t("create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
