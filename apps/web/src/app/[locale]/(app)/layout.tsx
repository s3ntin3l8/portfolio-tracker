import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { setRequestLocale } from "next-intl/server";
import { AppShell } from "@/components/app-shell";
import { ImportTasksProvider } from "@/components/import-tasks-provider";
import { SessionErrorGuard } from "@/components/session-error-guard";
import { PwaUpdater } from "@/components/pwa-updater";
import { Toaster } from "@/components/ui/sonner";
import { resolveSelection, loadMe, loadAccountHolders, loadNetWorth } from "@/lib/server-api";
import { qualifyingHolders } from "@/lib/portfolio-selection";
import { formatMoney, formatPercent } from "@/lib/utils";
import { getSessionState } from "@/lib/session-token";

// Auth is enforced only once it's configured, so the design-system screens stay
// viewable in local dev before Authentik is wired. Configured = AUTH_SECRET + issuer.
const authConfigured = Boolean(process.env.AUTH_SECRET && process.env.AUTHENTIK_ISSUER);

// Force every route under this layout to render per-request. Without this, `next build`
// runs with no auth env / no request cookie, so `authConfigured` is false at build time,
// the `auth()` call below is skipped, and — with no dynamic API touched — Next statically
// prerenders the whole authed subtree in a signed-out snapshot (me=null, no portfolios,
// admin gate 404ing) that then gets served frozen to every real user in production. Every
// page here is per-user and reads the session cookie; none of it is safely cacheable.
export const dynamic = "force-dynamic";

export default async function AppLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  let serverSessionExpired = false;
  if (authConfigured) {
    const cookieStore = await cookies();
    const cookieHeader = cookieStore
      .getAll()
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
    const sessionState = await getSessionState(cookieHeader);
    if (!sessionState.isAuthenticated) {
      redirect(`/${locale}`);
    }
    serverSessionExpired = sessionState.isExpired;
  }

  const [selection, holders, me, netWorthResult] = await Promise.all([
    resolveSelection(),
    loadAccountHolders(),
    loadMe(),
    loadNetWorth(),
  ]);

  // Only surface holders with ≥2 portfolios in the switcher (a 1-portfolio holder
  // is equivalent to selecting that portfolio directly via the portfolios section).
  const qualHolders = qualifyingHolders(selection.portfolios, holders).map((h) => ({
    id: h.id,
    name: h.name,
  }));

  // Sidebar net-worth footer (reference: always-visible, pinned bottom). Same scope
  // (single-portfolio vs. aggregate) as everywhere else — resolved by `loadNetWorth`.
  const netWorthSummary =
    netWorthResult.status === "ok"
      ? {
          valueFormatted: formatMoney(
            Number(netWorthResult.data.netWorth),
            netWorthResult.data.displayCurrency,
            locale,
          ),
          allTimePctFormatted:
            Number(netWorthResult.data.totalCost) > 0
              ? formatPercent(
                  Number(netWorthResult.data.totalUnrealizedPnL) /
                    Number(netWorthResult.data.totalCost),
                  locale,
                )
              : null,
        }
      : null;

  return (
    <>
      <SessionErrorGuard serverSessionExpired={serverSessionExpired} />
      {/* mobileOffset clears the fixed bottom nav on mobile (where sonner forces
          full-width bottom placement) so a persistent toast never overlaps its tap
          targets — a real latent overlap, though not the cause of #451 (confirmed via
          user report: nav is fully visible when taps go dead, nothing overlays it). */}
      <Toaster
        richColors
        position="bottom-right"
        mobileOffset={{ bottom: "calc(env(safe-area-inset-bottom) + 4.75rem)" }}
      />
      <PwaUpdater />
      <ImportTasksProvider>
        <AppShell
          portfolios={selection.portfolios.map((p) => ({
            id: p.id,
            name: p.name,
            brokerage: p.brokerage,
            accountHolder: p.accountHolder,
          }))}
          holders={qualHolders}
          selectedId={selection.selectedId}
          selectedHolderId={selection.selectedHolderId}
          isAdmin={Boolean(me?.isAdmin)}
          netWorthSummary={netWorthSummary}
        >
          {children}
        </AppShell>
      </ImportTasksProvider>
    </>
  );
}
