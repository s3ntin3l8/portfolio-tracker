"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Cake, Loader2, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useApiClient } from "@/lib/api";
import { useRouter } from "@/i18n/navigation";
import { SELECTED_PORTFOLIO_COOKIE } from "@/lib/portfolio-selection";

type Mode = "idle" | "rename" | "delete" | "birthYear";

/**
 * Per-card portfolio controls: inline rename and a two-step delete confirm (the
 * delete cascades to the portfolio's transactions, so the confirm spells that out).
 * Deleting the portfolio that is currently selected in the global switcher resets the
 * switcher back to the "All portfolios" aggregate.
 */
export function PortfolioActions({
  portfolioId,
  name,
  birthYear = null,
}: {
  portfolioId: string;
  name: string;
  birthYear?: number | null;
}) {
  const t = useTranslations("PortfolioActions");
  const api = useApiClient();
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("idle");
  const [draftName, setDraftName] = useState(name);
  const [draftBirthYear, setDraftBirthYear] = useState(
    birthYear !== null ? String(birthYear) : "",
  );
  const [busy, setBusy] = useState(false);

  async function onRename() {
    const next = draftName.trim();
    if (!next || next === name) {
      setMode("idle");
      return;
    }
    setBusy(true);
    try {
      await api.updatePortfolio(portfolioId, { name: next });
      router.refresh();
    } finally {
      setBusy(false);
      setMode("idle");
    }
  }

  async function onSaveBirthYear() {
    const raw = draftBirthYear.trim();
    const next = raw === "" ? null : Number(raw);
    if (next !== null && !Number.isInteger(next)) {
      setMode("idle");
      return;
    }
    setBusy(true);
    try {
      await api.updatePortfolio(portfolioId, { birthYear: next });
      router.refresh();
    } finally {
      setBusy(false);
      setMode("idle");
    }
  }

  async function onDelete() {
    setBusy(true);
    try {
      await api.deletePortfolio(portfolioId);
      // Drop the switcher's selection if it pointed at the now-deleted portfolio.
      if (document.cookie.includes(`${SELECTED_PORTFOLIO_COOKIE}=${portfolioId}`)) {
        document.cookie = `${SELECTED_PORTFOLIO_COOKIE}=all; path=/; max-age=0; samesite=lax`;
      }
      router.refresh();
    } finally {
      setBusy(false);
      setMode("idle");
    }
  }

  if (mode === "rename") {
    return (
      <div className="flex items-center gap-1">
        <Input
          autoFocus
          value={draftName}
          onChange={(e) => setDraftName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void onRename();
            if (e.key === "Escape") setMode("idle");
          }}
          aria-label={t("rename")}
          className="h-8"
        />
        <Button size="sm" onClick={onRename} disabled={busy}>
          {busy && <Loader2 className="size-3.5 animate-spin" />}
          {t("save")}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setMode("idle")} disabled={busy}>
          {t("cancel")}
        </Button>
      </div>
    );
  }

  if (mode === "birthYear") {
    return (
      <div className="flex items-center gap-1">
        <Input
          autoFocus
          type="number"
          inputMode="numeric"
          placeholder={t("birthYearPlaceholder")}
          value={draftBirthYear}
          onChange={(e) => setDraftBirthYear(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void onSaveBirthYear();
            if (e.key === "Escape") setMode("idle");
          }}
          aria-label={t("setBirthYear")}
          className="h-8 w-24"
        />
        <Button size="sm" onClick={onSaveBirthYear} disabled={busy}>
          {busy && <Loader2 className="size-3.5 animate-spin" />}
          {t("save")}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setMode("idle")} disabled={busy}>
          {t("cancel")}
        </Button>
      </div>
    );
  }

  if (mode === "delete") {
    return (
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">{t("deleteWarning")}</p>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="destructive" onClick={onDelete} disabled={busy}>
            {busy && <Loader2 className="size-3.5 animate-spin" />}
            {t("confirmDelete")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setMode("idle")} disabled={busy}>
            {t("cancel")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1">
      <Button
        size="icon"
        variant="ghost"
        aria-label={t("rename")}
        onClick={() => {
          setDraftName(name);
          setMode("rename");
        }}
      >
        <Pencil className="size-4" />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        aria-label={t("setBirthYear")}
        onClick={() => {
          setDraftBirthYear(birthYear !== null ? String(birthYear) : "");
          setMode("birthYear");
        }}
      >
        <Cake className="size-4" />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        aria-label={t("delete")}
        onClick={() => setMode("delete")}
      >
        <Trash2 className="size-4" />
      </Button>
    </div>
  );
}
