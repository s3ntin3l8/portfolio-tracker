import { getTranslations } from "next-intl/server";
import { ShieldCheck } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { ThemeToggle } from "@/components/theme-toggle";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { DisplayCurrency } from "@/components/display-currency";
import { UpdateProfile } from "@/components/update-profile";
import { AppVersion } from "@/components/app-version";
import { APP_VERSION } from "@/lib/version";

/** Small uppercase section label above each settings card. */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-2 px-0.5 text-xs font-bold uppercase tracking-[.04em] text-text-3">
      {children}
    </p>
  );
}

/**
 * The Settings "Account" section content — reused verbatim by both `/settings` (the
 * index route's desktop default) and `/settings/account` (the mobile drill-in target).
 * Each preference gets its own labelled box (matching the reference): the name form,
 * Display currency, Language, and Appearance.
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
          {me && <UpdateProfile initialName={me.name ?? ""} />}
        </CardContent>
      </Card>

      <div>
        <SectionLabel>{t("displayCurrency")}</SectionLabel>
        <Card>
          <CardContent className="p-5">
            {me && <DisplayCurrency current={me.displayCurrency} />}
          </CardContent>
        </Card>
      </div>

      <div>
        <SectionLabel>{t("language")}</SectionLabel>
        <Card>
          <CardContent className="p-5">
            <LocaleSwitcher />
          </CardContent>
        </Card>
      </div>

      <div>
        <SectionLabel>{t("appearance")}</SectionLabel>
        <Card>
          <CardContent className="p-5">
            <div className="flex items-center justify-between py-1">
              <span className="text-sm font-medium">{t("appearance")}</span>
              <ThemeToggle />
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="flex items-center gap-2.5 rounded-xl bg-card px-4 py-3 text-xs text-muted-foreground shadow-card">
        <ShieldCheck className="size-4 shrink-0" />
        <span>{t("authVia", { email: me?.email ?? "" })}</span>
      </div>
      <AppVersion
        ariaLabel={t("version", { version: APP_VERSION })}
        className="block text-center text-xs text-muted-foreground"
      />
    </div>
  );
}
