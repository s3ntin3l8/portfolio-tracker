import { getTranslations } from "next-intl/server";
import { Card, CardContent } from "@/components/ui/card";
import { PreferenceChips } from "@/components/preference-chips";
import type { UserPreferences } from "@portfolio/api-client";

/**
 * The Settings "Investing" section — real chip controls (`ProfileSettings.dc.html`'s
 * `taxChips`/`cbChips`) backed by the global `user_preferences.taxRegime`/
 * `costBasisMode` columns. The "Tax code" chip here and the Tax page's DE/ID toggle
 * write the exact same preference (`PreferenceChips`), so flipping either one updates
 * both — see the Tax page's "Tax regime · applies everywhere, also in Settings" label.
 */
export async function InvestingSection({
  prefs,
}: {
  prefs: UserPreferences | null;
}) {
  const t = await getTranslations("Settings");
  const taxRegime = prefs?.taxRegime ?? "DE";
  const costBasisMode = prefs?.costBasisMode ?? "purchase_price";

  return (
    <div className="space-y-4">
      <div>
        <p className="mb-2 px-0.5 text-xs font-bold uppercase tracking-wide text-muted-foreground">
          {t("investingTaxLabel")}
        </p>
        <Card>
          <CardContent className="p-4">
            <PreferenceChips
              prefKey="taxRegime"
              current={taxRegime}
              options={[
                { value: "DE", label: t("taxCodeGermany") },
                { value: "ID", label: t("taxCodeIndonesia") },
              ]}
            />
            <p className="mt-2.5 px-0.5 text-xs text-muted-foreground">
              {taxRegime === "ID" ? t("investingTaxNoteId") : t("investingTaxNoteDe")}
            </p>
          </CardContent>
        </Card>
      </div>

      <div>
        <p className="mb-2 px-0.5 text-xs font-bold uppercase tracking-wide text-muted-foreground">
          {t("investingCostBasisLabel")}
        </p>
        <Card>
          <CardContent className="p-4">
            <PreferenceChips
              prefKey="costBasisMode"
              current={costBasisMode}
              options={[
                { value: "purchase_price", label: t("costBasisPurchasePrice") },
                { value: "total_paid", label: t("costBasisTotalPaid") },
              ]}
            />
            <p className="mt-2.5 px-0.5 text-xs text-muted-foreground">
              {t("investingCostBasisNote")}
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
