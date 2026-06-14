"use client";

import { CreatePortfolioForm } from "@/components/create-portfolio-form";
import { useApiClient } from "@/lib/api";
import { useRouter } from "@/i18n/navigation";

/** Real-client wrapper: creates the portfolio, then refreshes server data. */
export function CreatePortfolio() {
  const api = useApiClient();
  const router = useRouter();
  return <CreatePortfolioForm client={api} onSuccess={() => router.refresh()} />;
}
