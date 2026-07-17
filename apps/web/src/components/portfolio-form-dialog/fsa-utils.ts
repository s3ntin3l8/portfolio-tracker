import { useMemo } from "react";
import type { AccountHolder, Portfolio } from "@portfolio/api-client";

export function useFsaAllocation(
  accountHolderId: string,
  taxAllowanceAnnual: string,
  holders: AccountHolder[],
  siblingPortfolios: Portfolio[],
  currentPortfolioId?: string,
) {
  const effectiveHolderId =
    accountHolderId !== "__new__" && accountHolderId !== "" ? accountHolderId : null;
  const selectedHolderObj = holders.find((h) => h.id === effectiveHolderId) ?? null;
  const holderAllowanceCap = Number(selectedHolderObj?.taxAllowanceAnnual ?? 1000);
  const siblingsTotal = siblingPortfolios
    .filter((p) => p.accountHolderId === effectiveHolderId && p.id !== currentPortfolioId)
    .reduce((sum, p) => sum + Number(p.taxAllowanceAnnual ?? 0), 0);
  const currentFsaNum = Number(taxAllowanceAnnual) || 0;
  const totalAllocated = siblingsTotal + currentFsaNum;
  const fsaRemainingForHolder = Math.max(0, holderAllowanceCap - totalAllocated);
  const fsaOverAllocated = effectiveHolderId != null && totalAllocated > holderAllowanceCap;
  const showFsaHelper = effectiveHolderId != null && siblingPortfolios.length > 0;

  return useMemo(
    () => ({
      selectedHolderObj,
      holderAllowanceCap,
      siblingsTotal,
      totalAllocated,
      fsaRemainingForHolder,
      fsaOverAllocated,
      showFsaHelper,
    }),
    [
      selectedHolderObj,
      holderAllowanceCap,
      siblingsTotal,
      totalAllocated,
      fsaRemainingForHolder,
      fsaOverAllocated,
      showFsaHelper,
    ],
  );
}
