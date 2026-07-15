import { getTranslations } from "next-intl/server";
import { Card, CardContent } from "@/components/ui/card";
import { PwaInstallButton } from "@/components/pwa-install-button";

export async function InstallAppSection() {
  const t = await getTranslations("Settings");

  return (
    <div className="space-y-4">
      <div>
        <p className="mb-2 px-0.5 text-xs font-bold uppercase tracking-[.04em] text-text-3">
          {t("installApp")}
        </p>
        <Card>
          <CardContent className="p-5">
            <PwaInstallButton />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
