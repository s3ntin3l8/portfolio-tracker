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
import { useApiClient } from "@/lib/api";
import { Link, useRouter } from "@/i18n/navigation";

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

  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);

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

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="divide-y divide-border text-sm">
          {items.map((imp) => {
            const busy = busyId === imp.id;
            return (
              <li
                key={imp.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2"
              >
                <Badge variant="outline" className="uppercase">
                  {imp.parser}
                </Badge>
                <Badge variant={STATUS_VARIANT[imp.status]}>
                  {t(`status.${imp.status}`)}
                </Badge>
                <span className="text-muted-foreground">
                  {t("items", { count: imp.count })}
                </span>
                <span className="text-muted-foreground">
                  {df.format(new Date(imp.createdAt))}
                </span>
                <span className="ml-auto flex items-center gap-1">
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
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
