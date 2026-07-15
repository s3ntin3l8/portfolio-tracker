"use client";

import { useTranslations } from "next-intl";
import { MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import type { AccountHolder } from "@portfolio/api-client";
import { Button } from "@/components/ui/button";
import { MonogramBadge } from "@/components/monogram-badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DeleteHolderDialog } from "@/components/delete-holder-dialog";
import { HolderFormDialog } from "@/components/holder-form-dialog";

/**
 * Manage the people an investment account can belong to (the user, a child, …).
 * Holders are defined once and linked from portfolios, so birth year + child status
 * live in one place (issue #207). Deleting a holder unassigns it from any portfolios
 * (they revert to "standard"), it never deletes the portfolios.
 */
export function AccountHoldersManager({ holders }: { holders: AccountHolder[] }) {
  const t = useTranslations("AccountHolders");
  const tf = useTranslations("PortfolioForm");

  return (
    <div className="rounded-[18px] bg-card p-[18px] shadow-card">
      <div className="mb-3 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-[15px] font-bold">{t("title")}</h2>
          <p className="mt-0.5 text-xs font-medium text-text-2">{t("subtitle")}</p>
        </div>
        <HolderFormDialog
          mode="create"
          trigger={
            // Reference: soft-green pill; icon-only on mobile, icon+label on desktop.
            <button
              type="button"
              aria-label={t("add")}
              className="flex shrink-0 items-center gap-1.5 rounded-[9px] bg-primary/10 px-[11px] py-[7px] text-xs font-semibold text-primary transition-colors hover:bg-primary/15"
            >
              <Plus className="size-[15px]" strokeWidth={2.4} />
              <span className="hidden sm:inline">{t("add")}</span>
            </button>
          }
        />
      </div>

      {holders.length > 0 ? (
        <div className="flex flex-col gap-2">
          {holders.map((h) => (
            <div
              key={h.id}
              className="flex items-center gap-3 rounded-[12px] bg-card-2 px-[13px] py-[11px]"
            >
              <MonogramBadge label={h.name} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-bold">{h.name}</p>
                <p className="truncate text-xs font-medium text-text-2">
                  {tf(`holderType${capitalize(h.type)}`)}
                  {h.birthYear != null ? ` · ${h.birthYear}` : ""}
                </p>
              </div>
              <HolderRowMenu holder={h} />
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-text-2">{t("empty")}</p>
      )}
    </div>
  );
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The ⋯ overflow menu on a holder row: Edit (form dialog) + Delete (confirm modal) —
 *  mirrors the portfolio card menu. */
function HolderRowMenu({ holder }: { holder: AccountHolder }) {
  const t = useTranslations("AccountHolders");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon" variant="ghost" aria-label="More options">
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <HolderFormDialog
          mode="edit"
          holder={holder}
          trigger={
            <DropdownMenuItem onSelect={(e) => e.preventDefault()}>
              <Pencil className="size-4" />
              {t("edit")}
            </DropdownMenuItem>
          }
        />
        <DropdownMenuSeparator />
        <DeleteHolderDialog
          holder={holder}
          trigger={
            <DropdownMenuItem
              onSelect={(e) => e.preventDefault()}
              className="text-destructive focus:text-destructive"
            >
              <Trash2 className="size-4" />
              {t("delete")}
            </DropdownMenuItem>
          }
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
