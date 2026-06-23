"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { AlertCircle, Loader2, RefreshCw, Plug, Smartphone, Unplug } from "lucide-react";
import { toast } from "sonner";
import { apiErrorCode } from "@portfolio/api-client";
import type {
  ApiClient,
  TrConnection,
  TrImportCategory,
} from "@portfolio/api-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** The slice of the API client this flow needs (injectable for tests). */
export type TrConnectClient = Pick<
  ApiClient,
  | "connectTr"
  | "verifyTr"
  | "syncTr"
  | "disconnectTr"
  | "getTrConnection"
  | "updateTrCategories"
  | "reimportTr"
  | "reprocessTrDocuments"
>;

// Default staged categories when the connection hasn't been customised (card spending off).
const DEFAULT_CATEGORIES: TrImportCategory[] = ["trade", "income", "cashflow"];
const ALL_CATEGORIES: TrImportCategory[] = ["trade", "income", "cashflow", "card"];

// How long the awaiting phase waits for the approval to resolve before giving up, and
// how often it re-checks the authoritative connection status. The window matches the
// runner's pairing timeout (pairingTimeoutMs, 210s) so the UI doesn't give up first.
const APPROVAL_WINDOW_MS = 210_000;
const STATUS_POLL_INTERVAL_MS = 2500;
const STATUS_POLL_INITIAL_DELAY_MS = 1500;

type Phase = "form" | "awaiting" | "connected";

function phaseFor(status: TrConnection["status"]): Phase {
  if (status === "connected") return "connected";
  if (status === "awaiting_2fa") return "awaiting";
  return "form";
}

export function TrConnectFlow({
  client,
  portfolioId,
  initial,
  onChanged,
}: {
  client: TrConnectClient;
  /**
   * The portfolio this connection binds to. TrConnectFlow is only ever launched from a
   * single portfolio's edit/create dialog, so the target is implicit — there's no picker.
   */
  portfolioId: string;
  initial: TrConnection;
  onChanged?: () => void;
}) {
  const t = useTranslations("TradeRepublic");
  const [phase, setPhase] = useState<Phase>(phaseFor(initial.status));
  const [phone, setPhone] = useState("");
  const [pin, setPin] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [wafToken, setWafToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [categories, setCategories] = useState<Set<TrImportCategory>>(
    new Set(initial.importCategories ?? DEFAULT_CATEGORIES),
  );
  const [confirmingReimport, setConfirmingReimport] = useState(false);

  const expired = initial.status === "expired";

  // Map the API's machine-readable error code (e.g. `pytr_not_available`) to a specific
  // translated message, falling back to the generic one for unknown / non-API errors.
  function messageForError(err: unknown): string {
    const code = apiErrorCode(err);
    if (code && t.has(`errors.${code}`)) return t(`errors.${code}`);
    return t("error");
  }

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(messageForError(err));
    } finally {
      setBusy(false);
    }
  }

  const connect = (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !phone || !pin || !portfolioId) return;
    void run(async () => {
      await client.connectTr({
        phone,
        pin,
        portfolioId,
        ...(showAdvanced && wafToken ? { wafToken } : {}),
      });
      setPin("");
      // Re-arm the awaiting effect so this fresh pairing fires its own verify.
      verifyFiredRef.current = false;
      setPhase("awaiting");
    });
  };

  // Drives the `awaiting` phase. verifyTr() is the request that completes the pairing
  // server-side (it runs awaitApproval and persists the session); we fire it exactly once
  // per pairing and do NOT trust its client-side promise. Under React StrictMode (dev
  // double-mount), an access-token rotation re-creating the client mid-flight, HMR, or a
  // transient network drop, the client request can fail even though Fastify finished the
  // pairing — so we treat GET /tr/connection as the source of truth and poll it until the
  // status leaves `awaiting_2fa`. This is robust to those hiccups and resumes correctly
  // after a page refresh mid-pairing (the fresh mount re-fires verify; the server resumes
  // via hasPendingPairing).
  const verifyFiredRef = useRef(false);
  const windowStartRef = useRef(0);
  useEffect(() => {
    if (phase !== "awaiting") return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;

    if (!verifyFiredRef.current) {
      verifyFiredRef.current = true;
      windowStartRef.current = Date.now();
      // Fire-and-forget: this kicks off server-side completion; the poll observes it.
      void client.verifyTr().catch(() => undefined);
    }

    const poll = async () => {
      if (!active) return;
      try {
        const conn = await client.getTrConnection();
        if (!active) return;
        if (conn.status === "connected") {
          setError(null);
          setPhase("connected");
          onChanged?.();
          return;
        }
        if (conn.status !== "awaiting_2fa") {
          // error / expired / disconnected — the pairing did not complete.
          setError(t("approvalError"));
          setPhase("form");
          return;
        }
      } catch {
        // Transient status read (e.g. token mid-rotation) — keep waiting.
      }
      if (Date.now() - windowStartRef.current > APPROVAL_WINDOW_MS) {
        setError(t("approvalError"));
        setPhase("form");
        return;
      }
      timer = setTimeout(() => void poll(), STATUS_POLL_INTERVAL_MS);
    };
    timer = setTimeout(() => void poll(), STATUS_POLL_INITIAL_DELAY_MS);

    return () => {
      active = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const doSync = () => {
    void client.syncTr().then(() => {
      toast.success(t("syncQueued"));
      onChanged?.();
    }).catch((err: unknown) => {
      toast.error(messageForError(err));
    });
  };

  const disconnect = () =>
    void run(async () => {
      await client.disconnectTr();
      setPhase("form");
      onChanged?.();
    });

  const reimport = () =>
    void run(async () => {
      await client.reimportTr();
      setConfirmingReimport(false);
      onChanged?.();
    });

  const [reprocessDone, setReprocessDone] = useState(false);
  const reprocess = () =>
    void run(async () => {
      await client.reprocessTrDocuments();
      setReprocessDone(true);
    });

  // Toggle a staged category and persist it. At least one must stay enabled (server-enforced).
  const toggleCategory = (cat: TrImportCategory) => {
    const next = new Set(categories);
    if (next.has(cat)) next.delete(cat);
    else next.add(cat);
    if (next.size === 0) return; // never allow an empty selection
    setCategories(next);
    void run(async () => {
      await client.updateTrCategories([...next]);
    });
  };

  return (
    <div className="max-w-md space-y-4">
      {error && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          <AlertCircle className="size-4 shrink-0" />
          {error}
        </div>
      )}

      {phase === "form" && (
        <form onSubmit={connect} className="space-y-4">
          {expired && (
            <p className="text-sm text-muted-foreground">{t("expiredHint")}</p>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="tr-phone">{t("phone")}</Label>
            <Input
              id="tr-phone"
              type="tel"
              placeholder="+49…"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tr-pin">{t("pin")}</Label>
            <Input
              id="tr-pin"
              type="password"
              inputMode="numeric"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
            />
          </div>
          <button
            type="button"
            className="text-xs text-muted-foreground underline"
            onClick={() => setShowAdvanced((v) => !v)}
          >
            {t("advanced")}
          </button>
          {showAdvanced && (
            <div className="space-y-1.5">
              <Label htmlFor="tr-waf">{t("wafToken")}</Label>
              <Input
                id="tr-waf"
                value={wafToken}
                onChange={(e) => setWafToken(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">{t("wafTokenHint")}</p>
            </div>
          )}

          <div className="flex justify-end">
            <Button type="submit" disabled={busy || !phone || !pin || !portfolioId}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Plug className="size-4" />}
              {t("connect")}
            </Button>
          </div>
        </form>
      )}

      {phase === "awaiting" && (
        <div className="space-y-4">
          <div className="flex items-start gap-3 rounded-md border bg-muted/40 px-3 py-3">
            <Smartphone className="size-5 shrink-0 text-muted-foreground" />
            <div className="space-y-1">
              <p className="text-sm font-medium">{t("approveTitle")}</p>
              <p className="text-sm text-muted-foreground">{t("approveHint")}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {t("approveWaiting")}
          </div>
          <div className="flex justify-end">
            <Button variant="outline" onClick={disconnect} disabled={busy}>
              {t("cancel")}
            </Button>
          </div>
        </div>
      )}

      {phase === "connected" && (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">{t("connectedHint")}</p>

          {(() => {
            const recon = initial.lastReconciliation;
            if (!recon) return null;
            return (
              <div className="space-y-1 rounded-md border px-3 py-2 text-sm">
                <p className="font-medium">{t("reconcile.title")}</p>
                {recon.cash.map((c) => {
                  const off = Number(c.diff) !== 0;
                  return (
                    <div key={c.currency} className="flex justify-between gap-2">
                      <span className="text-muted-foreground">
                        {t("reconcile.row", { currency: c.currency, reported: c.reported, derived: c.derived })}
                      </span>
                      <span className={off ? "text-destructive" : "text-muted-foreground"}>
                        {off ? t("reconcile.off", { diff: c.diff }) : t("reconcile.match")}
                      </span>
                    </div>
                  );
                })}
              </div>
            );
          })()}

          <fieldset className="space-y-2 rounded-md border px-3 py-3">
            <legend className="px-1 text-sm font-medium">{t("categories.title")}</legend>
            <p className="text-xs text-muted-foreground">{t("categories.hint")}</p>
            {ALL_CATEGORIES.map((cat) => (
              <label key={cat} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-4 align-middle accent-primary"
                  checked={categories.has(cat)}
                  disabled={busy}
                  onChange={() => toggleCategory(cat)}
                />
                {t(`categories.${cat}`)}
              </label>
            ))}
          </fieldset>

          <div className="flex items-center justify-end gap-3">
            <Button onClick={doSync} disabled={busy}>
              {busy ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RefreshCw className="size-4" />
              )}
              {t("syncNow")}
            </Button>
            <Button variant="outline" onClick={disconnect} disabled={busy}>
              <Unplug className="size-4" />
              {t("disconnect")}
            </Button>
          </div>

          {/* Re-process retained settlement PDFs: enriches tax/fee/price on confirmed
              transactions from stored PDFs without wiping any data. */}
          <div className="border-t pt-3">
            {reprocessDone ? (
              <p className="text-xs text-muted-foreground">{t("reprocess.done")}</p>
            ) : (
              <button
                type="button"
                className="text-xs text-muted-foreground underline"
                onClick={reprocess}
                disabled={busy}
              >
                {t("reprocess.action")}
              </button>
            )}
          </div>

          {/* Re-import: clears the resolved-events ledger + pytr transactions and re-stages
              the whole timeline fresh. Destructive, so it asks for confirmation. */}
          <div className="border-t pt-3">
            {confirmingReimport ? (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-muted-foreground">{t("reimport.warning")}</span>
                <Button variant="destructive" size="sm" onClick={reimport} disabled={busy}>
                  {busy && <Loader2 className="size-3.5 animate-spin" />}
                  {t("reimport.confirm")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirmingReimport(false)}
                  disabled={busy}
                >
                  {t("cancel")}
                </Button>
              </div>
            ) : (
              <button
                type="button"
                className="text-xs text-muted-foreground underline"
                onClick={() => setConfirmingReimport(true)}
              >
                {t("reimport.action")}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
