import { setRequestLocale } from "next-intl/server";
import { redirect } from "@/i18n/navigation";

/**
 * The full-page manual-entry form (tabbed Transaction/Corporate action/Merger, inline
 * submit) is retired in favor of the Add-transaction bottom sheet
 * (`add-transaction-menu.tsx`), the app's one everyday add flow — it now handles both
 * deep-link cases this page used to serve directly: a harvest-suggestion prefill
 * (`?harvestInstrument=`) and a specific starting tab (`?kind=`, remapped to the sheet's
 * `?entry=`). Kept as a redirect, not deleted, so existing bookmarks/links (including
 * `/corporate-actions/new`'s own redirect here) still land somewhere useful — the shell's
 * `AddTransactionMenu` auto-opens on these params via its reactive effect.
 */
export default async function NewTransactionPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ kind?: string; harvestInstrument?: string }>;
}) {
  const { locale } = await params;
  const { kind, harvestInstrument } = await searchParams;
  setRequestLocale(locale);

  const query: Record<string, string> = {};
  if (harvestInstrument) {
    query.harvestInstrument = harvestInstrument;
  } else if (kind === "corporate-action" || kind === "merger") {
    query.entry = kind;
  }

  redirect({ href: { pathname: "/transactions", query }, locale });
}
