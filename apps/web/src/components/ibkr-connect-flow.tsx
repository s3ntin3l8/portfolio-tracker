"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { AlertCircle, Loader2, RefreshCw, Plug, Unplug } from "lucide-react";
import { toast } from "sonner";
import { apiErrorCode } from "@portfolio/api-client";
import type { ApiClient, IbkrConnection } from "@portfolio/api-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type IbkrConnectClient = Pick<
  ApiClient,
  "connectIbkr" | "syncIbkr" | "disconnectIbkr" | "getIbkrConnection" | "reimportIbkr"
>;

type Phase = "form" | "connected";

function phaseFor(status: IbkrConnection["status"]): Phase {
  return status === "connected" ? "connected" : "form";
}

export function IbkrConnectFlow({
  client,
  portfolioId,
  initial,
  onChanged,
}: {
  client: IbkrConnectClient;
  portfolioId: string;
  initial: IbkrConnection;
  onChanged?: () => void;
}) {
  const t = useTranslations("InteractiveBrokers");
  const [phase, setPhase] = useState<Phase>(phaseFor(initial.status));
  const [token, setToken] = useState("");
  const [queryId, setQueryId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingReimport, setConfirmingReimport] = useState(false);

  const expired = initial.status === "expired";

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
    if (busy || !token || !queryId || !portfolioId) return;
    void run(async () => {
      await client.connectIbkr({ token, queryId, portfolioId });
      setToken("");
      setPhase("connected");
      onChanged?.();
    });
  };

  const doSync = () => {
    void client
      .syncIbkr()
      .then(() => {
        toast.success(t("syncQueued"));
        onChanged?.();
      })
      .catch((err: unknown) => {
        toast.error(messageForError(err));
      });
  };

  const disconnect = () =>
    void run(async () => {
      await client.disconnectIbkr();
      setPhase("form");
      onChanged?.();
    });

  const reimport = () =>
    void run(async () => {
      await client.reimportIbkr();
      setConfirmingReimport(false);
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
          {expired && <p className="text-sm text-muted-foreground">{t("expiredHint")}</p>}
          <p className="text-xs text-muted-foreground">{t("setupHint")}</p>
          <div className="space-y-1.5">
            <Label htmlFor="ibkr-token">{t("flexToken")}</Label>
            <Input
              id="ibkr-token"
              type="password"
              placeholder={t("flexTokenPlaceholder")}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoComplete="off"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ibkr-query-id">{t("queryId")}</Label>
            <Input
              id="ibkr-query-id"
              type="text"
              inputMode="numeric"
              placeholder={t("queryIdPlaceholder")}
              value={queryId}
              onChange={(e) => setQueryId(e.target.value)}
            />
          </div>

          <div className="flex justify-end">
            <Button type="submit" disabled={busy || !token || !queryId || !portfolioId}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Plug className="size-4" />}
              {t("connect")}
            </Button>
          </div>
        </form>
      )}

      {phase === "connected" && (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">{t("connectedHint")}</p>

          {initial.flexAccountId && (
            <p className="text-xs text-muted-foreground">
              {t("accountId")}: <span className="font-mono">{initial.flexAccountId}</span>
            </p>
          )}

          {initial.lastSyncAt && (
            <p className="text-xs text-muted-foreground">
              {t("lastSync")}: {new Date(initial.lastSyncAt).toLocaleString()}
            </p>
          )}

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
                        {t("reconcile.row", {
                          currency: c.currency,
                          reported: c.reported,
                          derived: c.derived,
                        })}
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
