"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { AlertCircle, Check, Copy, KeyRound, Plus, Trash2 } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import type { ApiClient, ApiToken } from "@portfolio/api-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

const EXPIRY_OPTIONS = [
  { value: "30", labelKey: "tokensExpiry30" },
  { value: "90", labelKey: "tokensExpiry90" },
  { value: "365", labelKey: "tokensExpiry365" },
  { value: "", labelKey: "tokensExpiryNever" },
] as const;

/** The slice of the API client this manager needs (injectable for tests). */
export type ApiTokensClient = Pick<
  ApiClient,
  "listApiTokens" | "createApiToken" | "deleteApiToken"
>;

/**
 * Copy text to the clipboard, returning whether it succeeded. The async Clipboard
 * API only exists in a *secure context* (https or localhost); this app is often served
 * over plain HTTP on a LAN IP, where `navigator.clipboard` is undefined — so fall back
 * to a hidden-textarea + `execCommand("copy")`, which still works there.
 */
async function copyToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the legacy path.
    }
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/**
 * Design (`ProfileSettings.dc.html`, "Data & connections" → API access tokens): a
 * card-row list (key-icon square + name + monospace prefix/last-used line + a scope
 * pill), a "Create token" action, and a centered create-token modal with chip-style
 * scope/expiry pickers — not the previous sortable data table + inline form. Revoke
 * (a small trailing icon per row) isn't in the static mock, but is a real feature the
 * mock doesn't know about — kept per the "preserve real functionality" rule.
 */
export function ApiTokensManager({
  client,
  initialTokens,
}: {
  client: ApiTokensClient;
  initialTokens: ApiToken[];
}) {
  const t = useTranslations("Settings");
  const [tokens, setTokens] = useState<ApiToken[]>(initialTokens);
  const [modalOpen, setModalOpen] = useState(false);
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"read" | "write">("read");
  const [expiresInDays, setExpiresInDays] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  // The plaintext secret is returned exactly once, on creation — held here until the
  // user dismisses it. It is never re-fetchable.
  const [newSecret, setNewSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState<"idle" | "ok" | "fail">("idle");

  function openCreateModal() {
    setName("");
    setScope("read");
    setExpiresInDays("");
    setError(false);
    setNewSecret(null);
    setCopied("idle");
    setModalOpen(true);
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(false);
    try {
      const days = Number.parseInt(expiresInDays, 10);
      const created = await client.createApiToken({
        name: name.trim(),
        scope,
        ...(Number.isFinite(days) && days > 0 ? { expiresInDays: days } : {}),
      });
      setNewSecret(created.token);
      setTokens(await client.listApiTokens());
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    try {
      await client.deleteApiToken(id);
      setTokens((prev) => prev.filter((tok) => tok.id !== id));
    } catch {
      setError(true);
    }
  }

  async function copySecret() {
    if (!newSecret) return;
    const ok = await copyToClipboard(newSecret);
    setCopied(ok ? "ok" : "fail");
    // Revert the button label after a moment so it reads as a confirmation, not a state.
    setTimeout(() => setCopied("idle"), 2000);
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t("tokensHint")}</p>

      {error && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          <AlertCircle className="size-4 shrink-0" />
          {t("tokensError")}
        </div>
      )}

      {tokens.length > 0 && (
        <div className="divide-y divide-border overflow-hidden rounded-[20px] bg-card shadow-card">
          {tokens.map((tok) => (
            <div key={tok.id} className="flex items-center gap-3 px-4 py-3">
              <span className="flex size-[38px] shrink-0 items-center justify-center rounded-[11px] bg-background text-foreground">
                <KeyRound className="size-[18px]" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-bold">{tok.name}</p>
                <p className="truncate font-mono text-xs text-muted-foreground">
                  {tok.tokenPrefix}…{" · "}
                  {tok.lastUsedAt
                    ? t("tokensUsedOn", { date: tok.lastUsedAt.slice(0, 10) })
                    : t("tokensNever")}
                </p>
              </div>
              <span
                className={cn(
                  "shrink-0 rounded-[8px] px-2 py-1 text-[11px] font-bold",
                  tok.scope === "write"
                    ? "bg-[rgba(224,165,58,.16)] text-[var(--gold-fg)]"
                    : "bg-success/15 text-success",
                )}
              >
                {tok.scope === "write" ? t("tokensScopeWrite") : t("tokensScopeRead")}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t("tokensRevoke")}
                onClick={() => revoke(tok.id)}
                className="shrink-0"
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          ))}
        </div>
      )}

      <button
        type="button"
        onClick={openCreateModal}
        className="flex items-center gap-1.5 text-sm font-bold text-success"
      >
        <Plus className="size-4" strokeWidth={2.4} />
        {t("tokensCreate")}
      </button>

      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent className="max-w-[420px] rounded-[22px]">
          {newSecret ? (
            <>
              <DialogHeader>
                <DialogTitle>{t("tokensCreatedTitle")}</DialogTitle>
                <DialogDescription>{t("tokensCreatedWarning")}</DialogDescription>
              </DialogHeader>
              <div className="flex items-center gap-2">
                <code className="flex-1 overflow-x-auto rounded bg-background px-2 py-1 font-mono text-xs">
                  {newSecret}
                </code>
                <Button
                  type="button"
                  variant={copied === "ok" ? "default" : "outline"}
                  size="sm"
                  onClick={copySecret}
                  aria-live="polite"
                >
                  {copied === "ok" ? <Check className="size-4" /> : <Copy className="size-4" />}
                  {copied === "ok"
                    ? t("tokensCopied")
                    : copied === "fail"
                      ? t("tokensCopyFailed")
                      : t("tokensCopy")}
                </Button>
              </div>
              <Button
                type="button"
                onClick={() => setModalOpen(false)}
                className="h-auto w-full rounded-[13px] py-3 text-sm font-bold"
              >
                {t("tokensDone")}
              </Button>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>{t("tokensCreateTitle")}</DialogTitle>
                <DialogDescription>{t("tokensCreateSubtitle")}</DialogDescription>
              </DialogHeader>

              <form onSubmit={create} className="space-y-4">
                {error && (
                  <div
                    role="alert"
                    className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                  >
                    <AlertCircle className="size-4 shrink-0" />
                    {t("tokensError")}
                  </div>
                )}

                <div className="space-y-1.5">
                  <Label htmlFor="token-name">{t("tokensName")}</Label>
                  <Input
                    id="token-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={t("tokensNamePlaceholder")}
                    required
                  />
                </div>

                <div className="space-y-1.5">
                  <Label id="token-scope-label">{t("tokensScope")}</Label>
                  <div
                    role="radiogroup"
                    aria-labelledby="token-scope-label"
                    className="flex w-full gap-[7px]"
                  >
                    {(["read", "write"] as const).map((s) => (
                      <button
                        key={s}
                        type="button"
                        role="radio"
                        aria-checked={scope === s}
                        onClick={() => setScope(s)}
                        className={cn(
                          "flex-1 rounded-[11px] py-[9px] text-center text-[13px] transition-colors",
                          scope === s
                            ? "bg-pill font-bold text-white"
                            : "bg-background font-semibold text-foreground",
                        )}
                      >
                        {s === "read" ? t("tokensScopeRead") : t("tokensScopeWrite")}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label id="token-expiry-label">{t("tokensExpiry")}</Label>
                  <div
                    role="radiogroup"
                    aria-labelledby="token-expiry-label"
                    className="flex flex-wrap gap-[7px]"
                  >
                    {EXPIRY_OPTIONS.map((o) => (
                      <button
                        key={o.labelKey}
                        type="button"
                        role="radio"
                        aria-checked={expiresInDays === o.value}
                        onClick={() => setExpiresInDays(o.value)}
                        className={cn(
                          "rounded-full px-3.5 py-1.5 text-xs font-bold transition-colors",
                          expiresInDays === o.value
                            ? "bg-pill text-white"
                            : "bg-border text-foreground",
                        )}
                      >
                        {t(o.labelKey)}
                      </button>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {expiresInDays
                      ? t("tokensExpiryNoteDays", { days: expiresInDays })
                      : t("tokensExpiryNoteNever")}
                  </p>
                </div>

                <div className="flex items-center justify-end gap-2.5 pt-1">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setModalOpen(false)}
                    className="h-auto rounded-[11px] px-4 py-2.5 text-sm font-bold"
                  >
                    {t("tokensCancel")}
                  </Button>
                  <Button
                    type="submit"
                    disabled={busy || !name.trim()}
                    className="h-auto rounded-[11px] px-4 py-2.5 text-sm font-bold"
                  >
                    {busy && <Spinner size="sm" />}
                    {t("tokensCreate")}
                  </Button>
                </div>
              </form>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
