import { cookies } from "next/headers";
import { setRequestLocale } from "next-intl/server";
import { Landing } from "@/components/landing";

// Locale-based default when no returning-user cookie is set yet — id visitors see the
// domestic figure, everyone else a Euro one (the primary user's home currency).
const DEFAULT_CURRENCY_BY_LOCALE: Record<string, string> = { id: "IDR", en: "EUR" };
const SUPPORTED_DEMO_CURRENCIES = ["IDR", "USD", "EUR", "SGD"];

export default async function LandingPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const cookieStore = await cookies();
  const cookieCurrency = cookieStore.get("display_currency")?.value;
  const currency =
    cookieCurrency && SUPPORTED_DEMO_CURRENCIES.includes(cookieCurrency)
      ? cookieCurrency
      : (DEFAULT_CURRENCY_BY_LOCALE[locale] ?? "EUR");

  return <Landing initialCurrency={currency} />;
}
