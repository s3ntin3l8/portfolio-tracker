import { redirect } from "next/navigation";
import { setRequestLocale } from "next-intl/server";
import { AppShell } from "@/components/app-shell";
import { SessionErrorGuard } from "@/components/session-error-guard";
import { resolveSelection, loadMe } from "@/lib/server-api";
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

  const [selection, me] = await Promise.all([resolveSelection(), loadMe()]);

  return (
    <>
      <SessionErrorGuard />
      <AppShell
        portfolios={selection.portfolios.map((p) => ({
          id: p.id,
          name: p.name,
          brokerage: p.brokerage,
        }))}
        selectedId={selection.selectedId}
        isAdmin={Boolean(me?.isAdmin)}
      >
        {children}
      </AppShell>
    </>
  );
}
