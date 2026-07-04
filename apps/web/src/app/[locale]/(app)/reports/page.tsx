import { getTranslations, setRequestLocale } from "next-intl/server";
import { Coins, ScrollText, PiggyBank, Receipt, ChevronRight } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { Card } from "@/components/ui/card";

// The Reports hub groups the four statement screens (Pocket 5-tab IA). Each card links to a
// full report. Rich per-card figures (values, deltas, mini split-bars) land in a follow-up;
// this is the navigable hub.
const REPORTS = [
  { href: "/income", key: "income", icon: Coins },
  { href: "/trades", key: "trades", icon: ScrollText },
  { href: "/savings", key: "savings", icon: PiggyBank },
  { href: "/tax", key: "tax", icon: Receipt },
] as const;

export default async function ReportsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("Reports");

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-extrabold tracking-tight">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2">
        {REPORTS.map(({ href, key, icon: Icon }) => (
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
