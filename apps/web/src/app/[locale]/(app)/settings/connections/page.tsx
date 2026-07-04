import { getTranslations, setRequestLocale } from "next-intl/server";
import { SectionHeader } from "@/components/section-header";
import { DataConnectionsSection } from "@/components/settings-sections/data-connections-section";
import { loadApiTokens, loadTrConnection, loadIbkrConnection } from "@/lib/server-api";

export default async function SettingsConnectionsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("Settings");

  const [apiTokens, trConnection, ibkrConnection] = await Promise.all([
    loadApiTokens(),
    loadTrConnection(),
    loadIbkrConnection(),
  ]);

  return (
    <>
      <SectionHeader title={t("navData")} backHref="/settings" />
      <DataConnectionsSection
        apiTokens={apiTokens}
        trConnection={trConnection}
        ibkrConnection={ibkrConnection}
      />
    </>
  );
}
