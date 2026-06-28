import { getTranslations, setRequestLocale } from "next-intl/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { ThemeToggle } from "@/components/theme-toggle";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { SignOutButton } from "@/components/sign-out-button";
import { UpdateProfile } from "@/components/update-profile";
import { ApiTokens } from "@/components/api-tokens";
import { loadMe, loadApiTokens } from "@/lib/server-api";

export default async function SettingsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("Settings");

  const me = await loadMe();
  const apiTokens = await loadApiTokens();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("account")}</CardTitle>
        </CardHeader>
        <CardContent>
          {me ? (
            <>
              <div className="flex items-center justify-between py-2 text-sm">
                <span className="text-muted-foreground">{t("email")}</span>
                <span className="font-medium">{me.email}</span>
              </div>
              <Separator className="my-4" />
              <UpdateProfile
                initialName={me.name ?? ""}
                initialCurrency={me.displayCurrency}
              />
            </>
          ) : null}
          <p className="mt-4 text-xs text-muted-foreground">{t("authVia")}</p>
          <Separator className="my-4" />
          <SignOutButton />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("tokens")}</CardTitle>
        </CardHeader>
        <CardContent>
          <ApiTokens initialTokens={apiTokens} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("preferences")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">{t("appearance")}</span>
            <ThemeToggle />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">{t("language")}</span>
            <LocaleSwitcher />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
