import { Suspense } from "react";
import { setRequestLocale } from "next-intl/server";
import { AuthErrorRecovery } from "@/components/auth-error-recovery";

/**
 * Auth.js `pages.error` lands here (next-intl localizes the path). A failed OAuth
 * callback recovers by restarting a fresh sign-in instead of dead-ending on the generic
 * 500 error page — see {@link AuthErrorRecovery}.
 */
export default async function AuthErrorPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6">
      {/* useSearchParams() needs a Suspense boundary or static prerender bails to CSR. */}
      <Suspense>
        <AuthErrorRecovery />
      </Suspense>
    </main>
  );
}
