import { setRequestLocale } from "next-intl/server";
import { redirect } from "@/i18n/navigation";

// The corporate-action form now lives as a tab in the Add-transaction sheet
// (`add-transaction-menu.tsx`). Keep this path as a lightweight redirect so any
// bookmarks land there directly, rather than bouncing through the retired
// `/transactions/new` page's own redirect.
export default async function NewCorporateActionPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  redirect({
    href: { pathname: "/transactions", query: { entry: "corporate-action" } },
    locale,
  });
}
