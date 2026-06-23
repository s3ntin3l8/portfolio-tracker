import { redirect } from "next/navigation";
import { setRequestLocale } from "next-intl/server";
import { AppShell } from "@/components/app-shell";
import { SessionErrorGuard } from "@/components/session-error-guard";
import { Toaster } from "@/components/ui/sonner";
import { resolveSelection, loadMe, loadAccountHolders } from "@/lib/server-api";
import { qualifyingHolders } from "@/lib/portfolio-selection";
import { auth } from "@/auth";

// Auth is enforced only once it's configured, so the design-system screens stay
// viewable in local dev before Authentik is wired. Configured = AUTH_SECRET + issuer.
const authConfigured = Boolean(
  process.env.AUTH_SECRET && process.env.AUTHENTIK_ISSUER,
);

export default async function AppLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  if (authConfigured) {
    const session = await auth();
    if (!session) redirect(`/${locale}`);
  }

  const [selection, holders, me] = await Promise.all([
    resolveSelection(),
    loadAccountHolders(),
    loadMe(),
  ]);

  // Only surface holders with ≥2 portfolios in the switcher (a 1-portfolio holder
  // is equivalent to selecting that portfolio directly via the portfolios section).
  const qualHolders = qualifyingHolders(selection.portfolios, holders).map((h) => ({
    id: h.id,
    name: h.name,
  }));

  return (
    <>
      <SessionErrorGuard />
      <Toaster richColors position="bottom-right" />
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
      >
        {children}
      </AppShell>
    </>
  );
}
