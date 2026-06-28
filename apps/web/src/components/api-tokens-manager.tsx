"use client";

import { useState } from "react";
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

/** The slice of the API client this manager needs (injectable for tests). */
export type ApiTokensClient = Pick<
  ApiClient,
  "listApiTokens" | "createApiToken" | "deleteApiToken"
>;

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
  const [copied, setCopied] = useState(false);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(false);
    setNewSecret(null);
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
    try {
      await navigator.clipboard.writeText(newSecret);
      setCopied(true);
    } catch {
      // Clipboard may be unavailable (insecure context) — the secret is still visible.
    }
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
            <Button type="button" variant="outline" size="sm" onClick={copySecret}>
              {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
              {copied ? t("tokensCopied") : t("tokensCopy")}
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
              <TableHead>{t("tokensName")}</TableHead>
              <TableHead>{t("tokensScope")}</TableHead>
              <TableHead>{t("tokensLastUsed")}</TableHead>
              <TableHead>{t("tokensExpires")}</TableHead>
              <TableHead className="sr-only">{t("tokensRevoke")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tokens.map((tok) => (
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
