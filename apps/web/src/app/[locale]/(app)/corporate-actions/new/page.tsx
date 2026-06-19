import { setRequestLocale } from "next-intl/server";
import { redirect } from "@/i18n/navigation";

// The corporate-action form now lives as a tab on /transactions/new. Keep this path as a
// lightweight redirect so any bookmarks land on that tab.
export default async function NewCorporateActionPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  redirect({
    href: { pathname: "/transactions/new", query: { kind: "corporate-action" } },
    locale,
  });
}
