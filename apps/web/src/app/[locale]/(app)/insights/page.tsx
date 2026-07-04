import { getTranslations, setRequestLocale } from "next-intl/server";
import { PieChart, Scale, ChevronRight } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { Card } from "@/components/ui/card";

// Insights hub (Pocket 5-tab IA). The full screen — XIRR hero, rebalancing drift editor,
// concentration and best/worst performers — is composed in a follow-up from existing
// allocation/target components. For now this routes to where that analysis lives today.
const SECTIONS = [
  { href: "/holdings", key: "allocation", icon: PieChart },
  { href: "/savings", key: "rebalancing", icon: Scale },
] as const;

export default async function InsightsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("Insights");

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-extrabold tracking-tight">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2">
        {SECTIONS.map(({ href, key, icon: Icon }) => (
          <Link key={key} href={href} className="group">
            <Card className="flex items-center gap-4 p-5 transition-colors hover:border-primary/40">
              <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <Icon className="size-5" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="font-semibold">{t(`${key}.title`)}</div>
                <div className="text-sm text-muted-foreground">{t(`${key}.desc`)}</div>
              </div>
              <ChevronRight className="size-5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
