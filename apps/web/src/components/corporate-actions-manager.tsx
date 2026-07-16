"use client";

import { useState } from "react";
import { useTranslations, useLocale } from "next-intl";
import { ChevronRight, Check, Loader2, Pencil, Trash2, X } from "lucide-react";
import type { CorporateAction } from "@portfolio/api-client";
import { ApiError } from "@portfolio/api-client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-picker";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "sonner";
import { SortableTableHead } from "@/components/ui/sortable-table-head";
import { useApiClient } from "@/lib/api";
import { useRouter } from "@/i18n/navigation";
import { useTableSort } from "@/lib/table-sort";
import type { ColDef } from "@/lib/table-sort";

const CA_COLS: ColDef<CorporateAction>[] = [
  { key: "type", get: (ca) => ca.type, type: "text" },
  { key: "ratio", get: (ca) => ca.ratio, type: "numeric" },
  { key: "exDate", get: (ca) => ca.exDate, type: "date" },
];

const TYPES = ["split", "bonus", "rights"] as const;

/**
 * Editable list of an instrument's corporate actions: inline edit
 * (type / ratio / ex-date) and a two-step delete per row. Derived holdings
 * recompute on the next server render (`router.refresh()`).
 */
export function CorporateActionsManager({
  items: initial,
  isAdmin = true,
}: {
  items: CorporateAction[];
  isAdmin?: boolean;
}) {
  const t = useTranslations("Instrument");
  const tc = useTranslations("CorpAction");
  const tt = useTranslations("TxType");
  const locale = useLocale();
  const df = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });
  const api = useApiClient();
  const router = useRouter();

  const [items, setItems] = useState(initial);
  const { sortKey, sortDir, toggle: toggleSort, sort } = useTableSort<CorporateAction>(CA_COLS);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [type, setType] = useState<(typeof TYPES)[number]>("split");
  const [ratio, setRatio] = useState("");
  const [exDate, setExDate] = useState("");
  const [sheetCa, setSheetCa] = useState<CorporateAction | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

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
      setSheetCa(null);
      router.refresh();
    } catch (err) {
      const msg = err instanceof ApiError ? err.body : tc("saveError");
      toast.error(msg);
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
    } catch (err) {
      const msg = err instanceof ApiError ? err.body : tc("deleteError");
      toast.error(msg);
    } finally {
      setBusy(false);
      setConfirmId(null);
      setSheetCa(null);
      setConfirmDelete(false);
    }
  }

  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("noCorporateActions")}</p>;
  }

  const sorted = sort(items);

  return (
    <>
      <div className="hidden md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <SortableTableHead
                colKey="type"
                sortKey={sortKey}
                sortDir={sortDir}
                onToggle={toggleSort}
              >
                {tc("type")}
              </SortableTableHead>
              <SortableTableHead
                colKey="ratio"
                sortKey={sortKey}
                sortDir={sortDir}
                onToggle={toggleSort}
              >
                {tc("ratio")}
              </SortableTableHead>
              <SortableTableHead
                colKey="exDate"
                sortKey={sortKey}
                sortDir={sortDir}
                onToggle={toggleSort}
              >
                {tc("exDate")}
              </SortableTableHead>
              {isAdmin && (
                <TableCell className="h-10 px-3 text-left align-middle text-xs font-medium text-muted-foreground">
                  <span className="sr-only">{tc("edit")}</span>
                </TableCell>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((ca) =>
              editingId === ca.id ? (
                <TableRow key={ca.id}>
                  <TableCell colSpan={isAdmin ? 4 : 3}>
                    <div className="flex flex-wrap items-end gap-2">
                      <div className="space-y-1">
                        <span className="text-xs text-muted-foreground">{tc("type")}</span>
                        <Select
                          aria-label={tc("type")}
                          value={type}
                          onChange={(e) => setType(e.target.value as (typeof TYPES)[number])}
                        >
                          {TYPES.map((ty) => (
                            <option key={ty} value={ty}>
                              {tt(ty)}
                            </option>
                          ))}
                        </Select>
                      </div>
                      <div className="space-y-1">
                        <span className="text-xs text-muted-foreground">{tc("ratio")}</span>
                        <Input
                          aria-label={tc("ratio")}
                          inputMode="decimal"
                          className="w-24"
                          value={ratio}
                          onChange={(e) => setRatio(e.target.value)}
                        />
                      </div>
                      <div className="space-y-1">
                        <span className="text-xs text-muted-foreground">{tc("exDate")}</span>
                        <DatePicker
                          label={tc("exDate")}
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
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                <TableRow key={ca.id}>
                  <TableCell>
                    <Badge variant="outline">{tt(ca.type)}</Badge>
                  </TableCell>
                  <TableCell className="tabular text-muted-foreground">{ca.ratio}</TableCell>
                  <TableCell className="tabular text-muted-foreground">
                    {df.format(new Date(ca.exDate))}
                  </TableCell>
                  {isAdmin && (
                    <TableCell className="text-right">
                      {confirmId === ca.id ? (
                        <span className="flex items-center justify-end gap-1">
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
                        <span className="flex items-center justify-end gap-1">
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
                    </TableCell>
                  )}
                </TableRow>
              ),
            )}
          </TableBody>
        </Table>
      </div>

      <div className="space-y-3 md:hidden">
        {sorted.map((ca) => (
          <div
            key={ca.id}
            {...(isAdmin
              ? {
                  role: "button",
                  tabIndex: 0,
                  className:
                    "flex cursor-pointer items-center justify-between rounded-[20px] bg-card shadow-card px-4 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  onClick: () => {
                    setConfirmId(null);
                    setEditingId(null);
                    setType(ca.type as (typeof TYPES)[number]);
                    setRatio(ca.ratio);
                    setExDate(ca.exDate.slice(0, 10));
                    setConfirmDelete(false);
                    setSheetCa(ca);
                  },
                  onKeyDown: (e: React.KeyboardEvent) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setConfirmId(null);
                      setEditingId(null);
                      setType(ca.type as (typeof TYPES)[number]);
                      setRatio(ca.ratio);
                      setExDate(ca.exDate.slice(0, 10));
                      setConfirmDelete(false);
                      setSheetCa(ca);
                    }
                  },
                }
              : {
                  className:
                    "flex items-center justify-between rounded-[20px] bg-card shadow-card px-4 py-3",
                })}
          >
            <div>
              <Badge variant="outline">{tt(ca.type)}</Badge>
              <div className="mt-1 text-xs text-muted-foreground tabular-nums">
                {ca.ratio} · {df.format(new Date(ca.exDate))}
              </div>
            </div>
            {isAdmin && <ChevronRight className="size-5 shrink-0 text-muted-foreground" />}
          </div>
        ))}
      </div>

      {isAdmin && (
        <Sheet
          open={sheetCa !== null}
          onOpenChange={(o) => {
            if (!o) {
              setSheetCa(null);
              setConfirmDelete(false);
            }
          }}
        >
          <SheetContent side="bottom" className="px-4 pb-8">
            <SheetHeader>
              <SheetTitle>{tc("edit")}</SheetTitle>
            </SheetHeader>
            {sheetCa && (
              <div className="space-y-4 pt-4">
                <div className="space-y-1">
                  <span className="text-xs text-muted-foreground">{tc("type")}</span>
                  <Select
                    aria-label={tc("type")}
                    value={type}
                    onChange={(e) => setType(e.target.value as (typeof TYPES)[number])}
                  >
                    {TYPES.map((ty) => (
                      <option key={ty} value={ty}>
                        {tt(ty)}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="space-y-1">
                  <span className="text-xs text-muted-foreground">{tc("ratio")}</span>
                  <Input
                    aria-label={tc("ratio")}
                    inputMode="decimal"
                    value={ratio}
                    onChange={(e) => setRatio(e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <span className="text-xs text-muted-foreground">{tc("exDate")}</span>
                  <DatePicker
                    label={tc("exDate")}
                    value={exDate}
                    onChange={(e) => setExDate(e.target.value)}
                  />
                </div>
                <div className="flex gap-2 pt-2">
                  <Button disabled={busy} onClick={() => save(sheetCa.id)}>
                    {busy ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Check className="size-4" />
                    )}
                    {tc("save")}
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      setSheetCa(null);
                      setConfirmDelete(false);
                    }}
                  >
                    <X className="size-4" />
                    {tc("cancel")}
                  </Button>
                </div>
                <div className="border-t border-border pt-4">
                  {confirmDelete ? (
                    <div className="flex gap-2">
                      <Button
                        variant="destructive"
                        onClick={async () => {
                          await remove(sheetCa.id);
                        }}
                      >
                        {busy && <Loader2 className="size-3.5 animate-spin" />}
                        {tc("delete")}
                      </Button>
                      <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
                        {tc("cancel")}
                      </Button>
                    </div>
                  ) : (
                    <Button
                      variant="destructive"
                      className="w-full"
                      onClick={() => setConfirmDelete(true)}
                    >
                      <Trash2 className="size-4" />
                      {tc("delete")}
                    </Button>
                  )}
                </div>
              </div>
            )}
          </SheetContent>
        </Sheet>
      )}
    </>
  );
}
