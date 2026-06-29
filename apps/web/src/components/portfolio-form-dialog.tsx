"use client";

import { useState, useEffect } from "react";
import { useTranslations } from "next-intl";
import { AlertCircle, Loader2, TriangleAlert } from "lucide-react";
import type {
  AccountHolder,
  AccountHolderType,
  Portfolio,
  TrConnection,
  IbkrConnection,
} from "@portfolio/api-client";
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
import { deletePortfolioWithCleanup } from "@/lib/delete-portfolio";
import { KNOWN_BROKERAGES, resolveBrokerage } from "@/lib/brokerages";
import { BrokerageIcon } from "@/components/brokerage-icon";
import { TrConnectFlow } from "@/components/tr-connect-flow";
import { IbkrConnectFlow } from "@/components/ibkr-connect-flow";

const CURRENCIES = ["IDR", "USD", "EUR", "SGD"];

/** The portfolio fields the edit form pre-fills. `portfolioType` is read-only here
 * (derived from the holder) and only used to gate the TR connection section. */
export type EditablePortfolio = Pick<
  Portfolio,
  "id" | "name" | "baseCurrency" | "accountHolderId" | "portfolioType" | "brokerage" | "accountNumber" | "iban" | "includeInAggregate" | "cashCounted" | "allowNegativeCash" | "documentRetention" | "taxAllowanceAnnual" | "transactionCount"
>;

// Sentinel select value for "create a new holder inline".
const NEW_HOLDER = "__new__";

/**
 * Create/edit a portfolio in a modal. One form serves both flows: in "create" mode
 * it POSTs a new portfolio, in "edit" mode it PATCHes the given one and also exposes
 * a two-step delete in the footer (the delete cascades to the portfolio's
 * transactions, and resets the global switcher if it pointed at this portfolio).
 *
 * Whom the portfolio belongs to (and therefore its child status + beneficiary birth
 * year) is chosen via the account-holder picker: pick an existing holder or create one
 * inline. Child-ness and the "to age 18" forecast derive from the selected holder.
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
  const tibkr = useTranslations("InteractiveBrokers");
  const te = useTranslations("Empty");
  const api = useApiClient();
  const router = useRouter();

  const [open, setOpen] = useState(false);
  const [name, setName] = useState(portfolio?.name ?? "");
  const [currency, setCurrency] = useState(portfolio?.baseCurrency ?? "IDR");
  // The user's holders (fetched on open) and the selected one. "" = no holder,
  // NEW_HOLDER = create one inline using the fields below.
  const [holders, setHolders] = useState<AccountHolder[]>([]);
  const [accountHolderId, setAccountHolderId] = useState(portfolio?.accountHolderId ?? "");
  const [newHolderName, setNewHolderName] = useState("");
  const [newHolderType, setNewHolderType] = useState<AccountHolderType>("self");
  const [newHolderBirthYear, setNewHolderBirthYear] = useState("");
  const [brokerage, setBrokerage] = useState(portfolio?.brokerage ?? "");
  const [accountNumber, setAccountNumber] = useState(portfolio?.accountNumber ?? "");
  const [iban, setIban] = useState(portfolio?.iban ?? "");
  const [includeInAggregate, setIncludeInAggregate] = useState(portfolio?.includeInAggregate ?? true);
  const [cashCounted, setCashCounted] = useState(portfolio?.cashCounted ?? false);
  const [allowNegativeCash, setAllowNegativeCash] = useState(portfolio?.allowNegativeCash ?? false);
  const [documentRetention, setDocumentRetention] = useState(portfolio?.documentRetention ?? false);
  // Per-depot Freistellungsauftrag allocation (FSA). Empty string = no allocation.
  const [taxAllowanceAnnual, setTaxAllowanceAnnual] = useState(portfolio?.taxAllowanceAnnual ?? "");
  // Sibling portfolios for the same holder — used to compute "€X of €cap allocated" hint.
  const [siblingPortfolios, setSiblingPortfolios] = useState<Portfolio[]>([]);
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
  // IBKR connection — same loading pattern as TR.
  const [ibkrConnection, setIbkrConnection] = useState<IbkrConnection | null | false>(null);
  const [ibkrFetchSeq, setIbkrFetchSeq] = useState(0);

  const isTr = resolveBrokerage(brokerage)?.key === "trade-republic";
  const isIbkr = resolveBrokerage(brokerage)?.key === "interactive-brokers";
  // In edit mode the portfolio already exists; in create mode it exists after creation.
  const effectivePortfolio = mode === "edit" ? portfolio : createdPortfolio;
  // Whether the portfolio is (or would be) a child depot, derived from the chosen
  // holder: the inline new-holder's type, or an existing holder's type.
  const selectedHolder = holders.find((h) => h.id === accountHolderId) ?? null;
  const liveIsChild =
    accountHolderId === NEW_HOLDER
      ? newHolderType === "child"
      : selectedHolder?.type === "child";
  // Trade Republic can't sync child accounts (Kinderdepot). Gate the connect section on the
  // *saved* type so the offer never disagrees with the backend guard that rejects such
  // bindings (#199); use the live child status only for the explanatory note, which is
  // cosmetic and should also be right while creating a child portfolio before its first save.
  const isTrChildSaved = isTr && effectivePortfolio?.portfolioType === "child";
  // Show the explanatory note when the saved portfolio is already a child depot, or
  // when the holder currently chosen would make it one (covers create-before-save and
  // the holders list still loading).
  const showTrChildNote = isTrChildSaved || (isTr && Boolean(liveIsChild));
  // Show the TR section only once we have a real portfolio id to bind against, and never
  // for a TR child account.
  const showTrSection = effectivePortfolio != null && isTr && !isTrChildSaved;
  // IBKR section: show once the portfolio exists.
  const showIbkrSection = effectivePortfolio != null && isIbkr;

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

  useEffect(() => {
    if (!open || !showIbkrSection) return;
    let active = true;
    api
      .getIbkrConnection()
      .then((conn) => {
        if (active) setIbkrConnection(conn);
      })
      .catch(() => {
        if (active) setIbkrConnection(false);
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, showIbkrSection, ibkrFetchSeq]);

  // Load the user's account holders and portfolios when the dialog opens.
  // Holders feed the picker; portfolios feed the FSA allocation helper.
  // Mirrors the TR-connection fetch (all setState inside the async callback).
  useEffect(() => {
    if (!open) return;
    let active = true;
    Promise.all([api.listAccountHolders(), api.listPortfolios()])
      .then(([hs, pfs]) => {
        if (active) {
          setHolders(hs);
          setSiblingPortfolios(pfs);
        }
      })
      .catch(() => {
        if (active) {
          setHolders([]);
          setSiblingPortfolios([]);
        }
      });
    return () => {
      active = false;
    };
    // api is stable (context); open is the real trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Reset the form to the portfolio's current values whenever the dialog opens, so a
  // cancelled edit never leaks stale drafts into the next open.
  function onOpenChange(next: boolean) {
    if (next) {
      setName(portfolio?.name ?? "");
      setCurrency(portfolio?.baseCurrency ?? "IDR");
      setAccountHolderId(portfolio?.accountHolderId ?? "");
      setNewHolderName("");
      setNewHolderType("self");
      setNewHolderBirthYear("");
      setBrokerage(portfolio?.brokerage ?? "");
      setAccountNumber(portfolio?.accountNumber ?? "");
      setIban(portfolio?.iban ?? "");
      setIncludeInAggregate(portfolio?.includeInAggregate ?? true);
      setCashCounted(portfolio?.cashCounted ?? false);
      setAllowNegativeCash(portfolio?.allowNegativeCash ?? false);
      setDocumentRetention(portfolio?.documentRetention ?? false);
      setTaxAllowanceAnnual(portfolio?.taxAllowanceAnnual ?? "");
      setSiblingPortfolios([]);
      setError(false);
      setConfirmDelete(false);
      setCreatedPortfolio(null);
      setTrConnection(null);
      setTrFetchSeq(0);
      setIbkrConnection(null);
      setIbkrFetchSeq(0);
    }
    setOpen(next);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    // Creating a new holder inline requires a name.
    if (accountHolderId === NEW_HOLDER && !newHolderName.trim()) return;
    setBusy(true);
    setError(false);
    try {
      // Resolve the holder id: create the inline holder first when requested, so the
      // portfolio links to a real id. Keep local state consistent if the dialog stays
      // open afterwards (TR create-then-connect).
      let holderId: string | null = accountHolderId || null;
      if (accountHolderId === NEW_HOLDER) {
        const by =
          newHolderType === "child" && newHolderBirthYear.trim() !== ""
            ? Number(newHolderBirthYear)
            : null;
        const createdHolder = await api.createAccountHolder({
          name: newHolderName.trim(),
          type: newHolderType,
          birthYear: by,
        });
        holderId = createdHolder.id;
        setHolders((prev) => [...prev, createdHolder]);
        setAccountHolderId(createdHolder.id);
      }
      const fsaTrimmed = taxAllowanceAnnual.trim();
      const input = {
        name: trimmed,
        baseCurrency: currency,
        accountHolderId: holderId,
        brokerage: brokerage.trim() || null,
        accountNumber: accountNumber.trim() || null,
        iban: iban.trim() || null,
        includeInAggregate,
        cashCounted,
        allowNegativeCash,
        documentRetention,
        taxAllowanceAnnual: fsaTrimmed !== "" ? fsaTrimmed : null,
      };
      if (mode === "edit" && portfolio) {
        await api.updatePortfolio(portfolio.id, input);
        router.refresh();
        setOpen(false);
      } else {
        const created = await api.createPortfolio(input);
        router.refresh();
        if ((isTr && created.portfolioType !== "child") || isIbkr) {
          // Stay open and reveal the broker connection section bound to the new portfolio.
          // TR child accounts can't sync, so close like a non-TR portfolio.
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
      await deletePortfolioWithCleanup(api, router, portfolio.id);
      setOpen(false);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  // FSA allocation helper: sum all sibling portfolios' allocations for the selected
  // holder (excluding the current portfolio to avoid double-counting), then add the
  // current input value. Used to show "€X of €cap allocated — €Y left" in the form.
  const effectiveHolderId = accountHolderId !== NEW_HOLDER ? accountHolderId : null;
  const selectedHolderObj = holders.find((h) => h.id === effectiveHolderId) ?? null;
  const holderAllowanceCap = Number(selectedHolderObj?.taxAllowanceAnnual ?? 1000);
  const siblingsTotal = siblingPortfolios
    .filter((p) => p.accountHolderId === effectiveHolderId && p.id !== portfolio?.id)
    .reduce((sum, p) => sum + Number(p.taxAllowanceAnnual ?? 0), 0);
  const currentFsaNum = Number(taxAllowanceAnnual) || 0;
  const totalAllocated = siblingsTotal + currentFsaNum;
  const fsaRemainingForHolder = Math.max(0, holderAllowanceCap - totalAllocated);
  const fsaOverAllocated = effectiveHolderId != null && totalAllocated > holderAllowanceCap;
  const showFsaHelper = effectiveHolderId != null && siblingPortfolios.length > 0;

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
      {/* Don't dismiss on outside interaction: this form often holds pasted broker
          credentials, and a click elsewhere (or the window losing focus when you
          switch tabs to copy a password) must not throw the work away. Closes only
          via Save/Done, the X button, or Escape. */}
      <DialogContent
        className="max-h-[90dvh] overflow-y-auto"
        onInteractOutside={(e) => e.preventDefault()}
      >
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
            {isTr && !effectivePortfolio && !showTrChildNote && (
              <p className="text-xs text-muted-foreground">{t("trConnectAfterSave")}</p>
            )}
            {/* TR can't sync child accounts — explain instead of offering the connection. */}
            {showTrChildNote && (
              <p className="text-xs text-muted-foreground">{t("trChildUnsupported")}</p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="portfolio-account-holder">{t("accountHolder")}</Label>
            <Select
              id="portfolio-account-holder"
              value={accountHolderId}
              onChange={(e) => setAccountHolderId(e.target.value)}
            >
              <option value="">{t("holderNone")}</option>
              {holders.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                  {h.type === "child" ? ` · ${t("holderTypeChild")}` : ""}
                  {h.birthYear != null ? ` (${h.birthYear})` : ""}
                </option>
              ))}
              <option value={NEW_HOLDER}>{t("holderNew")}</option>
            </Select>
            <p className="text-xs text-muted-foreground">{t("accountHolderHint")}</p>

            {accountHolderId === NEW_HOLDER && (
              <div className="mt-2 space-y-3 rounded-md border border-border/60 p-3">
                <div className="space-y-1.5">
                  <Label htmlFor="new-holder-name">{t("holderName")}</Label>
                  <Input
                    id="new-holder-name"
                    value={newHolderName}
                    onChange={(e) => setNewHolderName(e.target.value)}
                    placeholder={t("accountHolderPlaceholder")}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="new-holder-type">{t("holderType")}</Label>
                  <Select
                    id="new-holder-type"
                    value={newHolderType}
                    onChange={(e) => setNewHolderType(e.target.value as AccountHolderType)}
                  >
                    <option value="self">{t("holderTypeSelf")}</option>
                    <option value="child">{t("holderTypeChild")}</option>
                    <option value="other">{t("holderTypeOther")}</option>
                  </Select>
                </div>
                {newHolderType === "child" && (
                  <div className="space-y-1.5">
                    <Label htmlFor="new-holder-birth-year">{t("birthYear")}</Label>
                    <Input
                      id="new-holder-birth-year"
                      type="number"
                      inputMode="numeric"
                      placeholder={t("birthYearPlaceholder")}
                      value={newHolderBirthYear}
                      onChange={(e) => setNewHolderBirthYear(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">{t("birthYearHint")}</p>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="portfolio-account-number">{t("accountNumber")}</Label>
            <Input
              id="portfolio-account-number"
              value={accountNumber}
              onChange={(e) => setAccountNumber(e.target.value)}
              placeholder={t("accountNumberPlaceholder")}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="portfolio-iban">{t("iban")}</Label>
            <Input
              id="portfolio-iban"
              value={iban}
              onChange={(e) => setIban(e.target.value)}
              placeholder={t("ibanPlaceholder")}
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

          {/* Per-depot Freistellungsauftrag (FSA) allocation */}
          <div className="space-y-1.5">
            <Label htmlFor="portfolio-fsa">{t("taxAllowanceAnnual")}</Label>
            <Input
              id="portfolio-fsa"
              type="number"
              inputMode="decimal"
              min={0}
              step={1}
              value={taxAllowanceAnnual}
              onChange={(e) => setTaxAllowanceAnnual(e.target.value)}
              placeholder={t("taxAllowanceAnnualPlaceholder")}
            />
            {showFsaHelper && !fsaOverAllocated && (
              <p className="text-xs text-muted-foreground">
                {t("taxAllowanceHelper", {
                  allocated: totalAllocated.toFixed(0),
                  cap: holderAllowanceCap.toFixed(0),
                  remaining: fsaRemainingForHolder.toFixed(0),
                  holder: selectedHolderObj?.name ?? "",
                })}
              </p>
            )}
            {showFsaHelper && fsaOverAllocated && (
              <div className="flex items-start gap-1.5 text-xs text-yellow-700 dark:text-yellow-300">
                <TriangleAlert className="size-3.5 mt-0.5 shrink-0" />
                <span>{t("taxAllowanceOverAllocated", { cap: holderAllowanceCap.toFixed(0) })}</span>
              </div>
            )}
            {!showFsaHelper && (
              <p className="text-xs text-muted-foreground">{t("taxAllowanceAnnualHint")}</p>
            )}
          </div>

          <div className="flex items-center gap-3">
            <input
              id="portfolio-cash-counted"
              type="checkbox"
              checked={cashCounted}
              onChange={(e) => setCashCounted(e.target.checked)}
              className="size-4 rounded border-input accent-primary"
            />
            <div>
              <Label htmlFor="portfolio-cash-counted">{t("cashCounted")}</Label>
              <p className="text-xs text-muted-foreground">{t("cashCountedHint")}</p>
            </div>
          </div>

          {/* Only meaningful when cash is inside the boundary — the guard runs only then. */}
          {cashCounted && (
            <div className="flex items-center gap-3">
              <input
                id="portfolio-allow-negative-cash"
                type="checkbox"
                checked={allowNegativeCash}
                onChange={(e) => setAllowNegativeCash(e.target.checked)}
                className="size-4 rounded border-input accent-primary"
              />
              <div>
                <Label htmlFor="portfolio-allow-negative-cash">{t("allowNegativeCash")}</Label>
                <p className="text-xs text-muted-foreground">{t("allowNegativeCashHint")}</p>
              </div>
            </div>
          )}

          <div className="flex items-center gap-3">
            <input
              id="portfolio-document-retention"
              type="checkbox"
              checked={documentRetention}
              onChange={(e) => setDocumentRetention(e.target.checked)}
              className="size-4 rounded border-input accent-primary"
            />
            <div>
              <Label htmlFor="portfolio-document-retention">{t("documentRetention")}</Label>
              <p className="text-xs text-muted-foreground">{t("documentRetentionHint")}</p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <input
              id="portfolio-include-in-aggregate"
              type="checkbox"
              checked={includeInAggregate}
              onChange={(e) => setIncludeInAggregate(e.target.checked)}
              className="size-4 rounded border-input accent-primary"
            />
            <div>
              <Label htmlFor="portfolio-include-in-aggregate">
                {t("includeInAggregate")}
              </Label>
              <p className="text-xs text-muted-foreground">{t("includeInAggregateHint")}</p>
            </div>
          </div>

          <DialogFooter className="pt-2">
            {mode === "edit" &&
              (confirmDelete ? (
                <div className="mr-auto flex flex-col gap-2 sm:flex-row sm:items-center">
                  <p className="text-xs text-muted-foreground">
                    {t("deleteWarning", { count: portfolio?.transactionCount ?? 0 })}{" "}
                    {t("deleteRelatedNote")}
                  </p>
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
            {/* After a TR/IBKR create the portfolio is saved; swap the create button for Done. */}
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
                  portfolioId={effectivePortfolio.id}
                  cashCounted={cashCounted}
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

        {/* IBKR connection section — same pattern as TR but simpler (no 2FA phase). */}
        {showIbkrSection && (
          <div className="border-t pt-4">
            <p className="mb-3 text-sm font-medium">{tibkr("sectionTitle")}</p>
            {ibkrConnection === null ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                <span>{t("trLoading")}</span>
              </div>
            ) : ibkrConnection === false ? (
              <p className="text-sm text-muted-foreground">{te("unavailableBody")}</p>
            ) : (
              <IbkrConnectFlow
                client={api}
                portfolioId={effectivePortfolio!.id}
                initial={ibkrConnection}
                onChanged={() => {
                  router.refresh();
                  setIbkrFetchSeq((s) => s + 1);
                }}
              />
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
