"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { AlertCircle, Loader2, RefreshCw, Plug, Smartphone, Unplug } from "lucide-react";
import { apiErrorCode } from "@portfolio/api-client";
import type {
  ApiClient,
  TrConnection,
  TrSyncResult,
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

const selectClass =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function TrConnectFlow({
  client,
  portfolios,
  initial,
  onChanged,
}: {
  client: TrConnectClient;
  portfolios: { id: string; name: string }[];
  initial: TrConnection;
  onChanged?: () => void;
}) {
  const t = useTranslations("TradeRepublic");
  const [phase, setPhase] = useState<Phase>(phaseFor(initial.status));
  const [phone, setPhone] = useState("");
  const [pin, setPin] = useState("");
  const [portfolioId, setPortfolioId] = useState(
    initial.portfolioId ?? portfolios[0]?.id ?? "",
  );
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [wafToken, setWafToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sync, setSync] = useState<TrSyncResult | null>(null);
  const [categories, setCategories] = useState<Set<TrImportCategory>>(
    new Set(initial.importCategories ?? DEFAULT_CATEGORIES),
  );

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

  const doSync = () =>
    void run(async () => {
      const result = await client.syncTr();
      setSync(result);
      onChanged?.();
    });

  const disconnect = () =>
    void run(async () => {
      await client.disconnectTr();
      setSync(null);
      setPhase("form");
      onChanged?.();
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
          <div className="space-y-1.5">
            <Label htmlFor="tr-portfolio">{t("portfolio")}</Label>
            <select
              id="tr-portfolio"
              className={selectClass}
              value={portfolioId}
              onChange={(e) => setPortfolioId(e.target.value)}
            >
              {portfolios.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
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

          <Button type="submit" disabled={busy || !phone || !pin || !portfolioId}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Plug className="size-4" />}
            {t("connect")}
          </Button>
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
          <Button variant="outline" onClick={disconnect} disabled={busy}>
            {t("cancel")}
          </Button>
        </div>
      )}

      {phase === "connected" && (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">{t("connectedHint")}</p>
          {sync && (
            <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
              {t("synced", { drafts: sync.drafts ?? 0 })}
            </div>
          )}

          {(() => {
            const recon = sync?.reconciliation ?? initial.lastReconciliation;
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

          <div className="flex items-center gap-3">
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
        </div>
      )}
    </div>
  );
}
