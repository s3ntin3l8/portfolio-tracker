import { getTranslations } from "next-intl/server";
import type { AccountHolder, Portfolio } from "@portfolio/api-client";
import { Card, CardContent } from "@/components/ui/card";
import { Link } from "@/i18n/navigation";
import { BrokerageIcon } from "@/components/brokerage-icon";
import { AccountHoldersManager } from "@/components/account-holders-manager";
import { formatMoney } from "@/lib/utils";

/**
 * The Settings "Portfolios & holders" section: a compact portfolios list linking out to
 * the full `/portfolios` page (design's "Manage ›"), plus the existing account-holders
 * manager reused as-is.
 */
export async function PortfoliosHoldersSection({
  portfolios,
  holders,
  locale,
}: {
  portfolios: Array<{ portfolio: Portfolio; netWorth: string }>;
  holders: AccountHolder[];
  locale: string;
}) {
  const t = await getTranslations("Settings");

  return (
    <div className="space-y-4">
      <div>
        <div className="mb-2 flex items-center justify-between px-0.5">
          <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">
            {t("portfoliosLabel")}
          </p>
          <Link href="/portfolios" className="text-xs font-bold text-primary">
            {t("manage")} ›
          </Link>
        </div>
        {portfolios.length > 0 ? (
          <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
            {portfolios.map(({ portfolio, netWorth }) => (
              <Link
                key={portfolio.id}
                href="/portfolios"
                className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/50"
              >
                <BrokerageIcon brokerage={portfolio.brokerage} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-bold">{portfolio.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {formatMoney(Number(netWorth), portfolio.baseCurrency, locale)}
                  </p>
                </div>
              </Link>
            ))}
          </div>
        ) : (
          <Card>
            <CardContent className="p-5 text-sm text-muted-foreground">{t("portfoliosDesc")}</CardContent>
          </Card>
        )}
      </div>

      <AccountHoldersManager holders={holders} />
    </div>
  );
}
