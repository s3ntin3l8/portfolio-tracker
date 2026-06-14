"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { AlertCircle, Loader2 } from "lucide-react";
import type { ApiClient } from "@portfolio/api-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** The slice of the API client this form needs (injectable for tests). */
export type CreatePortfolioClient = Pick<ApiClient, "createPortfolio">;

const CURRENCIES = ["IDR", "USD", "EUR", "SGD"];

export function CreatePortfolioForm({
  client,
  onSuccess,
}: {
  client: CreatePortfolioClient;
  onSuccess?: () => void;
}) {
  const t = useTranslations("Manage.portfolio");
  const [name, setName] = useState("");
  const [currency, setCurrency] = useState("IDR");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(false);
    try {
      await client.createPortfolio({ name: name.trim(), baseCurrency: currency });
      setName("");
      onSuccess?.();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="max-w-md space-y-4">
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
        <Label htmlFor="portfolio-currency">{t("currency")}</Label>
        <select
          id="portfolio-currency"
          value={currency}
          onChange={(e) => setCurrency(e.target.value)}
          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {CURRENCIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>

      <Button type="submit" disabled={busy || !name.trim()}>
        {busy && <Loader2 className="size-4 animate-spin" />}
        {busy ? t("creating") : t("create")}
      </Button>
    </form>
  );
}
