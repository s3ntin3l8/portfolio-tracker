"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { AlertCircle, Check, Copy, Loader2, Trash2 } from "lucide-react";
import type { ApiClient, ApiToken } from "@portfolio/api-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SortableTableHead } from "@/components/ui/sortable-table-head";
import { useTableSort, type ColDef } from "@/lib/table-sort";

const TOKEN_COLS: ColDef<ApiToken>[] = [
  { key: "name", get: (t) => t.name, type: "text" },
  { key: "scope", get: (t) => t.scope, type: "text" },
  { key: "lastUsed", get: (t) => t.lastUsedAt ?? "", type: "date" },
  { key: "expires", get: (t) => t.expiresAt ?? "", type: "date" },
];

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

export function ApiTokensManager({
  client,
  initialTokens,
}: {
  client: ApiTokensClient;
  initialTokens: ApiToken[];
}) {
  const t = useTranslations("Settings");
  const [tokens, setTokens] = useState<ApiToken[]>(initialTokens);
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"read" | "write">("read");
  const [expiresInDays, setExpiresInDays] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  // The plaintext secret is returned exactly once, on creation — held here until the
  // user dismisses it. It is never re-fetchable.
  const [newSecret, setNewSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState<"idle" | "ok" | "fail">("idle");
  const { sortKey, sortDir, toggle, sort } = useTableSort<ApiToken>(TOKEN_COLS);
  const sortedTokens = useMemo(() => sort(tokens), [tokens, sort]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(false);
    setNewSecret(null);
    setCopied("idle");
    try {
      const days = Number.parseInt(expiresInDays, 10);
      const created = await client.createApiToken({
        name: name.trim(),
        scope,
        ...(Number.isFinite(days) && days > 0 ? { expiresInDays: days } : {}),
      });
      setNewSecret(created.token);
      setName("");
      setExpiresInDays("");
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

      {newSecret && (
        <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-3">
          <p className="text-sm font-medium">{t("tokensCreatedTitle")}</p>
          <p className="text-xs text-muted-foreground">{t("tokensCreatedWarning")}</p>
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
        </div>
      )}

      <form onSubmit={create} className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="token-name">{t("tokensName")}</Label>
          <Input
            id="token-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("tokensNamePlaceholder")}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="token-scope">{t("tokensScope")}</Label>
          <Select
            id="token-scope"
            value={scope}
            onChange={(e) => setScope(e.target.value as "read" | "write")}
          >
            <option value="read">{t("tokensScopeRead")}</option>
            <option value="write">{t("tokensScopeWrite")}</option>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="token-expiry">{t("tokensExpiry")}</Label>
          <Input
            id="token-expiry"
            type="number"
            min={1}
            value={expiresInDays}
            onChange={(e) => setExpiresInDays(e.target.value)}
            placeholder={t("tokensExpiryPlaceholder")}
            className="w-28"
          />
        </div>
        <Button type="submit" disabled={busy || !name.trim()}>
          {busy && <Loader2 className="size-4 animate-spin" />}
          {t("tokensCreate")}
        </Button>
      </form>

      {tokens.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <SortableTableHead colKey="name" sortKey={sortKey} sortDir={sortDir} onToggle={toggle}>{t("tokensName")}</SortableTableHead>
              <SortableTableHead colKey="scope" sortKey={sortKey} sortDir={sortDir} onToggle={toggle}>{t("tokensScope")}</SortableTableHead>
              <SortableTableHead colKey="lastUsed" sortKey={sortKey} sortDir={sortDir} onToggle={toggle}>{t("tokensLastUsed")}</SortableTableHead>
              <SortableTableHead colKey="expires" sortKey={sortKey} sortDir={sortDir} onToggle={toggle}>{t("tokensExpires")}</SortableTableHead>
              <TableHead className="sr-only">{t("tokensRevoke")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortedTokens.map((tok) => (
              <TableRow key={tok.id}>
                <TableCell>
                  <span className="font-medium">{tok.name}</span>
                  <span className="ml-2 font-mono text-xs text-muted-foreground">
                    {tok.tokenPrefix}…
                  </span>
                </TableCell>
                <TableCell>{tok.scope}</TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {tok.lastUsedAt ? tok.lastUsedAt.slice(0, 10) : t("tokensNever")}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {tok.expiresAt ? tok.expiresAt.slice(0, 10) : t("tokensNoExpiry")}
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={t("tokensRevoke")}
                    onClick={() => revoke(tok.id)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
