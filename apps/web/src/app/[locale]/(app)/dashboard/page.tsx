import { redirect } from "@/i18n/navigation";

// The dashboard has merged into Holdings (Pocket 5-tab IA). Keep the old path working for
// bookmarks, PWA shortcuts and share links. The former dashboard content (net-worth KPIs,
// allocation, history chart) is being folded into /holdings in a follow-up; recover it from
// git history (`main:apps/web/.../dashboard/page.tsx`) when doing that merge.
export default async function DashboardRedirect({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  redirect({ href: "/holdings", locale });
}
