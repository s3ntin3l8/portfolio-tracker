"use client";

import { useTranslations } from "next-intl";
import { Archive, ArchiveRestore, CircleSlash, Download, FolderInput } from "lucide-react";
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import type { TxRow } from "@/components/transactions-table";

export function OverflowMenuContent({
  tx,
  canReassign,
  showReceipt,
  canSetStatus,
  statusLabel,
  statusBusy,
  onReassign,
  onDownload,
  onSetStatus,
}: {
  tx: TxRow;
  canReassign: boolean;
  showReceipt?: boolean;
  canSetStatus: boolean;
  statusLabel: string;
  statusBusy: boolean;
  onReassign?: (tx: TxRow) => void;
  onDownload: () => void;
  onSetStatus: (status: "normal" | "archived" | "cash_neutral") => void;
}) {
  const tm = useTranslations("Manage");
  const ts = useTranslations("Manage.status");

  return (
    <DropdownMenuContent align="end">
      {canReassign && onReassign && (
        <DropdownMenuItem onClick={() => onReassign(tx)}>
          <FolderInput className="size-4" />
          {tm("reassign")}
        </DropdownMenuItem>
      )}
      {showReceipt && (
        <DropdownMenuItem onClick={onDownload}>
          <Download className="size-4" />
          {tm("downloadReceipt")}
        </DropdownMenuItem>
      )}
      {canSetStatus && (
        <>
          {(canReassign || showReceipt) && <DropdownMenuSeparator />}
          <DropdownMenuLabel>{ts("label")}</DropdownMenuLabel>
          <DropdownMenuItem
            onClick={() => onSetStatus("normal")}
            disabled={statusLabel === "normal" || statusBusy}
          >
            <ArchiveRestore className="size-4" />
            {ts("normal")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => onSetStatus("archived")}
            disabled={statusLabel === "archived" || statusBusy}
          >
            <Archive className="size-4" />
            {ts("archived")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => onSetStatus("cash_neutral")}
            disabled={statusLabel === "cash_neutral" || statusBusy}
          >
            <CircleSlash className="size-4" />
            {ts("cashNeutral")}
          </DropdownMenuItem>
        </>
      )}
    </DropdownMenuContent>
  );
}
