"use client";

import { Pencil, MoreHorizontal } from "lucide-react";
import { useTranslations } from "next-intl";
import type { EditablePortfolio } from "@/components/portfolio-form-dialog";
import { PortfolioFormDialog } from "@/components/portfolio-form-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * The ⋯ overflow menu on a portfolio card.
 * Lives in its own client component so the server-side card can remain RSC
 * while the DropdownMenu + Dialog interaction (which requires client event
 * handlers) is isolated here.
 */
export function PortfolioCardMenu({ portfolio }: { portfolio: EditablePortfolio }) {
  const tf = useTranslations("PortfolioForm");

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon" variant="ghost" aria-label="More options">
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <PortfolioFormDialog
          mode="edit"
          portfolio={portfolio}
          trigger={
            <DropdownMenuItem onSelect={(e) => e.preventDefault()}>
              <Pencil className="size-4" />
              {tf("edit")}
            </DropdownMenuItem>
          }
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
