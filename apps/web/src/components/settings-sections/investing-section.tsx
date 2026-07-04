import { getTranslations } from "next-intl/server";
import { Card, CardContent } from "@/components/ui/card";
import { Link } from "@/i18n/navigation";

/**
 * The Settings "Investing" section. Scoped down from the design's tax-code/cost-basis
 * chips: neither is backed by a stored global user preference today — cost basis is a
 * per-view `?costBasis=` query toggle (Holdings/Instrument/Trades) and the tax profile
 * (residence, capital-gains rate, Sparerpauschbetrag) lives per account holder, not on
 * the user. Rather than inventing new preference-storage for this visual PR, this
 * section is informational and links to where each is actually configured.
 */
export async function InvestingSection() {
  const t = await getTranslations("Settings");

  return (
    <div className="space-y-4">
      <div>
        <p className="mb-2 px-0.5 text-xs font-bold uppercase tracking-wide text-muted-foreground">
          {t("investingCostBasisLabel")}
        </p>
        <Card>
          <CardContent className="p-5 text-sm text-muted-foreground">
            {t("investingCostBasisNote")}
          </CardContent>
        </Card>
      </div>

      <div>
        <p className="mb-2 px-0.5 text-xs font-bold uppercase tracking-wide text-muted-foreground">
          {t("investingTaxLabel")}
        </p>
        <Card>
          <CardContent className="space-y-2 p-5 text-sm text-muted-foreground">
            <p>{t("investingTaxNote")}</p>
            <Link href="/settings/portfolios" className="inline-block text-sm font-bold text-primary">
              {t("investingTaxLink")} ›
            </Link>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
