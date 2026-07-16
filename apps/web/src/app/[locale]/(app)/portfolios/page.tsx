import { redirect } from "next/navigation";

/**
 * Portfolio management now lives inside Settings ("Portfolios & holders") so it appears in
 * the settings nav like every other section. This legacy path redirects there (keeps old
 * links / PWA shortcuts working).
 */
export default async function PortfoliosPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  redirect(`/${locale}/settings/portfolios`);
}
