import type { SparplanStats, DriftRow, SparplanContributionSplit } from "@portfolio/api-client";

export interface Props {
  data: SparplanStats;
  currency: string;
  locale: string;
  portfolioId?: string;
  drift?: DriftRow[];
  contributionSplit?: SparplanContributionSplit[];
}
