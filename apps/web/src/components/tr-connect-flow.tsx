"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { AlertCircle, Loader2, RefreshCw, Plug, Unplug } from "lucide-react";
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
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sync, setSync] = useState<TrSyncResult | null>(null);

  const expired = initial.status === "expired";

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch {
      setError(t("error"));
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

  const verify = (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !code) return;
    void run(async () => {
      await client.verifyTr(code);
      setCode("");
      setPhase("connected");
      onChanged?.();
    });
  };

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
        <form onSubmit={verify} className="space-y-4">
          <p className="text-sm text-muted-foreground">{t("codeHint")}</p>
          <div className="space-y-1.5">
            <Label htmlFor="tr-code">{t("code")}</Label>
            <Input
              id="tr-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </div>
          <Button type="submit" disabled={busy || !code}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            {t("verify")}
          </Button>
        </form>
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
