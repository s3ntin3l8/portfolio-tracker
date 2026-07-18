import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { setRequestLocale } from "next-intl/server";
import { getSessionState } from "@/lib/session-token";
import { OnboardingFlow } from "@/components/onboarding/onboarding-flow";

// Same authConfigured gate as the `(app)` layout — auth is only enforced once
// AUTH_SECRET + issuer are set, so the design-system screens stay viewable in local
// dev before Authentik is wired.
const authConfigured = Boolean(process.env.AUTH_SECRET && process.env.AUTHENTIK_ISSUER);

// Onboarding is a sibling of `(app)`, not inside it — full-screen, no AppShell — so
// it needs its own auth gate (the `(app)` layout's redirect doesn't cover this route).
// Every render depends on the session cookie, so this can't be statically prerendered.
export const dynamic = "force-dynamic";

export default async function OnboardingPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);

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
  }

  return <OnboardingFlow />;
}
