import { redirect } from "next/navigation";
import { setRequestLocale } from "next-intl/server";
import { AppShell } from "@/components/app-shell";
import { SessionErrorGuard } from "@/components/session-error-guard";
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

  return (
    <>
      <SessionErrorGuard />
      <AppShell>{children}</AppShell>
    </>
  );
}
