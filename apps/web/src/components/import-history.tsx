"use client";

import { useState } from "react";
import { useTranslations, useLocale } from "next-intl";
import { Eye, Loader2, Trash2, Undo2 } from "lucide-react";
import type { ImportRecord } from "@portfolio/api-client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SortableTableHead } from "@/components/ui/sortable-table-head";
import { useApiClient } from "@/lib/api";
import { Link, useRouter } from "@/i18n/navigation";
import { useTableSort } from "@/lib/table-sort";
import type { ColDef } from "@/lib/table-sort";

const IH_COLS: ColDef<ImportRecord>[] = [
  { key: "parser", get: (r) => r.parser, type: "text" },
  { key: "status", get: (r) => r.status, type: "text" },
  { key: "count", get: (r) => r.count, type: "numeric" },
  { key: "createdAt", get: (r) => r.createdAt, type: "date" },
];

const STATUS_VARIANT: Record<
  ImportRecord["status"],
  "warning" | "success" | "outline"
> = {
  draft: "warning",
  confirmed: "success",
  discarded: "outline",
};

/**
 * The user's import history with per-row actions: discard a draft, or undo a
 * confirmed import (which removes the transactions it wrote). Discarded rows are
 * shown for the audit trail but carry no action.
 */
export function ImportHistory({ items }: { items: ImportRecord[] }) {
  const t = useTranslations("ImportHistory");
  const locale = useLocale();
  const df = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  const api = useApiClient();
  const router = useRouter();

  const { sortKey, sortDir, toggle: toggleSort, sort } = useTableSort<ImportRecord>(IH_COLS);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [clearingAll, setClearingAll] = useState(false);

  async function discard(id: string) {
    setBusyId(id);
    try {
      await api.discardImport(id);
      router.refresh();
    } finally {
      setBusyId(null);
    }
  }

  async function undo(id: string) {
    setBusyId(id);
    try {
      await api.deleteImport(id);
      router.refresh();
    } finally {
      setBusyId(null);
      setConfirmId(null);
    }
  }

  async function clear(id: string) {
    setBusyId(id);
    try {
      await api.clearImport(id);
      router.refresh();
    } finally {
      setBusyId(null);
    }
  }

  const discardedIds = items.filter((i) => i.status === "discarded").map((i) => i.id);

  async function clearAllDiscarded() {
    setClearingAll(true);
    try {
      await Promise.all(discardedIds.map((id) => api.clearImport(id)));
      router.refresh();
    } finally {
      setClearingAll(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>{t("title")}</CardTitle>
        {discardedIds.length > 0 && (
          <Button
            size="sm"
            variant="ghost"
            disabled={clearingAll}
            onClick={clearAllDiscarded}
          >
            {clearingAll ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Trash2 className="size-3.5" />
            )}
            {t("clearAll")}
          </Button>
        )}
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <SortableTableHead colKey="parser" sortKey={sortKey} sortDir={sortDir} onToggle={toggleSort}>Parser</SortableTableHead>
              <SortableTableHead colKey="status" sortKey={sortKey} sortDir={sortDir} onToggle={toggleSort}>Status</SortableTableHead>
              <SortableTableHead colKey="count" sortKey={sortKey} sortDir={sortDir} onToggle={toggleSort}>Items</SortableTableHead>
              <SortableTableHead colKey="createdAt" sortKey={sortKey} sortDir={sortDir} onToggle={toggleSort}>Timestamp</SortableTableHead>
              <TableCell className="h-10 px-3 text-left align-middle text-xs font-medium text-muted-foreground">
                <span className="sr-only">Actions</span>
              </TableCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sort(items).map((imp) => {
              const busy = busyId === imp.id;
              return (
                <TableRow key={imp.id}>
                  <TableCell>
                    <Badge variant="outline" className="uppercase">
                      {imp.parser}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[imp.status]}>
                      {t(`status.${imp.status}`)}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {t("items", { count: imp.count })}
                  </TableCell>
                  <TableCell
                    className="tabular whitespace-nowrap text-muted-foreground"
                    suppressHydrationWarning
                  >
                    {df.format(new Date(imp.createdAt))}
                  </TableCell>
                  <TableCell className="text-right">
                    <span className="flex items-center justify-end gap-1">
                      {imp.status === "draft" && (
                        <>
                          <Button size="sm" variant="secondary" asChild>
                            <Link href={`/import/${imp.id}`}>
                              <Eye className="size-3.5" />
                              {t("review")}
                            </Link>
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy}
                            onClick={() => discard(imp.id)}
                          >
                            {busy ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : (
                              <Trash2 className="size-3.5" />
                            )}
                            {t("discard")}
                          </Button>
                        </>
                      )}
                      {imp.status === "discarded" && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => clear(imp.id)}
                        >
                          {busy ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <Trash2 className="size-3.5" />
                          )}
                          {t("clear")}
                        </Button>
                      )}
                      {imp.status === "confirmed" &&
                        (confirmId === imp.id ? (
                          <>
                            <span className="text-xs text-muted-foreground">
                              {t("undoWarning", { count: imp.count })}
                            </span>
                            <Button
                              size="sm"
                              variant="destructive"
                              disabled={busy}
                              onClick={() => undo(imp.id)}
                            >
                              {busy && <Loader2 className="size-3.5 animate-spin" />}
                              {t("undo")}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy}
                              onClick={() => setConfirmId(null)}
                            >
                              {t("cancel")}
                            </Button>
                          </>
                        ) : (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setConfirmId(imp.id)}
                          >
                            <Undo2 className="size-3.5" />
                            {t("undo")}
                          </Button>
                        ))}
                    </span>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
