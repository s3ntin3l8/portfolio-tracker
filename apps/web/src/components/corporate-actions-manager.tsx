"use client";

import { useState } from "react";
import { useTranslations, useLocale } from "next-intl";
import { Check, Loader2, Pencil, Trash2, X } from "lucide-react";
import type { CorporateAction } from "@portfolio/api-client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { useApiClient } from "@/lib/api";
import { useRouter } from "@/i18n/navigation";

const TYPES = ["split", "bonus", "rights"] as const;

/**
 * Editable list of an instrument's corporate actions: inline edit
 * (type / ratio / ex-date) and a two-step delete per row. Derived holdings
 * recompute on the next server render (`router.refresh()`).
 */
export function CorporateActionsManager({
  items: initial,
}: {
  items: CorporateAction[];
}) {
  const t = useTranslations("Instrument");
  const tc = useTranslations("CorpAction");
  const tt = useTranslations("TxType");
  const locale = useLocale();
  const df = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });
  const api = useApiClient();
  const router = useRouter();

  const [items, setItems] = useState(initial);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [type, setType] = useState<(typeof TYPES)[number]>("split");
  const [ratio, setRatio] = useState("");
  const [exDate, setExDate] = useState("");

  function beginEdit(ca: CorporateAction) {
    setConfirmId(null);
    setEditingId(ca.id);
    setType(ca.type as (typeof TYPES)[number]);
    setRatio(ca.ratio);
    setExDate(ca.exDate.slice(0, 10));
  }

  async function save(id: string) {
    setBusy(true);
    try {
      const updated = await api.updateCorporateAction(id, {
        type,
        ratio: ratio || "1",
        exDate: new Date(exDate),
      });
      setItems((prev) => prev.map((c) => (c.id === id ? updated : c)));
      setEditingId(null);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    try {
      await api.deleteCorporateAction(id);
      setItems((prev) => prev.filter((c) => c.id !== id));
      router.refresh();
    } finally {
      setBusy(false);
      setConfirmId(null);
    }
  }

  if (items.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">{t("noCorporateActions")}</p>
    );
  }

  return (
    <ul className="divide-y divide-border text-sm">
      {items.map((ca) =>
        editingId === ca.id ? (
          <li key={ca.id} className="flex flex-wrap items-end gap-2 py-2">
            <div className="space-y-1">
              <span className="text-xs text-muted-foreground">
                {tc("type")}
              </span>
              <Select
                aria-label={tc("type")}
                value={type}
                onChange={(e) =>
                  setType(e.target.value as (typeof TYPES)[number])
                }
              >
                {TYPES.map((ty) => (
                  <option key={ty} value={ty}>
                    {tt(ty)}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1">
              <span className="text-xs text-muted-foreground">
                {tc("ratio")}
              </span>
              <Input
                aria-label={tc("ratio")}
                inputMode="decimal"
                className="w-24"
                value={ratio}
                onChange={(e) => setRatio(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <span className="text-xs text-muted-foreground">
                {tc("exDate")}
              </span>
              <Input
                aria-label={tc("exDate")}
                type="date"
                className="w-40"
                value={exDate}
                onChange={(e) => setExDate(e.target.value)}
              />
            </div>
            <div className="flex items-center gap-1">
              <Button
                size="icon"
                variant="ghost"
                aria-label={tc("save")}
                disabled={busy}
                onClick={() => save(ca.id)}
              >
                {busy ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Check className="size-4" />
                )}
              </Button>
              <Button
                size="icon"
                variant="ghost"
                aria-label={tc("cancel")}
                disabled={busy}
                onClick={() => setEditingId(null)}
              >
                <X className="size-4" />
              </Button>
            </div>
          </li>
        ) : (
          <li key={ca.id} className="flex items-center justify-between gap-2 py-2">
            <Badge variant="outline">{tt(ca.type)}</Badge>
            <span className="tabular ml-auto text-muted-foreground">
              {t("ratio")} {ca.ratio} · {t("exDate")}{" "}
              {df.format(new Date(ca.exDate))}
            </span>
            {confirmId === ca.id ? (
              <span className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={busy}
                  onClick={() => remove(ca.id)}
                >
                  {busy && <Loader2 className="size-3.5 animate-spin" />}
                  {tc("delete")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setConfirmId(null)}
                >
                  {tc("cancel")}
                </Button>
              </span>
            ) : (
              <span className="flex items-center gap-1">
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={tc("edit")}
                  onClick={() => beginEdit(ca)}
                >
                  <Pencil className="size-4" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={tc("delete")}
                  onClick={() => {
                    setEditingId(null);
                    setConfirmId(ca.id);
                  }}
                >
                  <Trash2 className="size-4" />
                </Button>
              </span>
            )}
          </li>
        ),
      )}
    </ul>
  );
}
