"use client";

import { useState, useEffect, useId } from "react";
import { useTranslations } from "next-intl";
import { AlertCircle, ChevronDown, Loader2, TriangleAlert } from "lucide-react";
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
import { Switch } from "@/components/ui/switch";
import { HolderTypeChips } from "@/components/holder-type-chips";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
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
  const subtitleId = useId();

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
  const effectiveHolderId =
    accountHolderId !== NEW_HOLDER && accountHolderId !== "" ? accountHolderId : null;
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
    <Sheet open={open} onOpenChange={onOpenChange} dismissible={false}>
      <SheetTrigger asChild>{trigger}</SheetTrigger>
      {/* Reference bottom-sheet (Pocket Prototype): pinned to the bottom, 28px top radius,
          drag handle + card-bg close button (from SheetContent). Don't dismiss on outside
          interaction, drag, or window blur: this form often holds pasted broker
          credentials, and a swipe or a click elsewhere (or the window losing focus when
          you switch tabs to copy a password) must not throw the work away. Closes only
          via Save/Done, the X button, or Escape. */}
      <SheetContent
        aria-describedby={subtitleId}
        onInteractOutside={(e) => e.preventDefault()}
        // Also keep the sheet open when focus leaves the window (switching apps/tabs to copy
        // a password) — that blur fires focusOutside, which onInteractOutside doesn't cover.
        onFocusOutside={(e) => e.preventDefault()}
      >
        <SheetHeader className="pb-0">
          <SheetTitle>{mode === "edit" ? t("editTitle") : t("createTitle")}</SheetTitle>
          <p id={subtitleId} className="text-xs font-medium text-text-2">
            {t("subtitle")}
          </p>
        </SheetHeader>

        {/* Portfolio fields — the submit button lives inside this form. */}
        <form onSubmit={submit} className="space-y-4 p-6 pt-4">
          {error && (
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

          <Eyebrow>{t("sectionOwnership")}</Eyebrow>

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
                  <Label id="new-holder-type-label">{t("holderType")}</Label>
                  <HolderTypeChips
                    value={newHolderType}
                    onChange={setNewHolderType}
                    labelledBy="new-holder-type-label"
                  />
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

          <Eyebrow>{t("sectionAccount")}</Eyebrow>

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

          {/* Base currency + per-depot Freistellungsauftrag (FSA) allocation share one row. */}
          <div className="flex items-start gap-3">
            <div className="w-[130px] shrink-0 space-y-1.5">
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

            <div className="flex-1 space-y-1.5">
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
          </div>

          {/* Advanced accounting options — collapsed by default to keep the sheet short. */}
          <details className="group">
            <summary className="flex cursor-pointer list-none items-center justify-between px-0.5 py-1 [&::-webkit-details-marker]:hidden">
              <span className="text-[11px] font-bold uppercase tracking-[0.06em] text-text-3">
                {t("sectionAccounting")}
              </span>
              <ChevronDown className="size-4 shrink-0 text-text-3 transition-transform group-open:rotate-180" />
            </summary>
            <div className="mt-1">
              <ToggleRow
                id="portfolio-cash-counted"
                checked={cashCounted}
                onCheckedChange={setCashCounted}
                title={t("cashCounted")}
                hint={t("cashCountedHint")}
              />
              {/* Only meaningful when cash is inside the boundary — the guard runs only then. */}
              {cashCounted && (
                <ToggleRow
                  id="portfolio-allow-negative-cash"
                  checked={allowNegativeCash}
                  onCheckedChange={setAllowNegativeCash}
                  title={t("allowNegativeCash")}
                  hint={t("allowNegativeCashHint")}
                />
              )}
              <ToggleRow
                id="portfolio-document-retention"
                checked={documentRetention}
                onCheckedChange={setDocumentRetention}
                title={t("documentRetention")}
                hint={t("documentRetentionHint")}
              />
              <ToggleRow
                id="portfolio-include-in-aggregate"
                checked={includeInAggregate}
                onCheckedChange={setIncludeInAggregate}
                title={t("includeInAggregate")}
                hint={t("includeInAggregateHint")}
              />
            </div>
          </details>

          <div className="sticky bottom-0 -mx-6 bg-background border-t border-border px-6 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))] z-[2] mt-4">
            {/* After a TR/IBKR create the portfolio is saved; swap the create button for Done. */}
            {mode === "create" && createdPortfolio ? (
              <Button
                type="button"
                onClick={() => setOpen(false)}
                className="h-auto w-full rounded-[15px] py-[15px] text-[15px] font-bold"
              >
                {t("done")}
              </Button>
            ) : (
              <Button
                type="submit"
                disabled={busy || !name.trim()}
                className="h-auto w-full rounded-[15px] py-[15px] text-[15px] font-bold"
              >
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

            {/* Edit mode: full-width red delete text → two-step confirm (solid red + caption),
                mirroring the reference's footer delete + delete-confirm sheet. */}
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
                    {t("deleteWarning", { count: portfolio?.transactionCount ?? 0 })}{" "}
                    {t("deleteRelatedNote")}
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

        {/* TR connection section — rendered outside the form to avoid nested <form> issues.
            Appears after the portfolio exists (edit always, create after first save). */}
        {showTrSection && (
          <div className="border-t border-line px-6 pb-6 pt-4">
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
          <div className="border-t border-line px-6 pb-6 pt-4">
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
      </SheetContent>
    </Sheet>
  );
}

/** Uppercase section eyebrow used to group the sheet's fields (reference: 11px/700/upper). */
function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-0.5 text-[11px] font-bold uppercase tracking-[0.06em] text-text-3">
      {children}
    </p>
  );
}

/** A settings toggle row (label + hint on the left, Switch on the right), stacked with
 *  hairline dividers between rows — the reference "Accounting options" list. */
function ToggleRow({
  id,
  checked,
  onCheckedChange,
  title,
  hint,
}: {
  id: string;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  title: string;
  hint: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-t border-line py-3 first:border-t-0">
      <div className="min-w-0">
        <Label htmlFor={id} className="text-[13px] font-semibold text-foreground">
          {title}
        </Label>
        <p className="mt-0.5 text-[11px] font-medium text-text-3">{hint}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} className="shrink-0" />
    </div>
  );
}
