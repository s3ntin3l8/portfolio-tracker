"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { TableCell, TableRow } from "@/components/ui/table";
import { Download, Eye, FolderInput, Trash2, Undo2 } from "lucide-react";
import { Link, useRouter } from "@/i18n/navigation";
import type { ImportRecord } from "@portfolio/api-client";
import { cn } from "@/lib/utils";
import { sourceMeta, statusLabelKey } from "./utils";
import { STATUS_VARIANT } from "./types";

const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

export function RowActions({
  imp,
  busyId,
  confirmId,
  canReassign,
  t,
  onDiscard,
  onClear,
  onUndo,
  onDownload,
  onReassign,
  onSetConfirmId,
}: {
  imp: ImportRecord;
  busyId: string | null;
  confirmId: string | null;
  canReassign: boolean;
  t: (key: string, params?: Record<string, string | number | Date>) => string;
  onDiscard: (id: string) => void;
  onClear: (id: string) => void;
  onUndo: (id: string) => void;
  onDownload: (id: string) => void;
  onReassign: (id: string) => void;
  onSetConfirmId: (id: string | null) => void;
}) {
  const busy = busyId === imp.id;

  return (
    <span className="flex items-center justify-end gap-1">
      {imp.status === "draft" && (
        <>
          <Button size="icon" variant="ghost" asChild>
            <Link
              href={`/transactions/import/${imp.id}`}
              title={t("review")}
              aria-label={t("review")}
              onPointerDown={stop}
              onClick={stop}
            >
              <Eye className="size-4" />
            </Link>
          </Button>
          <Button
            size="icon"
            variant="ghost"
            title={t("discard")}
            aria-label={t("discard")}
            disabled={busy}
            onPointerDown={stop}
            onClick={(e) => {
              stop(e);
              onDiscard(imp.id);
            }}
          >
            {busy ? <Spinner size="sm" /> : <Trash2 className="size-4" />}
          </Button>
        </>
      )}
      {imp.status === "discarded" && (
        <Button
          size="icon"
          variant="ghost"
          title={t("clear")}
          aria-label={t("clear")}
          disabled={busy}
          onPointerDown={stop}
          onClick={(e) => {
            stop(e);
            onClear(imp.id);
          }}
        >
          {busy ? <Spinner size="sm" /> : <Trash2 className="size-4" />}
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
              onPointerDown={stop}
              onClick={(e) => {
                stop(e);
                onUndo(imp.id);
              }}
            >
              {busy && <Spinner size="xs" />}
              {t("undo")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onPointerDown={stop}
              onClick={(e) => {
                stop(e);
                onSetConfirmId(null);
              }}
            >
              {t("cancel")}
            </Button>
          </>
        ) : (
          <>
            {imp.document && (
              <Button
                size="icon"
                variant="ghost"
                title={imp.document.originalFilename ?? t("downloadReceipt")}
                aria-label={t("downloadReceipt")}
                onPointerDown={stop}
                onClick={(e) => {
                  stop(e);
                  onDownload(imp.id);
                }}
              >
                <Download className="size-4" />
              </Button>
            )}
            {canReassign && (
              <Button
                size="icon"
                variant="ghost"
                title={t("reassign")}
                aria-label={t("reassign")}
                onPointerDown={stop}
                onClick={(e) => {
                  stop(e);
                  onReassign(imp.id);
                }}
              >
                <FolderInput className="size-4" />
              </Button>
            )}
            <Button
              size="icon"
              variant="ghost"
              title={t("undo")}
              aria-label={t("undo")}
              onPointerDown={stop}
              onClick={(e) => {
                stop(e);
                onSetConfirmId(imp.id);
              }}
            >
              <Undo2 className="size-4" />
            </Button>
          </>
        ))}
    </span>
  );
}

export function DesktopRow({
  imp,
  selected,
  selectionMode,
  t,
  ts,
  df,
  onToggleOne,
  actions,
}: {
  imp: ImportRecord;
  selected: Set<string>;
  selectionMode: boolean;
  t: (key: string, params?: Record<string, string | number | Date>) => string;
  ts: (key: string) => string;
  df: Intl.DateTimeFormat;
  onToggleOne: (id: string) => void;
  actions: React.ReactNode;
}) {
  const { style, label } = sourceMeta(imp, ts);
  const Icon = style.icon;
  return (
    <TableRow data-state={selected.has(imp.id) ? "selected" : undefined}>
      <TableCell className="w-16">
        {selectionMode && (
          <input
            type="checkbox"
            className="size-4 align-middle accent-primary"
            aria-label={t("selectRow")}
            checked={selected.has(imp.id)}
            onChange={() => onToggleOne(imp.id)}
          />
        )}
      </TableCell>
      <TableCell className="max-w-[220px]">
        <span className="flex min-w-0 items-center gap-2.5">
          <span
            className="flex size-7 shrink-0 items-center justify-center rounded-[9px]"
            style={{ background: style.bg, color: style.fg }}
          >
            <Icon className="size-3.5" strokeWidth={2} />
          </span>
          <span className="min-w-0 truncate text-[13px] font-bold" title={label}>
            {label}
          </span>
        </span>
      </TableCell>
      <TableCell>
        <Badge variant="outline" className="uppercase">
          {imp.parser}
        </Badge>
      </TableCell>
      <TableCell>
        <Badge variant={STATUS_VARIANT[imp.status]}>{t(statusLabelKey(imp))}</Badge>
      </TableCell>
      <TableCell className="text-muted-foreground">{t("items", { count: imp.count })}</TableCell>
      <TableCell
        className="tabular whitespace-nowrap text-muted-foreground"
        suppressHydrationWarning
      >
        {df.format(new Date(imp.createdAt))}
      </TableCell>
      <TableCell className="text-right">{actions}</TableCell>
    </TableRow>
  );
}

export function MobileRow({
  imp,
  selected,
  selectionMode,
  t,
  ts,
  shortDf,
  onToggleOne,
  longPressHandlers,
  consumeLongPress,
  actions,
}: {
  imp: ImportRecord;
  selected: Set<string>;
  selectionMode: boolean;
  t: (key: string, params?: Record<string, string | number | Date>) => string;
  ts: (key: string) => string;
  shortDf: Intl.DateTimeFormat;
  onToggleOne: (id: string) => void;
  longPressHandlers: (id: string) => Record<string, (e: React.PointerEvent) => void>;
  consumeLongPress: () => boolean;
  actions: React.ReactNode;
}) {
  const router = useRouter();
  const { style, sourceLabel, label } = sourceMeta(imp, ts);
  const Icon = style.icon;
  const isSelected = selected.has(imp.id);

  function handleTap() {
    if (consumeLongPress()) return;
    if (selectionMode) {
      onToggleOne(imp.id);
      return;
    }
    if (imp.status === "draft") {
      router.push(`/transactions/import/${imp.id}`);
    }
  }

  return (
    <div
      data-testid={`import-mobile-${imp.id}`}
      data-state={isSelected ? "selected" : undefined}
      onClick={handleTap}
      {...longPressHandlers(imp.id)}
      className={cn(
        "flex cursor-pointer select-none items-center gap-3 px-[15px] py-[13px]",
        isSelected && "bg-primary/10",
      )}
    >
      {selectionMode && (
        <input
          type="checkbox"
          readOnly
          aria-label={t("selectRow")}
          checked={isSelected}
          className="size-4 shrink-0 accent-primary"
        />
      )}
      <span
        className="flex size-10 shrink-0 items-center justify-center rounded-[12px]"
        style={{ background: style.bg, color: style.fg }}
      >
        <Icon className="size-5" strokeWidth={1.9} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-bold" title={label}>
          {label}
        </p>
        <div className="flex min-w-0 items-center gap-1.5 text-[11px] font-medium text-text-2">
          <span className="truncate">
            {sourceLabel} · {shortDf.format(new Date(imp.createdAt))} ·{" "}
            {t("items", { count: imp.count })}
          </span>
          <Badge variant={STATUS_VARIANT[imp.status]} className="shrink-0 px-1.5 py-0 text-[9px]">
            {t(statusLabelKey(imp))}
          </Badge>
        </div>
      </div>
      <span className="shrink-0">{actions}</span>
    </div>
  );
}
