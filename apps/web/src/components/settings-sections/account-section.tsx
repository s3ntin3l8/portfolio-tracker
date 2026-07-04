import { getTranslations } from "next-intl/server";
import { ShieldCheck } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { ThemeToggle } from "@/components/theme-toggle";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { UpdateProfile } from "@/components/update-profile";

/**
 * The Settings "Account" section content — reused verbatim by both `/settings` (the
 * index route's desktop default) and `/settings/account` (the mobile drill-in target).
 * Composes existing components as-is per the Phase-2E brief: `UpdateProfile` (name +
 * display currency, an editable form — the design's static currency/name display isn't
 * reused since our app already has a working save flow), `ThemeToggle`, `LocaleSwitcher`.
 */
export async function AccountSection({
  me,
}: {
  me: { name: string | null; displayCurrency: string; email: string } | null;
}) {
  const t = await getTranslations("Settings");

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-5">
          {me && <UpdateProfile initialName={me.name ?? ""} initialCurrency={me.displayCurrency} />}
        </CardContent>
      </Card>

      <div>
        <p className="mb-2 px-0.5 text-xs font-bold uppercase tracking-wide text-muted-foreground">
          {t("preferences")}
        </p>
        <Card>
          <CardContent className="p-5">
            <div className="flex items-center justify-between py-1">
              <span className="text-sm font-medium">{t("appearance")}</span>
              <ThemeToggle />
            </div>
            <Separator className="my-3" />
            <div className="flex items-center justify-between py-1">
              <span className="text-sm font-medium">{t("language")}</span>
              <LocaleSwitcher />
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="flex items-center gap-2.5 rounded-2xl border border-border bg-card px-4 py-3 text-xs text-muted-foreground shadow-sm">
        <ShieldCheck className="size-4 shrink-0" />
        <span>{t("authVia", { email: me?.email ?? "" })}</span>
      </div>
    </div>
  );
}
