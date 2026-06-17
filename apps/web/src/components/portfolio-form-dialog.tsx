"use client";

import { useState, useEffect } from "react";
import { useTranslations } from "next-intl";
import { AlertCircle, Loader2 } from "lucide-react";
import type { Portfolio, TrConnection } from "@portfolio/api-client";
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
import { KNOWN_BROKERAGES, resolveBrokerage } from "@/lib/brokerages";
import { BrokerageIcon } from "@/components/brokerage-icon";
import { TrConnectFlow } from "@/components/tr-connect-flow";

const CURRENCIES = ["IDR", "USD", "EUR", "SGD"];

/** The portfolio fields the edit form pre-fills. */
export type EditablePortfolio = Pick<
  Portfolio,
  "id" | "name" | "baseCurrency" | "portfolioType" | "birthYear" | "brokerage"
>;

/**
 * Create/edit a portfolio in a modal. One form serves both flows: in "create" mode
 * it POSTs a new portfolio, in "edit" mode it PATCHes the given one and also exposes
 * a two-step delete in the footer (the delete cascades to the portfolio's
 * transactions, and resets the global switcher if it pointed at this portfolio).
 *
 * The birth year only applies to "child" portfolios, so its input is shown only when
 * the type is set to child — matching the backend, which clears it otherwise.
 *
 * When the portfolio's brokerage is Trade Republic, a TR connection section is shown
 * below the form fields. In create mode, it appears after the portfolio is saved
 * (create-then-connect). In edit mode, it appears immediately. The dialog stays open
 * so the TR connection can be managed without closing and reopening.
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
  const ttr = useTranslations("TradeRepublic");
  const te = useTranslations("Empty");
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
  const [brokerage, setBrokerage] = useState(portfolio?.brokerage ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Create-then-connect: populated after a successful create when brokerage is TR.
  const [createdPortfolio, setCreatedPortfolio] = useState<Portfolio | null>(null);
  // TR connection fetched client-side when the TR section is visible.
  // null = not yet fetched / loading; false = fetch failed; TrConnection = success.
  const [trConnection, setTrConnection] = useState<TrConnection | null | false>(null);
  // Incrementing this triggers a re-fetch (used by onChanged callback).
  const [trFetchSeq, setTrFetchSeq] = useState(0);

  const isTr = resolveBrokerage(brokerage)?.key === "trade-republic";
  // In edit mode the portfolio already exists; in create mode it exists after creation.
  const effectivePortfolio = mode === "edit" ? portfolio : createdPortfolio;
  // Show the TR section only once we have a real portfolio id to bind against.
  const showTrSection = effectivePortfolio != null && isTr;

  // Fetch (or re-fetch) the TR connection when the dialog is open and the section is
  // visible, or when onChanged fires (trFetchSeq bump). Gating on `open` matters: it
  // re-runs the fetch each time the dialog opens (onOpenChange resets trConnection to
  // null), and avoids firing getTrConnection() for every closed TR card on the page.
  // All setState calls are inside async callbacks so the React Compiler rule against
  // synchronous setState in effects is satisfied. getTrConnection always resolves to a
  // TrConnection (status "disconnected" when no row exists) or rejects; null reliably
  // means "loading/not yet fetched".
  useEffect(() => {
    if (!open || !showTrSection) return;
    let active = true;
    api
      .getTrConnection()
      .then((conn) => {
        if (active) setTrConnection(conn);
      })
      .catch(() => {
        if (active) setTrConnection(false);
      });
    return () => {
      active = false;
    };
    // api is stable (context); open, showTrSection and trFetchSeq are the real triggers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, showTrSection, trFetchSeq]);

  // Reset the form to the portfolio's current values whenever the dialog opens, so a
  // cancelled edit never leaks stale drafts into the next open.
  function onOpenChange(next: boolean) {
    if (next) {
      setName(portfolio?.name ?? "");
      setCurrency(portfolio?.baseCurrency ?? "IDR");
      setType(portfolio?.portfolioType ?? "standard");
      setBirthYear(portfolio?.birthYear != null ? String(portfolio.birthYear) : "");
      setBrokerage(portfolio?.brokerage ?? "");
      setError(false);
      setConfirmDelete(false);
      setCreatedPortfolio(null);
      setTrConnection(null);
      setTrFetchSeq(0);
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
      brokerage: brokerage.trim() || null,
    };
    try {
      if (mode === "edit" && portfolio) {
        await api.updatePortfolio(portfolio.id, input);
        router.refresh();
        // Keep the dialog open when brokerage is TR so the connection section stays
        // accessible; the user can close with the × or the Done button.
        if (!isTr) setOpen(false);
      } else {
        const created = await api.createPortfolio(input);
        router.refresh();
        if (isTr) {
          // Stay open and reveal the TR connection section bound to the new portfolio.
          setCreatedPortfolio(created);
        } else {
          setOpen(false);
        }
      }
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
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  // Derive the initial state for TrConnectFlow. The connection is one-per-user: if it's
  // actively bound to a different portfolio, force the connect form so the user can
  // re-bind here (the server upserts on userId).
  const boundElsewhere =
    trConnection !== null &&
    trConnection !== false &&
    effectivePortfolio != null &&
    trConnection.status !== "disconnected" &&
    trConnection.portfolioId !== null &&
    trConnection.portfolioId !== effectivePortfolio.id;

  const trInitForFlow: TrConnection | null =
    !trConnection  // null (loading) or false (error)
      ? null
      : boundElsewhere
        ? { ...trConnection, status: "disconnected", portfolioId: null }
        : trConnection;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{mode === "edit" ? t("editTitle") : t("createTitle")}</DialogTitle>
          <DialogDescription>{t("subtitle")}</DialogDescription>
        </DialogHeader>

        {/* Portfolio fields — the submit button lives inside this form. */}
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
            <Label htmlFor="portfolio-brokerage">{t("brokerage")}</Label>
            <div className="flex items-center gap-2">
              <BrokerageIcon brokerage={brokerage} />
              <Input
                id="portfolio-brokerage"
                value={brokerage}
                onChange={(e) => setBrokerage(e.target.value)}
                placeholder={t("brokeragePlaceholder")}
                list="brokerage-suggestions"
                autoComplete="off"
              />
            </div>
            <datalist id="brokerage-suggestions">
              {KNOWN_BROKERAGES.map((b) => (
                <option key={b} value={b} />
              ))}
            </datalist>
            {/* Hint shown only in create mode before the portfolio has been saved. */}
            {isTr && !effectivePortfolio && (
              <p className="text-xs text-muted-foreground">{t("trConnectAfterSave")}</p>
            )}
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
            {/* After a TR create the portfolio is saved; swap the create button for Done. */}
            {mode === "create" && createdPortfolio ? (
              <Button type="button" onClick={() => setOpen(false)}>
                {t("done")}
              </Button>
            ) : (
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
            )}
          </DialogFooter>
        </form>

        {/* TR connection section — rendered outside the form to avoid nested <form> issues.
            Appears after the portfolio exists (edit always, create after first save). */}
        {showTrSection && (
          <div className="border-t pt-4">
            <p className="mb-3 text-sm font-medium">{t("trSectionTitle")}</p>
            {trConnection === null ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                <span>{t("trLoading")}</span>
              </div>
            ) : trConnection === false ? (
              <p className="text-sm text-muted-foreground">{te("unavailableBody")}</p>
            ) : (
              <>
                {boundElsewhere && (
                  <div
                    role="note"
                    className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
                  >
                    {ttr("boundElsewhere")}
                  </div>
                )}
                <TrConnectFlow
                  client={api}
                  portfolios={[
                    { id: effectivePortfolio.id, name: effectivePortfolio.name },
                  ]}
                  initial={trInitForFlow!}
                  onChanged={() => {
                    router.refresh();
                    setTrFetchSeq((s) => s + 1);
                  }}
                />
              </>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
