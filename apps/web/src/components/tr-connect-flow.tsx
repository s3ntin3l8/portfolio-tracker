"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { AlertCircle, Loader2, RefreshCw, Plug, Smartphone, Unplug } from "lucide-react";
import { apiErrorCode } from "@portfolio/api-client";
import type { ApiClient, TrConnection, TrSyncResult } from "@portfolio/api-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** The slice of the API client this flow needs (injectable for tests). */
export type TrConnectClient = Pick<
  ApiClient,
  "connectTr" | "verifyTr" | "syncTr" | "disconnectTr"
>;

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
      setPhase("awaiting");
    });
  };

  // Once awaiting, long-poll the verify endpoint until the user approves the push in the
  // TR app (resolves → connected) or it is declined / expires (→ back to the form). An
  // effect (not the connect handler) drives this so a page refresh mid-pairing resumes it.
  const pollingRef = useRef(false);
  useEffect(() => {
    if (phase !== "awaiting" || pollingRef.current) return;
    pollingRef.current = true;
    let cancelled = false;
    void (async () => {
      try {
        await client.verifyTr();
        if (!cancelled) {
          setError(null);
          setPhase("connected");
          onChanged?.();
        }
      } catch {
        if (!cancelled) {
          setError(t("approvalError"));
          setPhase("form");
        }
      } finally {
        pollingRef.current = false;
      }
    })();
    return () => {
      cancelled = true;
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
